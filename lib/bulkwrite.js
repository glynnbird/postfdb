const keyutils = require('./keyutils.js')

module.exports = async (db, databaseName, docs) => {
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
      let seq = parseInt(dbObj.update_seq)

      for (var j in docs) {
        const doc = docs[j]
        const id = doc._id
        seq++

        // calculate doc key
        const docKey = keyutils.getDocKey(databaseName, id)

        // calculate the changes key
        const changesKey = keyutils.getChangesKey(databaseName, seq)
        let i

        // delete old indexes for the old version of this document, if it exists
        const oldDoc = await tn.get(docKey)
        if (oldDoc) {
          const oldIndexedFields = Object.keys(oldDoc).filter(function (x) { return x.startsWith('_') && !['_id', '_rev', '_deleted'].includes(x) })
          for (i in oldIndexedFields) {
            const indexedField = oldIndexedFields[i]
            const niceIndexedField = indexedField.replace(/^_/, '')
            const oldk = keyutils.getIndexKey(databaseName, niceIndexedField, oldDoc[indexedField], id)
            await tn.clear(oldk)
          }
        }

        // deal with the document itself
        const changesObj = { id: id }
        if (doc._deleted) {
          // mark as deleted in changes
          changesObj.deleted = true

          // delete the document itself
          await tn.clear(docKey)

          // decrement doc count
          if (oldDoc) {
            // decrement doc count  
            dbObj['doc_count']--
          }
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
            const niceIndexedField = indexedField.replace(/^_/, '')

            // set new key
            const k = keyutils.getIndexKey(databaseName, niceIndexedField, doc[indexedField], id)
            await tn.set(k, id)
          }
                  
          // increment doc count
          if (!oldDoc) {
            // increment doc count  
            dbObj['doc_count']++
          }
        }

        // write the change to change log
        await tn.set(changesKey, changesObj)
      }

      // write db obj
      dbObj.update_seq = seq.toString()
      await tn.set(k, dbObj)
      return { ok: true }
    })
  } catch (e) {
    console.log(e)
  }
}
