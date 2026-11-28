# Reminder table carve-out migration

The reminder tables (`life_reminder_plans`, `life_reminder_attempts`, and
`life_escalation_states`) move from `app_lifeops` into `app_reminders` once,
idempotently, and without modifying the source tables.

## Story: Copy prior reminder tables once without losing or replaying owner edits

> As an owner, I want my existing reminder plans, delivery attempts, and
> escalation states copied into `app_reminders` once on upgrade, without
> altering the legacy source or replaying deleted rows later.

### Migration copies only into an empty target, records a durable marker, and never alters the source

Each reminder table starts with its observed source presence, target emptiness,
and durable marker state. If the marker is already recorded, migration reports
`AlreadyMigrated` and copies nothing—even after the owner later deletes every
row from the target table. If the source table is absent, migration reports
`SourceMissing` without recording a completion marker. If the target already
holds rows, migration records the marker and reports `TargetNonEmpty` without
overwriting them. Only when no marker exists, the source exists, and the target
is empty does migration copy the rows, verify projection completeness, record
the marker, and report `Copied`. The source table is never altered, and a
recorded marker is never cleared.

```quint
type MigrationOutcome = OutcomeNone | OutcomeCopied | OutcomeSourceMissing | OutcomeTargetNonEmpty | OutcomeAlreadyMigrated
type ReminderTableMigration = {
  sourcePresent: bool,
  targetEmpty: bool,
  markerRecorded: bool,
  sourceRows: int,
  targetRows: int,
  sourceUntouched: bool,
  lastOutcome: MigrationOutcome
}
pure val initial: ReminderTableMigration = {
  sourcePresent: false,
  targetEmpty: true,
  markerRecorded: false,
  sourceRows: 0,
  targetRows: 0,
  sourceUntouched: true,
  lastOutcome: OutcomeNone
}
pure val countValues = Set(0, 1, 3)
pure def canSeedSource(s: ReminderTableMigration, count: int): bool =
  not(s.sourcePresent) and not(s.markerRecorded) and count >= 0
pure def seedSource(s: ReminderTableMigration, count: int): ReminderTableMigration =
  { ...s, sourcePresent: true, sourceRows: count }
pure def canRunMigration(s: ReminderTableMigration): bool = true
pure def runMigration(s: ReminderTableMigration): ReminderTableMigration =
  if (s.markerRecorded) { ...s, lastOutcome: OutcomeAlreadyMigrated }
  else if (not(s.sourcePresent)) { ...s, lastOutcome: OutcomeSourceMissing }
  else if (not(s.targetEmpty)) { ...s, markerRecorded: true, lastOutcome: OutcomeTargetNonEmpty }
  else {
    ...s,
    markerRecorded: true,
    targetRows: s.sourceRows,
    targetEmpty: s.sourceRows == 0,
    lastOutcome: OutcomeCopied
  }
pure def canOwnerWriteTarget(s: ReminderTableMigration, count: int): bool = count > 0
pure def ownerWriteTarget(s: ReminderTableMigration, count: int): ReminderTableMigration =
  { ...s, targetRows: count, targetEmpty: false }
pure def canOwnerClearTarget(s: ReminderTableMigration): bool = not(s.targetEmpty)
pure def ownerClearTarget(s: ReminderTableMigration): ReminderTableMigration =
  { ...s, targetRows: 0, targetEmpty: true }
pure def alwaysSourceNeverAltered(s: ReminderTableMigration): bool =
  s.sourceUntouched and s.sourceRows >= 0 and s.targetRows >= 0 and (s.targetEmpty == (s.targetRows == 0))
pure def alwaysCopiedRecordsMarker(s: ReminderTableMigration): bool =
  (s.lastOutcome == OutcomeCopied implies (s.markerRecorded and s.sourcePresent)) and
  (s.lastOutcome == OutcomeTargetNonEmpty implies s.markerRecorded)
pure def stepMarkerNeverClears(before: ReminderTableMigration, after: ReminderTableMigration): bool =
  before.markerRecorded implies after.markerRecorded
pure def stepRecordedMarkerNeverReCopies(before: ReminderTableMigration, via: str, after: ReminderTableMigration): bool =
  (via == "runMigration" and before.markerRecorded) implies (after.lastOutcome == OutcomeAlreadyMigrated and after.targetRows == before.targetRows)
pure def sometimesCopiedFromLegacy(s: ReminderTableMigration): bool =
  s.lastOutcome == OutcomeCopied and s.targetRows > 0
pure def sometimesAlreadyMigratedAfterClear(s: ReminderTableMigration): bool =
  s.lastOutcome == OutcomeAlreadyMigrated and s.targetEmpty and s.sourceRows > 0
pure def sometimesTargetNonEmptyPreserved(s: ReminderTableMigration): bool =
  s.lastOutcome == OutcomeTargetNonEmpty and s.markerRecorded
```
