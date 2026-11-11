// One reviewed telephony proposal through the shared TS device coordinator.
// Native invocation is an abstract port: it never establishes carrier delivery,
// physical UI ownership, Android permission/role grants or native crash durability.
module TelephonyActionOwnership {
  type State = { phase: str, capable: bool, foreground: bool, current: bool,
    aborted: bool, approved: bool, claimed: bool, journal: str,
    dispatches: int, authorizedDispatch: bool, result: str, exact: bool,
    receipt: str }
  var s: State
  val admissible = s.capable and s.foreground and s.current and not(s.aborted)
  action initialize(capable: bool): bool = s' = {
    phase: "offered", capable: capable, foreground: true, current: true,
    aborted: false, approved: false, claimed: false, journal: "none",
    dispatches: 0, authorizedDispatch: false, result: "none", exact: false,
    receipt: "none" }
  action init = any { initialize(true), initialize(false) }
  action review = all { s.phase == "offered", admissible,
    s' = s.with("phase", "reviewed") }
  action reserve = all { s.phase == "reviewed", admissible,
    s' = s.with("phase", "reserved").with("journal", "reserved") }
  action approve = all { s.phase == "reserved", admissible,
    s' = s.with("phase", "approved").with("approved", true) }
  action claim = all { s.phase == "approved", admissible,
    s' = s.with("phase", "claimed").with("claimed", true).with("journal", "applying") }
  action dispatch = all { s.phase == "claimed", admissible, s.dispatches == 0,
    s' = s.with("phase", "dispatched").with("dispatches", 1).with("authorizedDispatch", true) }
  action cancel = all { not(s.aborted), s' = s.with("aborted", true) }
  action loseForeground = all { s.foreground, s' = s.with("foreground", false) }
  action changeSelection = all { s.current, s' = s.with("current", false) }
  action refuse = all {
    Set("offered", "reviewed", "reserved", "approved", "claimed").contains(s.phase),
    not(admissible), s' = s.with("phase", "blocked") }
  // A native exception can have an unknown effect; only an exact typed response
  // may establish success/failure. A contradictory response is not journaled.
  action nativeReply(result: str): bool = all { s.phase == "dispatched",
    Set("succeeded", "failed", "unknown").contains(result),
    s' = s.with("phase", "settled").with("journal", "terminal")
      .with("result", result).with("exact", result != "unknown") }
  action contradictoryReply = all { s.phase == "dispatched",
    s' = s.with("phase", "uncertain").with("result", "unknown") }
  action publishReceipt = all { s.phase == "settled", s.receipt == "none",
    s' = s.with("receipt", if (s.result == "succeeded" and s.exact) "applied"
      else if (s.result == "failed" and s.exact) "failed" else "unknown") }
  // Lost upload retains the same terminal journal. They never invoke
  // another port. Unknown outcomes cannot be upgraded by an owner's guess.
  action retryUpload = all { s.phase == "settled", s' = s }
  action reconcileUnknown = all { Set("settled", "uncertain").contains(s.phase),
    s.result == "unknown", s' = s }
  action step = any { review, reserve, approve, claim, dispatch, cancel,
    loseForeground, changeSelection, refuse, nativeReply("succeeded"),
    nativeReply("failed"), nativeReply("unknown"), contradictoryReply,
    publishReceipt, retryUpload, reconcileUnknown, s' = s }
  val TypeOK = Set("offered", "reviewed", "reserved", "approved", "claimed",
    "dispatched", "settled", "uncertain", "blocked").contains(s.phase)
    and Set("none", "reserved", "applying", "terminal").contains(s.journal)
    and Set("none", "succeeded", "failed", "unknown").contains(s.result)
    and Set("none", "applied", "failed", "unknown").contains(s.receipt)
  val AtMostOnce = s.dispatches >= 0 and s.dispatches <= 1
  val DispatchHasOriginalOwner = s.dispatches == 1 implies
    (s.approved and s.claimed and s.authorizedDispatch and s.journal != "none")
  val AppliedNeedsExactReceipt = s.receipt == "applied" implies
    (s.journal == "terminal" and s.result == "succeeded" and s.exact and s.dispatches == 1)
  val UnknownIsNotSuccess = s.result == "unknown" implies s.receipt != "applied"
  temporal NoDispatchAfterCancellation = always((s.aborted implies
    next(s.dispatches) == s.dispatches).orKeep(s))
  temporal NoDispatchAfterSelectionChange = always((not(s.current) implies
    next(s.dispatches) == s.dispatches).orKeep(s))
  temporal NoDispatchAfterForegroundLoss = always((not(s.foreground) implies
    next(s.dispatches) == s.dispatches).orKeep(s))
  temporal TerminalReceiptStable = always((s.receipt != "none" implies
    next(s.receipt) == s.receipt).orKeep(s))
  action settleNative = any { nativeReply("succeeded"), nativeReply("failed"),
    nativeReply("unknown"), contradictoryReply }
  temporal NativeSettles = (s.phase == "dispatched").leadsTo(s.phase != "dispatched")
  temporal FairNativeSettles = settleNative.weakFair(s) implies NativeSettles
  run missingCapabilityCannotDispatchTest = initialize(false).then(refuse)
    .expect(s.phase == "blocked" and s.dispatches == 0)
  run foregroundLossCannotDispatchTest = initialize(true).then(review)
    .then(reserve).then(approve).then(claim).then(loseForeground).then(refuse)
    .expect(s.phase == "blocked" and s.dispatches == 0)
  run contradictoryResultCannotPublishTest = initialize(true).then(review)
    .then(reserve).then(approve).then(claim).then(dispatch).then(contradictoryReply)
    .then(reconcileUnknown).expect(s.phase == "uncertain" and s.receipt == "none")
  run changedSelectionCannotDispatchTest = initialize(true).then(review)
    .then(reserve).then(approve).then(claim).then(changeSelection).then(refuse)
    .expect(s.dispatches == 0 and s.phase == "blocked")
  run cancelledBeforeDispatchTest = initialize(true).then(review).then(reserve)
    .then(approve).then(claim).then(cancel).then(refuse).expect(s.dispatches == 0)
  run lostUploadDoesNotRepeatTest = initialize(true).then(review).then(reserve)
    .then(approve).then(claim).then(dispatch).then(nativeReply("succeeded"))
    .then(retryUpload).then(publishReceipt).then(retryUpload)
    .expect(s.dispatches == 1 and s.receipt == "applied" and AppliedNeedsExactReceipt)
  run cancelCannotUndoKnownEffectTest = initialize(true).then(review).then(reserve)
    .then(approve).then(claim).then(dispatch).then(cancel).then(nativeReply("succeeded"))
    .then(publishReceipt).expect(s.dispatches == 1 and s.receipt == "applied")
  run unknownCannotBecomeSuccessTest = initialize(true).then(review).then(reserve)
    .then(approve).then(claim).then(dispatch).then(nativeReply("unknown"))
    .then(publishReceipt).then(reconcileUnknown).expect(UnknownIsNotSuccess)
}
