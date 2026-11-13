// Two one-shot calls after the adapter is installed on the owned SDK clients.
// SDK settlement and the wrapper's finally continuation are separate steps.
module TelegramCancellation {
  pure val Calls = Set(1, 2)
  pure val Owners = Set(1, 2)
  type Reason = { kind: str, name: str }
  pure val NativeAbort = { kind: "native", name: "AbortError" }
  pure val NativeTimeout = { kind: "native", name: "TimeoutError" }
  pure val Legacy = { kind: "legacy", name: "AbortError" }
  pure val Custom = { kind: "custom", name: "custom" }
  pure val Reasons = Set(NativeAbort, NativeTimeout, Legacy, Custom)
  type CallState = {
    phase: str, controller: int, preAborted: bool,
    listener: bool, added: int, removed: int,
    ownedAborted: bool, forwardedBy: int,
    reasonToken: str, reasonName: str, writable: bool,
    sdk: str, sdkReceipt: int, delivered: str, deliveredReceipt: int
  }
  type State = {
    owner: int -> int, originalOwner: int -> int,
    reason: int -> Reason, originalReason: int -> Reason,
    aborted: int -> bool, calls: int -> CallState
  }
  var s: State

  pure val idleCall = {
    phase: "idle", controller: 0, preAborted: false,
    listener: false, added: 0, removed: 0,
    ownedAborted: false, forwardedBy: 0,
    reasonToken: "none", reasonName: "none", writable: false,
    sdk: "none", sdkReceipt: 0, delivered: "none", deliveredReceipt: 0
  }
  pure def initialState(owner: int -> int, reason: int -> Reason): State = {
    owner: owner, originalOwner: owner, reason: reason, originalReason: reason,
    aborted: Owners.mapBy(_ => false), calls: Calls.mapBy(_ => idleCall)
  }
  action initShared = {
    nondet first = Reasons.oneOf()
    nondet second = Reasons.oneOf()
    s' = initialState(Calls.mapBy(_ => 1), Owners.mapBy(o => if (o == 1) first else second))
  }
  action initSeparate = {
    nondet first = Reasons.oneOf()
    nondet second = Reasons.oneOf()
    s' = initialState(Calls.mapBy(c => c), Owners.mapBy(o => if (o == 1) first else second))
  }
  action initMixed = {
    nondet first = Reasons.oneOf()
    nondet second = Reasons.oneOf()
    s' = initialState(Calls.mapBy(c => if (c == 1) 1 else 0), Owners.mapBy(o => if (o == 1) first else second))
  }
  def signalled(c: int): bool = s.owner.get(c) != 0
  def callerAborted(c: int): bool = if (signalled(c)) s.aborted.get(s.owner.get(c)) else false
  def kind(c: int): str = if (signalled(c)) s.reason.get(s.owner.get(c)).kind else "none"
  def reasonToken(c: int): str = if (kind(c) == "custom") {
    if (s.owner.get(c) == 1) "caller1" else "caller2"
  } else if (c == 1) "owned1" else "owned2"
  def reasonName(c: int): str = if (signalled(c)) s.reason.get(s.owner.get(c)).name else "none"
  def forwarded(c: int, call: CallState): CallState = {
    ...call, ownedAborted: true, forwardedBy: s.owner.get(c),
    reasonToken: reasonToken(c), reasonName: reasonName(c), writable: true
  }

