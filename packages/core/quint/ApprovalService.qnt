// src/services/approval.ts. Claiming the pending entry precedes every callback.
// Timeout, selection, cancellation, stop, callback failures and task deletion
// have the same separate transitions as the implementation's awaits.
module ApprovalService {

  const Selectors: Set[str]

  const CanFail: bool

  type State = {
    inMap: bool,
    timer: str,
    taskExists: bool,
    result: str,
    selRuns: int,
    toRuns: int,
    tpc: str,
    tHas: bool,
    spc: str -> str,
    sHas: str -> bool,
    cpc: str,
    stopped: bool
  }

  var s: State

  pure def settle(v: State, r: str): State = {
    ...v,
    result: if (v.result == "none") r else v.result
  }

  action init = s' = {
    inMap: true,
    timer: "armed",
    taskExists: true,
    result: "none",
    selRuns: 0,
    toRuns: 0,
    tpc: "idle",
    tHas: false,
    spc: Selectors.mapBy(i => "idle"),
    sHas: Selectors.mapBy(i => false),
    cpc: "idle",
    stopped: false
  }

  action Fire = all {
    s.timer == "armed",
    s' = {
      ...s,
      timer: "fired",
      tHas: s.inMap,
      inMap: false,
      tpc: if (s.inMap) "getTask" else "done"
    }
  }

  action TGetTask = all {
    s.tpc == "getTask",
    s' = if (s.taskExists) {
      ...s,
      tpc: "onTimeout",
      toRuns: s.toRuns + 1
    } else {
      ...s,
      tpc: "resolve"
    }
  }

  action TCallbackDone = all {
    s.tpc == "onTimeout",
    s' = {
      ...s,
      tpc: "resolve"
    }
  }

  action TCallbackFails = all {
    CanFail,
    s.tpc == "onTimeout",
    s' = settle({
      ...s,
      tpc: "done",
      inMap: false
    }, "rejected")
  }

  action TResolve = all {
    s.tpc == "resolve",
    s' = settle({
      ...s,
      tpc: "deleteTask"
    }, "timedOut")
  }

  action TDelete = all {
    s.tpc == "deleteTask",
    s' = {
      ...s,
      taskExists: false,
      tpc: "done"
    }
  }

  action Deliver(i: str): bool = all {
    s.spc.get(i) == "idle",
    s.taskExists,
    s' = {
      ...s,
      spc: s.spc.set(i, "getTask")
    }
  }

  action SGetTask(i: str): bool = all {
    s.spc.get(i) == "getTask",
    s' = if (not(s.taskExists)) {
      ...s,
      spc: s.spc.set(i, "deleteTask")
    } else {
      ...s,
      sHas: s.sHas.set(i, s.inMap),
      inMap: false,
      timer: if (s.inMap and s.timer == "armed") "cleared" else s.timer,
      spc: s.spc.set(i, if (s.inMap) "onSelect" else if (s.stopped) "deleteTask" else "done"),
      selRuns: if (s.inMap) s.selRuns + 1 else s.selRuns
    }
  }

  action SCallbackDone(i: str): bool = all {
    s.spc.get(i) == "onSelect",
    s' = settle({
      ...s,
      spc: s.spc.set(i, "deleteTask")
    }, "selected")
  }

  action SCallbackFails(i: str): bool = all {
    CanFail,
    s.spc.get(i) == "onSelect",
    s' = settle({
      ...s,
      spc: s.spc.set(i, "done")
    }, "rejected")
  }

  action SDelete(i: str): bool = all {
    s.spc.get(i) == "deleteTask",
    s' = {
      ...s,
      taskExists: false,
      spc: s.spc.set(i, "done")
    }
  }

  pure def cancel(v: State): State = if (v.inMap) settle({
    ...v,
    timer: if (v.timer == "armed") "cleared" else v.timer,
    inMap: false
  }, "cancelled") else v

  action Cancel = all {
    s.cpc == "idle",
    s' = {
      ...cancel(s),
      cpc: "deleteTask"
    }
  }

  action CancelDelete = all {
    s.cpc == "deleteTask",
    s' = {
      ...s,
      taskExists: false,
      cpc: "done"
    }
  }

  action Stop = all {
    not(s.stopped),
    s' = {
      ...cancel(s),
      stopped: true
    }
  }

  val Finished = s.timer != "armed" and Set("idle", "done").contains(s.tpc) and Set("idle", "done").contains(s.cpc) and
  Selectors.forall(i => Set("idle", "done").contains(s.spc.get(i)))

  action SelectionStep = {
    nondet i = Selectors.oneOf()
    any {
      Deliver(i),
      SGetTask(i),
      SCallbackDone(i),
      SCallbackFails(i),
      SDelete(i)
    }
  }

  action nextStep = any {
    Fire,
    TGetTask,
    TCallbackDone,
    TCallbackFails,
    TResolve,
    TDelete,
    SelectionStep,
    Cancel,
    CancelDelete,
    Stop,
    all {
      Finished,
      s' = s
    }
  }

  action step = any {
    nextStep,
    s' = s
  }

  val TypeOK = and {
    Set("armed", "fired", "cleared").contains(s.timer),
    Set("none", "selected", "timedOut", "cancelled", "rejected").contains(s.result),
    s.selRuns >= 0,
    s.toRuns >= 0,
    Set("idle", "getTask", "onTimeout", "resolve", "deleteTask", "done").contains(s.tpc),
    s.spc.keys() == Selectors,
    s.sHas.keys() == Selectors,
    Selectors.forall(i => Set("idle", "getTask", "onSelect", "deleteTask", "done").contains(s.spc.get(i))),
    Set("idle", "deleteTask", "done").contains(s.cpc)
  }

  val AtMostOneCallback = s.selRuns + s.toRuns <= 1

  val ResultAgrees = and {
    s.result == "cancelled" implies s.selRuns + s.toRuns == 0,
    s.result == "selected" implies s.toRuns == 0,
    s.result == "timedOut" implies s.selRuns == 0
  }

  val SingleOwner = (if (s.tHas) 1 else 0) + (if (s.inMap) 1 else 0) <= 1 and Selectors.forall(i => s.sHas.get(i) implies
  (not(s.inMap) and not(s.tHas) and Selectors.exclude(Set(i)).forall(j => not(s.sHas.get(j)))))

  temporal Fairness = and {
    Fire.weakFair(s),
    TGetTask.weakFair(s),
    any {
      TCallbackDone,
      TCallbackFails
    }.weakFair(s),
    TResolve.weakFair(s),
    TDelete.weakFair(s),
    Selectors.forall(i => and {
      SGetTask(i).weakFair(s),
      any {
        SCallbackDone(i),
        SCallbackFails(i)
      }.weakFair(s),
      SDelete(i).weakFair(s)
    })
  }

  temporal SettlesOnce = always((
    Set("selected", "timedOut", "cancelled", "rejected").forall(result =>
      s.result == result implies next(s.result) == result)
  ).orKeep(s))

  temporal CallerSettles = Fairness implies eventually(s.result != "none")

  temporal DeadlockFree = always(enabled(nextStep))
}
module ApprovalService_failures {
  import ApprovalService(Selectors = Set("s1", "s2"), CanFail = true).*
}
module ApprovalService_race {
  import ApprovalService(Selectors = Set("s1", "s2"), CanFail = false).*
}

