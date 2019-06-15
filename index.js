const path = require('path').posix
const { EventEmitter } = require('events')

const collect = require('stream-collector')
const thunky = require('thunky')
const unixify = require('unixify')
const mutexify = require('mutexify')
const duplexify = require('duplexify')
const through = require('through2')
const pumpify = require('pumpify')
const pump = require('pump')

const coreByteStream = require('hypercore-byte-stream')
const MountableHypertrie = require('mountable-hypertrie')

const createFileDescriptor = require('./lib/fd')
const Stat = require('./lib/stat')
const errors = require('./lib/errors')
const defaultCorestore = require('./lib/storage')
const { messages } = require('hyperdrive-schemas')
const { contentKeyPair, contentOptions, ContentState } = require('./lib/content')

// 20 is arbitrary, just to make the fds > stdio etc
const STDIO_CAP = 20

module.exports = (...args) => new Hyperdrive(...args)
module.exports.constants = require('filesystem-constants').linux

class Hyperdrive extends EventEmitter {
  constructor (storage, key, opts) {
    super()

    if (isObject(key)) {
      opts = key
      key = null
    }
    if (!opts) opts = {}

    this.opts = opts
    this.key = null
    this.discoveryKey = null
    this.live = true
    this.sparse = opts.sparse !== false
    // TODO: Add support for mixed-sparsity.
    this.sparseMetadata = this.sparse || opts.sparseMetadata !== false

    this._corestore = defaultCorestore(storage, {
      sparse: this.sparse,
      valueEncoding: 'binary'
    })
    this.metadata = this._corestore.default({
      key,
      secretKey: opts.secretKey,
    })
    this._db = opts._db || new MountableHypertrie(this._corestore, key, {
      feed: this.metadata,
      sparse: this.sparse
    })

    this._contentStates = new Map()
    if (opts._content) this._contentStates.set(this._db, new ContentState(opts._content))

    this._fds = []
    this._writingFds = new Map()

    this.ready = thunky(this._ready.bind(this))
    this.ready(onReady)

    const self = this

    function onReady (err) {
      if (err) return self.emit('error', err)
      self.emit('ready')
    }
  }

  get version () {
    // TODO: The trie version starts at 1, so the empty hyperdrive version is also 1. This should be 0.
    return this._db.version
  }

  get writable () {
    return this.metadata.writable
  }

  get contentWritable () {
    const contentState = this._contentStates.get(this._db)
    if (!contentState) return false
    return contentState.feed.writable
  }

  _ready (cb) {
    const self = this

    self.metadata.on('error', onerror)
    self.metadata.on('append', update)

    return self.metadata.ready(err => {
      if (err) return cb(err)

      const rootContentKeyPair = self.metadata.secretKey ? contentKeyPair(self.metadata.secretKey) : {}

      /**
       * TODO: Update comment to reflect mounts.
       *
       * If a db is provided as input, ensure that a contentFeed is also provided, then return (this is a checkout).
       * If the metadata feed is writable:
       *    If the metadata feed has length 0, then the db should be initialized with the content feed key as metadata.
       *    Else, initialize the db without metadata and load the content feed key from the header.
       * If the metadata feed is readable:
       *    Initialize the db without metadata and load the content feed key from the header.
       */
      if (self.opts._db) {
        if (!self._contentStates.get(self.opts._db)) return cb(new Error('Must provide a db and a content feed'))
        return done(null)
      } else if (self.metadata.writable && !self.metadata.length) {
        initialize(rootContentKeyPair)
      } else {
        restore(rootContentKeyPair)
      }
    })

    /**
     * The first time the hyperdrive is created, we initialize both the db (metadata feed) and the content feed here.
     */
    function initialize (keyPair) {
      self._db.setMetadata(keyPair.publicKey)
      self._db.ready(err => {
        if (err) return cb(err)
        self._getContent(self._db, { secretKey: keyPair.secretKey }, err => {
          if (err) return cb(err)
          return done(null)
        })
      })
    }

    /**
     * If the hyperdrive has already been created, wait for the db (metadata feed) to load.
     * If the metadata feed is writable, we can immediately load the content feed from its private key.
     * (Otherwise, we need to read the feed's metadata block first)
     */
    function restore (keyPair) {
      if (self.metadata.writable) {
        self._db.ready(err => {
          if (err) return done(err)
          self._getContent(self._db, { secretKey: keyPair.secretKey }, done)
        })
      } else {
        self._db.ready(done)
      }
    }

    function done (err) {
      if (err) return cb(err)
      self.key = self.metadata.key
      self.discoveryKey = self.metadata.discoveryKey
      return cb(null)
    }

    function onerror (err) {
      if (err) self.emit('error', err)
    }

    function update () {
      self.emit('update')
    }
  }

