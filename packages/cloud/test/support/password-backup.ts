import { readFile } from "node:fs/promises"
import { PGlite } from "@electric-sql/pglite"
import { PGLiteSocketServer } from "@electric-sql/pglite-socket"
import { Client } from "pg"

export const webRequest = (url: string, init?: RequestInit) => new Request(url, init)

export async function openBackupDatabase() {
  const database = await PGlite.create()
  const socket = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 5 })
  try {
    await socket.start()
    for (const name of ["0001_foundation", "0101_identity_transport", "0109_password_backups", "0110_password_backup_device_binding"]) {
      await database.exec(await readFile(new URL(`../../src/store/migrations/${name}.sql`, import.meta.url), "utf8"))
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
