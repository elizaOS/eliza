// Source: the PGlite socket patch and its real-wire conformance suite.
// One backend serves two client lifetimes. Protocol-cycle ownership is distinct
// from explicit transaction ownership: Bind need not set isInTransaction().
// Describe/Execute require that client's portal until its own Sync. A Sync in
// an explicit transaction releases only the cycle, not the transaction owner.
module pglite_protocol_ownership {
  type State = {
    live: int -> bool,
    phase: int -> str,
    cycleOwner: int,
    transactionOwner: int,
    portalOwner: int,
    active: int,
    frame: str,
    processing: bool,
    recovering: int,
    recovery: str,
    terminal: bool,
    stopping: bool,
    stopped: bool,
    sqlErrorUsed: bool,
    cycleFailed: bool,
    closeUsed: bool,
    provisional: bool,
    committed: bool,
    commitAdmitted: bool,
    orphaned: bool
  }
  var s: State
  pure val clients = Set(0, 1)
  pure val extended = Set("parse", "bind", "describe", "execute", "sync")
  pure val requests = extended.union(Set("begin", "query", "commit", "rollback"))

  action initialize(simplePeer: bool, explicitTransaction: bool): bool = s' = {
    live: Map(0 -> true, 1 -> true),
    phase: Map(0 -> (if (explicitTransaction) "begin" else "parse"),
      1 -> (if (simplePeer) "query" else "parse")),
    cycleOwner: -1, transactionOwner: -1, portalOwner: -1,
    active: -1, frame: "none", processing: false,
    recovering: -1, recovery: "none", terminal: false, stopping: false, stopped: false,
    sqlErrorUsed: false, cycleFailed: false, closeUsed: false,
    provisional: false, committed: false, commitAdmitted: false,
    orphaned: false
  }
  action init = any {
    initialize(true, false), initialize(false, false),
    initialize(true, true), initialize(false, true)
  }

  // Acquisition precedes the backend await. A close during the first BEGIN or
  // Parse must therefore observe the in-flight owner, even before completion.
  action dispatch(client: int): bool = all {
    s.live.get(client), not(s.terminal), not(s.processing),
    s.active == -1, s.recovering == -1,
    s.cycleOwner == -1 or s.cycleOwner == client,
    s.transactionOwner == -1 or s.transactionOwner == client,
    requests.contains(s.phase.get(client)),
    val frame = s.phase.get(client)
    s' = { ...s, active: client, frame: frame, processing: true,
      cycleOwner: if (extended.contains(frame)) client else s.cycleOwner,
      commitAdmitted: s.commitAdmitted or (client == 0 and
        (frame == "commit" or (frame == "sync" and s.transactionOwner == -1))) }
  }

  action completeFrame = all {
    s.active != -1, s.processing, not(s.terminal),
    val client = s.active
    val frame = s.frame
    val nextPhase = if (frame == "sync") {
      if (s.transactionOwner == client) "commit" else "done"
    } else Map("begin" -> "parse", "parse" -> "bind", "bind" -> "describe",
      "describe" -> "execute", "execute" -> "sync", "query" -> "done",
      "commit" -> "done", "rollback" -> "done").get(frame)
    val commits = client == 0 and
      (frame == "commit" or (frame == "sync" and s.transactionOwner == -1))
    s' = { ...s, active: -1, frame: "none", processing: false,
      phase: s.phase.set(client, if (s.live.get(client)) nextPhase else "closed"),
      cycleOwner: if (frame == "sync") -1 else s.cycleOwner,
      transactionOwner: if (frame == "begin") client
        else if (Set("commit", "rollback").contains(frame)) -1 else s.transactionOwner,
      portalOwner: if (frame == "bind") client
        else if (Set("commit", "rollback").contains(frame) or
          (frame == "sync" and s.transactionOwner == -1)) -1 else s.portalOwner,
      cycleFailed: s.cycleFailed and frame != "sync",
      provisional: if (commits or frame == "rollback") false
        else s.provisional or (client == 0 and frame == "execute"),
      committed: s.committed or (commits and s.provisional),
      orphaned: s.orphaned or (client == 0 and frame == "execute" and
        not(s.live.get(client)) and not(s.commitAdmitted)) }
  }

  action requestRollback(client: int): bool = all {
    s.live.get(client), s.phase.get(client) == "commit", not(s.processing),
    s.active == -1, s.recovering == -1, not(s.terminal),
    s' = { ...s, phase: s.phase.set(client, "rollback") }
  }

  // PostgreSQL ErrorResponse is protocol data. It does not release the cycle:
  // the failing client must Sync, or disconnect and complete owned recovery.
  action sqlError = all {
    s.active != -1, s.processing, not(s.terminal), not(s.sqlErrorUsed),
    Set("parse", "bind", "describe", "execute").contains(s.frame),
    val client = s.active
    s' = { ...s, active: -1, frame: "none", processing: false,
      phase: s.phase.set(client, if (s.live.get(client)) "sync" else "closed"),
      sqlErrorUsed: true, cycleFailed: true }
  }

  // Until Sync, PostgreSQL can ignore the failed owner's simple Query too.
  // That ignored frame is not an acknowledgement that the backend is reusable.
  action ignoredOwnerQuery(client: int): bool = all {
    s.live.get(client), s.cycleOwner == client, s.cycleFailed,
    s.active == -1, s.recovering == -1, not(s.terminal), s' = s
  }

  // A transport/backend exception may leave the BEGIN or Bind effect unknown.
  // Conservatively retain its possible owner behind the failed-closed queue.
  // If commit was already admitted, its outcome can also be committed; closing
  // a socket does not undo a commit that the client has already requested.
  action rawException = all {
    s.active != -1, s.processing, not(s.terminal), not(s.closeUsed),
    val client = s.active
    val pendingWrite = s.provisional or (client == 0 and s.frame == "execute")
    val mayCommit = client == 0 and s.commitAdmitted and
      Set("sync", "commit").contains(s.frame)
    s' = { ...s, active: -1, frame: "none", processing: false,
      live: s.live.set(client, false),
      phase: clients.mapBy(other => if (other == client or not(s.live.get(other)))
        "closed" else "rejected"),
      closeUsed: true, terminal: true, recovering: -1, recovery: "failed",
      transactionOwner: if (s.frame == "begin") client else s.transactionOwner,
      portalOwner: if (s.frame == "bind") client else s.portalOwner,
      provisional: pendingWrite and not(mayCommit),
      committed: s.committed or (mayCommit and pendingWrite),
      orphaned: s.orphaned or (client == 0 and pendingWrite and not(s.commitAdmitted)) }
  }

  action disconnect(client: int): bool = all {
    s.live.get(client), not(s.closeUsed), not(s.terminal),
    val ownsBackend = s.active == client or s.cycleOwner == client or
      s.transactionOwner == client
    s' = { ...s, live: s.live.set(client, false),
      phase: s.phase.set(client, "closed"), closeUsed: true,
      recovering: if (ownsBackend) client else s.recovering,
      recovery: if (ownsBackend) "preRollback" else s.recovery,
      orphaned: s.orphaned or
        (client == 0 and s.provisional and not(s.commitAdmitted)) }
  }
  // A late socket-data callback cannot reactivate or enqueue a closed client.
  action lateEnqueue(client: int): bool = all { not(s.live.get(client)), s' = s }

  // An initial ROLLBACK prevents Sync from committing orphaned successful DML.
  // A prior SQL error may make the backend ignore it until Sync; in that case
  // Sync aborts an implicit transaction, or a later ROLLBACK ends explicit T/E.
  action acknowledgePreRollback = all {
    s.recovering != -1, s.active == -1, not(s.terminal),
    s.recovery == "preRollback",
    s' = { ...s, recovery: "sync",
      transactionOwner: if (s.cycleFailed) s.transactionOwner else -1,
      portalOwner: if (s.cycleFailed) s.portalOwner else -1,
      provisional: s.provisional and s.cycleFailed }
  }
  action acknowledgeRecoverySync = all {
    s.recovering != -1, s.active == -1, not(s.terminal),
    s.recovery == "sync",
    s' = { ...s, cycleOwner: -1, cycleFailed: false,
      recovery: if (s.transactionOwner == -1) "release" else "postRollback",
      portalOwner: if (s.transactionOwner == -1) -1 else s.portalOwner,
      provisional: s.provisional and s.transactionOwner != -1 }
  }
  action acknowledgePostRollback = all {
    s.recovering != -1, s.active == -1, not(s.terminal),
    s.recovery == "postRollback",
    s' = { ...s, transactionOwner: -1, portalOwner: -1,
      provisional: false, recovery: "release" }
  }
  action releaseRecovery = all {
    s.recovering != -1, s.active == -1, not(s.terminal),
    s.recovery == "release", s.cycleOwner == -1,
    s.transactionOwner == -1, s.portalOwner == -1,
    s' = { ...s, recovering: -1, recovery: "none" }
  }
  action failRecovery = all {
    s.recovering != -1, s.active == -1, not(s.terminal),
    Set("preRollback", "sync", "postRollback").contains(s.recovery),
    s' = { ...s, terminal: true, recovering: -1, recovery: "failed", processing: false,
      phase: clients.mapBy(client => if (s.live.get(client)) "rejected" else "closed") }
  }
  action recoveryAttempt = any {
    acknowledgePreRollback, acknowledgeRecoverySync, acknowledgePostRollback, failRecovery
  }
  // A disconnected handler remains owned by server.stop until its detach task
  // settles. Shutdown can close the peer too, but cannot publish early success.
  action beginShutdown = all {
    not(s.stopping), not(s.stopped), s.recovering != -1 or s.terminal,
    s' = { ...s, stopping: true,
      live: clients.mapBy(_ => false), phase: clients.mapBy(_ => "closed") }
  }
  action finishShutdown = all {
    s.stopping, s.active == -1, not(s.processing),
    s.recovering == -1 or s.terminal,
    s' = { ...s, stopping: false, stopped: true }
  }
  action idle = s' = s
  action step = {
    nondet client = clients.oneOf()
    any { dispatch(client), completeFrame, requestRollback(client), sqlError, rawException,
      disconnect(client), lateEnqueue(client), ignoredOwnerQuery(client),
      recoveryAttempt, releaseRecovery, beginShutdown, finishShutdown, idle }
  }

  val OwnerBounds = Set(-1, 0, 1).contains(s.cycleOwner) and
    Set(-1, 0, 1).contains(s.transactionOwner) and
    Set(-1, 0, 1).contains(s.portalOwner) and
    Set(-1, 0, 1).contains(s.active) and Set(-1, 0, 1).contains(s.recovering)
  val OneBackendOwner = s.cycleOwner == -1 or s.transactionOwner == -1 or
    s.cycleOwner == s.transactionOwner
  val NoForeignFrame = s.active == -1 or all {
    s.cycleOwner == -1 or s.cycleOwner == s.active,
    s.transactionOwner == -1 or s.transactionOwner == s.active,
    s.recovering == -1 or s.recovering == s.active
  }
  val ProcessingIsOwned = s.processing == (s.active != -1)
  val PortalIsOwned = s.portalOwner == -1 or s.portalOwner == s.cycleOwner or
    s.portalOwner == s.transactionOwner or s.portalOwner == s.recovering
  val BoundPortalSurvives = clients.forall(client =>
    (s.live.get(client) and not(s.terminal) and not(s.cycleFailed) and
      Set("describe", "execute", "sync").contains(s.phase.get(client)))
      .implies(s.portalOwner == client))
  val ClosedOwnerIsRecovering = clients.forall(client =>
    (not(s.live.get(client)) and
      (s.cycleOwner == client or s.transactionOwner == client or s.active == client))
      .implies(s.recovering == client or s.terminal))
  val CyclePhasesStayOwned = clients.forall(client =>
    (s.live.get(client) and not(s.terminal) and
      Set("bind", "describe", "execute", "sync").contains(s.phase.get(client)))
      .implies(s.cycleOwner == client))
  val ClosedClientsStayClosed = clients.forall(client =>
    not(s.live.get(client)).implies(s.phase.get(client) == "closed"))
  val FailedQueueRunsNothing = s.terminal.implies(s.active == -1 and not(s.processing))
  val ShutdownKeepsClientsClosed = (s.stopping or s.stopped).implies(
    clients.forall(client => not(s.live.get(client)) and s.phase.get(client) == "closed"))
  val StoppedHasNoRecovery = s.stopped.implies(s.active == -1 and not(s.processing) and
    (s.recovering == -1 or s.terminal))
  val OrphanWriteNeverCommits = s.orphaned.implies(not(s.committed))
  val Safety = OwnerBounds and OneBackendOwner and NoForeignFrame and
    ProcessingIsOwned and PortalIsOwned and BoundPortalSurvives and CyclePhasesStayOwned and
    ClosedOwnerIsRecovering and ClosedClientsStayClosed and
    FailedQueueRunsNothing and ShutdownKeepsClientsClosed and StoppedHasNoRecovery and
    OrphanWriteNeverCommits

  temporal FairCleanup = completeFrame.weakFair(s) and recoveryAttempt.weakFair(s) and
    releaseRecovery.weakFair(s)
  temporal CleanupSettles = FairCleanup.implies(
    (s.recovering != -1).leadsTo(s.recovering == -1 or s.terminal))
  temporal CleanupWithoutFairness =
    (s.recovering != -1).leadsTo(s.recovering == -1 or s.terminal)
  temporal ShutdownSettles = (FairCleanup and finishShutdown.weakFair(s)).implies(
    s.stopping.leadsTo(s.stopped))

  // Negative witnesses retain the earlier bug and two unsafe repair choices.
  action legacyForeignQuery = all {
    s.cycleOwner == 0, s.transactionOwner == -1, s.active == -1,
    s.phase.get(1) == "query",
    s' = { ...s, portalOwner: -1, phase: s.phase.set(1, "done") }
  }
  action legacyUnacknowledgedRelease = all {
    s.recovering != -1, s.recovery == "preRollback", s.active == -1,
    s' = { ...s, recovering: -1, recovery: "none" }
  }
  action legacyCleanupCommits = all {
    s.recovering == 0, s.recovery == "preRollback", s.provisional,
    s' = { ...s, committed: true }
  }
  action legacyEarlyShutdown = all {
    s.stopping, s.recovering != -1,
    s' = { ...s, stopping: false, stopped: true }
  }
  run crossClientSyncDropsPortalTest = initialize(true, false)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(completeFrame)
    .then(legacyForeignQuery).expect(not(Safety))
  run syncKeepsExplicitTransactionTest = initialize(true, true)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(completeFrame)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(completeFrame)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(completeFrame)
    .expect(Safety and s.cycleOwner == -1 and s.transactionOwner == 0)
    .then(dispatch(0)).then(completeFrame).then(dispatch(1)).then(completeFrame)
    .expect(Safety and s.transactionOwner == -1 and s.phase.get(1) == "done")
  run disconnectDuringBeginTest = initialize(true, true)
    .then(dispatch(0)).then(disconnect(0)).then(completeFrame)
    .expect(Safety and s.transactionOwner == 0 and s.recovering == 0)
    .then(acknowledgePreRollback).then(acknowledgeRecoverySync).then(releaseRecovery)
    .then(lateEnqueue(0)).then(dispatch(1)).then(completeFrame).expect(Safety)
  run failedExplicitTransactionCleanupTest = initialize(true, true)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(sqlError)
    .then(disconnect(0)).then(acknowledgePreRollback).then(acknowledgeRecoverySync)
    .expect(Safety and s.recovery == "postRollback" and s.transactionOwner == 0)
    .then(acknowledgePostRollback).then(releaseRecovery).expect(Safety)
  run releaseBeforeResetIsUnsafeTest = initialize(true, false)
    .then(dispatch(0)).then(completeFrame).then(disconnect(0))
    .then(legacyUnacknowledgedRelease).expect(not(Safety))
  run syncFirstWouldCommitOrphanTest = initialize(true, false)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(completeFrame)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(completeFrame)
    .then(disconnect(0)).then(legacyCleanupCommits).expect(not(Safety))
  run rawExceptionResetsProcessingTest = initialize(true, false)
    .then(dispatch(0)).then(rawException)
    .expect(Safety and not(s.processing) and s.terminal)
    .then(lateEnqueue(0)).expect(Safety and s.terminal)
  run ignoredQueryDoesNotReleaseFailedCycleTest = initialize(true, false)
    .then(dispatch(0)).then(sqlError).then(ignoredOwnerQuery(0))
    .expect(Safety and s.cycleOwner == 0 and s.phase.get(1) == "query")
  run failedTransactionSyncRetainsOwnerTest = initialize(true, true)
    .then(dispatch(0)).then(completeFrame).then(dispatch(0)).then(sqlError)
    .then(dispatch(0)).then(completeFrame)
    .expect(Safety and s.cycleOwner == -1 and s.transactionOwner == 0)
    .then(requestRollback(0)).then(dispatch(0)).then(completeFrame)
    .then(dispatch(1)).then(completeFrame).expect(Safety)
  run shutdownWaitsForDisconnectedRecoveryTest = initialize(true, false)
    .then(dispatch(0)).then(completeFrame).then(disconnect(0)).then(beginShutdown)
    .then(acknowledgePreRollback).then(acknowledgeRecoverySync).then(releaseRecovery)
    .then(finishShutdown).expect(Safety and s.stopped)
  run earlyCloseEventLosesShutdownOwnershipTest = initialize(true, false)
    .then(dispatch(0)).then(completeFrame).then(disconnect(0)).then(beginShutdown)
    .then(legacyEarlyShutdown).expect(not(Safety))
}