  _getContent (db, opts, cb) {
    if (typeof opts === 'function') return this._getContent(db, null, opts)
    const self = this

    const existingContent = self._contentStates.get(db)
    if (existingContent) return process.nextTick(cb, null, existingContent)

    db.getMetadata((err, publicKey) => {
      if (err) return cb(err)
      return onkey(publicKey)
    })

    function onkey (publicKey) {
      const contentOpts = { key: publicKey, ...contentOptions(self, opts && opts.secretKey), ...opts }
      const feed = self._corestore.get(contentOpts)
      feed.ready(err => {
        if (err) return cb(err)
        const state = new ContentState(feed)
        self._contentStates.set(db, state)
        feed.on('error', err => self.emit('error', err))
        if (!feed.writable) {
          return feed.update(1, err => {
            if (err) return cb(err)
            return cb(null, state)
          })
        }
        return cb(null, state)
      })
    }
  }

  _putStat (name, stat, opts, cb) {
    if (typeof opts === 'function') return this._putStat(name, stat, null, opts)
    try {
      var encoded = messages.Stat.encode(stat)
    } catch (err) {
      return cb(err)
    }
    this._db.put(name, encoded, opts, err => {
      if (err) return cb(err)
      return cb(null, stat)
    })
  }

  _update (name, stat, cb) {
    name = unixify(name)

    this._db.get(name, (err, st) => {
      if (err) return cb(err)
      if (!st) return cb(new errors.FileNotFound(name))
      try {
        var decoded = messages.Stat.decode(st.value)
      } catch (err) {
        return cb(err)
      }
      const newStat = Object.assign(decoded, stat)
      return this._putStat(name, newStat, cb)
    })
  }

  open (name, flags, cb) {
    name = unixify(name)

    this.ready(err => {
      if (err) return cb(err)
      createFileDescriptor(this, name, flags, (err, fd) => {
        if (err) return cb(err)
        cb(null, STDIO_CAP + this._fds.push(fd) - 1)
      })
    })
  }

  read (fd, buf, offset, len, pos, cb) {
    if (typeof pos === 'function') {
      cb = pos
      pos = null
    }

    const desc = this._fds[fd - STDIO_CAP]
    if (!desc) return process.nextTick(cb, new errors.BadFileDescriptor(`Bad file descriptor: ${fd}`))
    if (pos == null) pos = desc.position
    desc.read(buf, offset, len, pos, cb)
  }

  write (fd, buf, offset, len, pos, cb) {
    if (typeof pos === 'function') {
      cb = pos
      pos = null
    }

    const desc = this._fds[fd - STDIO_CAP]
    if (!desc) return process.nextTick(cb, new errors.BadFileDescriptor(`Bad file descriptor: ${fd}`))
    if (pos == null) pos = desc.position
    desc.write(buf, offset, len, pos, cb)
  }

  createReadStream (name, opts) {
    if (!opts) opts = {}
    const self = this

    name = unixify(name)

    const length = typeof opts.end === 'number' ? 1 + opts.end - (opts.start || 0) : typeof opts.length === 'number' ? opts.length : -1
    const stream = coreByteStream({
      ...opts,
      highWaterMark: opts.highWaterMark || 64 * 1024
    })

    this.ready(err => {
      if (err) return stream.destroy(err)
      this.stat(name, (err, st, trie) => {
        if (err) return stream.destroy(err)
        this._getContent(trie, (err, contentState) => {
          if (err) return stream.destroy(err)
          return oncontent(st, contentState)
        })
      })
    })

    function oncontent (st, contentState) {
      console.log('IN ONCONTENT, content length:', contentState.feed.length, 'byteLength:', contentState.feed.byteLength)
      if (st.mount && st.mount.hypercore) {
        var byteOffset = 0
        var blockOffset = 0
        var blockLength = st.blocks
        var feed = self._corestore.get({
          key: st.mount.key,
          sparse: self.sparse
        })
      } else {
        blockOffset = st.offset
        blockLength = st.blocks
        byteOffset = opts.start ? st.byteOffset + opts.start : st.byteOffset
        feed = contentState.feed
      }
      const byteLength = length !== -1 ? length : (opts.start ? st.size - opts.start : st.size)

      console.log('st:', st)
      console.log('byteLength:', byteLength, 'blockOffset:', blockOffset, 'byteOffset:', byteOffset, 'blockLength:', blockLength)

      stream.start({
        feed,
        blockOffset,
        blockLength,
        byteOffset,
        byteLength
      })
    }

    return stream
  }

