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
      spc: s.spc.set(i, if (s.inMap) "onSelect" else "deleteTask"),
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
