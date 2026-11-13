// src/runtime/action-handler-settlement.ts. Every original await remains a transition.
// Transport completion, late callbacks, admission denial and replyFailure stay distinct.
module ActionSettlement {

  const InHandler: int

  const Late: int

  const Outcomes: Set[str]

  const MayDeny: bool

  pure val N = InHandler + Late

  type State = {
    spc: str,
    hpc: str,
    phase: str,
    outcome: str,
    emitted: int,
    buffer: List[int],
    chain: List[int],
    busy: bool,
    delivered: List[int],
    target: int
  }

  var s: State

  action init = s' = {
    spc: "admit",
    hpc: "idle",
    phase: "pending",
    outcome: "none",
    emitted: 0,
    buffer: [],
    chain: [],
    busy: false,
    delivered: [],
    target: 0
  }

  pure def receive(v: State, id: int): State =
  if (v.phase == "pending") {
    ...v,
    buffer: v.buffer.append(id)
  }
  else if (v.phase == "failed" or v.outcome == "replyFailure") v
  else {
    ...v,
    chain: v.chain.append(id)
  }

  action Admit = all {
    s.spc == "admit",
    any {
      all {
        MayDeny,
        s' = {
          ...s,
          phase: "failed",
          spc: "done"
        }
      },
      s' = {
        ...s,
        spc: "wait",
        hpc: "running"
      }
    }
  }

  action HandlerEmit = all {
    s.hpc == "running",
    s.emitted < InHandler,
    s' = receive({
      ...s,
      emitted: s.emitted + 1
    }, s.emitted + 1)
  }

  action HandlerReturn = {
    nondet o = Outcomes.oneOf()
    all {
      s.hpc == "running",
      s.emitted == InHandler,
      s' = {
        ...s,
        outcome: o,
        hpc: "returned"
      }
    }
  }

  action LateEmit = all {
    s.hpc == "returned",
    s.emitted < N,
    s' = receive({
      ...s,
      emitted: s.emitted + 1
    }, s.emitted + 1)
  }

  action Settle = all {
    s.spc == "wait",
    s.hpc == "returned",
    s' = if (Set("invalid", "throw").contains(s.outcome)) {
      ...s,
      phase: "failed",
      buffer: [],
      spc: "done"
    } else if (s.outcome == "replyFailure") {
      ...s,
      phase: "settled",
      buffer: [],
      spc: "done"
    } else {
      ...s,
      phase: "settled",
      chain: s.chain.concat(s.buffer),
      target: s.delivered.length() + s.chain.length() + s.buffer.length(),
      spc: "drain"
    }
  }

  action Deliver = all {
    not(s.busy),
    s.chain.length() > 0,
    s' = {
      ...s,
      delivered: s.delivered.append(s.chain.head()),
      chain: s.chain.tail(),
      busy: true
    }
  }

  action TransportSettle = all {
    s.busy,
    s' = {
      ...s,
      busy: false
    }
  }

  action Drained = all {
    s.spc == "drain",
    s.delivered.length() > s.target or (s.delivered.length() == s.target and not(s.busy)),
    s' = {
      ...s,
      spc: "done"
    }
  }

  val Finished = s.spc == "done" and not(s.busy) and s.chain.length() == 0 and (s.hpc == "idle" or
  s.emitted == N)

  action nextStep = any {
    Admit,
    HandlerEmit,
    HandlerReturn,
    LateEmit,
    Settle,
    Deliver,
    TransportSettle,
    Drained,
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
    Set("admit", "wait", "drain", "done").contains(s.spc),
    Set("idle", "running", "returned").contains(s.hpc),
    Set("pending", "settled", "failed").contains(s.phase),
    Outcomes.union(Set("none")).contains(s.outcome),
    s.emitted >= 0,
    s.emitted <= N,
    s.buffer.indices().forall(i => s.buffer.nth(i) >= 1 and s.buffer.nth(i) <= N),
    s.chain.indices().forall(i => s.chain.nth(i) >= 1 and s.chain.nth(i) <= N),
    s.delivered.indices().forall(i => s.delivered.nth(i) >= 1 and s.delivered.nth(i) <= N)
  }

  val DeliveredInEmissionOrder = s.delivered.indices().forall(i => s.delivered.indices().forall(j => i < j implies
  s.delivered.nth(i) < s.delivered.nth(j)))

  val DeliveredOnlyEmitted = s.delivered.indices().forall(i => s.delivered.nth(i) <= s.emitted)

  val NoneAfterFailure = s.phase == "failed" implies s.delivered.length() == 0

  val NoneOnReplyFailure = s.outcome == "replyFailure" implies s.delivered.length() == 0

  val NoneWhilePending = s.phase == "pending" implies s.delivered.length() == 0

  temporal Fairness = and {
    nextStep.weakFair(s),
    HandlerEmit.weakFair(s),
    HandlerReturn.weakFair(s),
    LateEmit.weakFair(s),
    Settle.weakFair(s),
    Deliver.weakFair(s),
    TransportSettle.weakFair(s),
    Drained.weakFair(s)
  }

  temporal SettleReturns = Fairness implies eventually(s.spc == "done")

  temporal AllDelivered = Fairness implies eventually(always(s.phase == "settled" and s.outcome == "ok" implies
  s.delivered.length() == N))

  temporal DeadlockFree = always(enabled(nextStep))
}
module ActionSettlement_late {
  import ActionSettlement(InHandler = 3, Late = 3, Outcomes = Set("ok"), MayDeny = false).*
}
module ActionSettlement_outcomes {
  import ActionSettlement(InHandler = 2, Late = 1, Outcomes = Set("ok", "replyFailure", "invalid", "throw"), MayDeny = true).*
}
