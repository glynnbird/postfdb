const keyutils = require('./keyutils.js')

module.exports = async (fdb, db, databaseName, docs) => {
  try {
    await db.doTransaction(async tn => {
      // get database
      const k = keyutils.getDBKey(databaseName)

      // check the database exists
      const dbObj = await tn.get(k)
      if (!dbObj) {
        throw new Error('missing database')
      }

      for (var j in docs) {
        const doc = docs[j]
        const id = doc._id

        // calculate doc key
        const docKey = keyutils.getDocKey(databaseName, id)
        let i

        // delete old indexes for the old version of this document, if it exists
        const oldDoc = await tn.get(docKey)
        if (oldDoc) {
          const oldIndexedFields = Object.keys(oldDoc).filter(function (x) { return x.startsWith('_') && !['_id', '_rev', '_deleted'].includes(x) })
          for (i in oldIndexedFields) {
            const indexedField = oldIndexedFields[i]
            // only de-index if the data's changed
            if (oldDoc[indexedField] !== doc[indexedField]) {
              const niceIndexedField = indexedField.replace(/^_/, '')
              const oldk = keyutils.getIndexKey(databaseName, niceIndexedField, oldDoc[indexedField], id)
              await tn.clear(oldk)
            }
          }
        }

        // deal with the document itself
        const changesObj = { id: id }
        if (doc._deleted) {
          // mark as deleted in changes
          changesObj.deleted = true

          // delete the document itself
          await tn.clear(docKey)
        } else {
          // write doc to database
          delete doc._id
          delete doc._rev
          await tn.set(docKey, doc)

          // write any indexes for the new document
          // find any fields which start with _ but are not _id, _rev, or _deleted
          const indexedFields = Object.keys(doc).filter(function (x) { return x.startsWith('_') && !['_id', '_rev', '_deleted'].includes(x) })
          for (i in indexedFields) {
            const indexedField = indexedFields[i]
            // only re-index if the data's changed
            if (!oldDoc || oldDoc[indexedField] !== doc[indexedField]) {
              const niceIndexedField = indexedField.replace(/^_/, '')

              // set new key
              const k = keyutils.getIndexKey(databaseName, niceIndexedField, doc[indexedField], id)
              await tn.set(k, id)
            }
          }
        }

        // write the change to change log
        const changesKey = keyutils.getChangesKey(databaseName, fdb.tuple.unboundVersionstamp())
        await tn.setVersionstampedKey(changesKey, changesObj)
      }

      return { ok: true }
    })
  } catch (e) {
    console.log(e)
  }
}
