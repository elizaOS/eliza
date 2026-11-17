lemma TaskIdentityViews(s: TaskServiceOwners)
  ensures alwaysExecutionIdentitiesUnique(s) == (forall execution :: execution in s.executions ==> |ProofLib.Filter((other: Execution) => (other.id == execution.id), s.executions)| == 1)
  ensures alwaysStopIdentitiesUnique(s) == (forall call :: call in s.stops ==> |ProofLib.Filter((other: StopCall) => (other.id == call.id), s.stops)| == 1)
{}

lemma TaskExecutionDistinct(rows: seq<Execution>)
  ensures (forall execution :: execution in rows ==> |ProofLib.Filter((other: Execution) => (other.id == execution.id), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: Execution) => row.id)
{
  if forall execution :: execution in rows ==> |ProofLib.Filter((other: Execution) => (other.id == execution.id), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].id != rows[j].id
    {
      ProofLib.FilterCountOneIffUnique((other: Execution) => (other.id == rows[i].id), rows, (row: Execution) => row.id, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: Execution) => row.id) {
    forall execution | execution in rows
      ensures |ProofLib.Filter((other: Execution) => (other.id == execution.id), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == execution;
      ProofLib.FilterOne((other: Execution) => (other.id == execution.id), rows, i);
    }
  }
}

lemma TaskExecutionMapKeys(before: seq<Execution>, after: seq<Execution>)
  requires ProofLib.DistinctBy(before, (row: Execution) => row.id)
  requires |after| == |before|
  requires forall i :: 0 <= i < |after| ==> after[i].id == before[i].id
  ensures ProofLib.DistinctBy(after, (row: Execution) => row.id)
{
  forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j
    ensures after[i].id != after[j].id
  {}
}

lemma TaskStopCallDistinct(rows: seq<StopCall>)
  ensures (forall call :: call in rows ==> |ProofLib.Filter((other: StopCall) => (other.id == call.id), rows)| == 1) <==> ProofLib.DistinctBy(rows, (row: StopCall) => row.id)
{
  if forall call :: call in rows ==> |ProofLib.Filter((other: StopCall) => (other.id == call.id), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j
      ensures rows[i].id != rows[j].id
    {
      ProofLib.FilterCountOneIffUnique((other: StopCall) => (other.id == rows[i].id), rows, (row: StopCall) => row.id, i);
    }
  } else if ProofLib.DistinctBy(rows, (row: StopCall) => row.id) {
    forall call | call in rows
      ensures |ProofLib.Filter((other: StopCall) => (other.id == call.id), rows)| == 1
    {
      var i :| 0 <= i < |rows| && rows[i] == call;
      ProofLib.FilterOne((other: StopCall) => (other.id == call.id), rows, i);
    }
  }
}

lemma TaskStopCallMapKeys(before: seq<StopCall>, after: seq<StopCall>)
  requires ProofLib.DistinctBy(before, (row: StopCall) => row.id)
  requires |after| == |before|
  requires forall i :: 0 <= i < |after| ==> after[i].id == before[i].id
  ensures ProofLib.DistinctBy(after, (row: StopCall) => row.id)
{
  forall i, j | 0 <= i < |after| && 0 <= j < |after| && i != j
    ensures after[i].id != after[j].id
  {}
}

lemma TaskUnchangedWork(before: TaskServiceOwners, after: TaskServiceOwners)
  requires inv(before)
  requires after.executions == before.executions && after.operations == before.operations && after.stops == before.stops
  requires before.stopped ==> after.stopped
  requires forall drain :: drain in before.drains ==> exists kept :: kept in after.drains && kept.id == drain.id
  ensures alwaysExecutionsHavePendingOwner(after)
  ensures alwaysStopReturnsAfterOperations(after)
  ensures alwaysStopsKeepAdmissionClosed(after)
  ensures alwaysExecutionIdentitiesUnique(after)
  ensures alwaysStopIdentitiesUnique(after)
  ensures alwaysStopsNameRetainedDrains(after)
  ensures alwaysStopSnapshotsCoverPending(after)
{}

