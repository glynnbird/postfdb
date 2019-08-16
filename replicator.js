// modules and libraries
// const docutils = require('./lib/docutils.js')
// const replutils = require('./lib/replicatorutils.js')
// const tableutils = require('./lib/tableutils.js')
const pkg = require('./package.json')
const defaults = require('./lib/defaults.js')
const debug = require('debug')(pkg.name)
const url = require('url')
const writeDoc = require('./lib/writedoc.js')
const keyutils = require('./lib/keyutils.js')
const createDatabase = require('./lib/createdatabase.js')

// start up FoundationDB connection
const fdb = require('foundationdb')
fdb.setAPIVersion(600)
const db = fdb.openSync()
  .withKeyEncoding(fdb.encoders.tuple)
  .withValueEncoding(fdb.encoders.json)

// look in the database for new replication jobs
const lookForNewReplications = async (firstTime) => {
  let key

  // when running this for the first time we want new jobs
  // and running jobs (jobs that were running when the
  // replicator stopped)
  if (firstTime) {
    key = ['_replicator', 'index', 'i1', 'running']
  } else {
    key = ['_replicator', 'index', 'i1', 'new']
  }
  try {
    const data = await db.getRangeAllStartsWith(key)
    if (data) {
      const newReplications = []
      for (var i in data) {
        const id = data[i][1]
        key = keyutils.getDocKey('_replicator', id)
        const doc = await db.get(key)
        doc._id = id
        newReplications.push(doc)
      }
      console.log(newReplications)
      for (i in newReplications) {
        const row = newReplications[i]
        startReplication(row)
      }
    }
  } catch (e) {
    console.error(e)
    debug(e)
  }
}

// start replication job
const startReplication = async (job) => {
  const shortJobId = job._id.substr(0, 6) + '..'
  job.state = job._i1 = 'running'
  let parsedUrl
  try {
    // parse the source url
    parsedUrl = new url.URL(job.source)
    if (!parsedUrl) {
      throw (new Error('Invalid source URL'))
    }
    // set the status to running
    await writeDoc(db, '_replicator', job._id, job)
  } catch (e) {
    debug(e)
    job.state = job._i1 = 'error'
    writeDoc(db, '_replicator', job._id, job, defaults.clusterid)
    return
  }

  // create target if necessary
  try {
    // if the target database needs creating
    if (job.create_target) {
      await createDatabase(db, job.target)
    }
  } catch (e) {
    debug('Target already present')
  }

  // create Nano object
  const Nano = require('nano')
  const sourceUrl = parsedUrl.href.replace(parsedUrl.pathname, '')
  const nano = Nano(sourceUrl)
  const databaseName = parsedUrl.pathname.replace(/^\//, '')
  const ChangesReader = require('changesreader')
  const changesReader = new ChangesReader(databaseName, nano.request)

  // run replication
  let worker
  console.log(shortJobId + ' starting  from ' + job.seq.substr(0, 10))
  const opts = {
    batchSize: 5000,
    since: job.seq,
    includeDocs: true,
    wait: true
  }
  if (job.exclude.length > 0) {
    opts.qs = { exclude: job.exclude }
  }

  // decide whether to use continuous or one-off
  if (job.continuous) {
    worker = changesReader.start(opts)
  } else {
    worker = changesReader.get(opts)
  }

  // listen for changes events
  worker
    .on('batch', (b, callback) => {
      console.log(shortJobId + ' ' + b.length + ' changes')
      try {
        const write = async () => {
          let docCount = 0
          for (var i = 0; i < b.length; i++) {
            if (b.deleted) {
              await writeDoc(db, job.target, b[i].id, { _deleted: true })
              docCount++
            } else {
              if (!b[i].id.match(/^_design/)) {
                await writeDoc(db, job.target, b[i].id, b[i].doc)
                docCount++
              }
            }
          }
          job.doc_count += docCount
          await writeDoc(db, '_replicator', job._id, job)
        }
        write().then(callback)
      } catch (e) {
        debug(e)
      }
    }).on('seq', (s) => {
      console.log('SEQ', s)
      job.seq = s
      // will be written on next batch
    }).on('error', (e) => {
      debug('changesreader error', e)
      job.state = job._i1 = 'error'
      writeDoc(db, '_replicator', job._id, job)
    }).on('end', (e) => {
      setTimeout(function () {
        console.log(shortJobId + ' ended')
        job.state = job._i1 = 'completed'
        writeDoc(db, '_replicator', job._id, job)
      }, 1000)
    })
}

// main
const main = async () => {
  try {
    // check for new replications every 30 seconds
    setInterval(lookForNewReplications, 30 * 1000)
    await lookForNewReplications(true)
  } catch (e) {
    debug(e)
    console.error('Cannot connect to Postgre')
  }
}

main()
