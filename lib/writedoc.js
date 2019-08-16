const keyutils = require('./keyutils.js')

module.exports = async (db, databaseName, id, d) => {
  // clone to stop mutation of incoming object
  const doc = JSON.parse(JSON.stringify(d))
  try {
    await db.doTransaction(async tn => {
      // get database
      const k = keyutils.getDBKey(databaseName)

      // check the database exists
      const dbObj = await tn.get(k)
      if (!dbObj) {
        throw new Error('missing database')
      }

      // calculate new sequence
      const seq = parseInt(dbObj.update_seq) + 1

      // calculate doc key
      const docKey = keyutils.getDocKey(databaseName, id)

      // calculate the changes key
      const changesKey = keyutils.getChangesKey(databaseName, seq.toString())

      // write newchange
      const changesObj = { id: id }
      if (doc._deleted) {
        changesObj.deleted = true
      }
      await tn.set(changesKey, changesObj)

      // write doc to database
      const oldDoc = await tn.get(docKey)
      delete doc._id
      delete doc._rev
      await tn.set(docKey, doc)

      // write any indexes to the database
      // find any fields which start with _ but are not _id, _rev, or _deleted
      const indexedFields = Object.keys(doc).filter(function (x) { return x.startsWith('_') && !['_id', '_rev', '_deleted'].includes(x) })
      for (var i in indexedFields) {
        const indexedField = indexedFields[i]
        const niceIndexedField = indexedField.replace(/^_/, '')

        // clear old key
        if (oldDoc) {
          const oldk = keyutils.getIndexKey(databaseName, niceIndexedField, oldDoc[indexedField], id)
          await tn.clear(oldk)
        }

        // set new key
        const k = keyutils.getIndexKey(databaseName, niceIndexedField, doc[indexedField], id)
        await tn.set(k, id)
      }

      // update seq
      dbObj.update_seq = seq.toString()
      await tn.set(k, dbObj)

      return { ok: true }
    })
  } catch (e) {
    console.log(e)
  }
}
