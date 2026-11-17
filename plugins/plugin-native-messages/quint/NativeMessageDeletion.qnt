// One owner-confirmed local message reference. The UI confirmation is a host assumption.
// Identity dates use the reader's units; rawDate distinguishes provider representations.
// The other transport holds a row with the same numeric id, thread and date.
module NativeMessageDeletion {
  type State = { phase: str, allowed: bool, target: str, rowExists: bool, rowMatches: bool, rowSettled: bool,
    rawDate: int, captured: bool, capturedMatch: bool, capturedSettled: bool, capturedRaw: int,
    dispatches: int, applied: bool, authorizedAtDispatch: bool, settledAtDispatch: bool,
    foreignExists: bool, result: str }
  var s: State
  val Transports = Set("sms", "mms")
  pure def other(kind: str): str = if (kind == "sms") "mms" else "sms"
  // MessageDeletion.Reference.collection(): the selected transport's own table.
  pure def collection(kind: str): str = kind

  // settled: an inbox or sent row. A draft, outbox, queued or failed row belongs to a send.
  action initWith(target: str, settled: bool): bool = s' = { phase: "read", allowed: true, target: target,
    rowExists: true, rowMatches: true, rowSettled: settled, rawDate: 0,
    captured: false, capturedMatch: false, capturedSettled: false, capturedRaw: 0,
    dispatches: 0, applied: false, authorizedAtDispatch: false, settledAtDispatch: false,
    foreignExists: true, result: "none" }
  action init = {
    nondet target = Transports.oneOf()
    nondet settled = Set(true, false).oneOf()
    initWith(target, settled)
  }
  action capture = all { s.phase == "read", s.allowed,
    s' = { ...s, phase: "checked", captured: s.rowExists, capturedMatch: s.rowMatches,
      capturedSettled: s.rowSettled, capturedRaw: s.rawDate } }
  action loseAccess = all { s.phase != "done", s.allowed, s' = s.with("allowed", false) }
  action changeIdentity = all { s.phase == "read" or s.phase == "checked", s.rowExists,
    s' = s.with("rowMatches", false) }
  action changeRawDate = all { s.phase == "checked", s.rawDate == 0,
    s' = s.with("rawDate", 1) }
  action externalRemove = all { s.phase == "read" or s.phase == "checked", s.rowExists,
    s' = s.with("rowExists", false) }
  // The composer or radio moves the row into or out of a send at any time before the effect.
  action changeBox = all { s.phase == "read" or s.phase == "checked", s.rowExists,
    s' = s.with("rowSettled", not(s.rowSettled)) }
  action refuse = all { (s.phase == "read" or s.phase == "checked") and not(s.allowed),
    s' = { ...s, phase: "done", result: "refused" } }
  action missingBeforeEffect = all { s.phase == "checked", s.allowed, not(s.captured),
    s' = { ...s, phase: "done", result: "not-found" } }
  action staleBeforeEffect = all { s.phase == "checked", s.allowed, s.captured, not(s.capturedMatch),
    s' = { ...s, phase: "done", result: "stale" } }
  action notSettledBeforeEffect = all { s.phase == "checked", s.allowed, s.captured, s.capturedMatch,
    not(s.capturedSettled), s' = { ...s, phase: "done", result: "not-settled" } }
  // One provider delete into a table. The selection binds id, thread, observed raw date and, when
  // settledOnly, a settled box. A delete sent to the other table removes its same-id row.
  action effect(into: str, settledOnly: bool, providerAccepts: bool): bool = all {
    s.phase == "checked", s.captured, s.capturedMatch, s.capturedSettled, s.dispatches == 0,
    val selected = s.rowExists and s.rowMatches and s.rawDate == s.capturedRaw
      and (s.rowSettled or not(settledOnly))
    val applied = providerAccepts and into == s.target and selected
    s' = { ...s, phase: "effect", dispatches: 1, applied: applied,
      authorizedAtDispatch: s.allowed, settledAtDispatch: s.rowSettled,
      rowExists: s.rowExists and not(applied),
      foreignExists: s.foreignExists and not(providerAccepts and into == other(s.target)) } }
  // MessageDeletion.delete: authority rechecked after the identity read, then the conditional delete.
  action dispatch(providerAccepts: bool): bool = all { s.allowed,
    effect(collection(s.target), true, providerAccepts) }
  action knownDelete = all { s.phase == "effect", s.applied,
    s' = { ...s, phase: "done", result: "deleted" } }
  action missingAfterZero = all { s.phase == "effect", not(s.applied), s.allowed, not(s.rowExists),
    s' = { ...s, phase: "done", result: "not-found" } }
  action staleAfterZero = all { s.phase == "effect", not(s.applied), s.allowed, s.rowExists,
    not(s.rowMatches) or s.rawDate != s.capturedRaw,
    s' = { ...s, phase: "done", result: "stale" } }
  action notSettledAfterZero = all { s.phase == "effect", not(s.applied), s.allowed, s.rowExists,
    s.rowMatches, s.rawDate == s.capturedRaw, not(s.rowSettled),
    s' = { ...s, phase: "done", result: "not-settled" } }
  // Lost replies, unexplained counts or an unreadable post-effect check never mean deleted.
  action unknown = all { s.phase == "effect", s' = { ...s, phase: "done", result: "unknown" } }
  action progress = any { capture, refuse, missingBeforeEffect, staleBeforeEffect, notSettledBeforeEffect,
    dispatch(true), dispatch(false), knownDelete, missingAfterZero, staleAfterZero, notSettledAfterZero, unknown }
  action step = any { progress, loseAccess, changeIdentity, changeRawDate, externalRemove, changeBox, s' = s }

  val TypeOK = Set("read", "checked", "effect", "done").contains(s.phase)
    and Transports.contains(s.target)
    and Set("none", "refused", "deleted", "not-found", "stale", "not-settled", "unknown").contains(s.result)
    and Set(0, 1).contains(s.rawDate) and Set(0, 1).contains(s.capturedRaw)
  val AtMostOneDispatch = s.dispatches >= 0 and s.dispatches <= 1
  val DispatchNeedsLiveAuthority = s.dispatches > 0 implies s.authorizedAtDispatch
  val OnlySettledRowsDeleted = s.applied implies s.settledAtDispatch
  val ConfirmedMeansApplied = s.result == "deleted" implies s.applied
  val ForeignTransportPreserved = s.foreignExists
  val RefusalMeansNoDispatch = s.result == "refused" implies s.dispatches == 0
  temporal ResultStable = always((s.phase == "done" implies next(s.result) == s.result).orKeep(s))
  temporal FairProviderSettles = progress.weakFair(s) implies (s.phase != "done").leadsTo(s.phase == "done")

  run selectedDeleteTest = initWith("sms", true).then(capture).then(dispatch(true)).then(knownDelete)
    .expect(s.result == "deleted" and not(s.rowExists) and ForeignTransportPreserved)
  run selectedMmsDeleteTest = initWith("mms", true).then(capture).then(dispatch(true)).then(knownDelete)
    .expect(s.result == "deleted" and not(s.rowExists) and ForeignTransportPreserved)
  run changedIdentityTest = initWith("sms", true).then(capture).then(changeIdentity).then(dispatch(true))
    .then(staleAfterZero).expect(s.result == "stale" and s.rowExists and not(s.applied))
  run changedRawDateTest = initWith("sms", true).then(capture).then(changeRawDate).then(dispatch(true))
    .then(staleAfterZero).expect(s.result == "stale" and s.rowExists)
  run inFlightSendTest = initWith("sms", false).then(capture).then(notSettledBeforeEffect)
    .expect(s.result == "not-settled" and s.rowExists and s.dispatches == 0)
  run requeuedAfterReadTest = initWith("mms", true).then(capture).then(changeBox).then(dispatch(true))
    .then(notSettledAfterZero).expect(s.result == "not-settled" and s.rowExists and not(s.applied))
  run accessBeforeEffectTest = initWith("sms", true).then(capture).then(loseAccess).then(refuse)
    .expect(RefusalMeansNoDispatch and s.rowExists)
  run knownAfterAccessLossTest = initWith("sms", true).then(capture).then(dispatch(true)).then(loseAccess)
    .then(knownDelete).expect(s.result == "deleted")
  run lostReplyTest = initWith("sms", true).then(capture).then(dispatch(true)).then(unknown)
    .expect(s.result == "unknown" and s.dispatches == 1 and not(s.rowExists))
  run refusedProviderTest = initWith("sms", true).then(capture).then(dispatch(false)).then(unknown)
    .expect(s.result == "unknown" and s.rowExists)

  // Witnesses: each removes one production guard and breaks the invariant that guard protects.
  run noAuthorityRecheckWitness = initWith("sms", true).then(capture).then(loseAccess)
    .then(effect(collection(s.target), true, true)).expect(not(DispatchNeedsLiveAuthority))
  run otherTableWitness = initWith("sms", true).then(capture)
    .then(effect(other(s.target), true, true)).expect(not(ForeignTransportPreserved))
  run anyBoxWitness = initWith("mms", true).then(capture).then(changeBox)
    .then(effect(collection(s.target), false, true)).expect(not(OnlySettledRowsDeleted) and not(s.rowExists))
}
