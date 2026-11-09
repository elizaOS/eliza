// One app, two published deployments, reversible deactivation and irreversible deletion.
// Only an acknowledged SQL deletion snapshot authorizes removal of its exact objects.
module app_frontend_deletion {
  type State = { app: bool, active: bool, credential: bool, requested: bool,
    rows: Set[int], objects: Set[int], finalize: str, permit: Set[int] }
  var s: State
  action init = s' = { app: true, active: true, credential: true, requested: false,
    rows: Set(0), objects: Set(0), finalize: "idle", permit: Set() }
  action prepare = all { s.app, not(s.requested),
    s' = { ...s, active: false, credential: false, requested: true } }
  // Existing same-owner update permits reactivation; deactivation is not deletion authority.
  action reactivate = all { s.app, s' = { ...s, active: true } }
  action publishSecond = all { s.app, not(s.rows.contains(1)),
    s' = { ...s, rows: s.rows.union(Set(1)), objects: s.objects.union(Set(1)) } }
  action beginFinalize = all { s.requested, s.finalize == "idle",
    s' = { ...s, finalize: "pending" } }
  // 0 = rollback; 1 = commit acknowledged; 2 = commit with lost acknowledgement.
  action finishFinalize(mode) = all { s.finalize == "pending",
    val applies = mode != 0 and s.app and not(s.active) and not(s.credential)
    s' = { ...s, app: if (applies) false else s.app,
      active: if (applies) false else s.active,
      rows: if (applies) Set() else s.rows,
      permit: if (applies and mode == 1) s.rows else Set(), finalize: "done" } }
  action cleanup = all { s.permit != Set(),
    s' = { ...s, objects: s.objects.exclude(s.permit), permit: Set() } }
  action finish = { nondet mode = 0.to(2).oneOf() finishFinalize(mode) }
  action step = any { prepare, reactivate, publishSecond, beginFinalize, finish, cleanup, s' = s }
  val safety = all {
    s.rows.subseteq(s.objects),
    s.permit != Set() implies (not(s.app) and s.rows == Set()),
    s.active implies s.app,
  }
  temporal FinalizationSettles = finish.weakFair(s) implies
    always(s.finalize == "pending" implies eventually(s.finalize == "done"))
  temporal AcknowledgedCleanupSettles = cleanup.weakFair(s) implies
    always(s.permit != Set() implies eventually(s.permit == Set()))

  run successTest = init.then(prepare).then(beginFinalize).then(finishFinalize(1))
    .then(cleanup).expect(safety and not(s.app) and s.objects == Set())
  run rejectedDeleteRemainsRestorableTest = init.then(prepare).then(beginFinalize)
    .then(finishFinalize(0)).then(reactivate).expect(safety and s.active and s.objects == Set(0))
  run concurrentReactivationRejectsDeleteTest = init.then(prepare).then(beginFinalize)
    .then(reactivate).then(finishFinalize(1)).expect(safety and s.app and s.rows == Set(0))
  run lostCommitReplyRetainsObjectsTest = init.then(prepare).then(beginFinalize)
    .then(finishFinalize(2)).expect(safety and not(s.app) and s.objects == Set(0))
  run latePublicationIsInSnapshotTest = init.then(prepare).then(beginFinalize)
    .then(publishSecond).then(finishFinalize(1)).expect(safety and s.permit == Set(0, 1))
  run allSnapshotObjectsAreRemovedTest = init.then(publishSecond).then(prepare)
    .then(beginFinalize).then(finishFinalize(1)).then(cleanup)
    .expect(safety and s.objects == Set())
  action oldCleanupBeforeFinalDelete = all { s.requested,
    s' = { ...s, objects: Set() } }
  run oldRestorableContentLossWitnessTest = init.then(prepare)
    .then(oldCleanupBeforeFinalDelete).then(beginFinalize).then(finishFinalize(0))
    .then(reactivate).expect(not(safety) and s.app and s.active)
  run oldConcurrentReactivationWitnessTest = init.then(prepare).then(reactivate)
    .then(oldCleanupBeforeFinalDelete).then(beginFinalize).then(finishFinalize(1))
    .expect(not(safety) and s.app and s.active)
}

// Three one-shot operations and two deployment rows; the parent serializes them.
// The second activation reverses the row order to represent a changed active row.
module app_frontend_deletion_locks {
  pure val actors = Set("deletion", "first", "second")
  type State = { app: bool, parent: str, rowA: str, rowB: str, pc: str -> int }
  var s: State
  action init = s' = { app: true, parent: "free", rowA: "free", rowB: "free",
    pc: Map("deletion" -> 0, "first" -> 0, "second" -> 0) }
  action acquireParent(actor) = all { actors.contains(actor), s.pc.get(actor) == 0,
    s.parent == "free",
    s' = if (s.app) { ...s, parent: actor, pc: s.pc.set(actor, 1) }
      else { ...s, pc: s.pc.set(actor, 4) } }
  action acquireFirstRow(actor) = all { s.parent == actor, s.pc.get(actor) == 1,
    if (actor == "second") s.rowB == "free" else s.rowA == "free",
    s' = { ...s, rowA: if (actor == "second") s.rowA else actor,
      rowB: if (actor == "second") actor else s.rowB, pc: s.pc.set(actor, 2) } }
  action acquireSecondRow(actor) = all { s.parent == actor, s.pc.get(actor) == 2,
    if (actor == "second") s.rowA == "free" else s.rowB == "free",
    s' = { ...s, rowA: actor, rowB: actor, pc: s.pc.set(actor, 3) } }
  action commit(actor) = all { s.parent == actor, s.pc.get(actor) == 3,
    s' = { ...s, app: s.app and actor != "deletion", parent: "free",
      rowA: "free", rowB: "free", pc: s.pc.set(actor, 4) } }
  action abort(actor) = all { s.parent == actor,
    s' = { ...s, parent: "free", rowA: "free", rowB: "free", pc: s.pc.set(actor, 4) } }
  action step = { nondet actor = actors.oneOf()
    any { acquireParent(actor), acquireFirstRow(actor), acquireSecondRow(actor),
      commit(actor), abort(actor), s' = s } }
  val safety = all {
    s.rowA != "free" implies s.parent == s.rowA,
    s.rowB != "free" implies s.parent == s.rowB,
    (s.rowA != "free" and s.rowB != "free") implies s.rowA == s.rowB,
  }
  run activationThenDeletionTest = init.then(acquireParent("first"))
    .then(acquireFirstRow("first")).then(acquireSecondRow("first")).then(commit("first"))
    .then(acquireParent("deletion")).then(acquireFirstRow("deletion"))
    .then(acquireSecondRow("deletion")).then(commit("deletion"))
    .then(acquireParent("second")).expect(safety and not(s.app) and s.pc.get("second") == 4)
  run changedActiveOrderingTest = init.then(acquireParent("first"))
    .then(acquireFirstRow("first")).then(acquireSecondRow("first")).then(commit("first"))
    .then(acquireParent("second")).then(acquireFirstRow("second"))
    .then(acquireSecondRow("second")).then(commit("second")).expect(safety)
  run abortedDeletionPreservesAppTest = init.then(acquireParent("deletion"))
    .then(acquireFirstRow("deletion")).then(abort("deletion"))
    .then(acquireParent("second")).then(acquireFirstRow("second"))
    .then(acquireSecondRow("second")).then(commit("second")).expect(safety and s.app)
  action oldDeletionLocksFirst = all { s.rowA == "free", s.pc.get("deletion") == 0,
    s' = { ...s, rowA: "deletion", pc: s.pc.set("deletion", 2) } }
  action oldSecondLocksFirst = all { s.rowB == "free", s.pc.get("second") == 0,
    s' = { ...s, rowB: "second", pc: s.pc.set("second", 2) } }
  run oldUnorderedSnapshotDeadlockWitnessTest = init.then(oldDeletionLocksFirst)
    .then(oldSecondLocksFirst).expect(not(safety) and s.rowA != s.rowB
      and s.pc.get("deletion") == 2 and s.pc.get("second") == 2)
}
