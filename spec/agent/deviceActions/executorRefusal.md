# Device executor refusal and settlement

One reserved and claimed device proposal reaches the host executor at most
once through `plugins/plugin-assistant/src/services/device-actions/client-coordinator.ts`.
[Claim and receipt custody](./execution.md) owns the journal around the call.
This spec owns what the coordinator may say about the call's effect: a
receipt that says "no effect" comes only from the coordinator's own no-call
path or from a trusted, typed refusal by the executor, never from an error's
name or text. Synchronizing a stored receipt retries the upload, never the
native call.

## Story: Say the device did nothing only when that is certain

> As a user, when a device action fails I am told it had no effect only when
> that is known. A lost reply after the device acted is reported as unknown,
> and retrying the report never runs the action again.

### The executor is called at most once, and only for a live, unexpired claim

The coordinator claims the proposal and then invokes the executor. If the
proposal was retired or has expired by then, it settles with a no-effect
receipt without calling the executor. Otherwise it calls once, while the
proposal is still authorized. An effect can only follow that call.

```quint
type CallPhase = CallUnclaimed | CallClaimed | CallInvoked | CallSettled
type CallOutcome = OutcomePending | ConfirmedNoEffect | Applied | OutcomeUnknown | OrdinaryFailure
type ExecutorCall = { phase: CallPhase, retired: bool, expired: bool, calls: int, effects: int, authorizedAtCall: bool, outcome: CallOutcome, receiptPending: bool, noEffectCode: bool }
pure val initial: ExecutorCall = { phase: CallUnclaimed, retired: false, expired: false, calls: 0, effects: 0, authorizedAtCall: false, outcome: OutcomePending, receiptPending: false, noEffectCode: false }
pure def canClaimCall(c: ExecutorCall): bool = c.phase == CallUnclaimed and not(c.retired)
pure def claimCall(c: ExecutorCall): ExecutorCall = { ...c, phase: CallClaimed }
pure def canInvoke(c: ExecutorCall): bool = c.phase == CallClaimed
pure def invoke(c: ExecutorCall): ExecutorCall =
  if (c.retired or c.expired) { ...c, phase: CallSettled, outcome: ConfirmedNoEffect, noEffectCode: true, receiptPending: true }
  else { ...c, phase: CallInvoked, calls: 1, authorizedAtCall: true }
pure def canLandEffect(c: ExecutorCall): bool = c.phase == CallInvoked and c.effects == 0
pure def landEffect(c: ExecutorCall): ExecutorCall = { ...c, effects: 1 }
pure def canRetire(c: ExecutorCall): bool = not(c.retired)
pure def retire(c: ExecutorCall): ExecutorCall = { ...c, retired: true }
pure def canExpire(c: ExecutorCall): bool = not(c.expired)
pure def expire(c: ExecutorCall): ExecutorCall = { ...c, expired: true }
pure def alwaysAtMostOneCallAndEffect(c: ExecutorCall): bool = c.calls >= 0 and c.calls <= 1 and c.effects >= 0 and c.effects <= 1
pure def alwaysEffectHadAnAuthorizedCall(c: ExecutorCall): bool = c.effects > 0 implies (c.calls == 1 and c.authorizedAtCall)
pure def sometimesRetiredBeforeCallHasNoEffect(c: ExecutorCall): bool = c.retired and c.calls == 0 and c.outcome == ConfirmedNoEffect
```

### A no-effect receipt needs a trusted refusal or no call at all

After the call, a trusted typed refusal settles the attempt as confirmed with
no effect; the premise of that port is that the executor did nothing. An
ordinary failure keeps its own receipt and never gains the no-effect code. A
success needs the effect. Any attempt not yet settled can become unknown when
its reply is lost.

```quint
pure def canRefuseTrusted(c: ExecutorCall): bool = c.phase == CallInvoked and c.effects == 0
pure def refuseTrusted(c: ExecutorCall): ExecutorCall = { ...c, phase: CallSettled, outcome: ConfirmedNoEffect, noEffectCode: true, receiptPending: true }
pure def canFailOrdinarily(c: ExecutorCall): bool = c.phase == CallInvoked
pure def failOrdinarily(c: ExecutorCall): ExecutorCall = { ...c, phase: CallSettled, outcome: OrdinaryFailure, noEffectCode: false, receiptPending: true }
pure def canSucceed(c: ExecutorCall): bool = c.phase == CallInvoked and c.effects == 1
pure def succeed(c: ExecutorCall): ExecutorCall = { ...c, phase: CallSettled, outcome: Applied, receiptPending: true }
pure def canLoseReply(c: ExecutorCall): bool = c.phase == CallClaimed or c.phase == CallInvoked
pure def loseReply(c: ExecutorCall): ExecutorCall = { ...c, phase: CallSettled, outcome: OutcomeUnknown, receiptPending: true }
pure def alwaysNoEffectReceiptIsTrue(c: ExecutorCall): bool = (c.outcome == ConfirmedNoEffect or c.noEffectCode) implies c.effects == 0
pure def alwaysSuccessHasEffect(c: ExecutorCall): bool = c.outcome == Applied implies c.effects == 1
pure def sometimesRefusedAfterCallWithoutEffect(c: ExecutorCall): bool = c.outcome == ConfirmedNoEffect and c.calls == 1 and not(c.receiptPending)
pure def sometimesLostReplyAfterEffectIsUnknown(c: ExecutorCall): bool = c.outcome == OutcomeUnknown and c.effects == 1
```

### Synchronizing a settled receipt never repeats the call

Synchronization uploads the stored receipt of a settled attempt. Once settled,
no event changes the call count, the effect count or the outcome.

```quint
pure def canSyncReceipt(c: ExecutorCall): bool = c.phase == CallSettled and c.receiptPending
pure def syncReceipt(c: ExecutorCall): ExecutorCall = { ...c, receiptPending: false }
pure def stepSettledAttemptNeverReplays(before: ExecutorCall, after: ExecutorCall): bool =
  before.phase == CallSettled implies (after.phase == CallSettled and after.calls == before.calls and after.effects == before.effects and after.outcome == before.outcome)
```
