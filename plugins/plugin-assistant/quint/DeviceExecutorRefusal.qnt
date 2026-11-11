// Coordinator projection: one reserved/claimed proposal and one host invocation.
// Only a trusted executor's no-effect refusal may settle as not dispatched.
module DeviceExecutorRefusal {
  var s: { phase: int, retired: bool, calls: int, effects: int,
    authorizedAtCall: bool, outcome: int, receiptPending: bool }
  // outcome: 0 pending, 1 confirmed no effect, 2 applied, 3 unknown.
  action init = s' = { phase: 0, retired: false, calls: 0, effects: 0,
    authorizedAtCall: true, outcome: 0, receiptPending: false }
  action claim = all { s.phase == 0,
    s' = s.with("phase", if (s.retired) 3 else 1)
      .with("outcome", if (s.retired) 3 else 0) }
  action invoke = all { s.phase == 1,
    s' = if (s.retired) s.with("phase", 3).with("outcome", 1)
      else s.with("phase", 2).with("calls", 1).with("authorizedAtCall", not(s.retired)),
  }
  // This is an explicit trusted-port premise, not inferred from an error name.
  action confirmedRefusal = all { s.phase == 2, s.effects == 0,
    s' = s.with("phase", 3).with("outcome", 1).with("receiptPending", true) }
  action effect = all { s.phase == 2, s.effects == 0,
    s' = s.with("effects", 1) }
  action success = all { s.phase == 2, s.effects == 1,
    s' = s.with("phase", 3).with("outcome", 2).with("receiptPending", true) }
  action unknown = all { s.phase < 3,
    s' = s.with("phase", 3).with("outcome", 3).with("receiptPending", true) }
  action retire = all { not(s.retired), s' = s.with("retired", true) }
  // Explicit history synchronization retries a receipt, never the native call.
  action sync = all { s.phase == 3, s.receiptPending,
    s' = s.with("receiptPending", false) }
  action advance = any { claim, invoke, confirmedRefusal, success, unknown }
  action step = any { advance, effect, retire, sync, s' = s }
  val TypeOK = s.phase.in(0.to(3)) and s.calls.in(0.to(1))
    and s.effects.in(0.to(1)) and s.outcome.in(0.to(3))
  val NoFalseNoEffectReceipt = s.outcome == 1 implies s.effects == 0
  val EffectHadInvocation = s.effects > 0 implies s.calls == 1 and s.authorizedAtCall
  val SuccessHasEffect = s.outcome == 2 implies s.effects == 1
  temporal Settles = (s.phase < 3).leadsTo(s.phase == 3)
  temporal FairSettlement = advance.weakFair(s) implies Settles
  temporal TerminalNeverReplays = always((s.phase == 3 implies
    next(s.calls) == s.calls and next(s.effects) == s.effects).orKeep(s))
  run refusedClaimSettlesWithoutEffectTest = init.then(claim).then(invoke)
    .then(confirmedRefusal).then(sync).expect(s.outcome == 1 and s.effects == 0 and s.calls == 1)
  run lostReplyAfterEffectIsUnknownTest = init.then(claim).then(invoke)
    .then(effect).then(unknown).then(sync).expect(s.outcome == 3 and s.effects == 1)
  run retirementBeforeCallCannotDispatchTest = init.then(claim).then(retire)
    .then(invoke).expect(s.calls == 0 and s.effects == 0 and s.outcome == 1)
  run retirementDoesNotEraseAcceptedResultTest = init.then(claim).then(invoke)
    .then(effect).then(retire).then(success).expect(s.outcome == 2 and s.effects == 1)
}
