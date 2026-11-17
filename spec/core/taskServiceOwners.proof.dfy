// Proofs for spec/core/taskServiceOwners.md.

// --- Helpers ----------------------------------------------------------------

// The pieces of inv, stated with forall.
lemma InvParts(s: TaskServiceOwners)
  ensures alwaysExecutionsHavePendingOwner(s) <==>
    (forall e :: e in s.executions && !e.phase.ExecutionDone? ==> operationPending(s, e.operation))
  ensures alwaysExecutionIdsAreUnique(s) <==>
    (forall a, b :: a in s.executions && b in s.executions && a.id == b.id ==> a == b)
  ensures alwaysStopReturnsAfterOperations(s) <==>
    (forall c :: c in s.stops && c.phase.StopReturned? ==>
      (forall x :: x in c.operations ==> !operationPending(s, x)) &&
      (forall e :: e in s.executions ==> e.phase.ExecutionDone?))
  ensures alwaysStopSnapshotHoldsPendingOperations(s) <==>
    (forall c, o :: c in s.stops && (c.phase.WaitOperations? || c.phase.StopReturned?) && o in s.operations ==>
      o.completed || o.id in c.operations)
{}

// Two states that agree on everything inv reads satisfy inv together.
lemma InvSameParts(s: TaskServiceOwners, t: TaskServiceOwners)
  requires inv(s)
  requires t.operations == s.operations && t.executions == s.executions && t.stops == s.stops
  requires t.ticks == s.ticks && t.activeTick == s.activeTick && t.stopped == s.stopped
  requires t.stopped ==> !t.localTimer && !t.hasTimer
  ensures inv(t)
{}

// A change to the tick fields alone keeps inv when the active tick stays owned.
lemma InvTickParts(s: TaskServiceOwners, t: TaskServiceOwners)
  requires inv(s)
  requires t.operations == s.operations && t.executions == s.executions && t.stops == s.stops
  requires t.stopped == s.stopped && t.localTimer == s.localTimer && t.hasTimer == s.hasTimer
  requires alwaysActiveTickOwned(t)
  ensures inv(t)
{}

// armed keeps inv, for any deadline.
lemma ArmedAll(u: TaskServiceOwners)
  requires inv(u)
  ensures forall at :: inv(armed(u, at))
{
  forall at ensures inv(armed(u, at)) {
    InvSameParts(u, armed(u, at));
  }
}

// A mapped execution list keeps ids, and executions that share an id stay equal.
lemma MappedIdsUnique(s: TaskServiceOwners, t: TaskServiceOwners)
  requires alwaysExecutionIdsAreUnique(s)
  requires |t.executions| == |s.executions|
  requires forall i :: 0 <= i < |s.executions| ==> t.executions[i].id == s.executions[i].id
  requires forall i, j :: 0 <= i < |s.executions| && 0 <= j < |s.executions| && s.executions[i] == s.executions[j] ==> t.executions[i] == t.executions[j]
  ensures alwaysExecutionIdsAreUnique(t)
{
  forall a, b | a in t.executions && b in t.executions && a.id == b.id ensures a == b {
    var i :| 0 <= i < |t.executions| && t.executions[i] == a;
    var j :| 0 <= j < |t.executions| && t.executions[j] == b;
  }
}

// The stop snapshot fold adds each operation id that is not there yet.
lemma SnapshotStep(a: seq<int>, operation: Operation)
  ensures ((ids: seq<int>, operation: Operation) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [operation.id])))(a, operation) == a + (if operation.id in a then [] else [operation.id])
{
  reveal Std.Collections.Seq.Filter();
}

// A fold of that shape keeps what it started with and adds every id it reads.
lemma SnapshotMemberAny(f: (seq<int>, Operation) -> seq<int>, acc: seq<int>, xs: seq<Operation>, o: Operation)
  requires forall a, y :: f(a, y) == a + (if y.id in a then [] else [y.id])
  ensures forall x :: x in acc ==> x in Std.Collections.Seq.FoldLeft(f, acc, xs)
  ensures o in xs ==> o.id in Std.Collections.Seq.FoldLeft(f, acc, xs)
  decreases |xs|
{
  if |xs| > 0 {
    SnapshotMemberAny(f, f(acc, xs[0]), xs[1..], o);
  }
}

// Every pending operation's id is in the snapshot a stop takes.
lemma SnapshotHoldsPending(ops: seq<Operation>, o: Operation)
  requires o in ops && !o.completed
  ensures o.id in Std.Collections.Seq.FoldLeft((ids: seq<int>, operation: Operation) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [operation.id])), [], ProofLib.Filter((operation: Operation) => !(operation.completed), ops))
{
  forall a: seq<int>, y: Operation
    ensures ((ids: seq<int>, operation: Operation) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [operation.id])))(a, y) == a + (if y.id in a then [] else [y.id])
  {
    SnapshotStep(a, y);
  }
  ProofLib.FilterMember((operation: Operation) => !(operation.completed), ops, o);
  SnapshotMemberAny((ids: seq<int>, operation: Operation) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [operation.id])), [], ProofLib.Filter((operation: Operation) => !(operation.completed), ops), o);
}

