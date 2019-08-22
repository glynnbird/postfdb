const keyutils = require('./keyutils.js')

module.exports = async (db, databaseName) => {
  const k = keyutils.getDBKey(databaseName)
  const existingDB = await db.get(k)
  if (existingDB) {
    throw new Error('existing database')
  }
  const obj = {
    db_name: databaseName
  }
  await db.set(k, obj)
}