// ApprovalService's own retirement receipt spans task creation, waiting callers,
// direct selection callbacks, the worker's deletion, and claimed timer callbacks.
// One request through one old instance; replacement may start only after stop.
// Durable rows left by already-pending cancellations/callback failure are retained.
module ApprovalRetirement {
  type State = {
    stopped: bool, retired: bool, replacement: bool,
    phase: str, task: bool, result: str
  }
  var s: State

  pure val phases = Set("idle", "creating", "publish", "cleanup", "pending",
    "selectionRead", "timeoutRead", "selectCallback", "timeoutCallback",
    "selectDelete", "timeoutDelete", "listing", "done")
  val inMap = Set("pending", "selectionRead").contains(s.phase) and s.result == "none"
  val busy = not(Set("idle", "done").contains(s.phase))

  action init = s' = {
    stopped: false, retired: false, replacement: false,
    phase: "idle", task: false, result: "none"
  }
  action Admit = all {
    not(s.stopped), s.phase == "idle",
    s' = { ...s, phase: "creating" }
  }
  action BeginList = all {
    not(s.stopped), s.phase == "idle",
    s' = { ...s, phase: "listing" }
  }
  action ListSettles = all {
    s.phase == "listing",
    s' = { ...s, phase: "done" }
  }
  action WriteDone = all {
    s.phase == "creating",
    s' = { ...s, phase: "publish", task: true }
  }
  action WriteFailed = all {
    s.phase == "creating",
    s' = { ...s, phase: "done", result: "rejected" }
  }
  action Publish = all {
    s.phase == "publish",
    s' = { ...s, phase: if (s.stopped) "cleanup" else "pending" }
  }
  action Cleanup = all {
    s.phase == "cleanup",
    s' = { ...s, phase: "done", task: false, result: "rejected" }
  }
  action BeginSelection = all {
    not(s.stopped), s.phase == "pending",
    s' = { ...s, phase: "selectionRead" }
  }
  action BeginTimeout = all {
    not(s.stopped), s.phase == "pending",
    s' = { ...s, phase: "timeoutRead" }
  }
  action ReadSelection = all {
    s.phase == "selectionRead",
    s' = { ...s, phase: if (s.stopped) "selectDelete" else "selectCallback" }
  }
  action SelectionReadFails = all {
    s.phase == "selectionRead",
    s' = { ...s, phase: if (s.stopped) "done" else "pending" }
  }
  action ReadTimeout = all {
    s.phase == "timeoutRead",
    s' = { ...s, phase: "timeoutCallback" }
  }
  action CallbackDone = all {
    Set("selectCallback", "timeoutCallback").contains(s.phase),
    s' = { ...s,
      phase: if (s.phase == "selectCallback") "selectDelete" else "timeoutDelete",
      result: if (s.phase == "selectCallback") "selected" else "timedOut"
    }
  }
  action CallbackFailed = all {
    Set("timeoutRead", "selectCallback", "timeoutCallback").contains(s.phase),
    s' = { ...s, phase: "done", result: if (s.result == "none") "rejected" else s.result }
  }
  action DeleteDone = all {
    Set("selectDelete", "timeoutDelete").contains(s.phase),
    s' = { ...s, phase: "done", task: false }
  }
  action DeleteFailed = all {
    Set("selectDelete", "timeoutDelete", "cleanup").contains(s.phase),
    s' = { ...s, phase: "done", result: if (s.result == "none") "rejected" else s.result }
  }
  action Cancel = all {
    s.phase == "pending",
    s' = { ...s, phase: "selectDelete", result: "cancelled" }
  }
  action Stop = all {
    not(s.stopped),
    s' = { ...s, stopped: true,
      phase: if (s.phase == "pending") "done" else s.phase,
      result: if (inMap) "cancelled" else s.result
    }
  }
  action Retire = all {
    s.stopped, not(s.retired), not(busy),
    s' = { ...s, retired: true }
  }
  action Replace = all {
    s.retired, not(s.replacement),
    s' = { ...s, replacement: true }
  }
  action step = any {
    Admit, BeginList, ListSettles, WriteDone, WriteFailed, Publish, Cleanup,
    BeginSelection, BeginTimeout, ReadSelection, SelectionReadFails, ReadTimeout,
    CallbackDone, CallbackFailed, DeleteDone, DeleteFailed, Cancel, Stop,
    Retire, Replace, s' = s
  }
  val TypeOK = phases.contains(s.phase) and Set("none", "selected", "timedOut", "cancelled", "rejected").contains(s.result)
  val NoLatePending = s.stopped implies not(inMap)
  val RetiredIsDrained = s.retired implies (s.stopped and not(busy))
  val ReplacementIsDrained = s.replacement implies s.retired
  temporal SettlesOnce = always((Set("selected", "timedOut", "cancelled", "rejected").forall(result =>
    s.result == result implies next(s.result) == result)).orKeep(s))
  temporal RetiredEffectsStay = always((s.retired implies
    (next(s.phase) == s.phase and next(s.task) == s.task and next(s.result) == s.result)).orKeep(s))
  temporal CompletionFairness = and {
    ListSettles.weakFair(s), any { WriteDone, WriteFailed }.weakFair(s), Publish.weakFair(s),
    any { Cleanup, DeleteFailed }.weakFair(s),
    any { ReadSelection, SelectionReadFails }.weakFair(s),
    any { ReadTimeout, CallbackFailed }.weakFair(s),
    any { CallbackDone, CallbackFailed }.weakFair(s),
    any { DeleteDone, DeleteFailed }.weakFair(s), Retire.weakFair(s)
  }
  temporal StopDrains = CompletionFairness implies always(s.stopped implies eventually(s.retired))
  temporal UnfairStopDrains = always(s.stopped implies eventually(s.retired))

  run lateWriteIsRejectedTest = init.then(Admit).then(Stop).then(WriteDone)
    .then(Publish).expect(s.phase == "cleanup" and not(s.retired))
    .then(Cleanup).then(Retire).then(Replace)
    .expect(s.result == "rejected" and not(s.task))
  run claimedSelectionFinishesTest = init.then(Admit).then(WriteDone).then(Publish)
    .then(BeginSelection).then(ReadSelection).then(Stop)
    .expect(not(s.retired) and s.result == "none")
    .then(CallbackDone).then(DeleteDone).then(Retire)
    .expect(s.result == "selected")
  run unclaimedSelectionCancelsTest = init.then(Admit).then(WriteDone).then(Publish)
    .then(BeginSelection).then(Stop).then(ReadSelection).then(DeleteDone).then(Retire)
    .expect(s.result == "cancelled")
  run claimedTimeoutRejectsTest = init.then(Admit).then(WriteDone).then(Publish)
    .then(BeginTimeout).then(Stop).then(ReadTimeout).then(CallbackFailed).then(Retire)
    .expect(s.result == "rejected" and s.task)
  run failedSelectionReadKeepsOwnerTest = init.then(Admit).then(WriteDone).then(Publish)
    .then(BeginSelection).then(SelectionReadFails).expect(inMap and s.result == "none")
    .then(Stop).then(Retire).expect(s.result == "cancelled")

}

