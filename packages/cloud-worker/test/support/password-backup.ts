import { readdir, readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { Client } from "pg"

export const webRequest = (url: string, init?: RequestInit) => new Request(url, init)

const standaloneMigrations = [
  "0001_foundation.sql",
  "0101_identity_transport.sql",
  "0102_checkout_transport.sql",
  "0103_google_connections.sql",
  "0104_speech.sql",
  "0105_code_challenges.sql",
  "0106_google_actions.sql",
  "0107_password_backups.sql",
  "0108_password_backup_device_binding.sql",
]

export async function openBackupDatabase(existingStandalone = false) {
  const database = await PGlite.create()
  const socket = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 5 })
  try {
    await socket.start()
    const migrations = new URL("../../src/store/migrations/", import.meta.url)
    const available = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()
    const names = existingStandalone ? standaloneMigrations : available
    await database.exec("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)")
    for (const name of names) {
      await database.exec(await readFile(new URL(name, migrations), "utf8"))
      await database.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, 1)", [name])
    }
    const databaseUrl = "postgresql://postgres:postgres@" + socket.getServerConn() + "/postgres"
    const db = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 })
    await db.connect()
    return {
      db, databaseUrl, pendingMigrations: available.filter((name) => !names.includes(name)),
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