  // TODO: Update when support is added to MountableHypertrie
  /*
  createDiffStream (other, prefix, opts) {
    if (other instanceof Hyperdrive) other = other.version
    if (typeof prefix === 'object') return this.createDiffStream(other, '/', prefix)
    prefix = prefix || '/'

    const proxy = duplexify.obj()
    proxy.setWritable(false)

    this.ready(err => {
      if (err) return proxy.destroy(err)

      const decoder = through.obj((chunk, enc, cb) => {
        let obj = { type: !chunk.left ? 'del' : 'put', name: chunk.key }
        if (chunk.left) {
          try {
            obj.stat = messages.Stat.decode(chunk.left.value)
          } catch (err) {
            return cb(err)
          }
        }
        return cb(null, obj)
      })
      proxy.setReadable(pumpify.obj(this._db.createDiffStream(other, prefix, opts), decoder))
    })

    return proxy
  }
  */

  createDirectoryStream (name, opts) {
    if (!opts) opts = {}

    name = unixify(name)

    const proxy = duplexify.obj()
    proxy.setWritable(false)

    this.ready(err => {
      if (err) return
      const stream = pump(
        this._db.createReadStream(name, opts),
        through.obj((chunk, enc, cb) => {
          try {
            var stat = messages.Stat.decode(chunk.value)
          } catch (err) {
            return cb(err)
          }
          return cb(null, {
            path: chunk.key,
            stat: new Stat(stat)
          })
        })
      )
      proxy.setReadable(stream)
    })

    return proxy
  }

  createWriteStream (name, opts) {
    if (!opts) opts = {}
    name = unixify(name)

    const self = this
    var release

    const proxy = duplexify()
    proxy.setReadable(false)

    // TODO: support piping through a "split" stream like rabin

    this.ready(err => {
      if (err) return proxy.destroy(err)
      this.stat(name, { trie: true }, (err, stat, trie) => {
        if (err && (err.errno !== 2)) return proxy.destroy(err)
        this._getContent(trie, (err, contentState) => {
          if (err) return proxy.destroy(err)
          contentState.lock(_release => {
            release = _release
            append(contentState)
          })
        })
      })
    })

    return proxy

    function append (contentState) {
      if (proxy.destroyed) return release()

      const byteOffset = contentState.feed.byteLength
      const offset = contentState.feed.length

      self.emit('appending', name, opts)

      // TODO: revert the content feed if this fails!!!! (add an option to the write stream for this (atomic: true))
      const stream = contentState.feed.createWriteStream()

      proxy.on('close', ondone)
      proxy.on('finish', ondone)

      proxy.setWritable(stream)
      proxy.on('prefinish', function () {
        const stat = Stat.file({
          ...opts,
          offset,
          byteOffset,
          size: contentState.feed.byteLength - byteOffset,
          blocks: contentState.feed.length - offset
        })
        proxy.cork()
        self._putStat(name, stat, function (err) {
          if (err) return proxy.destroy(err)
          self.emit('append', name, opts)
          proxy.uncork()
        })
      })
    }

    function ondone () {
      proxy.removeListener('close', ondone)
      proxy.removeListener('finish', ondone)
      release()
    }
  }

  create (name, opts, cb) {
    if (typeof opts === 'function') return this.create(name, null, opts)

    name = unixify(name)

    this.ready(err => {
      if (err) return cb(err)
      this.lstat(name, { file: true, trie: true }, (err, stat) => {
        if (err && err.errno !== 2) return cb(err)
        if (stat) return cb(null, stat)
        const st = Stat.file(opts)
        return this._putStat(name, st, cb)
      })
    })
  }