// One persisted task: required callbacks (sync or async), or callback-free async.
// The maintained coding-tools caller supplies both callbacks. Attached metadata
// cannot replace source-owned choices, request identity or callback requirements.
// Their construction is checked against actual SQLite records. Task lookup succeeds here;
// the existing race/retirement modules cover read admission and claimed errors.
// Callback functions remain local; neither runtime restart nor worker-name
// registration recreates them. Deadline timers are owned only by the live
// instance. Startup timer reconstruction and durable callback retry are gaps.
module ApprovalPersisted {
  const NeedsCallbacks: bool
  type State = { phase: str, effect: str, restarted: bool, worker: bool }
  var s: State
  pure val phases = Set("live", "selectEffect", "timeoutEffect", "selectDelete",
    "timeoutDelete", "orphan", "selected", "deleted")
  val taskPresent = not(Set("selected", "deleted").contains(s.phase))
  val finished = Set("orphan", "selected", "deleted").contains(s.phase)

  action init = s' = { phase: "live", effect: "idle", restarted: false, worker: true }
  action Select = all {
    s.worker, s.phase == "live",
    s' = { ...s, phase: if (NeedsCallbacks) "selectEffect" else "selectDelete",
      effect: if (NeedsCallbacks) "running" else "idle" }
  }
  action Timeout = all {
    s.phase == "live",
    s' = { ...s, phase: if (NeedsCallbacks) "timeoutEffect" else "timeoutDelete",
      effect: if (NeedsCallbacks) "running" else "idle" }
  }
  action EffectDone = all {
    Set("selectEffect", "timeoutEffect").contains(s.phase),
    s' = { ...s, effect: "success",
      phase: if (s.phase == "selectEffect") "selectDelete" else "timeoutDelete" }
  }
  action EffectFailed = all {
    Set("selectEffect", "timeoutEffect").contains(s.phase),
    s' = { ...s, phase: "orphan", effect: "failure" }
  }
  action DeleteDone = all {
    Set("selectDelete", "timeoutDelete").contains(s.phase),
    s' = { ...s, phase: if (s.phase == "selectDelete") "selected" else "deleted" }
  }
  action DeleteFailed = all {
    Set("selectDelete", "timeoutDelete").contains(s.phase),
    s' = { ...s, phase: "orphan" }
  }
  action Restart = all {
    not(s.restarted), Set("live", "orphan").contains(s.phase),
    s' = { ...s, phase: "orphan", restarted: true, worker: false }
  }
  action RegisterSameName = all {
    s.restarted, not(s.worker),
    s' = { ...s, worker: true }
  }
  action SelectPersistedFree = all {
    not(NeedsCallbacks), s.worker, s.phase == "orphan",
    s' = { ...s, phase: "selectDelete" }
  }
  action RejectUnavailable = all {
    NeedsCallbacks, s.worker, s.phase == "orphan", s' = s
  }
  action Cancel = all {
    Set("live", "orphan").contains(s.phase),
    s' = { ...s, phase: "deleted" }
  }
  action step = any {
    Select, Timeout, EffectDone, EffectFailed, DeleteDone, DeleteFailed,
    Restart, RegisterSameName, SelectPersistedFree, RejectUnavailable, Cancel, s' = s
  }
  val TypeOK = phases.contains(s.phase) and Set("idle", "running", "success", "failure").contains(s.effect)
  val AcknowledgedSelectionHasEffect = (NeedsCallbacks and s.phase == "selected") implies s.effect == "success"
  val NoInventedFreeEffects = not(NeedsCallbacks) implies s.effect == "idle"
  val RestartCannotAcknowledgeCallback = (NeedsCallbacks and s.restarted) implies s.phase != "selected"
  temporal OrphanCannotResume = always(((NeedsCallbacks and s.phase == "orphan") implies
    (next(s.phase) == "orphan" or next(s.phase) == "deleted")).orKeep(s))
  temporal LostCallbackHasNoNewEffects = always(((NeedsCallbacks and s.phase == "orphan") implies
    next(s.effect) == s.effect).orKeep(s))
  temporal CompletionFairness = and {
    Timeout.weakFair(s), any { EffectDone, EffectFailed }.weakFair(s),
    any { DeleteDone, DeleteFailed }.weakFair(s)
  }
  temporal FairOutcome = CompletionFairness implies eventually(finished)
  temporal UnfairOutcome = eventually(finished)


}
module ApprovalPersisted_callbacks {
  import ApprovalPersisted(NeedsCallbacks = true).*
  run failedEffectIsNotAcknowledgedTest = init.then(Select).then(EffectFailed)
    .then(RejectUnavailable).expect(taskPresent and s.effect == "failure")
  run reRegistrationDoesNotRestoreCallbackTest = init.then(Restart).then(RegisterSameName)
    .then(RejectUnavailable).expect(taskPresent and s.effect == "idle")
  run completedEffectWithFailedDeleteIsNotRetriedTest = init.then(Select).then(EffectDone)
    .then(DeleteFailed).then(RejectUnavailable).expect(taskPresent and s.effect == "success")
}
module ApprovalPersisted_callbackFree {
  import ApprovalPersisted(NeedsCallbacks = false).*
  run callbackFreeTimerRemovesTaskTest = init.then(Timeout).then(DeleteDone).expect(not(taskPresent))
  run persistedFreeTaskCanBeSelectedTest = init.then(Restart).then(RegisterSameName)
    .then(SelectPersistedFree).then(DeleteDone).expect(s.phase == "selected")
}