// What snapshotOperations makes of the stop call it names.
lemma SnapshotCall(s: TaskServiceOwners, id: int, i: int)
  requires 0 <= i < |s.stops| && s.stops[i].id == id
  ensures snapshotOperations(s, id).stops[i].phase.WaitOperations?
  ensures snapshotOperations(s, id).stops[i].operations == Std.Collections.Seq.FoldLeft((ids: seq<int>, operation: Operation) => (ids + Std.Collections.Seq.Filter((set_x: int) => !((set_x in ids)), [operation.id])), [], ProofLib.Filter((operation: Operation) => !(operation.completed), s.operations))
{
}

// --- Transitions ------------------------------------------------------------

lemma admitOperation_ensures(s: TaskServiceOwners, id: int, tick: int)
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysExecutionsHavePendingOwner(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysExecutionIdsAreUnique(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysActiveTickOwned(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStoppedHasNoTimer(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopReturnsAfterOperations(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopCallsKeepServiceStopped(admitOperation(s, id, tick)))
  ensures (inv(s) ==> canAdmitOperation(s, id, tick) ==> alwaysStopSnapshotHoldsPendingOperations(admitOperation(s, id, tick)))
{
  if inv(s) && canAdmitOperation(s, id, tick) {
    var t := admitOperation(s, id, tick);
    forall e | e in t.executions && !e.phase.ExecutionDone? ensures operationPending(t, e.operation) {
      var o :| o in s.operations && o.id == e.operation && !o.completed;
    }
  }
}

lemma recheck_ensures(s: TaskServiceOwners, id: int, rowExists: bool, readSucceeded: bool)
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysExecutionsHavePendingOwner(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysExecutionIdsAreUnique(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysActiveTickOwned(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStoppedHasNoTimer(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopReturnsAfterOperations(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopCallsKeepServiceStopped(recheck(s, id, rowExists, readSucceeded)))
  ensures (inv(s) ==> canRecheck(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(recheck(s, id, rowExists, readSucceeded)))
{
  if inv(s) && canRecheck(s, id) {
    var t := recheck(s, id, rowExists, readSucceeded);
    InvParts(s); InvParts(t);
    forall e | e in t.executions && !e.phase.ExecutionDone? ensures operationPending(t, e.operation) {
      var i :| 0 <= i < |t.executions| && t.executions[i] == e;
    }
    MappedIdsUnique(s, t);
  }
}

lemma finishExecution_ensures(s: TaskServiceOwners, id: int, success: bool)
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysExecutionsHavePendingOwner(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysExecutionIdsAreUnique(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysActiveTickOwned(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStoppedHasNoTimer(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopReturnsAfterOperations(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopCallsKeepServiceStopped(finishExecution(s, id, success)))
  ensures (inv(s) ==> canFinishExecution(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(finishExecution(s, id, success)))
{
  if inv(s) && canFinishExecution(s, id) {
    var t := finishExecution(s, id, success);
    InvParts(s); InvParts(t);
    forall e | e in t.executions && !e.phase.ExecutionDone? ensures operationPending(t, e.operation) {
      var i :| 0 <= i < |t.executions| && t.executions[i] == e;
    }
    MappedIdsUnique(s, t);
  }
}

lemma completeOperation_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysExecutionsHavePendingOwner(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysExecutionIdsAreUnique(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysActiveTickOwned(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStoppedHasNoTimer(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopReturnsAfterOperations(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopCallsKeepServiceStopped(completeOperation(s, id)))
  ensures (inv(s) ==> canCompleteOperation(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(completeOperation(s, id)))
{
  if inv(s) && canCompleteOperation(s, id) {
    var t := completeOperation(s, id);
    InvParts(s); InvParts(t);
    assert t.executions == s.executions && t.stops == s.stops;
    forall x | operationPending(t, x) ensures operationPending(s, x) {
      var o :| o in t.operations && o.id == x && !o.completed;
      var i :| 0 <= i < |t.operations| && t.operations[i] == o;
      assert s.operations[i] in s.operations;
    }
    forall e | e in t.executions && !e.phase.ExecutionDone? ensures operationPending(t, e.operation) {
      var o :| o in s.operations && o.id == e.operation && !o.completed;
      var i :| 0 <= i < |s.operations| && s.operations[i] == o;
      assert t.operations[i] == o;
      assert t.operations[i] in t.operations;
    }
    forall c, o | c in t.stops && (c.phase.WaitOperations? || c.phase.StopReturned?) && o in t.operations
      ensures o.completed || o.id in c.operations
    {
      var i :| 0 <= i < |t.operations| && t.operations[i] == o;
      assert s.operations[i] in s.operations;
    }
  }
}

lemma tryExecute_ensures(s: TaskServiceOwners, id: int, operation: int, task: string, repeating: bool, blocking: bool, workerPresent: bool)
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysExecutionsHavePendingOwner(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysExecutionIdsAreUnique(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysActiveTickOwned(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStoppedHasNoTimer(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopReturnsAfterOperations(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopCallsKeepServiceStopped(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
  ensures (inv(s) ==> canTryExecute(s, id, operation) ==> alwaysStopSnapshotHoldsPendingOperations(tryExecute(s, id, operation, task, repeating, blocking, workerPresent)))
{
  if inv(s) && canTryExecute(s, id, operation) {
    var t := tryExecute(s, id, operation, task, repeating, blocking, workerPresent);
    if (((s.stopped || (task == "")) || !(workerPresent)) || ((!(repeating) || blocking) && (executionCount(s, task) > 0))) {
      InvSameParts(s, t);
    } else {
      var x := Execution(id, operation, task, (if repeating then ExecutionPhase.WorkerRunning else ExecutionPhase.RecheckOneShot), false);
      InvParts(s); InvParts(t);
      forall a, b | a in t.executions && b in t.executions && a.id == b.id ensures a == b {
        if a != x && b != x {
          assert a in s.executions && b in s.executions;
        } else if a != x {
          assert a in s.executions;
        } else if b != x {
          assert b in s.executions;
        }
      }
    }
  }
}

lemma tickQueryResult_ensures(s: TaskServiceOwners, id: int, succeeded: bool, rows: seq<DueRow>)
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysExecutionsHavePendingOwner(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysExecutionIdsAreUnique(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysActiveTickOwned(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStoppedHasNoTimer(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopReturnsAfterOperations(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopCallsKeepServiceStopped(tickQueryResult(s, id, succeeded, rows)))
  ensures (inv(s) ==> canTickQueryResult(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(tickQueryResult(s, id, succeeded, rows)))
{
  if inv(s) && canTickQueryResult(s, id) {
    var t := tickQueryResult(s, id, succeeded, rows);
    assert t.operations == s.operations && t.executions == s.executions && t.stops == s.stops;
    if s.activeTick != 0 {
      var k :| k in s.ticks && k.id == s.activeTick && !k.completed;
      var i :| 0 <= i < |s.ticks| && s.ticks[i] == k;
      assert t.ticks[i].id == k.id && !t.ticks[i].completed;
      assert t.ticks[i] in t.ticks;
    }
    InvTickParts(s, t);
  }
}

lemma finishTick_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysExecutionsHavePendingOwner(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysExecutionIdsAreUnique(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysActiveTickOwned(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStoppedHasNoTimer(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopReturnsAfterOperations(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopCallsKeepServiceStopped(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(finishTick(s, id)))
{
  if inv(s) && canFinishTick(s, id) {
    var u := s.(activeTick := (if (s.activeTick == id) then 0 else s.activeTick), ticks := (var s_map := s.ticks; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var entry := s_map[i_map]; (if (entry.id == id) then entry.(completed := true) else entry))));
    if u.activeTick != 0 {
      var k :| k in s.ticks && k.id == s.activeTick && !k.completed;
      var i :| 0 <= i < |s.ticks| && s.ticks[i] == k;
      assert u.ticks[i] == k;
      assert u.ticks[i] in u.ticks;
    }
    assert alwaysActiveTickOwned(u);
    InvTickParts(s, u);
    ArmedAll(u);
    var t := finishTick(s, id);
    assert t == u || t == armed(u, t.timerAt);
    assert inv(t);
  }
}

lemma resumeTimerWaiter_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysExecutionsHavePendingOwner(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysExecutionIdsAreUnique(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysActiveTickOwned(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStoppedHasNoTimer(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopReturnsAfterOperations(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopCallsKeepServiceStopped(resumeTimerWaiter(s, id)))
  ensures (inv(s) ==> canResumeTimerWaiter(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(resumeTimerWaiter(s, id)))
{
  if inv(s) {
    forall w: seq<int>, at: int ensures inv(armed(s.(wakeWaiters := w), at)) {
      ArmedAll(s.(wakeWaiters := w));
    }
  }
}

lemma startTimer_ensures(s: TaskServiceOwners, serverless: bool, daemon: bool, maximum: int)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysExecutionIdsAreUnique(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysActiveTickOwned(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopCallsKeepServiceStopped(startTimer(s, serverless, daemon, maximum)))
  ensures (inv(s) ==> alwaysStopSnapshotHoldsPendingOperations(startTimer(s, serverless, daemon, maximum)))
{
  if inv(s) {
    if (s.stopped || serverless) {
    } else if daemon {
      InvSameParts(s, s.(sharedRegistrations := (s.sharedRegistrations + 1)));
    } else if ((maximum < 1000) || (maximum > 2147483647)) {
      InvSameParts(s, s.(failures := (s.failures + 1)));
    } else {
      var u := s.(localTimer := true, hasTimer := false, maxTick := maximum);
      ArmedAll(u);
    }
  }
}

lemma markDirty_ensures(s: TaskServiceOwners, daemon: bool)
  ensures (inv(s) ==> alwaysExecutionsHavePendingOwner(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysExecutionIdsAreUnique(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysActiveTickOwned(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStoppedHasNoTimer(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopReturnsAfterOperations(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopCallsKeepServiceStopped(markDirty(s, daemon)))
  ensures (inv(s) ==> alwaysStopSnapshotHoldsPendingOperations(markDirty(s, daemon)))
{
  if inv(s) {
    ArmedAll(s);
  }
}

lemma prepareStop_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysExecutionsHavePendingOwner(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysExecutionIdsAreUnique(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysActiveTickOwned(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStoppedHasNoTimer(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopReturnsAfterOperations(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopCallsKeepServiceStopped(prepareStop(s, id)))
  ensures (inv(s) ==> canPrepareStop(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(prepareStop(s, id)))
{
  if inv(s) && canPrepareStop(s, id) {
    var t := prepareStop(s, id);
    InvParts(s); InvParts(t);
  }
}

lemma awaitTick_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysExecutionsHavePendingOwner(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysExecutionIdsAreUnique(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysActiveTickOwned(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStoppedHasNoTimer(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopReturnsAfterOperations(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopCallsKeepServiceStopped(awaitTick(s, id)))
  ensures (inv(s) ==> canAwaitTick(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(awaitTick(s, id)))
{
  if inv(s) && canAwaitTick(s, id) {
    var t := awaitTick(s, id);
    InvParts(s); InvParts(t);
    forall c | c in t.stops && (c.phase.WaitOperations? || c.phase.StopReturned?) ensures c in s.stops {
      var i :| 0 <= i < |t.stops| && t.stops[i] == c;
    }
  }
}

lemma snapshotOperations_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysExecutionsHavePendingOwner(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysExecutionIdsAreUnique(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysActiveTickOwned(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStoppedHasNoTimer(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopReturnsAfterOperations(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopCallsKeepServiceStopped(snapshotOperations(s, id)))
  ensures (inv(s) ==> canSnapshotOperations(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(snapshotOperations(s, id)))
{
  if inv(s) && canSnapshotOperations(s, id) {
    var t := snapshotOperations(s, id);
    InvParts(s); InvParts(t);
    forall i | 0 <= i < |s.stops| && s.stops[i].id != id ensures t.stops[i] == s.stops[i] {
    }
    forall i | 0 <= i < |s.stops| && s.stops[i].id == id
      ensures t.stops[i].phase.WaitOperations?
      ensures forall o :: o in s.operations && !o.completed ==> o.id in t.stops[i].operations
    {
      forall o | o in s.operations && !o.completed ensures o.id in t.stops[i].operations {
        SnapshotHoldsPending(s.operations, o);
        SnapshotCall(s, id, i);
      }
    }
    forall c | c in t.stops && c.phase.StopReturned? ensures c in s.stops {
      var i :| 0 <= i < |t.stops| && t.stops[i] == c;
    }
    forall c, o | c in t.stops && (c.phase.WaitOperations? || c.phase.StopReturned?) && o in t.operations
      ensures o.completed || o.id in c.operations
    {
      var i :| 0 <= i < |t.stops| && t.stops[i] == c;
    }
  }
}

lemma returnStop_ensures(s: TaskServiceOwners, id: int)
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysExecutionsHavePendingOwner(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysExecutionIdsAreUnique(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysActiveTickOwned(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStoppedHasNoTimer(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopReturnsAfterOperations(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopCallsKeepServiceStopped(returnStop(s, id)))
  ensures (inv(s) ==> canReturnStop(s, id) ==> alwaysStopSnapshotHoldsPendingOperations(returnStop(s, id)))
{
  if inv(s) && canReturnStop(s, id) {
    var t := returnStop(s, id);
    var g :| g in s.stops && g.id == id && g.phase.WaitOperations? && (forall x :: x in g.operations ==> !operationPending(s, x));
    forall o | o in s.operations ensures o.completed {}
  }
}
