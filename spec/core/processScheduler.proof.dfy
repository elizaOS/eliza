lemma register_ensures(s: ProcessScheduler, name: string)
  ensures (inv(s) ==> canRegister(s, name) ==> alwaysRegisteredNamesUnique(register(s, name)))
  ensures (inv(s) ==> canRegister(s, name) ==> alwaysDisposedCallbacksDrained(register(s, name)))
  ensures (inv(s) ==> canRegister(s, name) ==> alwaysDisposingIsDetached(register(s, name)))
  ensures (inv(s) ==> canRegister(s, name) ==> alwaysAllocatedIdentitiesFresh(register(s, name)))
  ensures (inv(s) ==> canRegister(s, name) ==> alwaysTimerIsRequired(register(s, name)))
  ensures (inv(s) ==> canRegister(s, name) ==> alwaysActiveTickIsOwned(register(s, name)))
{
  if inv(s) && canRegister(s, name) {
    var after := register(s, name);
    var added := ProcessEntry(s.serial, name, true, false, ProcessPhase.ProcessIdle, false, false, 0, 0);
    forall row | row in after.tasks && row.present ensures |ProofLib.Filter((x: ProcessEntry) => x.present && x.name == row.name, after.tasks)| == 1 {
      var p := (x: ProcessEntry) => x.present && x.name == row.name;
      ProofLib.FilterAppend(p, s.tasks, added);
      if row.name == name {
        ProofLib.FilterNone(p, s.tasks);
      }
    }
    forall row | row in after.tasks ensures row.id > 0 && row.id < after.serial && |ProofLib.Filter((x: ProcessEntry) => x.id == row.id, after.tasks)| == 1 {
      var p := (x: ProcessEntry) => x.id == row.id;
      ProofLib.FilterAppend(p, s.tasks, added);
      if row.id == s.serial {
        ProofLib.FilterNone(p, s.tasks);
      }
    }
  }
}

lemma returnDispose_ensures(s: ProcessScheduler, id: int)
  ensures (inv(s) ==> canReturnDispose(s, id) ==> alwaysRegisteredNamesUnique(returnDispose(s, id)))
  ensures (inv(s) ==> canReturnDispose(s, id) ==> alwaysDisposedCallbacksDrained(returnDispose(s, id)))
  ensures (inv(s) ==> canReturnDispose(s, id) ==> alwaysDisposingIsDetached(returnDispose(s, id)))
  ensures (inv(s) ==> canReturnDispose(s, id) ==> alwaysAllocatedIdentitiesFresh(returnDispose(s, id)))
  ensures (inv(s) ==> canReturnDispose(s, id) ==> alwaysTimerIsRequired(returnDispose(s, id)))
  ensures (inv(s) ==> canReturnDispose(s, id) ==> alwaysActiveTickIsOwned(returnDispose(s, id)))
{
  if inv(s) && canReturnDispose(s, id) {
    var after := returnDispose(s, id);
    ProcessMapTaskIdentity(s, after);
    ProcessTaskLookup(s, id);
    forall row | row in after.tasks && row.disposed ensures row.phase.ProcessIdle? && row.aborted && !row.present {
      var i :| 0 <= i < |after.tasks| && after.tasks[i] == row;
      var oldRow := s.tasks[i];
      if row.id == id {
        assert oldRow == taskAt(s, id);
      }
    }
  }
}

