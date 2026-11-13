// SQLiteStorageBase.backup: each effect can fail. A concurrent creator wins
// without replacement. Flush only newly-created ancestors plus their existing
// parent, and report success only after every required flush has succeeded.
module BackupPublication {
  const NewDirectories: int
  type State = {phase: str, destination: str, fileSynced: bool, flushed: int,
    reported: bool}
  var s: State
  action init = s' = {phase: "idle", destination: "absent", fileSynced: false,
    flushed: 0, reported: false}
  action Prepare = all {s.phase == "idle", s' = {...s, phase: "snapshot"}}
  action FlushFile = all {s.phase == "snapshot", s' = {...s, phase: "publish", fileSynced: true}}
  action ConcurrentCreate = all {Set("idle", "snapshot", "publish").contains(s.phase),
    s.destination == "absent", s' = {...s, destination: "other"}}
  action Publish = all {s.phase == "publish",
    s' = if (s.destination == "absent") {...s, destination: "ours", phase: "directories"}
      else {...s, phase: "failed"}}
  action FlushDirectory = all {s.phase == "directories", s.flushed < NewDirectories + 1,
    s' = {...s, flushed: s.flushed + 1}}
  action Report = all {s.phase == "directories", s.flushed == NewDirectories + 1,
    s' = {...s, phase: "complete", reported: true}}
  action Fail = all {not(Set("complete", "failed").contains(s.phase)), s' = {...s, phase: "failed"}}
  action Advance = any {Prepare, FlushFile, Publish, FlushDirectory, Report, Fail}
  action nextStep = any {Advance, ConcurrentCreate,
    all {Set("complete", "failed").contains(s.phase), s' = s}}
  action step = any {nextStep, s' = s}
  val TypeOK = and {Set("idle", "snapshot", "publish", "directories", "complete", "failed").contains(s.phase),
    Set("absent", "ours", "other").contains(s.destination), s.flushed >= 0, s.flushed <= NewDirectories + 1}
  val ReportOnlyDurable = s.reported implies
    (s.fileSynced and s.destination == "ours" and s.flushed == NewDirectories + 1 and s.phase == "complete")
  val FailureIsNotSuccess = s.phase == "failed" implies not(s.reported)
  temporal ExistingDestinationPreserved = always((s.destination == "other" implies next(s.destination) == "other").orKeep(s))
  temporal CompletesOrFails = Advance.weakFair(s).implies(
    (not(Set("complete", "failed").contains(s.phase))).leadsTo(Set("complete", "failed").contains(s.phase)))
  temporal DeadlockFree = always(enabled(nextStep))
}
module BackupPublication_existing { import BackupPublication(NewDirectories = 0).* }
module BackupPublication_nested { import BackupPublication(NewDirectories = 2).* }
