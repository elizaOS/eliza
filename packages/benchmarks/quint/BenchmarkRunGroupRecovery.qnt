// SQLite recovery at standalone startup, cohort startup and recover-stale-runs.
// Resume admission and retirement are separate durable operations in cohort.py.
module BenchmarkRunGroupRecovery {
  pure val Groups = Set("plain", "subscription", "finished")
  pure val Rows = Set("plain-old", "plain-fresh", "sub-running", "sub-failed", "sub-succeeded", "finished-zombie")
  pure val SubscriptionRows = Set("sub-running", "sub-failed", "sub-succeeded")
  pure val Retirable = Set("running", "failed", "succeeded")
  pure val GroupFor = Map(
    "plain-old" -> "plain", "plain-fresh" -> "plain",
    "sub-running" -> "subscription", "sub-failed" -> "subscription",
    "sub-succeeded" -> "subscription", "finished-zombie" -> "finished"
  )
  type Row = { status: str, old: bool, ended: str }
  pure val StaleRunning = { status: "running", old: true, ended: "none" }
  var s: {
    groups: str -> str, rows: str -> Row, phase: str, includeSubscription: bool,
    recovered: Set[str], outcome: str, dispatched: bool
  }

  action init = s' = {
    groups: Map("plain" -> "running", "subscription" -> "running", "finished" -> "succeeded"),
    rows: Map(
      "plain-old" -> StaleRunning,
      "plain-fresh" -> { ...StaleRunning, old: false },
      "sub-running" -> StaleRunning,
      "sub-failed" -> { status: "failed", old: true, ended: "original" },
      "sub-succeeded" -> { status: "succeeded", old: true, ended: "original" },
      "finished-zombie" -> StaleRunning
    ),
    phase: "idle", includeSubscription: false, recovered: Set(),
    outcome: "none", dispatched: false
  }

  val eligible = Rows.filter(row => {
    val group = GroupFor.get(row)
    val entry = s.rows.get(row)
    not(s.groups.get(group).in(Set("failed", "succeeded"))) and entry.status == "running"
      and entry.old and (group != "subscription" or s.includeSubscription)
  })
  def hasRunning(rows: str -> Row, group: str): bool = Rows.exists(row =>
    GroupFor.get(row) == group and rows.get(row).status == "running")

  action ageFreshRow = all {
    s.phase == "idle", not(s.rows.get("plain-fresh").old),
    s' = s.with("rows", s.rows.set("plain-fresh", { ...s.rows.get("plain-fresh"), old: true }))
  }
  action requestSweep(includeSubscription: bool): bool = all {
    s.phase == "idle",
    s' = { ...s, phase: "sweep", includeSubscription: includeSubscription,
      recovered: Set(), outcome: "pending" }
  }
  // A successful sweep is the committed row/group write and returned IDs.
  action commitSweep = all {
    s.phase == "sweep",
    {
      val rows = Rows.mapBy(row => {
        val entry = s.rows.get(row)
        if (not(eligible.contains(row))) entry
        else { ...entry, ended: "sweep", status:
          if (GroupFor.get(row) == "subscription") "paused_unknown" else "failed" }
      })
      val groups = Groups.mapBy(group => {
        val touched = eligible.exists(row => GroupFor.get(row) == group)
        if (touched and group == "subscription") "paused_unknown"
        else if (touched and not(hasRunning(rows, group))) "failed"
        else s.groups.get(group)
      })
      s' = { ...s, groups: groups, rows: rows, phase: "idle", recovered: eligible, outcome: "swept" }
    }
  }
  // A failed operation here has no durable commit. In resume, the preceding
  // successful admission stays durable even if retirement has to be retried.
  action failBeforeCommit = all {
    s.phase.in(Set("sweep", "retire")),
    s' = { ...s, phase: "idle", outcome: "error" }
  }
  action admitResume(exact: bool): bool = all {
    s.phase == "idle", not(s.dispatched),
    s' = if (exact)
      { ...s, groups: s.groups.set("subscription", "running"), phase: "retire", outcome: "pending" }
      else { ...s, outcome: "refused" }
  }
  action retirePreviousAttempt = all {
    s.phase == "retire",
    {
      val rows = Rows.mapBy(row => {
        val entry = s.rows.get(row)
        if (SubscriptionRows.contains(row) and Retirable.contains(entry.status))
          { ...entry, status: "paused_unknown", ended: if (entry.ended == "none") "retired" else entry.ended }
        else entry
      })
      s' = { ...s, rows: rows, phase: "ready", outcome: "retired" }
    }
  }
  action dispatch = all {
    s.phase == "ready",
    s' = { ...s, phase: "idle", dispatched: true, outcome: "dispatched" }
  }
  action settle = any { commitSweep, retirePreviousAttempt, failBeforeCommit, dispatch }
  action idle = s' = s
  action step = any {
    ageFreshRow, requestSweep(true), requestSweep(false), admitResume(true), admitResume(false), settle, idle
  }

  val FinishedGroupUnchanged = s.groups.get("finished") == "succeeded"
    and s.rows.get("finished-zombie") == StaleRunning
  val PlainFailureWaitsForRows = s.groups.get("plain") == "failed" implies not(hasRunning(s.rows, "plain"))
  val ResumeDispatchNeedsRetirement = s.dispatched implies SubscriptionRows.forall(row =>
    s.rows.get(row).status == "paused_unknown")
  temporal SweepTouchesOnlyEligibleRows = always((
    (s.phase == "sweep" and next(s.outcome) == "swept") implies
      (next(s.recovered) == eligible and Rows.forall(row =>
        (next(s.rows.get(row)) != s.rows.get(row)) == eligible.contains(row)))
  ).orKeep(s))
  temporal RetirementKeepsExistingEndTimes = always((
    (s.phase == "retire" and next(s.phase) == "ready") implies Rows.forall(row => {
      val entry = s.rows.get(row)
      if (not(SubscriptionRows.contains(row))) next(s.rows.get(row)) == entry
      else entry.ended != "none" implies next(s.rows.get(row).ended) == entry.ended
    })
  ).orKeep(s))
  val pending = s.phase != "idle"
  temporal Settles = pending.leadsTo(s.phase == "idle")
  temporal FairSettlement = settle.weakFair(s).implies(Settles)

  run plainSweepLeavesFreshAndSubscriptionRowsTest = init.then(requestSweep(false)).then(commitSweep)
    .expect(s.recovered == Set("plain-old") and s.groups.get("plain") == "running"
      and s.rows.get("plain-fresh").status == "running" and s.rows.get("sub-running") == StaleRunning)
    .then(ageFreshRow).then(requestSweep(false)).then(commitSweep)
    .expect(s.recovered == Set("plain-fresh") and s.groups.get("plain") == "failed" and PlainFailureWaitsForRows)
  run fullSweepPausesSubscriptionAndPreservesFinishedGroupTest = init.then(requestSweep(true)).then(commitSweep)
    .expect(s.recovered == Set("plain-old", "sub-running") and s.groups.get("subscription") == "paused_unknown"
      and s.rows.get("sub-running").status == "paused_unknown" and FinishedGroupUnchanged)
  run resumeRetiresAllPriorRowsBeforeDispatchTest = init.then(admitResume(true)).then(retirePreviousAttempt)
    .expect(s.rows.get("sub-running").ended == "retired" and s.rows.get("sub-failed").ended == "original"
      and s.rows.get("sub-succeeded").ended == "original" and s.rows.get("plain-old") == StaleRunning)
    .then(dispatch).expect(s.dispatched and ResumeDispatchNeedsRetirement)
  run resumeRejectionAndRetirementFailureCanRetryTest = init.then(requestSweep(true)).then(commitSweep)
    .then(admitResume(false)).expect(s.outcome == "refused" and s.groups.get("subscription") == "paused_unknown")
    .then(admitResume(true)).then(failBeforeCommit).expect(s.outcome == "error" and not(s.dispatched)
      and s.groups.get("subscription") == "running" and s.rows.get("sub-failed").status == "failed")
    .then(admitResume(true)).then(retirePreviousAttempt).then(dispatch)
    .expect(ResumeDispatchNeedsRetirement and s.dispatched and s.rows.get("sub-running").ended == "sweep")
  run abortedSweepCanRetryTest = init.then(requestSweep(true)).then(failBeforeCommit)
    .expect(s.recovered == Set() and s.rows.get("sub-running") == StaleRunning and FinishedGroupUnchanged)
    .then(requestSweep(true)).then(commitSweep).expect(s.recovered.contains("sub-running"))
}