lemma tick_ensures(s: ProcessScheduler)
  ensures (inv(s) ==> canTick(s) ==> alwaysRegisteredNamesUnique(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysDisposedCallbacksDrained(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysDisposingIsDetached(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysAllocatedIdentitiesFresh(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysTimerIsRequired(tick(s)))
  ensures (inv(s) ==> canTick(s) ==> alwaysActiveTickIsOwned(tick(s)))
{
  if inv(s) && canTick(s) {
    var after := tick(s);
    ProcessMapTaskIdentity(s, after);
    if s.adapter != "" && s.activeTick == 0 {
      var added := TickEntry(s.serial, s.generation, false);
      forall row | row in after.ticks ensures row.id > 0 && row.id < after.serial && |ProofLib.Filter((x: TickEntry) => x.id == row.id, after.ticks)| == 1 {
        var p := (x: TickEntry) => x.id == row.id;
        ProofLib.FilterAppend(p, s.ticks, added);
        if row.id == s.serial {
          ProofLib.FilterNone(p, s.ticks);
        }
      }
    }
  }
}

lemma finishTick_ensures(s: ProcessScheduler, id: int)
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysRegisteredNamesUnique(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysDisposedCallbacksDrained(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysDisposingIsDetached(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysAllocatedIdentitiesFresh(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysTimerIsRequired(finishTick(s, id)))
  ensures (inv(s) ==> canFinishTick(s, id) ==> alwaysActiveTickIsOwned(finishTick(s, id)))
{
  if inv(s) && canFinishTick(s, id) {
    var after := finishTick(s, id);
    forall row | row in after.ticks ensures row.id > 0 && row.id < after.serial && |ProofLib.Filter((x: TickEntry) => x.id == row.id, after.ticks)| == 1 {
      var i :| 0 <= i < |after.ticks| && after.ticks[i] == row;
      assert s.ticks[i] in s.ticks;
      var p := (x: TickEntry) => x.id == row.id;
      ProofLib.FilterLengthPointwise(p, p, s.ticks, after.ticks);
    }
    if after.activeTick != 0 {
      var row :| row in s.ticks && row.id == s.activeTick && !row.completed && row.generation == s.generation;
      var i :| 0 <= i < |s.ticks| && s.ticks[i] == row;
      assert after.ticks[i] == row;
      assert row in after.ticks;
    }
  }
}

lemma advanceDisposal_ensures(s: ProcessScheduler, success: bool)
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysRegisteredNamesUnique(advanceDisposal(s, success)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysDisposedCallbacksDrained(advanceDisposal(s, success)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysDisposingIsDetached(advanceDisposal(s, success)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysAllocatedIdentitiesFresh(advanceDisposal(s, success)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysTimerIsRequired(advanceDisposal(s, success)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysActiveTickIsOwned(advanceDisposal(s, success)))
{
  if inv(s) && canAdvanceDisposal(s) {
    var p := (task: ProcessEntry) => task.disposing && !task.disposed;
    var waiting := ProofLib.Filter(p, s.tasks);
    assert |waiting| > 0;
    var task := nextDisposingTask(s);
    assert task == waiting[0];
    ProofLib.FilterMember(p, s.tasks, task);
    ProcessTaskLookup(s, task.id);
    assert taskAt(s, task.id) == task;
    if task.phase.ProcessQueued? { enterProcess_ensures(s, task.id); }
    else if task.phase.ProcessRunning? { finishProcess_ensures(s, task.id, success); }
    else { returnDispose_ensures(s, task.id); }
  }
}

lemma dispose_ensures(s: ProcessScheduler, id: int)
  ensures (inv(s) ==> canDispose(s, id) ==> alwaysRegisteredNamesUnique(dispose(s, id)))
  ensures (inv(s) ==> canDispose(s, id) ==> alwaysDisposedCallbacksDrained(dispose(s, id)))
  ensures (inv(s) ==> canDispose(s, id) ==> alwaysDisposingIsDetached(dispose(s, id)))
  ensures (inv(s) ==> canDispose(s, id) ==> alwaysAllocatedIdentitiesFresh(dispose(s, id)))
  ensures (inv(s) ==> canDispose(s, id) ==> alwaysTimerIsRequired(dispose(s, id)))
  ensures (inv(s) ==> canDispose(s, id) ==> alwaysActiveTickIsOwned(dispose(s, id)))
{
  if inv(s) && canDispose(s, id) {
    var after := dispose(s, id);
    ProcessMapTaskIdentity(s, after);
  }
}

lemma enterProcess_ensures(s: ProcessScheduler, id: int)
  ensures (inv(s) ==> canEnterProcess(s, id) ==> alwaysRegisteredNamesUnique(enterProcess(s, id)))
  ensures (inv(s) ==> canEnterProcess(s, id) ==> alwaysDisposedCallbacksDrained(enterProcess(s, id)))
  ensures (inv(s) ==> canEnterProcess(s, id) ==> alwaysDisposingIsDetached(enterProcess(s, id)))
  ensures (inv(s) ==> canEnterProcess(s, id) ==> alwaysAllocatedIdentitiesFresh(enterProcess(s, id)))
  ensures (inv(s) ==> canEnterProcess(s, id) ==> alwaysTimerIsRequired(enterProcess(s, id)))
  ensures (inv(s) ==> canEnterProcess(s, id) ==> alwaysActiveTickIsOwned(enterProcess(s, id)))
{
  if inv(s) && canEnterProcess(s, id) {
    var after := enterProcess(s, id);
    ProcessMapTaskIdentity(s, after);
  }
}

lemma finishProcess_ensures(s: ProcessScheduler, id: int, success: bool)
  ensures (inv(s) ==> canFinishProcess(s, id) ==> alwaysRegisteredNamesUnique(finishProcess(s, id, success)))
  ensures (inv(s) ==> canFinishProcess(s, id) ==> alwaysDisposedCallbacksDrained(finishProcess(s, id, success)))
  ensures (inv(s) ==> canFinishProcess(s, id) ==> alwaysDisposingIsDetached(finishProcess(s, id, success)))
  ensures (inv(s) ==> canFinishProcess(s, id) ==> alwaysAllocatedIdentitiesFresh(finishProcess(s, id, success)))
  ensures (inv(s) ==> canFinishProcess(s, id) ==> alwaysTimerIsRequired(finishProcess(s, id, success)))
  ensures (inv(s) ==> canFinishProcess(s, id) ==> alwaysActiveTickIsOwned(finishProcess(s, id, success)))
{
  if inv(s) && canFinishProcess(s, id) {
    var after := finishProcess(s, id, success);
    ProcessMapTaskIdentity(s, after);
  }
}

lemma ProcessMapTaskIdentity(before: ProcessScheduler, after: ProcessScheduler)
  requires inv(before) && after.serial >= before.serial
  requires |after.tasks| == |before.tasks|
  requires forall i :: 0 <= i < |after.tasks| ==> after.tasks[i].id == before.tasks[i].id && after.tasks[i].name == before.tasks[i].name && (after.tasks[i].present ==> before.tasks[i].present)
  ensures alwaysRegisteredNamesUnique(after)
  ensures forall task :: task in after.tasks ==> task.id > 0 && task.id < after.serial && |ProofLib.Filter((x: ProcessEntry) => x.id == task.id, after.tasks)| == 1
{
  forall task | task in after.tasks ensures task.id > 0 && task.id < after.serial && |ProofLib.Filter((x: ProcessEntry) => x.id == task.id, after.tasks)| == 1 {
    var i :| 0 <= i < |after.tasks| && after.tasks[i] == task;
    assert before.tasks[i] in before.tasks;
    var sameId := (x: ProcessEntry) => x.id == task.id;
    ProofLib.FilterLengthPointwise(sameId, sameId, before.tasks, after.tasks);
  }
  forall task | task in after.tasks && task.present ensures |ProofLib.Filter((x: ProcessEntry) => x.present && x.name == task.name, after.tasks)| == 1 {
    var i :| 0 <= i < |after.tasks| && after.tasks[i] == task;
    var p := (x: ProcessEntry) => x.present && x.name == task.name;
    assert before.tasks[i] in before.tasks && p(before.tasks[i]);
    assert forall j :: 0 <= j < |after.tasks| && j != i ==> !p(after.tasks[j]) by {
      forall j | 0 <= j < |after.tasks| && j != i ensures !p(after.tasks[j]) {
        if p(after.tasks[j]) {
          assert p(before.tasks[j]);
          ProofLib.FilterTwo(p, before.tasks, i, j);
        }
      }
    }
    ProofLib.FilterOne(p, after.tasks, i);
  }
}

lemma ProcessTaskLookup(s: ProcessScheduler, id: int)
  requires inv(s)
  ensures forall row :: row in s.tasks && row.id == id ==> taskAt(s, id) == row
{
  forall row | row in s.tasks && row.id == id ensures taskAt(s, id) == row {
    var p := (task: ProcessEntry) => task.id == id;
    var matching := ProofLib.Filter(p, s.tasks);
    ProofLib.FilterMember(p, s.tasks, row);
    assert |matching| == 1 && matching[0] == row;
  }
}