lemma TaskCaptureOperationView(ids: seq<int>, entry: Operation)
  ensures captureOperation(ids, entry) == ids + ProofLib.Filter((set_x: int) => !((set_x in ids)), [entry.id])
{}

lemma TaskCaptureOperationMembership(ids: seq<int>, entry: Operation, id: int)
  ensures (id in captureOperation(ids, entry)) <==> (id in ids || id == entry.id)
{
  TaskCaptureOperationView(ids, entry);
  ProofLib.FilterMember((set_x: int) => !((set_x in ids)), [entry.id], id);
}

lemma TaskFoldMembership(merge: (seq<int>, Operation) -> seq<int>, rows: seq<Operation>, acc: seq<int>, id: int)
  requires forall ids: seq<int>, operation: Operation :: (id in merge(ids, operation)) <==> (id in ids || operation.id == id)
  ensures (id in Std.Collections.Seq.FoldLeft(merge, acc, rows)) <==> (id in acc || exists row :: row in rows && row.id == id)
  decreases |rows|
{
  if |rows| > 0 {
    TaskFoldMembership(merge, rows[1..], merge(acc, rows[0]), id);
  }
}

lemma TaskCaptureFoldMembership(rows: seq<Operation>, acc: seq<int>, id: int)
  ensures (id in Std.Collections.Seq.FoldLeft((ids: seq<int>, operation: Operation) => captureOperation(ids, operation), acc, rows)) <==> (id in acc || exists row :: row in rows && row.id == id)
{
  var merge := (ids: seq<int>, operation: Operation) => captureOperation(ids, operation);
  forall ids: seq<int>, operation: Operation
    ensures (id in merge(ids, operation)) <==> (id in ids || operation.id == id)
  {
    TaskCaptureOperationMembership(ids, operation, id);
  }
  TaskFoldMembership(merge, rows, acc, id);
}

lemma TaskSnapshotView(call: StopCall, id: int, operations: seq<Operation>)
  ensures snapshottedStop(call, id, operations) == (if call.id == id then call.(phase := StopPhase.WaitOperations, operations := Std.Collections.Seq.FoldLeft((ids: seq<int>, operation: Operation) => captureOperation(ids, operation), [], ProofLib.Filter((operation: Operation) => !(operation.completed), operations))) else call)
{}

lemma TaskSnapshotContainsPending(call: StopCall, id: int, operations: seq<Operation>, target: Operation)
  requires call.id == id
  requires target in operations && !target.completed
  ensures target.id in snapshottedStop(call, id, operations).operations
{
  TaskSnapshotView(call, id, operations);
  var pending := ProofLib.Filter((operation: Operation) => !(operation.completed), operations);
  ProofLib.FilterMember((operation: Operation) => !(operation.completed), operations, target);
  TaskCaptureFoldMembership(pending, [], target.id);
}

