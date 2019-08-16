// modules and libraries
const express = require('express')
const utils = require('./lib/utils.js')
const pkg = require('./package.json')
const debug = require('debug')(pkg.name)
const app = express()
const basicAuth = require('express-basic-auth')
const kuuid = require('kuuid')
const morgan = require('morgan')
const keyutils = require('./lib/keyutils.js')
const url = require('url')
const writeDoc = require('./lib/writedoc.js')
const createDatabase = require('./lib/createdatabase.js')
const bulkWrite = require('./lib/bulkwrite.js')

// fixed rev value - no MVCC here
const fixrev = '0-1'

// incoming environment variables vs defaults
const defaults = require('./lib/defaults.js')

// pretty print
// app.set('json spaces', 2)
app.set('x-powered-by', false)

// JSON parsing middleware
const bodyParser = require('body-parser')
app.use(bodyParser.json())

// compression middleware
const compression = require('compression')
app.use(compression())

// Logging middleware
if (defaults.logging !== 'none') {
  app.use(morgan(defaults.logging))
}

// AUTH middleware
if (defaults.username && defaults.password) {
  console.log('NOTE: authentication mode')
  const obj = {}
  obj[defaults.username] = defaults.password
  app.use(basicAuth({ users: obj }))
}

// readonly middleware
const readOnlyMiddleware = require('./lib/readonly.js')(defaults.readonly)
if (defaults.readonly) {
  console.log('NOTE: readonly mode')
}

// start up FoundationDB connection
const fdb = require('foundationdb')
fdb.setAPIVersion(600)
const db = fdb.openSync()
  .withKeyEncoding(fdb.encoders.tuple)
  .withValueEncoding(fdb.encoders.json)

// send error
const sendError = (res, statusCode, str) => {
  res.status(statusCode).send({ error: str })
}

// POST /_session
// session endpoint
app.post('/_session', async (req, res) => {
  res.send({ ok: true, name: 'admin', roles: ['admin'] })
})

// POST /_replicator
// start a replication
app.post('/_replicator', async (req, res) => {
  const doc = req.body || {}

  // if the source isn't a string then we need to construct
  // a string URL from the object
  if (typeof doc.source === 'object') {
    const authStr = doc.source.headers.Authorization.replace(/^Basic /, '')
    const usernamePassword = Buffer.from(authStr, 'base64').toString()
    const bits = usernamePassword.split(':')
    const username = bits[0]
    const password = bits[1]
    const u = new URL(doc.source.url)
    u.username = username
    u.password = password
    doc.source = u.toString()
  }

  // if the target isn't a string, we need to construct a string
  // target database from the URL
  if (typeof doc.target === 'object') {
    const u = new URL(doc.target.url)
    doc.target = u.pathname.replace(/^\//, '')
  }

  // bad request without a source & target
  if (!doc.source || !doc.target) {
    return sendError(res, 400, 'source and target must be supplied')
  }
  try {
    const myURL = new url.URL(doc.source)
    debug('source url', myURL.host)
  } catch (e) {
    return sendError(res, 400, 'source must be a URL')
  }
  if (!utils.validDatabaseName(doc.target)) {
    return sendError(res, 400, 'target must be a valid database name')
  }
  doc.continuous = (doc.continuous === true)
  doc.create_target = (doc.create_target === true)
  doc.state = 'new'
  doc.seq = '0'
  doc.doc_count = 0
  doc.exclude = doc.exclude || ''
  doc._i1 = doc.state
  const id = utils.hash(JSON.stringify({ source: doc.source, target: doc.target }))

  try {
    await writeDoc(db, '_replicator', id, doc)
    res.send({ ok: true, id: id, rev: fixrev })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not write to _replicator')
  }
})

// DELETE /_replicator/id
app.delete('/_replicator/:id', async (req, res) => {
  const id = req.params.id
  if (!utils.validID(id)) {
    return sendError(res, 400, 'Invalid id')
  }
  try {
    const k = keyutils.getDocKey('_replicator', id)
    const doc = await db.get(k)
    if (!doc) {
      throw (new Error('missing document'))
    }

    // set it to cancellled and write it back
    doc.state = doc._i1 = 'cancelled'
    await writeDoc(db, '_replicator', id, doc)
    res.send({ ok: true, id: id, rev: fixrev })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Document not found')
  }
})

// POST /db/_bulk_docs
// bulk add/update/delete several documents
app.post('/:db/_bulk_docs', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }

  // docs parameter
  const docs = req.body.docs
  if (!docs || !Array.isArray(req.body.docs) || docs.length === 0) {
    return sendError(res, 400, 'Invalid docs parameter')
  }

  try {
    // process each document
    const response = []
    const docsToInsert = []
    for (var i in docs) {
      const doc = docs[i]

      // update or insert
      const id = doc._id || kuuid.id()
      if (!utils.validID(id)) {
        response.push({ ok: false, id: id, error: 'invalid _id' })
        continue
      }
      doc._id = id
      docsToInsert.push(doc)
      response.push({ ok: true, id: id, rev: fixrev })
    }
    await bulkWrite(db, databaseName, docsToInsert)
    res.status(201).send(response)
  } catch (e) {
    res.status(400).send({ ok: false })
  }
})

