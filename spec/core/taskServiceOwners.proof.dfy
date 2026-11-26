lemma quarantineCompleted_ensures(s: TaskServiceOwners, task: string, success: bool)
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysExecutionsHavePendingOwner(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysActiveTickOwned(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysStoppedHasNoTimer(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysStopReturnsAfterOperations(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysStopKeepsAdmissionClosed(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysStopSnapshotHoldsPendingOperations(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> alwaysQuarantinedTaskHasNoWorker(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> stepQuarantineFollowsStartupGrace(s, "quarantineCompleted", quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> canQuarantineCompleted(s, task) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "quarantineCompleted", quarantineCompleted(s, task, success)))
{
  if inv(s) && canQuarantineCompleted(s, task) {
    var after := quarantineCompleted(s, task, success);
    forall q | q in after.quarantined
      ensures q !in after.workers
    {
      if q !in s.quarantined { ProofLib.FilterMember((set_x: string) => !((set_x in s.quarantined)), [task], q); }
    }
  }
}

lemma healCompleted_ensures(s: TaskServiceOwners, task: string, success: bool)
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysExecutionsHavePendingOwner(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysActiveTickOwned(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysStoppedHasNoTimer(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysStopReturnsAfterOperations(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysStopKeepsAdmissionClosed(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysStopSnapshotHoldsPendingOperations(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> alwaysQuarantinedTaskHasNoWorker(healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> stepQuarantineFollowsStartupGrace(s, "healCompleted", healCompleted(s, task, success)))
  ensures (inv(s) ==> canHealCompleted(s, task) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "healCompleted", healCompleted(s, task, success)))
{
  if inv(s) && canHealCompleted(s, task) && success {
    var after := healCompleted(s, task, success);
    forall q | q in after.quarantined
      ensures q !in after.workers
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in [task])), s.quarantined, q);
    }
  }
}

lemma registerWorker_ensures(s: TaskServiceOwners, task: string)
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysExecutionsHavePendingOwner(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysActiveTickOwned(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysStoppedHasNoTimer(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysStopReturnsAfterOperations(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysStopKeepsAdmissionClosed(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysStopSnapshotHoldsPendingOperations(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> alwaysQuarantinedTaskHasNoWorker(registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> stepQuarantineFollowsStartupGrace(s, "registerWorker", registerWorker(s, task)))
  ensures (inv(s) ==> canRegisterWorker(s, task) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "registerWorker", registerWorker(s, task)))
{
  if inv(s) && canRegisterWorker(s, task) {
    var after := registerWorker(s, task);
    forall q | q in after.quarantined
      ensures q !in after.workers
    {
      ProofLib.FilterMember((set_x: string) => !((set_x in [task])), s.quarantined, q);
      if q in after.workers && q !in s.workers { ProofLib.FilterMember((set_x: string) => !((set_x in s.workers)), [task], q); }
    }
  }
}

lemma admitOperation_ensures(s: TaskServiceOwners, id: int, tick: int)
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysExecutionsHavePendingOwner(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysActiveTickOwned(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStoppedHasNoTimer(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopReturnsAfterOperations(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopKeepsAdmissionClosed(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopSnapshotHoldsPendingOperations(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysQuarantinedTaskHasNoWorker(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> stepQuarantineFollowsStartupGrace(s, "admitOperation", admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "admitOperation", admitOperation(s, id, tick)))
{
  if inv(s) && canAdmitOperation(s, id, tick) {
    assert |s.stops| == 0;
  }
}

lemma tryExecute_ensures(s: TaskServiceOwners, id: int, operation: int, task: string, repeating: bool, blocking: bool)
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysExecutionsHavePendingOwner(tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysActiveTickOwned(tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStoppedHasNoTimer(tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopReturnsAfterOperations(tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopKeepsAdmissionClosed(tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopSnapshotHoldsPendingOperations(tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysQuarantinedTaskHasNoWorker(tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> stepQuarantineFollowsStartupGrace(s, "tryExecute", tryExecute(s, id, operation, task, repeating, blocking)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "tryExecute", tryExecute(s, id, operation, task, repeating, blocking)))
{
  if inv(s) && canTryExecute(s, id, operation) && !s.stopped {
    assert |s.stops| == 0;
  }
}

lemma recheck_ensures(s: TaskServiceOwners, id: int, rowExists: bool, readSucceeded: bool)
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysExecutionsHavePendingOwner(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysActiveTickOwned(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStoppedHasNoTimer(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopReturnsAfterOperations(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopKeepsAdmissionClosed(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysQuarantinedTaskHasNoWorker(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> stepQuarantineFollowsStartupGrace(s, "recheck", recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "recheck", recheck(s, id, rowExists, readSucceeded)))
{
  if inv(s) && canRecheck(s, id) {
    var after := recheck(s, id, rowExists, readSucceeded);
    forall e | e in after.executions
      ensures e.phase.ExecutionDone? || operationPending(after, e.operation)
    {
      var i :| 0 <= i < |after.executions| && after.executions[i] == e;
      assert s.executions[i] in s.executions;
    }
  }
}

lemma completeOperation_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysExecutionsHavePendingOwner(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysActiveTickOwned(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStoppedHasNoTimer(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopReturnsAfterOperations(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopKeepsAdmissionClosed(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysQuarantinedTaskHasNoWorker(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> stepQuarantineFollowsStartupGrace(s, "completeOperation", completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "completeOperation", completeOperation(s, id)))
{
  if inv(s) && canCompleteOperation(s, id) {
    var after := completeOperation(s, id);
    forall e | e in after.executions
      ensures e.phase.ExecutionDone? || operationPending(after, e.operation)
    {
      if !e.phase.ExecutionDone? {
        var o :| o in s.operations && o.id == e.operation && !o.completed;
        var j :| 0 <= j < |s.operations| && s.operations[j] == o;
        assert after.operations[j] == o;
      }
    }
    forall c | c in after.stops && (c.phase.WaitOperations? || c.phase.StopReturned?)
      ensures forall o :: o in after.operations ==> o.completed || o.id in c.operations
    {
      forall o | o in after.operations ensures o.completed || o.id in c.operations {
        var j :| 0 <= j < |after.operations| && after.operations[j] == o;
        assert s.operations[j] in s.operations;
      }
    }
  }
}

lemma tickQueryResult_ensures(s: TaskServiceOwners, id: int, succeeded: bool, rows: seq<DueRow>)
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysExecutionsHavePendingOwner(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysActiveTickOwned(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStoppedHasNoTimer(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopReturnsAfterOperations(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopKeepsAdmissionClosed(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysQuarantinedTaskHasNoWorker(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> stepQuarantineFollowsStartupGrace(s, "tickQueryResult", tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "tickQueryResult", tickQueryResult(s, id, succeeded, rows)))
{
  if inv(s) && canTickQueryResult(s, id) && s.activeTick != 0 {
    var after := tickQueryResult(s, id, succeeded, rows);
    var t :| t in s.ticks && t.id == s.activeTick && !t.completed;
    var j :| 0 <= j < |s.ticks| && s.ticks[j] == t;
    assert after.ticks[j].id == t.id && !after.ticks[j].completed;
    assert after.ticks[j] in after.ticks;
  }
}

lemma finishTick_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysExecutionsHavePendingOwner(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysActiveTickOwned(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStoppedHasNoTimer(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopReturnsAfterOperations(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopKeepsAdmissionClosed(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysQuarantinedTaskHasNoWorker(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> stepQuarantineFollowsStartupGrace(s, "finishTick", finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "finishTick", finishTick(s, id)))
{
  if inv(s) && canFinishTick(s, id) && s.activeTick != 0 && s.activeTick != id {
    var after := finishTick(s, id);
    var t :| t in s.ticks && t.id == s.activeTick && !t.completed;
    var j :| 0 <= j < |s.ticks| && s.ticks[j] == t;
    assert after.activeTick == s.activeTick;
    assert after.ticks[j] == t;
    assert after.ticks[j] in after.ticks;
  }
}

lemma NoPendingAfterSnapshot(s: TaskServiceOwners, c: StopCall)
  requires alwaysStopSnapshotHoldsPendingOperations(s) && alwaysExecutionsHavePendingOwner(s)
  requires c in s.stops && c.phase.WaitOperations? && forall x :: x in c.operations ==> !operationPending(s, x)
  ensures forall o :: o in s.operations ==> o.completed
  ensures forall e :: e in s.executions ==> e.phase.ExecutionDone?
{
  forall o | o in s.operations ensures o.completed {
    if !o.completed { assert o.id in c.operations; assert operationPending(s, o.id); }
  }
}

lemma returnStop_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysExecutionsHavePendingOwner(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysActiveTickOwned(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStoppedHasNoTimer(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopReturnsAfterOperations(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopKeepsAdmissionClosed(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysQuarantinedTaskHasNoWorker(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> stepQuarantineFollowsStartupGrace(s, "returnStop", returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "returnStop", returnStop(s, id)))
{
  if inv(s) && canReturnStop(s, id) {
    var c :| c in s.stops && c.id == id && c.phase.WaitOperations? && forall x :: x in c.operations ==> !operationPending(s, x);
    NoPendingAfterSnapshot(s, c);
  }
}

lemma snapshotOperations_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysExecutionsHavePendingOwner(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysActiveTickOwned(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStoppedHasNoTimer(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopReturnsAfterOperations(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopKeepsAdmissionClosed(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysQuarantinedTaskHasNoWorker(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> stepQuarantineFollowsStartupGrace(s, "snapshotOperations", snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> stepQuarantineLeavesOnlyByHealOrWorker(s, "snapshotOperations", snapshotOperations(s, id)))
{
  if inv(s) && canSnapshotOperations(s, id) {
    var after := snapshotOperations(s, id);
    forall c | c in after.stops && (c.phase.WaitOperations? || c.phase.StopReturned?)
      ensures forall o :: o in after.operations ==> o.completed || o.id in c.operations
    {
      var j :| 0 <= j < |after.stops| && after.stops[j] == c;
      assert s.stops[j] in s.stops;
      if s.stops[j].id == id { SnapshotHasPending(s, id, j); }
    }
  }
}

lemma SnapshotView(s: TaskServiceOwners, id: int, j: int)
  requires 0 <= j < |s.stops| && s.stops[j].id == id
  ensures |snapshotOperations(s, id).stops[j].operations| == |ProofLib.Filter((operation: Operation) => !(operation.completed), s.operations)|
  ensures forall i :: 0 <= i < |ProofLib.Filter((operation: Operation) => !(operation.completed), s.operations)| ==> snapshotOperations(s, id).stops[j].operations[i] == ProofLib.Filter((operation: Operation) => !(operation.completed), s.operations)[i].id
{
}

lemma SnapshotHasPending(s: TaskServiceOwners, id: int, j: int)
  requires 0 <= j < |s.stops| && s.stops[j].id == id
  ensures forall o :: o in s.operations && !o.completed ==> o.id in snapshotOperations(s, id).stops[j].operations
{
  SnapshotView(s, id, j);
  forall o | o in s.operations && !o.completed
    ensures o.id in snapshotOperations(s, id).stops[j].operations
  {
    ProofLib.FilterMember((operation: Operation) => !(operation.completed), s.operations, o);
    var k :| 0 <= k < |ProofLib.Filter((operation: Operation) => !(operation.completed), s.operations)| && ProofLib.Filter((operation: Operation) => !(operation.completed), s.operations)[k] == o;
    assert snapshotOperations(s, id).stops[j].operations[k] == o.id;
  }
}