lemma configure_ensures(s: TaskServiceOwners, now: int)
  ensures (inv(s) ==> canConfigure(s) ==> alwaysExecutionsHavePendingOwner(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysActiveTickOwned(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysStoppedHasNoTimer(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysStopReturnsAfterOperations(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysStopsKeepAdmissionClosed(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysExecutionIdentitiesUnique(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysStopIdentitiesUnique(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysStopsNameRetainedDrains(configure(s, now)))
  ensures (inv(s) ==> canConfigure(s) ==> alwaysStopSnapshotsCoverPending(configure(s, now)))
{
  if inv(s) && canConfigure(s) {
    var after := configure(s, now);
    TaskUnchangedWork(s, after);
  }
}

lemma setClock_ensures(s: TaskServiceOwners, now: int)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(setClock(s, now)))
  ensures (inv(s) ==> alwaysActiveTickOwned(setClock(s, now)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(setClock(s, now)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(setClock(s, now)))
  ensures (inv(s) ==> alwaysStopsKeepAdmissionClosed(setClock(s, now)))
  ensures (inv(s) ==> alwaysExecutionIdentitiesUnique(setClock(s, now)))
  ensures (inv(s) ==> alwaysStopIdentitiesUnique(setClock(s, now)))
  ensures (inv(s) ==> alwaysStopsNameRetainedDrains(setClock(s, now)))
  ensures (inv(s) ==> alwaysStopSnapshotsCoverPending(setClock(s, now)))
{
  if inv(s) {
    var after := setClock(s, now);
    TaskUnchangedWork(s, after);
  }
}

lemma admitOperation_ensures(s: TaskServiceOwners, id: int, tick: int)
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysExecutionsHavePendingOwner(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysActiveTickOwned(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStoppedHasNoTimer(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopReturnsAfterOperations(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopsKeepAdmissionClosed(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysExecutionIdentitiesUnique(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopIdentitiesUnique(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopsNameRetainedDrains(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopSnapshotsCoverPending(admitOperation(s, id, tick)))
{
  if inv(s) && canAdmitOperation(s, id, tick) {
    var after := admitOperation(s, id, tick);
    assert s.stops == [];
    forall execution | execution in after.executions && !execution.phase.ExecutionDone?
      ensures operationPending(after, execution.operation)
    {
      var owner :| owner in s.operations && owner.id == execution.operation && !owner.completed;
      assert owner in after.operations;
    }
  }
}

lemma recheck_ensures(s: TaskServiceOwners, id: int, rowExists: bool, readSucceeded: bool)
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysExecutionsHavePendingOwner(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysActiveTickOwned(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStoppedHasNoTimer(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopReturnsAfterOperations(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopsKeepAdmissionClosed(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysExecutionIdentitiesUnique(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopIdentitiesUnique(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopsNameRetainedDrains(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopSnapshotsCoverPending(recheck(s, id, rowExists, readSucceeded)))
{
  if inv(s) && canRecheck(s, id) {
    var after := recheck(s, id, rowExists, readSucceeded);
    TaskIdentityViews(s);
    TaskIdentityViews(after);
    TaskExecutionDistinct(s.executions);
    TaskExecutionDistinct(after.executions);
    assert forall i :: 0 <= i < |after.executions| ==> after.executions[i].id == s.executions[i].id;
    TaskExecutionMapKeys(s.executions, after.executions);
    var chosen :| 0 <= chosen < |s.executions| && s.executions[chosen].id == id && s.executions[chosen].phase.RecheckOneShot?;
    assert forall call :: call in s.stops ==> !call.phase.StopReturned?;
    forall i | 0 <= i < |after.executions| && !after.executions[i].phase.ExecutionDone?
      ensures operationPending(after, after.executions[i].operation)
    {
      if s.executions[i].id == id { assert i == chosen; }
      assert !s.executions[i].phase.ExecutionDone?;
      assert after.executions[i].operation == s.executions[i].operation;
    }
  }
}

lemma finishExecution_ensures(s: TaskServiceOwners, id: int, success: bool)
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysExecutionsHavePendingOwner(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysActiveTickOwned(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStoppedHasNoTimer(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopReturnsAfterOperations(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopsKeepAdmissionClosed(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysExecutionIdentitiesUnique(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopIdentitiesUnique(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopsNameRetainedDrains(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopSnapshotsCoverPending(finishExecution(s, id, success)))
{
  if inv(s) && canFinishExecution(s, id) {
    var after := finishExecution(s, id, success);
    TaskIdentityViews(s);
    TaskIdentityViews(after);
    TaskExecutionDistinct(s.executions);
    TaskExecutionDistinct(after.executions);
    assert forall i :: 0 <= i < |after.executions| ==> after.executions[i].id == s.executions[i].id;
    TaskExecutionMapKeys(s.executions, after.executions);
    assert forall call :: call in s.stops ==> !call.phase.StopReturned?;
    forall i | 0 <= i < |after.executions| && !after.executions[i].phase.ExecutionDone?
      ensures operationPending(after, after.executions[i].operation)
    {
      assert s.executions[i].id != id;
      assert after.executions[i] == s.executions[i];
    }
  }
}

lemma completeOperation_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysExecutionsHavePendingOwner(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysActiveTickOwned(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStoppedHasNoTimer(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopReturnsAfterOperations(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopsKeepAdmissionClosed(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysExecutionIdentitiesUnique(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopIdentitiesUnique(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopsNameRetainedDrains(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopSnapshotsCoverPending(completeOperation(s, id)))
{
  if inv(s) && canCompleteOperation(s, id) {
    var after := completeOperation(s, id);
    forall execution | execution in after.executions && !execution.phase.ExecutionDone?
      ensures operationPending(after, execution.operation)
    {
      assert execution.operation != id;
      var i :| 0 <= i < |s.operations| && s.operations[i].id == execution.operation && !s.operations[i].completed;
      assert after.operations[i] == s.operations[i];
    }
    forall operation | operation in after.operations && !operation.completed
      ensures operationPending(s, operation.id)
    {
      var i :| 0 <= i < |after.operations| && after.operations[i] == operation;
      assert s.operations[i] == operation;
    }
  }
}

lemma tryExecute_ensures(s: TaskServiceOwners, id: int, operation: int, task: string, repeating: bool, blocking: bool, workerPresent: bool)
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysExecutionsHavePendingOwner(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysActiveTickOwned(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStoppedHasNoTimer(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopReturnsAfterOperations(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopsKeepAdmissionClosed(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysExecutionIdentitiesUnique(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopIdentitiesUnique(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopsNameRetainedDrains(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopSnapshotsCoverPending(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
{
  if inv(s) && canTryExecute(s, id, operation) {
    var after := tryExecute(s, id, operation, task, repeating, blocking, workerPresent);
    if !s.stopped && task != "" && workerPresent && !((!repeating || blocking) && executionCount(s, task) > 0) {
      assert s.stops == [];
      TaskIdentityViews(s);
      TaskIdentityViews(after);
      TaskExecutionDistinct(s.executions);
      TaskExecutionDistinct(after.executions);
      var added := Execution(id, operation, task, (if repeating then ExecutionPhase.WorkerRunning else ExecutionPhase.RecheckOneShot), false);
      ProofLib.DistinctByConcat(s.executions, [added], (row: Execution) => row.id);
      forall execution | execution in after.executions && !execution.phase.ExecutionDone?
        ensures operationPending(after, execution.operation)
      { assert execution in s.executions || execution == added; }
    }
  }
}

lemma armed_ensures(s: TaskServiceOwners, at: int)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(armed(s, at)))
  ensures (inv(s) ==> alwaysActiveTickOwned(armed(s, at)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(armed(s, at)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(armed(s, at)))
  ensures (inv(s) ==> alwaysStopsKeepAdmissionClosed(armed(s, at)))
  ensures (inv(s) ==> alwaysExecutionIdentitiesUnique(armed(s, at)))
  ensures (inv(s) ==> alwaysStopIdentitiesUnique(armed(s, at)))
  ensures (inv(s) ==> alwaysStopsNameRetainedDrains(armed(s, at)))
  ensures (inv(s) ==> alwaysStopSnapshotsCoverPending(armed(s, at)))
{
  if inv(s) {
    var after := armed(s, at);
    TaskUnchangedWork(s, after);
  }
}

lemma beginHostTick_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysExecutionsHavePendingOwner(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysActiveTickOwned(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysStoppedHasNoTimer(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysStopReturnsAfterOperations(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysStopsKeepAdmissionClosed(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysExecutionIdentitiesUnique(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysStopIdentitiesUnique(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysStopsNameRetainedDrains(beginHostTick(s, id)))
  ensures (inv(s) ==> canBeginHostTick(s, id) ==> alwaysStopSnapshotsCoverPending(beginHostTick(s, id)))
{
  if inv(s) && canBeginHostTick(s, id) {
    var after := beginHostTick(s, id);
    TaskUnchangedWork(s, after);
  }
}

lemma fireTimer_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysExecutionsHavePendingOwner(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysActiveTickOwned(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysStoppedHasNoTimer(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysStopReturnsAfterOperations(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysStopsKeepAdmissionClosed(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysExecutionIdentitiesUnique(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysStopIdentitiesUnique(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysStopsNameRetainedDrains(fireTimer(s, id)))
  ensures (inv(s) ==> canFireTimer(s, id) ==> alwaysStopSnapshotsCoverPending(fireTimer(s, id)))
{
  if inv(s) && canFireTimer(s, id) {
    var after := fireTimer(s, id);
    TaskUnchangedWork(s, after);
  }
}

lemma tickQueryResult_ensures(s: TaskServiceOwners, id: int, succeeded: bool, rows: seq<DueRow>)
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysExecutionsHavePendingOwner(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysActiveTickOwned(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStoppedHasNoTimer(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopReturnsAfterOperations(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopsKeepAdmissionClosed(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysExecutionIdentitiesUnique(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopIdentitiesUnique(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopsNameRetainedDrains(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopSnapshotsCoverPending(tickQueryResult(s, id, succeeded, rows)))
{
  if inv(s) && canTickQueryResult(s, id) {
    var after := tickQueryResult(s, id, succeeded, rows);
    TaskUnchangedWork(s, after);
    if after.activeTick != 0 {
      var i :| 0 <= i < |s.ticks| && s.ticks[i].id == s.activeTick && !s.ticks[i].completed;
      assert after.activeTick == s.activeTick;
      assert after.ticks[i].id == after.activeTick && !after.ticks[i].completed;
    }
  }
}

lemma finishTick_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysExecutionsHavePendingOwner(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysActiveTickOwned(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStoppedHasNoTimer(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopReturnsAfterOperations(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopsKeepAdmissionClosed(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysExecutionIdentitiesUnique(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopIdentitiesUnique(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopsNameRetainedDrains(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopSnapshotsCoverPending(finishTick(s, id)))
{
  if inv(s) && canFinishTick(s, id) {
    var after := finishTick(s, id);
    TaskUnchangedWork(s, after);
    if after.activeTick != 0 {
      var i :| 0 <= i < |s.ticks| && s.ticks[i].id == s.activeTick && !s.ticks[i].completed;
      assert after.activeTick == s.activeTick;
      assert after.ticks[i].id == after.activeTick && !after.ticks[i].completed;
    }
  }
}

lemma resumeTimerWaiter_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysExecutionsHavePendingOwner(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysActiveTickOwned(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStoppedHasNoTimer(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopReturnsAfterOperations(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopsKeepAdmissionClosed(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysExecutionIdentitiesUnique(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopIdentitiesUnique(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopsNameRetainedDrains(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopSnapshotsCoverPending(resumeTimerWaiter(s, id)))
{
  if inv(s) && canResumeTimerWaiter(s, id) {
    var after := resumeTimerWaiter(s, id);
    TaskUnchangedWork(s, after);
  }
}

lemma startTimer_ensures(s: TaskServiceOwners, serverless: bool, daemon: bool, maximum: int)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysActiveTickOwned(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopsKeepAdmissionClosed(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysExecutionIdentitiesUnique(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopIdentitiesUnique(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopsNameRetainedDrains(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopSnapshotsCoverPending(startTimer(s, serverless, daemon, maximum)))
{
  if inv(s) {
    var after := startTimer(s, serverless, daemon, maximum);
    TaskUnchangedWork(s, after);
  }
}

lemma markDirty_ensures(s: TaskServiceOwners, daemon: bool)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysActiveTickOwned(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopsKeepAdmissionClosed(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysExecutionIdentitiesUnique(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopIdentitiesUnique(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopsNameRetainedDrains(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopSnapshotsCoverPending(markDirty(s, daemon)))
{
  if inv(s) {
    var after := markDirty(s, daemon);
    TaskUnchangedWork(s, after);
  }
}

lemma prepareStop_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysExecutionsHavePendingOwner(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysActiveTickOwned(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStoppedHasNoTimer(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopReturnsAfterOperations(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopsKeepAdmissionClosed(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysExecutionIdentitiesUnique(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopIdentitiesUnique(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopsNameRetainedDrains(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopSnapshotsCoverPending(prepareStop(s, id)))
{
  if inv(s) && canPrepareStop(s, id) {
    var after := prepareStop(s, id);
    TaskIdentityViews(s);
    TaskIdentityViews(after);
    TaskStopCallDistinct(s.stops);
    TaskStopCallDistinct(after.stops);
    assert forall call :: call in s.stops ==> call.id != id;
    var added := StopCall(id, id, StopPhase.WaitScheduler, 0, []);
    ProofLib.DistinctByConcat(s.stops, [added], (row: StopCall) => row.id);
  }
}

lemma schedulerDrained_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysExecutionsHavePendingOwner(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysActiveTickOwned(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysStoppedHasNoTimer(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysStopReturnsAfterOperations(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysStopsKeepAdmissionClosed(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysExecutionIdentitiesUnique(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysStopIdentitiesUnique(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysStopsNameRetainedDrains(schedulerDrained(s, id)))
  ensures (inv(s) ==> canSchedulerDrained(s, id) ==> alwaysStopSnapshotsCoverPending(schedulerDrained(s, id)))
{
  if inv(s) && canSchedulerDrained(s, id) {
    var after := schedulerDrained(s, id);
    forall drain | drain in s.drains
      ensures exists kept :: kept in after.drains && kept.id == drain.id
    {
      var i :| 0 <= i < |s.drains| && s.drains[i] == drain;
      assert after.drains[i].id == drain.id;
    }
    TaskUnchangedWork(s, after);
  }
}

lemma awaitTick_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysExecutionsHavePendingOwner(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysActiveTickOwned(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStoppedHasNoTimer(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopReturnsAfterOperations(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopsKeepAdmissionClosed(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysExecutionIdentitiesUnique(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopIdentitiesUnique(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopsNameRetainedDrains(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopSnapshotsCoverPending(awaitTick(s, id)))
{
  if inv(s) && canAwaitTick(s, id) {
    var after := awaitTick(s, id);
    TaskIdentityViews(s);
    TaskIdentityViews(after);
    TaskStopCallDistinct(s.stops);
    TaskStopCallDistinct(after.stops);
    assert forall i :: 0 <= i < |after.stops| ==> after.stops[i].id == s.stops[i].id;
    TaskStopCallMapKeys(s.stops, after.stops);
    var chosen :| 0 <= chosen < |s.stops| && s.stops[chosen].id == id && s.stops[chosen].phase.WaitScheduler?;
    forall i | 0 <= i < |after.stops|
      ensures after.stops[i].id == id ==> i == chosen
    {}
  }
}

lemma snapshotOperations_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysExecutionsHavePendingOwner(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysActiveTickOwned(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStoppedHasNoTimer(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopReturnsAfterOperations(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopsKeepAdmissionClosed(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysExecutionIdentitiesUnique(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopIdentitiesUnique(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopsNameRetainedDrains(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopSnapshotsCoverPending(snapshotOperations(s, id)))
{
  if inv(s) && canSnapshotOperations(s, id) {
    var after := snapshotOperations(s, id);
    TaskIdentityViews(s);
    TaskIdentityViews(after);
    TaskStopCallDistinct(s.stops);
    TaskStopCallDistinct(after.stops);
    assert forall i :: 0 <= i < |after.stops| ==> after.stops[i].id == s.stops[i].id;
    TaskStopCallMapKeys(s.stops, after.stops);
    var chosen :| 0 <= chosen < |s.stops| && s.stops[chosen].id == id && s.stops[chosen].phase.WaitTick?;
    forall i | 0 <= i < |after.stops|
      ensures after.stops[i].id == id ==> i == chosen
      ensures (after.stops[i].phase.WaitOperations? || after.stops[i].phase.StopReturned?) ==> (forall operation :: operation in after.operations ==> operation.completed || operation.id in after.stops[i].operations)
    {
      forall operation | operation in after.operations && !operation.completed && (after.stops[i].phase.WaitOperations? || after.stops[i].phase.StopReturned?)
        ensures operation.id in after.stops[i].operations
      {
        if s.stops[i].id == id {
          TaskSnapshotContainsPending(s.stops[i], id, s.operations, operation);
        }
      }
    }
  }
}

lemma returnStop_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysExecutionsHavePendingOwner(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysActiveTickOwned(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStoppedHasNoTimer(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopReturnsAfterOperations(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopsKeepAdmissionClosed(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysExecutionIdentitiesUnique(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopIdentitiesUnique(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopsNameRetainedDrains(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopSnapshotsCoverPending(returnStop(s, id)))
{
  if inv(s) && canReturnStop(s, id) {
    var after := returnStop(s, id);
    TaskIdentityViews(s);
    TaskIdentityViews(after);
    TaskStopCallDistinct(s.stops);
    TaskStopCallDistinct(after.stops);
    assert forall i :: 0 <= i < |after.stops| ==> after.stops[i].id == s.stops[i].id;
    TaskStopCallMapKeys(s.stops, after.stops);
    var chosen :| 0 <= chosen < |s.stops| && s.stops[chosen].id == id && s.stops[chosen].phase.WaitOperations? && (forall operation :: operation in s.stops[chosen].operations ==> !operationPending(s, operation));
    forall operation | operation in s.operations
      ensures operation.completed
    {
      if !operation.completed {
        assert operation.id in s.stops[chosen].operations;
        assert operationPending(s, operation.id);
      }
    }
    assert forall execution :: execution in s.executions ==> execution.phase.ExecutionDone?;
    forall i | 0 <= i < |after.stops|
      ensures after.stops[i].id == id ==> i == chosen
    {}
  }
}

lemma quarantineCompleted_ensures(s: TaskServiceOwners, task: string, success: bool)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysActiveTickOwned(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopsKeepAdmissionClosed(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysExecutionIdentitiesUnique(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopIdentitiesUnique(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopsNameRetainedDrains(quarantineCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopSnapshotsCoverPending(quarantineCompleted(s, task, success)))
{
  if inv(s) {
    var after := quarantineCompleted(s, task, success);
    TaskUnchangedWork(s, after);
  }
}

lemma healCompleted_ensures(s: TaskServiceOwners, task: string, success: bool)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysActiveTickOwned(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopsKeepAdmissionClosed(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysExecutionIdentitiesUnique(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopIdentitiesUnique(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopsNameRetainedDrains(healCompleted(s, task, success)))
  ensures (inv(s) ==> alwaysStopSnapshotsCoverPending(healCompleted(s, task, success)))
{
  if inv(s) {
    var after := healCompleted(s, task, success);
    TaskUnchangedWork(s, after);
  }
}

lemma workerRestored_ensures(s: TaskServiceOwners, task: string)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysActiveTickOwned(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysStopsKeepAdmissionClosed(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysExecutionIdentitiesUnique(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysStopIdentitiesUnique(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysStopsNameRetainedDrains(workerRestored(s, task)))
  ensures (inv(s) ==> alwaysStopSnapshotsCoverPending(workerRestored(s, task)))
{
  if inv(s) {
    var after := workerRestored(s, task);
    TaskUnchangedWork(s, after);
  }
}
