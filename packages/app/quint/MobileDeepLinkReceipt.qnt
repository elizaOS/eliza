// Source-linked Android capture/renderer/ack protocol. Two distinct native
// captures may carry the same URL. Receipt identities never wrap. Each capture
// has at most two application attempts and one renderer replacement is allowed.
// App retains pre-listener warm events. Cold onCreate capture does not emit an
// event until BridgeActivity dispatches onNewIntent for that launch Intent.
module MobileDeepLinkReceipt {
  pure val receipts = Set(1, 2)
  type State = {
    captured: int,
    warmCapture: bool,
    pendingNative: int,
    warmQueue: Set[int],
    peekReplies: Set[int],
    ready: bool,
    queued: Set[int],
    inFlight: Set[int],
    completed: Set[int],
    attempts: int -> int,
    acknowledgements: Set[int],
    applied: Set[int],
    rejected: Set[int],
    cleared: Set[int],
    replacements: int,
    lastAction: str,
    target: int,
    outcome: str
  }
  var s: State
  pure val initialState: State = {
    captured: 0,
    warmCapture: false,
    pendingNative: 0,
    warmQueue: Set(),
    peekReplies: Set(),
    ready: false,
    queued: Set(),
    inFlight: Set(),
    completed: Set(),
    attempts: Map(1 -> 0, 2 -> 0),
    acknowledgements: Set(),
    applied: Set(),
    rejected: Set(),
    cleared: Set(),
    replacements: 0,
    lastAction: "init",
    target: 0,
    outcome: ""
  }
  action init = s' = initialState