  readFile (name, opts, cb) {
    if (typeof opts === 'function') return this.readFile(name, null, opts)
    if (typeof opts === 'string') opts = {encoding: opts}
    if (!opts) opts = {}

    name = unixify(name)

    collect(this.createReadStream(name, opts), function (err, bufs) {
      if (err) return cb(err)
      let buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs)
      cb(null, opts.encoding && opts.encoding !== 'binary' ? buf.toString(opts.encoding) : buf)
    })
  }

  writeFile (name, buf, opts, cb) {
    if (typeof opts === 'function') return this.writeFile(name, buf, null, opts)
    if (typeof opts === 'string') opts = { encoding: opts }
    if (!opts) opts = {}
    if (typeof buf === 'string') buf = Buffer.from(buf, opts.encoding || 'utf-8')
    if (!cb) cb = noop

    name = unixify(name)

    let stream = this.createWriteStream(name, opts)

    // TODO: Do we need to maintain the error state? What's triggering 'finish' after 'error'?
    var errored = false

    stream.on('error', err => {
      errored = true
      return cb(err)
    })
    stream.on('finish', () => {
      if (!errored) return cb(null)
    })
    stream.end(buf)
  }

  truncate (name, size, cb) {
    name = unixify(name)

    this.lstat(name, { file: true, trie: true }, (err, st) => {
      if (err && err.errno !== 2) return cb(err)
      if (!st) return this.create(name, cb)
      if (size === st.size) return cb(null)
      if (size < st.size) {
        const readStream = this.createReadStream(name, { length: size })
        const writeStream = this.createWriteStream(name)
        return pump(readStream, writeStream, cb)
      } else {
        this.open(name, 'a', (err, fd) => {
          if (err) return cb(err)
          const length = size - st.size
          this.write(fd, Buffer.alloc(length), 0, length, st.size, err => {
            if (err) return cb(err)
            this.close(fd, cb)
          })
        })
      }
    })
  }

  _createStat (name, opts, cb) {
    const statConstructor = (opts && opts.directory) ? Stat.directory : Stat.file
    this._db.get(name, (err, node, trie) => {
      if (err) return cb(err)
      this._getContent(trie, (err, contentState) => {
        if (err) return cb(err)
        const st = statConstructor({
          ...opts,
          offset: contentState.feed.length,
          byteOffset: contentState.feed.byteLength
        })
        return cb(null, st)
      })
    })
  }

  mkdir (name, opts, cb) {
    if (typeof opts === 'function') return this.mkdir(name, null, opts)
    if (typeof opts === 'number') opts = {mode: opts}
    if (!opts) opts = {}
    if (!cb) cb = noop

    name = unixify(name)
    opts.directory = true

    this._createStat(name, opts, (err, st) => {
      if (err) return cb(err)
      this._putStat(name, st, {
        condition: ifNotExists
      }, cb)
    })
  }

  _statDirectory (name, opts, cb) {
    const ite = this._db.iterator(name)
    ite.next((err, st) => {
      if (err) return cb(err)
      if (name !== '/' && !st) return cb(new errors.FileNotFound(name))
      if (name === '/') return cb(null, Stat.directory())
      try {
        st = messages.Stat.decode(st.value)
      } catch (err) {
        return cb(err)
      }
      return cb(null, Stat.directory(st))
    })
  }

  lstat (name, opts, cb) {
    if (typeof opts === 'function') return this.lstat(name, null, opts)
    if (!opts) opts = {}
    const self = this
    name = unixify(name)

    this.ready(err => {
      if (err) return cb(err)
      this._db.get(name, opts, onstat)
    })

    function onstat (err, node, trie) {
      if (err) return cb(err)
      if (!node && opts.trie) return cb(null, null, trie)
      if (!node && opts.file) return cb(new errors.FileNotFound(name))
      if (!node) return self._statDirectory(name, opts, cb)
      try {
        var st = messages.Stat.decode(node.value)
      } catch (err) {
        return cb(err)
      }
      const writingFd = self._writingFds.get(name)
      if (writingFd) {
        st.size = writingFd.stat.size
      }
      cb(null, new Stat(st), trie)
    }
  }

  stat (name, opts, cb) {
    if (typeof opts === 'function') return this.stat(name, null, opts)
    if (!opts) opts = {}

    this.lstat(name, opts, (err, stat, trie) => {
      if (err) return cb(err)
      if (!stat) return cb(null, null, trie)
      if (stat.linkname) return this.lstat(stat.linkname, opts, cb)
      return cb(null, stat, trie)
    })
  }

  access (name, opts, cb) {
    if (typeof opts === 'function') return this.access(name, null, opts)
    if (!opts) opts = {}
    name = unixify(name)

    this.stat(name, opts, err => {
      cb(err)
    })
  }

  exists (name, opts, cb) {
    if (typeof opts === 'function') return this.exists(name, null, opts)
    if (!opts) opts = {}

    this.access(name, opts, err => {
      cb(!err)
    })
  }

  readdir (name, opts, cb) {
    if (typeof opts === 'function') return this.readdir(name, null, opts)

    name = unixify(name)
    if (name !== '/' && name.startsWith('/')) name = name.slice(1)

    const recursive = !!(opts && opts.recursive)

    this._db.list(name, { gt: true, recursive }, (err, list) => {
      if (err) return cb(err)
      return cb(null, list.map(st => {
        if (name === '/') return st.key.split('/')[0]
        return path.relative(name, st.key).split('/')[0]
      }))
    })
  }

  _del (name, cb) {
    this.ready(err => {
      if (err) return cb(err)
      this._db.del(name, (err, node) => {
        if (err) return cb(err)
        if (!node) return cb(new errors.FileNotFound(name))
        return cb(null)
      })
    })
  }

  unlink (name, cb) {
    name = unixify(name)
    this._del(name, cb || noop)
  }

  rmdir (name, cb) {
    if (!cb) cb = noop
    name = unixify(name)

    const self = this

    let stream = this._db.iterator(name)
    stream.next((err, val) => {
      if (err) return cb(err)
      if (val) return cb(new errors.DirectoryNotEmpty(name))
      self._del(name, cb)
    })
  }

  replicate (opts) {
    return this._corestore.replicate(opts)
  }

  checkout (version, opts) {
    const db = this._db.checkout(version)
    opts = {
      ...opts,
      _db: db,
      _content: this._contentStates.get(this._db)
    }
    return new Hyperdrive(this._corestore, this.key, opts)
  }

  _closeFile (fd, cb) {
    const desc = this._fds[fd - STDIO_CAP]
    if (!desc) return process.nextTick(cb, new Error('Invalid file descriptor'))
    this._fds[fd - STDIO_CAP] = null
    while (this._fds.length && !this._fds[this._fds.length - 1]) this._fds.pop()
    desc.close(cb)
  }

  close (fd, cb) {
    if (typeof fd === 'number') return this._closeFile(fd, cb || noop)
    else cb = fd
    if (!cb) cb = noop
    const self = this

    // Attempt to close all feeds, even if a subset of them fail. Return the last error.
    var closeErr = null

    this.ready(err => {
      if (err) return cb(err)
      return this._corestore.close(cb)
    })
  }

  watch (name, onchange) {
    name = unixify(name)
    return this._db.watch(name, onchange)
  }

  mount (path, key, opts, cb) {
    if (typeof opts === 'function') return this.mount(path, key, null, opts)
    const self = this

    path = unixify(path)
    opts = opts || {}

    opts.mount = {
      key,
      version: opts.version,
      hash: opts.hash,
      hypercore: !!opts.hypercore
    }
    opts.directory = !opts.hypercore

    if (opts.hypercore) {
      const core = this._corestore.get({
        key,
        ...opts,
        sparse: this.sparse
      })
      core.ready(err => {
        if (err) return cb(err)
        opts.size = core.byteLength
        opts.blocks = core.length
        return mountCore()
      })
    } else {
      return process.nextTick(mountTrie, null)
    }

    function mountCore () {
      self._createStat(path, opts, (err, st) => {
        if (err) return cb(err)
        return self._db.put(path, messages.Stat.encode(st), cb)
      })
    }

    function mountTrie () {
      self._createStat(path, opts, (err, st) => {
        if (err) return cb(err)
        self._db.mount(path, key, { ...opts, value: messages.Stat.encode(st) }, err => {
          if (err) return cb(err)
          return self._db.loadMount(path, cb)
        })
      })
    }
  }

  symlink (target, linkName, cb) {
    target = unixify(target)
    linkName = unixify(linkName)

    this.lstat(linkName, (err, stat) => {
      if (err && (err.errno !== 2)) return cb(err)
      if (!err) return cb(new errors.PathAlreadyExists(linkName))
      const st = Stat.symlink({
        linkname: target
      })
      return this._putStat(linkName, st, cb)
    })
  }
}

function isObject (val) {
  return !!val && typeof val !== 'string' && !Buffer.isBuffer(val)
}

function ifNotExists (oldNode, newNode, cb) {
  if (oldNode) return cb(new errors.PathAlreadyExists(oldNode.key))
  return cb(null, true)
}

function noop () {}
