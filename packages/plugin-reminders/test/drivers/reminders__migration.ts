// spec/reminders/migration.md, "Story: Copy prior reminder tables once without losing or replaying owner edits"
import type { Driver, Options } from "../../gen/reminders__migration.conformance.ts"
import type { MigrationOutcome, ReminderTableMigration } from "../../gen/reminders__migration.ts"
import { openSqliteRemindersStore, type SqliteCarveOutHandle } from "@elizaos/plugin-reminders"

interface Session {
  readonly store: SqliteCarveOutHandle
  sourcePresent: boolean
  initialSourceRows: number
  lastOutcome: MigrationOutcome
}

const sessions = new Map<string, Session>()

function mapOutcome(outcome: string): MigrationOutcome {
  if (outcome === "copied") return "OutcomeCopied"
  if (outcome === "target-non-empty") return "OutcomeTargetNonEmpty"
  if (outcome === "already-migrated") return "OutcomeAlreadyMigrated"
  if (outcome === "source-missing") return "OutcomeSourceMissing"
  return "OutcomeNone"
}

function sessionOf(key: string): Session {
  const existing = sessions.get(key)
  if (existing !== undefined) return existing
  const created: Session = {
    store: openSqliteRemindersStore(":memory:"),
    sourcePresent: false,
    initialSourceRows: 0,
    lastOutcome: "OutcomeNone",
  }
  sessions.set(key, created)
  return created
}

function countTable(session: Session, table: string): number {
  const row = session.store.db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as
    | { count?: number }
    | undefined
  return Number(row?.count ?? 0)
}

function hasMarker(session: Session): boolean {
  const row = session.store.db
    .prepare("SELECT 1 AS done FROM reminders_migration_state WHERE table_name = 'life_reminder_plans'")
    .get() as { done?: number } | undefined
  return row?.done === 1
}

export const driver: Driver<ReminderTableMigration> = {
  reset() {
    for (const session of sessions.values()) {
      session.store.close()
    }
    sessions.clear()
  },
  dispatch(key, event) {
    const session = sessionOf(key)
    switch (event.type) {
      case "seedSource": {
        if (session.sourcePresent || hasMarker(session) || event.count < 0) return "refused"
        session.store.db.exec(`
          CREATE TABLE legacy_life_reminder_plans (
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
            steps_json TEXT NOT NULL, mute_policy_json TEXT NOT NULL, quiet_hours_json TEXT NOT NULL,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          )
        `)
        const insert = session.store.db.prepare(
          "INSERT INTO legacy_life_reminder_plans VALUES (?, 'a', 'owner', 'o', '[]', '{}', '{}', '2026-01-01', '2026-01-01')",
        )
        for (let i = 0; i < event.count; i += 1) {
          insert.run(`src-${i}`)
        }
        session.sourcePresent = true
        session.initialSourceRows = event.count
        return "accepted"
      }
      case "runMigration": {
        const res = session.store.migrateTable("life_reminder_plans")
        session.lastOutcome = mapOutcome(res.outcome)
        return "accepted"
      }
      case "ownerWriteTarget": {
        if (event.count <= 0) return "refused"
        session.store.db.exec("DELETE FROM life_reminder_plans")
        const insert = session.store.db.prepare(
          "INSERT INTO life_reminder_plans VALUES (?, 'a', 'owner', 'o', '[]', '{}', '{}', '2026-01-02', '2026-01-02')",
        )
        for (let i = 0; i < event.count; i += 1) {
          insert.run(`owner-${i}`)
        }
        return "accepted"
      }
      case "ownerClearTarget": {
        if (countTable(session, "life_reminder_plans") === 0) return "refused"
        session.store.db.exec("DELETE FROM life_reminder_plans")
        return "accepted"
      }
      default: {
        const unreachable: never = event
        return unreachable
      }
    }
  },
  observe(key): ReminderTableMigration {
    const session = sessionOf(key)
    const targetRows = countTable(session, "life_reminder_plans")
    const sourceRows = session.sourcePresent ? countTable(session, "legacy_life_reminder_plans") : 0
    return {
      sourcePresent: session.sourcePresent,
      targetEmpty: targetRows === 0,
      markerRecorded: hasMarker(session),
      sourceRows,
      targetRows,
      sourceUntouched: sourceRows === session.initialSourceRows,
      lastOutcome: session.lastOutcome,
    }
  },
}

export const options: Options<ReminderTableMigration> = { keys: ["reminders"] }