// GET /db/_all_dbs
// get a list of databases (tables)
app.get('/_all_dbs', async (req, res) => {
  try {
    const startKey = keyutils.getDBKey('')
    const endKey = keyutils.getDBKey('{}')
    const data = await db.getRangeAll(startKey, endKey)
    const response = []
    for (var i in data) {
      const d = data[i]
      response.push(d[1].db_name)
    }
    res.send(response)
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not retrieve databases')
  }
})

// GET /db/_uuids
// get a list of unique ids
app.get('/_uuids', (req, res) => {
  const count = req.query.count ? JSON.parse(req.query.count) : 1
  if (count < 1 || count > 100) {
    return sendError(res, 400, 'invalid count parameter')
  }
  const obj = {
    uuids: []
  }
  for (var i = 0; i < count; i++) {
    obj.uuids.push(kuuid.id())
  }
  res.send(obj)
})

// POST /db/_purge
// totally delete documents
app.post('/:db/_purge', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  try {
    const ids = Object.keys(req.body)
    for (var i in ids) {
      const id = ids[i]
      const docKey = keyutils.getDocKey(databaseName, id)
      await db.clear(docKey)
    }
    res.send({ purge_seq: null, purged: req.body })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not retrieve databases')
  }
})

// GET /db/changes
// get a list of changes
app.get('/:db/_changes', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }

  // parameter munging
  let since = req.query.since ? req.query.since : '0'
  const includeDocs = req.query.include_docs === 'true'
  let limit
  try {
    since = parseInt(since)
    limit = req.query.limit ? Number.parseInt(req.query.limit) : null
  } catch (e) {
    return sendError(res, 400, 'Invalid limit parameter')
  }
  if (limit && (typeof limit !== 'number' || limit < 1)) {
    return sendError(res, 400, 'Invalid limit parameter')
  }

  try {
    const startKey = keyutils.getChangesKey(databaseName, since + 1 )
    const endKey = keyutils.getChangesKey(databaseName, Number.MAX_SAFE_INTEGER)
    const data = await db.getRangeAll(startKey, endKey, { limit: limit })
    let lastSeq
    const obj = {
      last_seq: '',
      results: []
    }

    // go through the changes backwards to deduplicate references
    // to changes to the same document
    data.reverse()
    const alreadySeen = []
    for (var i in data) {
      const c = data[i]
      const id = c[1].id
      const seq = c[0][2]
      if (!alreadySeen.includes(id)) {
        alreadySeen.push(id)
        const thisobj = {
          changes: [{ rev: fixrev }],
          id: id,
          seq: seq
        }
        if (c.deleted) {
          thisobj.deleted = true
        }
        if (includeDocs) {
          const docKey = keyutils.getDocKey(databaseName, id)
          const doc = await db.get(docKey)
          doc._id = id
          doc._rev = fixrev
          thisobj.doc = doc
        }
        lastSeq = seq
        obj.results.push(thisobj)
      }
    }
    obj.results.reverse()
    obj.last_seq = lastSeq
    res.send(obj)
  } catch (e) {
    console.error(e)
    return sendError(res, 400, 'Cannot retrieve changes feed')
  }
})

// GET /db/_query
// query one of the defaults.indexes
app.post('/:db/_query', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const query = req.body
  if (!query || typeof query !== 'object') {
    return sendError(res, 400, 'Invalid query')
  }
  if (!query.index) {
    return sendError(res, 400, 'Missing Parameter "index"')
  }
  if (!query.index.match(/^i[0-9]+$/)) {
    return sendError(res, 400, 'Invalid Parameter "index"')
  }
  if (!query.startkey && !query.endkey && !query.key) {
    return sendError(res, 400, 'Missing Parameter "startkey/endkey/key"')
  }

  // limit parameter
  const limit = query.limit ? query.limit : 100
  if (limit && (typeof limit !== 'number' || limit < 1)) {
    return sendError(res, 400, 'Invalid limit parameter')
  }

  try {
    const sk = keyutils.getIndexKey(databaseName, query.index, query.startkey, '')
    const ek = keyutils.getIndexKey(databaseName, query.index, query.endkey, '{}')
    const data = await db.getRangeAll(sk, ek, { limit: query.limit })
    const obj = { docs: [] }
    for (var i in data) {
      const row = data[i]
      const k = keyutils.getDocKey(databaseName, row[1])
      const doc = await db.get(k)
      doc._id = row[1]
      doc._rev = fixrev
      obj.docs.push(doc)
    }
    res.send(obj)
  } catch (e) {
    console.error(e)
    sendError(res, 404, 'Could not query database')
  }
})

