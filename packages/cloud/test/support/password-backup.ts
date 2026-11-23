import { readdir, readFile } from "node:fs/promises"
import { Client } from "pg"
import { serveDatabase } from "./database.ts"

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
  const migrations = new URL("../../src/store/migrations/", import.meta.url)
  const available = (await readdir(migrations)).filter((name) => name.endsWith(".sql")).sort()
  const names = existingStandalone ? standaloneMigrations : available
  const served = await serveDatabase(async (database) => {
    await database.exec("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)")
    for (const name of names) {
      await database.exec(await readFile(new URL(name, migrations), "utf8"))
      await database.query("INSERT INTO schema_migrations (name, applied_at) VALUES ($1, 1)", [name])
    }
  })
  const db = new Client({ connectionString: served.url, connectionTimeoutMillis: 5000 })
  try {
    await db.connect()
  } catch (cause) {
    await served.close()
    throw cause
  }
  return {
    db, databaseUrl: served.url, pendingMigrations: available.filter((name) => !names.includes(name)),
    async close() {
      try {
        await db.end()
      } finally {
        await served.close()
      }
    }
  }
}
