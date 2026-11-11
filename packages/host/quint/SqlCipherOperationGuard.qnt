// One operation on an already admitted SQLCipher handle. Owner verdicts come
// from the host. The native result and the caller's receipt are separate.
module SqlCipherOperationGuard {
  type Operation = Read | Write
  type Stage = BeforeCheck | NativeCall | AfterCheck | Settled
  type OwnerCheck = Allows | Refuses | Throws
  type Effect = NoEffect | ReadExecuted | WriteCommitted | NativeOutcomeUnknown
  type Reply = Pending | Accepted | RefusedBefore(bool) | RefusedAfter(bool) | NativeFailure
  type State = {
    operation: Operation, stage: Stage, effect: Effect, reply: Reply,
    closeAttempts: int, closeConfirmed: bool, closedUseRefused: bool,
  }
  var s: State

  pure def initial(operation: Operation): State = {
    operation: operation, stage: BeforeCheck, effect: NoEffect, reply: Pending,
    closeAttempts: 0, closeConfirmed: false, closedUseRefused: false,
  }
  action init = {
    nondet operation = Set(Read, Write).oneOf()
    s' = initial(operation)
  }
  action before(check: OwnerCheck): bool = all {
    s.stage == BeforeCheck,
    if (check == Allows) s' = s.with("stage", NativeCall)
    else s' = { ...s, stage: Settled, reply: RefusedBefore(check == Throws) },
  }
  action native(acknowledged: bool): bool = all {
    s.stage == NativeCall,
    if (acknowledged) s' = { ...s, stage: AfterCheck,
      effect: if (s.operation == Read) ReadExecuted else WriteCommitted }
    else s' = { ...s, stage: Settled, effect: NativeOutcomeUnknown, reply: NativeFailure },
  }
  action after(check: OwnerCheck): bool = all {
    s.stage == AfterCheck,
    s' = { ...s, stage: Settled,
      reply: if (check == Allows) Accepted else RefusedAfter(check == Throws) },
  }
  // A throw does not acknowledge native close. The adapter keeps its handle
  // state unconfirmed, so another caller can attempt close.
  action close(confirmed: bool): bool = all {
    s.stage == Settled, not(s.closeConfirmed), s.closeAttempts < 2,
    s' = { ...s, closeAttempts: s.closeAttempts + 1, closeConfirmed: confirmed },
  }
  action closedUse = all {
    s.closeConfirmed,
    s' = s.with("closedUseRefused", true),
  }
  action settleBefore = {
    nondet check = Set(Allows, Refuses, Throws).oneOf()
    before(check)
  }
  action settleNative = {
    nondet acknowledged = Set(false, true).oneOf()
    native(acknowledged)
  }
  action settleAfter = {
    nondet check = Set(Allows, Refuses, Throws).oneOf()
    after(check)
  }
  action closeAttempt = {
    nondet confirmed = Set(false, true).oneOf()
    close(confirmed)
  }
  action step = any {
    settleBefore, settleNative, settleAfter, closeAttempt, closedUse, s' = s,
  }

  val RefusalMatchesEffect = match s.reply {
    | Pending => s.stage != Settled
    | Accepted => s.effect.in(Set(ReadExecuted, WriteCommitted))
    | RefusedBefore(_) => s.effect == NoEffect
    | RefusedAfter(_) => s.effect.in(Set(ReadExecuted, WriteCommitted))
    | NativeFailure => s.effect == NativeOutcomeUnknown
  }
  val ReplyRequiresSettlement = (s.reply != Pending) implies s.stage == Settled
  val ClosedHandleRefusesUse = s.closedUseRefused implies s.closeConfirmed
  temporal OperationAuthorityAndReceipts = always(and {
    (s.effect == NoEffect and next(s.effect) != NoEffect) implies s.stage == NativeCall,
    (s.reply != Accepted and next(s.reply) == Accepted) implies s.stage == AfterCheck,
    s.effect != NoEffect implies next(s.effect) == s.effect,
    s.closeConfirmed implies (next(s.closeConfirmed) and next(s.closeAttempts) == s.closeAttempts),
  }.orKeep(s))
  temporal OperationEventuallySettles = eventually(s.stage == Settled)
  temporal FairOperationSettlement =
    (settleBefore.weakFair(s) and settleNative.weakFair(s) and settleAfter.weakFair(s))
    implies OperationEventuallySettles

  action writeInit = s' = initial(Write)
  action readInit = s' = initial(Read)
  run thrownBeforeWriteNeverDispatchesTest = writeInit.then(before(Throws))
    .expect(s.reply == RefusedBefore(true) and s.effect == NoEffect)
  run thrownAfterWriteDoesNotUndoCommitTest = writeInit.then(before(Allows)).then(native(true))
    .then(after(Throws)).expect(s.reply == RefusedAfter(true) and s.effect == WriteCommitted)
    .then(close(false)).expect(not(s.closeConfirmed) and s.closeAttempts == 1)
    .then(close(true)).then(closedUse).expect(s.closedUseRefused and s.effect == WriteCommitted)
  run nonUndefinedOwnerResultRefusesBeforeReadTest = readInit.then(before(Refuses))
    .expect(s.reply == RefusedBefore(false) and s.effect == NoEffect)
  run successfulReadRequiresBothChecksTest = readInit.then(before(Allows)).then(native(true))
    .expect(s.reply == Pending and s.effect == ReadExecuted)
    .then(after(Allows)).expect(s.reply == Accepted)
  run nativeFailureHasNoDurableOutcomeClaimTest = writeInit.then(before(Allows)).then(native(false))
    .expect(s.reply == NativeFailure and s.effect == NativeOutcomeUnknown)
}
