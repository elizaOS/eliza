import { readdir, readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { Client } from "pg"

export const webRequest = (url: string, init?: RequestInit) => new Request(url, init)

export async function openBackupDatabase(existingStandalone = false) {
  const database = await PGlite.create()
  const socket = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 5 })
  try {
    await socket.start()
    const migrations = new URL("../../src/store/migrations/", import.meta.url)
    const allNames = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()
    const names = existingStandalone
      ? allNames.filter((name) => name !== "0107_sms_code_transport.sql" && name !== "0108_native_google_challenges.sql")
      : allNames
    await database.exec("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)")
    for (const name of names) {
      await database.exec(await readFile(new URL(name, migrations), "utf8"))
      await database.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, 1)", [name])
    }
    const databaseUrl = "postgresql://postgres:postgres@" + socket.getServerConn() + "/postgres"
    const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 })
    await db.connect()
    return {
      db, databaseUrl,
      async close() {
        try {
          await db.end()
        } finally {
          try {
            await socket.stop()
          } finally {
            await database.close()
          }
        }
      }
    }
  } catch (cause) {
    await socket.stop()
    await database.close()
    throw cause
  }
}
