// spec/sqlite/backupPublication.md, "Story: Publish a durable SQLite backup without overwriting an existing destination"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Driver } from "../../gen/sqlite__backupPublication.conformance.ts"
import type { BackupState, Event } from "../../gen/sqlite__backupPublication.ts"
import { BackupPublicationSession } from "../../src/index.vibe"

let rootDir: string | undefined
const sessions = new Map<string, BackupPublicationSession>()

function sessionFor(key: string): BackupPublicationSession {
  if (!rootDir) rootDir = mkdtempSync(join(tmpdir(), "sqlite-backup-conformance-"))
  let session = sessions.get(key)
  if (!session) {
    session = new BackupPublicationSession(join(rootDir, key))
    sessions.set(key, session)
  }
  return session
}

export const driver: Driver<BackupState> = {
  reset() {
    sessions.clear()
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true })
      rootDir = undefined
    }
    return Promise.resolve()
  },
  dispatch(key: string, event: Event) {
    const session = sessionFor(key)
    let ok = false
    if (event.type === "prepare") ok = session.prepare(event.newDirs)
    else if (event.type === "flushFile") ok = session.flushFile()
    else if (event.type === "concurrentCreate") ok = session.concurrentCreate()
    else if (event.type === "publish") ok = session.publish()
    else if (event.type === "flushDirectory") ok = session.flushDirectory()
    else if (event.type === "report") ok = session.report()
    else if (event.type === "abortBackup") ok = session.abortBackup()
    return Promise.resolve(ok ? "accepted" : "refused")
  },
  observe(key: string): Promise<BackupState> {
    return Promise.resolve(sessionFor(key).getState())
  },
}

export const options = { keys: ["backup-a", "backup-b"] }
