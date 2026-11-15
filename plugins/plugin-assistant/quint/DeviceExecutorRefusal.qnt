// One reserved/claimed proposal and one host invocation. Only coordinator-owned
// no-call state or a trusted typed refusal can establish a no-effect receipt.
module DeviceExecutorRefusal {
  var s: { phase: int, retired: bool, expired: bool, calls: int, effects: int,
    authorizedAtCall: bool, outcome: int, receiptPending: bool,
    dispatch: int, copy: int, noEffectCode: bool, stableReceipt: bool }
  // outcome:0 pending,1 confirmed no effect,2 applied,3 unknown,4 ordinary failed.
  // dispatch:0 legacy/absent,1 not_started,2 attempted; copy:0 other,1 fixed,2 prefix.
  action freshInit = s' = { phase: 0, retired: false, expired: false, calls: 0, effects: 0,
    authorizedAtCall: true, outcome: 0, receiptPending: false,
    dispatch: 0, copy: 0, noEffectCode: false, stableReceipt: true }
  // Trusted prior coordinator no-call output; arbitrary unmarked fixed prose is
  // not established as authoritative by this legacy compatibility premise.
  action legacyFixedInit = s' = { phase: 3, retired: false, expired: false, calls: 0, effects: 0,
    authorizedAtCall: true, outcome: 1, receiptPending: true,
    dispatch: 0, copy: 1, noEffectCode: true, stableReceipt: true }
  action legacyPrefixInit = s' = { phase: 3, retired: false, expired: false, calls: 1, effects: 0,
    authorizedAtCall: true, outcome: 4, receiptPending: true,
    dispatch: 0, copy: 2, noEffectCode: false, stableReceipt: true }
  action init = any { freshInit, legacyFixedInit, legacyPrefixInit }
  action claim = all { s.phase == 0,
    s' = s.with("phase", if (s.retired) 3 else 1)
      .with("outcome", if (s.retired) 3 else 0) }
  action invoke = all { s.phase == 1,
    s' = if (s.retired or s.expired) s.with("phase", 3).with("outcome", 1)
      .with("dispatch", 1).with("noEffectCode", true).with("receiptPending", true)
      else s.with("phase", 2).with("calls", 1).with("authorizedAtCall", not(s.retired) and not(s.expired)),
  }
  // Explicit trusted-port premise, not inferred from an error name or prose.
  action confirmedRefusal = all { s.phase == 2, s.effects == 0,
    s' = s.with("phase", 3).with("outcome", 1).with("receiptPending", true)
      .with("dispatch", 1).with("copy", 2).with("noEffectCode", true) }
  action ordinaryFailure(copy: int): bool = all { s.phase == 2,
    s' = s.with("phase", 3).with("outcome", 4).with("receiptPending", true)
      .with("dispatch", 2).with("copy", copy).with("noEffectCode", false) }
  action effect = all { s.phase == 2, s.effects == 0,
    s' = s.with("effects", 1) }
  action success = all { s.phase == 2, s.effects == 1,
    s' = s.with("phase", 3).with("outcome", 2).with("receiptPending", true) }
  action unknown = all { s.phase < 3,
    s' = s.with("phase", 3).with("outcome", 3).with("receiptPending", true) }
  action retire = all { not(s.retired), s' = s.with("retired", true) }
  action expire = all { not(s.expired), s' = s.with("expired", true) }
  val restoredNoEffect = s.outcome.in(Set(1, 4)) and
    (s.dispatch == 1 or (s.dispatch == 0 and s.copy == 1))
  // Synchronization retries the stored receipt, never a native call. Markers
  // are preserved by the existing journal host; no control comes from new prose.
  action sync = all { s.phase == 3, s.receiptPending,
    s' = s.with("receiptPending", false)
      .with("stableReceipt", s.stableReceipt and restoredNoEffect == s.noEffectCode) }
  action advance = any { claim, invoke, confirmedRefusal, success, unknown,
    ordinaryFailure(0), ordinaryFailure(1), ordinaryFailure(2) }
  action step = any { advance, effect, retire, expire, sync, s' = s }
  val TypeOK = s.phase.in(0.to(3)) and s.calls.in(0.to(1))
    and s.effects.in(0.to(1)) and s.outcome.in(0.to(4))
    and s.dispatch.in(0.to(2)) and s.copy.in(0.to(2))
  val NoFalseNoEffectReceipt = (s.outcome == 1 or s.noEffectCode) implies s.effects == 0
  val EffectHadInvocation = s.effects > 0 implies s.calls == 1 and s.authorizedAtCall
  val SuccessHasEffect = s.outcome == 2 implies s.effects == 1
  val TerminalReceiptStable = s.stableReceipt
  temporal Settles = (s.phase < 3).leadsTo(s.phase == 3)
  temporal FairSettlement = advance.weakFair(s) implies Settles
  temporal TerminalNeverReplays = always((s.phase == 3 implies
    next(s.calls) == s.calls and next(s.effects) == s.effects).orKeep(s))
  run refusedClaimSettlesWithoutEffectTest = freshInit.then(claim).then(invoke)
    .then(confirmedRefusal).then(sync).expect(s.outcome == 1 and s.effects == 0 and s.calls == 1 and TerminalReceiptStable)
  run lostReplyAfterEffectIsUnknownTest = freshInit.then(claim).then(invoke)
    .then(effect).then(unknown).then(sync).expect(s.outcome == 3 and s.effects == 1 and TerminalReceiptStable)
  run retirementBeforeCallCannotDispatchTest = freshInit.then(claim).then(retire)
    .then(invoke).then(sync).expect(s.calls == 0 and s.effects == 0 and s.outcome == 1 and TerminalReceiptStable)
  run retirementDoesNotEraseAcceptedResultTest = freshInit.then(claim).then(invoke)
    .then(effect).then(retire).then(success).expect(s.outcome == 2 and s.effects == 1)
  run expiredBeforeInvocationCannotDispatchTest = freshInit.then(claim).then(expire)
    .then(invoke).then(sync).expect(s.calls == 0 and s.outcome == 1 and TerminalReceiptStable)
  run acceptedEffectSettlesAfterExpiryTest = freshInit.then(claim).then(invoke)
    .then(effect).then(expire).then(success).then(sync).expect(s.effects == 1 and s.outcome == 2 and TerminalReceiptStable)
  run ordinaryPrefixFailureKeepsItsReceiptTest = freshInit.then(claim).then(invoke)
    .then(ordinaryFailure(2)).then(sync).expect(s.dispatch == 2 and not(s.noEffectCode) and TerminalReceiptStable)
  run ordinaryExactFailureKeepsItsReceiptTest = freshInit.then(claim).then(invoke)
    .then(ordinaryFailure(1)).then(sync).expect(s.dispatch == 2 and not(s.noEffectCode) and TerminalReceiptStable)
  run failedEffectNeverAcquiresNoEffectCodeTest = freshInit.then(claim).then(invoke)
    .then(effect).then(ordinaryFailure(2)).then(sync).expect(s.effects == 1 and not(s.noEffectCode) and TerminalReceiptStable)
  run legacyFixedNoCallReceiptRemainsCompatibleTest = legacyFixedInit.then(sync)
    .expect(s.noEffectCode and TerminalReceiptStable)
  run unmarkedPrefixIsNotLegacyAuthorityTest = legacyPrefixInit.then(sync)
    .expect(not(s.noEffectCode) and TerminalReceiptStable)
}