  // MainActivity captures before Capacitor dispatches the same Intent.
  // SharedPreferences updates its visible map before confirming the disk
  // commit. An unconfirmed commit therefore keeps this new visible identity.
  action capture(outcome: str, emitWarm: bool): bool = all {
    s.captured < 2,
    s' = {
      ...s,
      captured: s.captured + 1,
      warmCapture: emitWarm,
      pendingNative: s.captured + 1,
      warmQueue: if (emitWarm) s.warmQueue.union(Set(s.captured + 1)) else s.warmQueue,
      lastAction: "capture",
      target: s.captured + 1,
      outcome: outcome
    }
  }
  // BridgeActivity forwards the already captured initial Intent to App without
  // minting a second identity. App may also redeliver its retained event.
  action dispatchWarm(id: int): bool = all {
    id > 0 and id <= s.captured,
    s' = {
      ...s,
      warmQueue: s.warmQueue.union(Set(id)),
      lastAction: "dispatchWarm",
      target: id,
      outcome: ""
    }
  }
  // Peek returns a snapshot. Its bridge callback may arrive after another
  // capture has replaced the durable slot.
  action peek = all {
    s.pendingNative != 0,
    s' = {
      ...s,
      peekReplies: s.peekReplies.union(Set(s.pendingNative)),
      lastAction: "peek",
      target: s.pendingNative,
      outcome: ""
    }
  }
  action ready = all {
    not(s.ready),
    s' = {
      ...s,
      ready: true,
      queued: Set(),
      inFlight: s.inFlight.union(s.queued),
      attempts: receipts.mapBy(id => s.attempts.get(id) + (if (s.queued.contains(id)) 1 else 0)),
      lastAction: "ready",
      target: 0,
      outcome: ""
    }
  }
  // Exact-receipt replay joins the existing attempt or confirms an already
  // completed one. Distinct receipts are independent even for identical URLs.
  action deliver(id: int, channel: str): bool = all {
    if (channel == "warm") s.warmQueue.contains(id)
      else s.peekReplies.contains(id),
    s.attempts.get(id) < 2 or s.completed.contains(id)
      or s.queued.contains(id) or s.inFlight.contains(id),
    s' = {
      ...s,
      warmQueue: if (channel == "warm") s.warmQueue.exclude(Set(id)) else s.warmQueue,
      peekReplies: if (channel == "peek") s.peekReplies.exclude(Set(id)) else s.peekReplies,
      queued: if (s.completed.contains(id) or s.inFlight.contains(id) or s.ready) s.queued
        else s.queued.union(Set(id)),
      inFlight: if (s.ready and not(s.completed.contains(id)) and not(s.inFlight.contains(id)))
        s.inFlight.union(Set(id)) else s.inFlight,
      attempts: if (s.ready and not(s.completed.contains(id)) and not(s.inFlight.contains(id)))
        s.attempts.set(id, s.attempts.get(id) + 1) else s.attempts,
      acknowledgements: if (s.completed.contains(id)) s.acknowledgements.union(Set(id))
        else s.acknowledgements,
      lastAction: "deliver",
      target: id,
      outcome: channel
    }
  }
  // The renderer may acknowledge only an applied or explicitly rejected
  // navigation. Promise rejection and unconfirmed outcomes retain retry.
  action finish(id: int, outcome: str): bool = all {
    s.inFlight.contains(id),
    s' = {
      ...s,
      inFlight: s.inFlight.exclude(Set(id)),
      completed: if (outcome == "failed") s.completed else s.completed.union(Set(id)),
      acknowledgements: if (outcome == "failed") s.acknowledgements
        else s.acknowledgements.union(Set(id)),
      applied: if (outcome == "applied") s.applied.union(Set(id)) else s.applied,
      rejected: if (outcome == "rejected") s.rejected.union(Set(id)) else s.rejected,
      lastAction: "finish",
      target: id,
      outcome: outcome
    }
  }
  // acknowledgePendingUrl compares both URL and capture receipt under the same
  // native lock. Removal updates the visible map even if disk commit is
  // unconfirmed. Disk recovery after native death is outside this instance.
  action acknowledge(id: int, outcome: str): bool = all {
    s.acknowledgements.contains(id),
    s' = {
      ...s,
      acknowledgements: s.acknowledgements.exclude(Set(id)),
      pendingNative: if (s.pendingNative == id) 0 else s.pendingNative,
      cleared: if (s.pendingNative == id) s.cleared.union(Set(id)) else s.cleared,
      lastAction: "acknowledge",
      target: id,
      outcome: outcome
    }
  }
  // An older renderer supplies no capture receipt. The v2 bridge refuses to
  // consume its slot. New renderers likewise do not send URL-only acknowledgements
  // to a v1 bridge. Delivery is preserved with possible replay on a later boot.
  action legacyAcknowledge = s' = {
    ...s,
    lastAction: "legacyAcknowledge",
    target: 0,
    outcome: "retained"
  }
  // Renderer replacement drops local attempt bookkeeping. Already-issued native
  // acknowledgements may still arrive. The durable slot remains replayable.
  action replaceRenderer = all {
    s.replacements == 0,
    s' = {
      ...s,
      peekReplies: Set(),
      ready: false,
      queued: Set(),
      inFlight: Set(),
      completed: Set(),
      replacements: 1,
      lastAction: "replaceRenderer",
      target: 0,
      outcome: ""
    }
  }
  action step = any {
    {
      nondet outcome = Set("persisted", "unconfirmed").oneOf()
      nondet emitWarm = Set(true, false).oneOf()
      capture(outcome, emitWarm)
    },
    peek,
    ready,
    {
      nondet id = receipts.oneOf()
      dispatchWarm(id)
    },
    {
      nondet id = receipts.oneOf()
      nondet channel = Set("warm", "peek").oneOf()
      deliver(id, channel)
    },
    {
      nondet id = receipts.oneOf()
      nondet outcome = Set("applied", "rejected", "failed").oneOf()
      finish(id, outcome)
    },
    {
      nondet id = receipts.oneOf()
      nondet outcome = Set("persisted", "unconfirmed").oneOf()
      acknowledge(id, outcome)
    },
    legacyAcknowledge,
    replaceRenderer
  }
  val clearedOnlyAfterTerminal = s.cleared.subseteq(s.applied.union(s.rejected))
  val receiptsStayDistinct = and {
    s.queued.intersect(s.inFlight) == Set(),
    s.completed.intersect(s.inFlight) == Set(),
    s.completed.intersect(s.queued) == Set(),
    s.acknowledgements.subseteq(s.applied.union(s.rejected))
  }
  val finiteBounds = and {
    s.captured >= 0 and s.captured <= 2,
    s.pendingNative >= 0 and s.pendingNative <= s.captured,
    receipts.forall(id => s.attempts.get(id) >= 0 and s.attempts.get(id) <= 2),
    s.replacements >= 0 and s.replacements <= 1
  }
  val invariant = clearedOnlyAfterTerminal and receiptsStayDistinct and finiteBounds
  action initScenario = s' = initialState
  run distinctWarmReceiptsTest = initScenario
    .then(capture("persisted", true)).then(deliver(1, "warm")).then(ready)
    .then(capture("persisted", true)).then(deliver(2, "warm"))
    .then(finish(1, "applied")).then(acknowledge(1, "persisted"))
    .expect(s.pendingNative == 2)
    .then(finish(2, "rejected")).then(acknowledge(2, "persisted"))
    .expect(s.pendingNative == 0 and invariant)
  run warmBeforeListenerTest = initScenario
    .then(capture("persisted", true)).then(capture("persisted", true)).then(ready)
    .then(deliver(1, "warm")).then(deliver(2, "warm"))
    .then(finish(1, "applied")).then(acknowledge(1, "persisted"))
    .expect(s.pendingNative == 2 and s.attempts.get(1) == 1 and s.attempts.get(2) == 1)
  run coldInitialIntentTest = initScenario
    .then(capture("persisted", false)).then(dispatchWarm(1)).then(ready)
    .then(peek).then(deliver(1, "peek")).then(deliver(1, "warm"))
    .expect(s.attempts.get(1) == 1 and s.attempts.get(2) == 0)
    .then(finish(1, "applied")).then(acknowledge(1, "persisted"))
    .expect(s.pendingNative == 0 and invariant)
  run failedApplicationRetryTest = initScenario
    .then(capture("persisted", true)).then(ready).then(peek).then(deliver(1, "peek"))
    .then(finish(1, "failed")).then(peek).then(deliver(1, "peek"))
    .then(finish(1, "applied")).then(acknowledge(1, "unconfirmed"))
    .expect(s.attempts.get(1) == 2 and s.pendingNative == 0 and invariant)
}
