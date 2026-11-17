// One owner-confirmed local message reference. The UI confirmation is a host assumption.
// Identity dates use the reader's units; rawDate distinguishes provider representations.
module NativeMessageDeletion {
  type State = { phase: str, allowed: bool, rowExists: bool, rowMatches: bool,
    rawDate: int, captured: bool, capturedMatch: bool, capturedRaw: int,
    dispatches: int, applied: bool, authorizedAtDispatch: bool, foreignExists: bool, result: str }
  var s: State
  action init = s' = { phase: "read", allowed: true, rowExists: true, rowMatches: true,
    rawDate: 0, captured: false, capturedMatch: false, capturedRaw: 0,
    dispatches: 0, applied: false, authorizedAtDispatch: false, foreignExists: true, result: "none" }
  action capture = all { s.phase == "read", s.allowed,
    s' = { ...s, phase: "checked", captured: s.rowExists, capturedMatch: s.rowMatches, capturedRaw: s.rawDate } }
  action loseAccess = all { s.phase != "done", s.allowed, s' = s.with("allowed", false) }
  action changeIdentity = all { s.phase == "read" or s.phase == "checked", s.rowExists,
    s' = s.with("rowMatches", false) }
  action changeRawDate = all { s.phase == "checked", s.rawDate == 0,
    s' = s.with("rawDate", 1) }
  action externalRemove = all { s.phase == "read" or s.phase == "checked", s.rowExists,
    s' = s.with("rowExists", false) }
  action refuse = all { (s.phase == "read" or s.phase == "checked") and not(s.allowed),
    s' = { ...s, phase: "done", result: "refused" } }
  action missingBeforeEffect = all { s.phase == "checked", s.allowed, not(s.captured),
    s' = { ...s, phase: "done", result: "not-found" } }
  action staleBeforeEffect = all { s.phase == "checked", s.allowed, s.captured, not(s.capturedMatch),
    s' = { ...s, phase: "done", result: "stale" } }
  action dispatch(providerAccepts: bool): bool = all { s.phase == "checked", s.allowed,
    s.captured, s.capturedMatch, s.dispatches == 0,
    val matches = s.rowExists and s.rowMatches and s.rawDate == s.capturedRaw
    val applied = providerAccepts and matches
    s' = { ...s, phase: "effect", dispatches: 1, applied: applied,
      authorizedAtDispatch: true, rowExists: s.rowExists and not(applied) } }
  action knownDelete = all { s.phase == "effect", s.applied,
    s' = { ...s, phase: "done", result: "deleted" } }
  action missingAfterZero = all { s.phase == "effect", not(s.applied), s.allowed, not(s.rowExists),
    s' = { ...s, phase: "done", result: "not-found" } }
  action staleAfterZero = all { s.phase == "effect", not(s.applied), s.allowed, s.rowExists,
    not(s.rowMatches) or s.rawDate != s.capturedRaw,
    s' = { ...s, phase: "done", result: "stale" } }
  // Lost replies, unexplained counts or an unreadable post-effect check never mean deleted.
  action unknown = all { s.phase == "effect", s' = { ...s, phase: "done", result: "unknown" } }
  action progress = any { capture, refuse, missingBeforeEffect, staleBeforeEffect,
    dispatch(true), dispatch(false), knownDelete, missingAfterZero, staleAfterZero, unknown }
  action step = any { progress, loseAccess, changeIdentity, changeRawDate, externalRemove, s' = s }
  val TypeOK = Set("read", "checked", "effect", "done").contains(s.phase)
    and Set("none", "refused", "deleted", "not-found", "stale", "unknown").contains(s.result)
    and Set(0, 1).contains(s.rawDate) and Set(0, 1).contains(s.capturedRaw)
  val AtMostOneDispatch = s.dispatches >= 0 and s.dispatches <= 1
  val AppliedNeedsLiveAuthority = s.applied implies (s.authorizedAtDispatch and s.captured and s.capturedMatch)
  val ConfirmedMeansApplied = s.result == "deleted" implies s.applied
  val ForeignTransportPreserved = s.foreignExists
  val RefusalMeansNoDispatch = s.result == "refused" implies s.dispatches == 0
  temporal ResultStable = always((s.phase == "done" implies next(s.result) == s.result).orKeep(s))
  temporal FairProviderSettles = progress.weakFair(s) implies (s.phase != "done").leadsTo(s.phase == "done")
  run selectedDeleteTest = init.then(capture).then(dispatch(true)).then(knownDelete)
    .expect(s.result == "deleted" and not(s.rowExists) and ForeignTransportPreserved)
  run changedIdentityTest = init.then(capture).then(changeIdentity).then(dispatch(true)).then(staleAfterZero)
    .expect(s.result == "stale" and s.rowExists and not(s.applied))
  run changedRawDateTest = init.then(capture).then(changeRawDate).then(dispatch(true)).then(staleAfterZero)
    .expect(s.result == "stale" and s.rowExists)
  run accessBeforeEffectTest = init.then(capture).then(loseAccess).then(refuse)
    .expect(RefusalMeansNoDispatch and s.rowExists)
  run knownAfterAccessLossTest = init.then(capture).then(dispatch(true)).then(loseAccess).then(knownDelete)
    .expect(s.result == "deleted")
  run lostReplyTest = init.then(capture).then(dispatch(true)).then(unknown)
    .expect(s.result == "unknown" and s.dispatches == 1 and not(s.rowExists))
  run refusedProviderTest = init.then(capture).then(dispatch(false)).then(unknown)
    .expect(s.result == "unknown" and s.rowExists)
}