// GET /db/_all_docs
// get all documents
app.get('/:db/_all_docs', async (req, res) => {
  const databaseName = req.params.db
  const includeDocs = req.query.include_docs === 'true'
  let startkey, endkey, limit, offset

  try {
    startkey = req.query.startkey ? JSON.parse(req.query.startkey) : '0'
    endkey = req.query.endkey ? JSON.parse(req.query.endkey) : '{}'
    limit = req.query.limit ? JSON.parse(req.query.limit) : 100
    offset = req.query.offset ? JSON.parse(req.query.offset) : 0
  } catch (e) {
    return sendError(res, 400, 'Invalid startkey/endkey/limit/offset parameters')
  }

  // check limit parameter
  if (limit && (typeof limit !== 'number' || limit < 1)) {
    return sendError(res, 400, 'Invalid limit parameter')
  }

  // offset parameter
  if (offset && (typeof offset !== 'number' || offset < 0)) {
    return sendError(res, 400, 'Invalid offset parameter')
  }

  try {
    const sk = keyutils.getDocKey(databaseName, startkey)
    const ek = keyutils.getDocKey(databaseName, endkey)
    const data = await db.getRangeAll(sk, ek, { limit: limit })
    const obj = {
      rows: []
    }
    for (var i in data) {
      const d = data[i]
      const id = d[0][2]
      const thisobj = { id: id, key: id, value: { rev: fixrev } }
      if (includeDocs) {
        const doc = d[1]
        doc._id = id
        doc._rev = fixrev
        thisobj.doc = doc
      }
      obj.rows.push(thisobj)
    }
    res.send(obj)
  } catch (e) {
    console.error(e)
    sendError(res, 404, 'Could not retrieve documents')
  }
})

// GET /db/doc
// get a doc with a known id
app.get('/:db/:id', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = req.params.id
  if (!utils.validID(id)) {
    return sendError(res, 400, 'Invalid id')
  }
  try {
    const k = keyutils.getDocKey(databaseName, id)
    const data = await db.get(k)
    if (!data || data._deleted) {
      throw new Error('missing document')
    }
    res.send(keyutils.processDoc(id, data))
  } catch (e) {
    console.error(e)
    sendError(res, 404, 'Document not found ' + id)
  }
})

// PUT /db/doc
// add a doc with a known id
app.put('/:db/:id', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = req.params.id
  if (!utils.validID(id)) {
    return sendError(res, 400, 'Invalid id')
  }
  const doc = req.body
  if (!doc || typeof doc !== 'object') {
    return sendError(res, 400, 'Invalid JSON')
  }
  try {
    await writeDoc(db, databaseName, id, doc)
    res.status(201).send({ ok: true, id: id, rev: fixrev })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not write document ' + id)
  }
})

// DELETE /db/doc
// delete a doc with a known id
app.delete('/:db/:id', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = req.params.id
  if (!utils.validID(id)) {
    return sendError(res, 400, 'Invalid id')
  }
  try {
    const obj = {
      _deleted: true
    }
    await writeDoc(db, databaseName, id, obj)
    res.send({ ok: true, id: id, rev: fixrev })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not delete document ' + databaseName + '/' + id)
  }
})

// POST /db
// add a doc without an id
app.post('/:db', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = kuuid.id()
  const doc = req.body
  try {
    await writeDoc(db, databaseName, id, doc)
    res.status(201).send({ ok: true, id: id, rev: fixrev })
  } catch (e) {
    debug(e)
    sendError(res, 400, 'Could not save document')
  }
})

// PUT /db
// create a database
app.put('/:db', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  debug('Creating database - ' + databaseName)
  try {
    await createDatabase(db, databaseName)
    res.send({ ok: true })
  } catch (e) {
    debug(e)
    sendError(res, 412, 'Database already exists')
  }
})

// DELETE /db
// delete a database (table)
app.delete('/:db', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  debug('Delete database - ' + databaseName)
  try {
    const k = keyutils.getDBKey(databaseName)
    if (!k) {
      throw new Error('database does not exist')
    }
    await db.clear(k)
    await db.clearRangeStartsWith([databaseName])
    res.send({ ok: true })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not drop database ' + databaseName)
  }
})

// GET /db
// get info on database (table)
app.get('/:db', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  debug('Get database info - ' + databaseName)
  try {
    const k = keyutils.getDBKey(databaseName)
    const database = await db.get(k)
    if (!database) {
      throw new Error('database does not exist')
    }
    res.send(database)
  } catch (e) {
    debug('error', e)
    sendError(res, 404, 'Could not get database info for ' + databaseName)
  }
})

// GET /
// return server information
app.get('/', (req, res) => {
  const obj = {
    postDB: 'Welcome',
    pkg: pkg.name,
    node: process.version,
    version: pkg.version
  }
  res.send(obj)
})

// backstop route
app.use(function (req, res) {
  res.status(404).send({ error: 'missing' })
})

// main
const main = async () => {
  try {
    try {
      await createDatabase(db, '_replicator')
    } catch (e) {
      // swallow errors
      debug('_replicator already exists')
    }

    // start up the app
    app.listen(defaults.port, () => console.log(`${pkg.name} API service listening on port ${defaults.port}!`))
  } catch (e) {
    console.error('Cannot connect to PostgreSQL')
  }
}
main()