  // Registration, precheck and SDK invocation contain no await in the adapter.
  // Even a pre-aborted request delegates once: the SDK owns its actual outcome.
  action begin(c: int): bool = {
    val call = { ...idleCall, phase: "running",
      controller: if (signalled(c)) c else 0,
      preAborted: callerAborted(c), listener: signalled(c),
      added: if (signalled(c)) 1 else 0 }
    all {
      s.calls.get(c).phase == "idle",
      s' = s.with("calls", s.calls.set(c, if (callerAborted(c)) forwarded(c, call) else call))
    }
  }
  // AbortSignal dispatches once listeners synchronously and removes them.
  // A listener registered after the original abort waits for finally cleanup.
  action abortOwner(o: int): bool = all {
    not(s.aborted.get(o)),
    s' = { ...s, aborted: s.aborted.set(o, true),
      calls: Calls.mapBy(c => if (s.owner.get(c) == o and s.calls.get(c).listener)
        forwarded(c, s.calls.get(c)).with("listener", false) else s.calls.get(c)) }
  }
  action settleAs(c: int, outcome: str): bool = all {
    s.calls.get(c).phase == "running",
    outcome != "abort" or s.calls.get(c).ownedAborted,
    s' = s.with("calls", s.calls.set(c, {
      ...s.calls.get(c), phase: "settled", sdk: outcome, sdkReceipt: c
    }))
  }
  action settle(c: int): bool = {
    nondet outcome = Set("success", "failure", "abort").oneOf()
    settleAs(c, outcome)
  }
  action finish(c: int): bool = all {
    s.calls.get(c).phase == "settled",
    s' = s.with("calls", s.calls.set(c, {
      ...s.calls.get(c), phase: "done", listener: false,
      removed: if (signalled(c)) 1 else 0,
      delivered: s.calls.get(c).sdk, deliveredReceipt: s.calls.get(c).sdkReceipt
    }))
  }
  action step = any {
    { nondet c = Calls.oneOf()
      any { begin(c), settle(c), finish(c) } },
    { nondet o = Owners.oneOf()
      abortOwner(o) },
    s' = s
  }

  val TypeOK = and {
    s.owner.keys() == Calls, s.originalOwner.keys() == Calls,
    s.reason.keys() == Owners, s.originalReason.keys() == Owners,
    s.aborted.keys() == Owners, s.calls.keys() == Calls,
    Owners.forall(o => Reasons.contains(s.reason.get(o))),
    Calls.forall(c => and {
      Set(0, 1, 2).contains(s.owner.get(c)),
      Set("idle", "running", "settled", "done").contains(s.calls.get(c).phase),
      Set("none", "success", "failure", "abort").contains(s.calls.get(c).sdk),
      Set("none", "success", "failure", "abort").contains(s.calls.get(c).delivered),
      Set(0, 1).contains(s.calls.get(c).added),
      Set(0, 1).contains(s.calls.get(c).removed),
      Set(0, 1, 2).contains(s.calls.get(c).controller),
      Set(0, 1, 2).contains(s.calls.get(c).forwardedBy),
      Set(0, 1, 2).contains(s.calls.get(c).sdkReceipt),
      Set(0, 1, 2).contains(s.calls.get(c).deliveredReceipt)
    })
  }
  val CallerOwnershipPreserved = s.owner == s.originalOwner and s.reason == s.originalReason
  val ControllerIsolation = Calls.forall(c =>
    s.calls.get(c).controller == (if (signalled(c) and s.calls.get(c).phase != "idle") c else 0))
  val CancellationOwnership = Calls.forall(c => and {
    s.calls.get(c).ownedAborted implies
      (signalled(c) and callerAborted(c) and s.calls.get(c).forwardedBy == s.owner.get(c)),
    (signalled(c) and callerAborted(c) and Set("running", "settled").contains(s.calls.get(c).phase))
      implies s.calls.get(c).ownedAborted
  })
  val ReasonPreservation = Calls.forall(c => s.calls.get(c).ownedAborted implies and {
    s.calls.get(c).reasonToken == reasonToken(c),
    s.calls.get(c).reasonName == reasonName(c), s.calls.get(c).writable
  })
  val ListenerCleanup = Calls.forall(c => and {
    s.calls.get(c).added == (if (signalled(c) and s.calls.get(c).phase != "idle") 1 else 0),
    s.calls.get(c).removed == (if (signalled(c) and s.calls.get(c).phase == "done") 1 else 0),
    s.calls.get(c).listener == (signalled(c)
      and Set("running", "settled").contains(s.calls.get(c).phase)
      and (s.calls.get(c).preAborted or not(callerAborted(c)))),
    s.calls.get(c).listener implies
      (signalled(c) and Set("running", "settled").contains(s.calls.get(c).phase)
        and s.calls.get(c).added == 1 and s.calls.get(c).removed == 0),
    (s.calls.get(c).phase == "done") implies
      (not(s.calls.get(c).listener) and s.calls.get(c).removed == (if (signalled(c)) 1 else 0)),
    not(signalled(c)) implies
      (not(s.calls.get(c).listener) and s.calls.get(c).added == 0
        and s.calls.get(c).removed == 0 and not(s.calls.get(c).ownedAborted))
  })
  val TruthfulSettlement = Calls.forall(c => and {
    (s.calls.get(c).phase == "done") implies and {
      s.calls.get(c).delivered == s.calls.get(c).sdk,
      s.calls.get(c).sdk != "none",
      s.calls.get(c).deliveredReceipt == c and s.calls.get(c).sdkReceipt == c
    },
    (s.calls.get(c).phase != "done") implies
      (s.calls.get(c).delivered == "none" and s.calls.get(c).deliveredReceipt == 0),
    (s.calls.get(c).sdk == "abort") implies s.calls.get(c).ownedAborted
  })
  val safety = TypeOK and CallerOwnershipPreserved and ControllerIsolation
    and CancellationOwnership and ReasonPreservation and ListenerCleanup and TruthfulSettlement

  temporal FinallyFair = Calls.forall(c => finish(c).weakFair(s))
  temporal SDKFair = Calls.forall(c => settle(c).weakFair(s))
  temporal SettledFinishesWithoutFairness = Calls.forall(c =>
    (s.calls.get(c).phase == "settled").leadsTo(s.calls.get(c).phase == "done"))
  temporal StartedFinishesWithoutFairness = Calls.forall(c =>
    (s.calls.get(c).phase == "running").leadsTo(s.calls.get(c).phase == "done"))
  temporal SettledFinishes = FinallyFair.implies(SettledFinishesWithoutFairness)
  temporal StartedFinishes = (SDKFair and FinallyFair).implies(StartedFinishesWithoutFairness)

  action nativeShared = s' = initialState(Calls.mapBy(_ => 1), Owners.mapBy(_ => NativeAbort))
  action timeoutShared = s' = initialState(Calls.mapBy(_ => 1), Owners.mapBy(_ => NativeTimeout))
  action customSeparate = s' = initialState(Calls.mapBy(c => c), Owners.mapBy(_ => Custom))
  action customShared = s' = initialState(Calls.mapBy(_ => 1), Owners.mapBy(_ => Custom))
  action legacyMixed = s' = initialState(Calls.mapBy(c => if (c == 1) 1 else 0), Owners.mapBy(_ => Legacy))
  // Negative-control boundary: passing the native caller reason directly to
  // the SDK retains its read-only message. This action is excluded from step.
  action obsoleteNativeReason(c: int): bool = all {
    s.calls.get(c).phase == "running", kind(c) == "native", callerAborted(c),
    s' = s.with("calls", s.calls.set(c, { ...s.calls.get(c),
      reasonToken: if (s.owner.get(c) == 1) "caller1" else "caller2", writable: false }))
  }
  run nativeReadOnlyReasonViolatesBoundaryTest = nativeShared.then(abortOwner(1)).then(begin(1))
    .then(obsoleteNativeReason(1)).expect(not(ReasonPreservation))
  run preAbortedNativeGetsOwnedWritableReasonTest = nativeShared.then(abortOwner(1)).then(begin(1))
    .expect(s.calls.get(1).ownedAborted and s.calls.get(1).listener
      and s.calls.get(1).reasonToken == "owned1" and safety)
  run nativeTimeoutKeepsItsOwnNameTest = timeoutShared.then(begin(1)).then(abortOwner(1))
    .expect(s.calls.get(1).reasonName == "TimeoutError" and s.calls.get(1).writable
      and s.reason.get(1).name == "TimeoutError" and safety)
  run separateOwnersDoNotCancelEachOtherTest = customSeparate.then(begin(1)).then(begin(2)).then(abortOwner(1))
    .expect(s.calls.get(1).ownedAborted and not(s.calls.get(2).ownedAborted)
      and s.calls.get(2).listener and safety)
  run sharedAbortReachesBothOwnedControllersTest = nativeShared.then(begin(1)).then(begin(2)).then(abortOwner(1))
    .expect(s.calls.get(1).reasonToken == "owned1" and s.calls.get(2).reasonToken == "owned2" and safety)
  run sharedCustomReasonKeepsCallerIdentityTest = customShared.then(begin(1)).then(begin(2)).then(abortOwner(1))
    .expect(s.calls.get(1).reasonToken == "caller1" and s.calls.get(2).reasonToken == "caller1" and safety)
  run settledSuccessSurvivesAbortBeforeFinallyTest = nativeShared.then(begin(1)).then(settleAs(1, "success"))
    .then(abortOwner(1)).then(finish(1)).expect(s.calls.get(1).delivered == "success" and safety)
  run lateAbortDoesNotTouchFinishedCallTest = customShared.then(begin(1)).then(begin(2))
    .then(settleAs(1, "failure")).then(finish(1)).then(abortOwner(1))
    .expect(not(s.calls.get(1).ownedAborted) and s.calls.get(1).delivered == "failure"
      and s.calls.get(2).ownedAborted and safety)
  run preAbortedLegacyAndNoSignalStaySeparateTest = legacyMixed.then(abortOwner(1)).then(begin(1)).then(begin(2))
    .then(settleAs(1, "abort")).then(finish(1)).then(settleAs(2, "success")).then(finish(2))
    .expect(s.calls.get(1).reasonName == "AbortError" and s.calls.get(2).added == 0 and safety)
}
