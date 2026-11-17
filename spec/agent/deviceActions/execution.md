# Device action custody

One device operation on the device that reviewed it: its local journal
entry, the server claim, the single executor call, the durable result that is
uploaded afterwards, and how its stored time is shown. The server's side of the request is the
[device actions](./index.md) spec; who may authorize an effect, and the SMS
bounds, are [telephony review](./telephonyReview.md).

The reminder journal is one such journal, shared by reminder creation and
revision-bound reminder actions. It validates its JSON and changes only by
an atomic compare-and-edit over a store owned by the current connection:
that connection's secure slot, by compare-and-exchange, on a device, and a
named browser document in a browser. Creation keeps at most 32 entries and
evicts confirmed entries first; the action store keeps at most 100; each
is bounded at 128 KiB serialized. A native outcome that is valid for a
different journal entry leaves the current entry pending.

## Story: Approve a device operation on the screen that reviewed it

> As a user, a device operation runs only after I approve it on the screen
> that reviewed it, or directly when I allow that, and only after the server
> claimed it for this device. It runs at most once.

### Dispatch needs an exact reservation and server claim

Only a live, nonsensitive, unexpired and exact context authorizes the
operation, by review or by an eligible direct request. The journal reserves
the exact operation; a prior entry is adopted only when it matches exactly
and holds no attempt, and anything else sends the entry to history recovery.
The server's claim grants the attempt, and the journal records applying
with that attempt before the executor is called. Retirement or expiry before
the call prevents it.

```quint
import telephonyReview.* from "./telephonyReview"
type DevicePhase = Unreviewed | Reviewed | JournalReserved | ServerClaimed | Applying | Dispatched | Settled | NeedsHistory
type DeviceOutcome = NoOutcome | Applied | ConfirmedNoEffect | Failed | Unknown
type ReserveEvidence = { newEntry: bool, exactMatch: bool, reservedWithoutAttempt: bool }
type DeviceAttempt = {
  phase: DevicePhase, operationId: int, attemptId: int, authorityKind: DeviceAuthority, retired: bool, expired: bool,
  calls: int, effects: int, result: DeviceOutcome, uploaded: bool, discarded: bool
}
pure val initial: DeviceAttempt = {
  phase: Unreviewed, operationId: 0, attemptId: 0, authorityKind: NoAuthority, retired: false, expired: false,
  calls: 0, effects: 0, result: NoOutcome, uploaded: false, discarded: false
}
pure def canShowProposal(s: DeviceAttempt, proposalValid: bool): bool = s.phase == Unreviewed and proposalValid and not(s.retired)
pure def showProposal(s: DeviceAttempt, proposalValid: bool): DeviceAttempt = { ...s, phase: Reviewed }
pure def canReserveAction(s: DeviceAttempt, operationId: int, evidence: AuthorityCheck): bool =
  s.phase == Reviewed and not(s.retired) and operationId > 0 and authority(evidence) != NoAuthority
pure def reserveAction(s: DeviceAttempt, operationId: int, evidence: AuthorityCheck, receipt: ReserveEvidence): DeviceAttempt =
  if (receipt.exactMatch and (receipt.newEntry or receipt.reservedWithoutAttempt))
    { ...s, operationId: operationId, authorityKind: authority(evidence), phase: JournalReserved }
  else { ...s, phase: NeedsHistory }
pure val operationIdValues = Set(0, 1, 2)
pure val receiptValues = Set(
  { newEntry: true, exactMatch: true, reservedWithoutAttempt: true },
  { newEntry: false, exactMatch: true, reservedWithoutAttempt: true },
  { newEntry: false, exactMatch: false, reservedWithoutAttempt: true },
  { newEntry: false, exactMatch: true, reservedWithoutAttempt: false }
)
pure def canAcceptClaim(s: DeviceAttempt, attemptId: int, exactClaim: bool): bool =
  s.phase == JournalReserved and not(s.retired) and attemptId > 0 and exactClaim
pure def acceptClaim(s: DeviceAttempt, attemptId: int, exactClaim: bool): DeviceAttempt =
  { ...s, phase: ServerClaimed, attemptId: attemptId }
pure val attemptIdValues = Set(0, 1, 2)
pure def canMarkApplying(s: DeviceAttempt): bool = s.phase == ServerClaimed and not(s.retired)
pure def markApplying(s: DeviceAttempt): DeviceAttempt = { ...s, phase: Applying }
pure def canRetireProposal(s: DeviceAttempt): bool = not(s.retired)
pure def retireProposal(s: DeviceAttempt): DeviceAttempt = { ...s, retired: true }
pure def canExpireProposal(s: DeviceAttempt): bool = not(s.expired)
pure def expireProposal(s: DeviceAttempt): DeviceAttempt = { ...s, expired: true }
pure def holdsClaim(phase: DevicePhase): bool =
  phase == ServerClaimed or phase == Applying or phase == Dispatched or phase == Settled
pure def alwaysDispatchOwnsClaim(s: DeviceAttempt): bool =
  (s.phase != Unreviewed and s.phase != Reviewed and s.phase != NeedsHistory implies
    s.operationId > 0 and s.authorityKind != NoAuthority) and
  (holdsClaim(s.phase) implies s.attemptId > 0)
pure def sometimesDirectRequestApplied(s: DeviceAttempt): bool = s.authorityKind == DirectRequest and s.result == Applied
```

### The executor is called at most once, for a live unexpired claim

Calling the executor needs the applying entry, the exact operation and the
current caller. If the proposal was retired or has expired by then, the
attempt settles as confirmed with no effect and the executor is never called.
Before dispatch the executor has not been called. An effect can only follow
that one call, and a dispatched effect may still land after its reply is
lost.

```quint
pure def canInvokeExecutor(s: DeviceAttempt, exactOperation: bool, currentCaller: bool): bool =
  s.phase == Applying and exactOperation and currentCaller
pure def invokeExecutor(s: DeviceAttempt, exactOperation: bool, currentCaller: bool): DeviceAttempt =
  if (s.retired or s.expired) { ...s, phase: Settled, result: ConfirmedNoEffect }
  else { ...s, phase: Dispatched, calls: 1 }
pure def canLandEffect(s: DeviceAttempt): bool =
  s.calls == 1 and s.effects == 0 and (s.phase == Dispatched or s.result == Unknown)
pure def landEffect(s: DeviceAttempt): DeviceAttempt = { ...s, effects: 1 }
pure def alwaysAtMostOneCallAndEffect(s: DeviceAttempt): bool =
  s.calls >= 0 and s.calls <= 1 and s.effects >= 0 and s.effects <= s.calls
pure def alwaysNoCallBeforeDispatch(s: DeviceAttempt): bool =
  (s.phase != Dispatched and s.phase != Settled) implies s.calls == 0
pure def stepOnlyApplyingCanCall(before: DeviceAttempt, after: DeviceAttempt): bool =
  after.calls > before.calls implies
    (before.phase == Applying and not(before.retired) and not(before.expired) and before.attemptId > 0)
pure def sometimesRetiredBeforeCallHasNoEffect(s: DeviceAttempt): bool =
  s.retired and s.calls == 0 and s.result == ConfirmedNoEffect
```

### No-effect needs a trusted refusal or no call

A settlement names the exact attempt. A trusted, typed refusal by the
executor settles it as confirmed with no effect; an ordinary failure keeps
its own receipt; success needs the effect and the operation's typed result,
and a malformed typed result leaves the applying entry for history recovery.
A lost reply is unknown, never success.

```quint
type ExecutorAnswer = AnswerSucceeded | AnswerRefused | AnswerFailed | AnswerLost
pure def answerOutcome(answer: ExecutorAnswer): DeviceOutcome =
  if (answer == AnswerSucceeded) Applied
  else if (answer == AnswerRefused) ConfirmedNoEffect
  else if (answer == AnswerFailed) Failed
  else Unknown
pure def canSettleAttempt(s: DeviceAttempt, answer: ExecutorAnswer, exactAttempt: bool, typedResult: bool): bool =
  s.phase == Dispatched and exactAttempt and
    (answer != AnswerSucceeded or (s.effects == 1 and typedResult)) and
    (answer != AnswerRefused or s.effects == 0)
pure def settleAttempt(s: DeviceAttempt, answer: ExecutorAnswer, exactAttempt: bool, typedResult: bool): DeviceAttempt =
  { ...s, phase: Settled, result: answerOutcome(answer) }
pure def alwaysNoEffectIsTrue(s: DeviceAttempt): bool = s.result == ConfirmedNoEffect implies s.effects == 0
pure def alwaysAppliedHadTheCall(s: DeviceAttempt): bool = s.result == Applied implies s.calls == 1 and s.effects == 1
pure def alwaysResultIsExplicit(s: DeviceAttempt): bool = (s.phase == Settled) == (s.result != NoOutcome)
pure def sometimesRefusedAfterCall(s: DeviceAttempt): bool = s.result == ConfirmedNoEffect and s.calls == 1
pure def sometimesLostReplyAfterEffectIsUnknown(s: DeviceAttempt): bool = s.result == Unknown and s.effects == 1
```

### A dispatched effect with an unknown result is resolved only by exact readback

An unknown result becomes applied only when a fresh read finds the exact
saved row, and confirmed with no effect only when the device definitively
refused and the fresh read shows the row absent. The live handler owns the
dispatch boundary: across an uncertain call the persisted entry stays
pending, and reconciliation asks the device for the row or receipt before
it changes the journal. The owner may discard an
unknown entry after a warning; the effect stays possible, and a discarded
entry is never resolved or applied to a successor's request.

```quint
pure def canResolveByReadback(s: DeviceAttempt, rowFound: bool, definiteRefusal: bool): bool =
  s.phase == Settled and s.result == Unknown and not(s.discarded) and
    (if (rowFound) s.effects == 1 else definiteRefusal and s.effects == 0)
pure def resolveByReadback(s: DeviceAttempt, rowFound: bool, definiteRefusal: bool): DeviceAttempt =
  { ...s, result: if (rowFound) Applied else ConfirmedNoEffect, uploaded: false }
pure def canDiscardUnknown(s: DeviceAttempt, ownerWarned: bool): bool =
  s.result == Unknown and ownerWarned and not(s.discarded)
pure def discardUnknown(s: DeviceAttempt, ownerWarned: bool): DeviceAttempt = { ...s, discarded: true }
pure def stepUnknownResolvedOnlyByReadback(before: DeviceAttempt, via: str, after: DeviceAttempt): bool =
  (before.result == Unknown and after.result != Unknown) implies via == "resolveByReadback"
pure def sometimesDiscardLeavesEffectUncertain(s: DeviceAttempt): bool = s.discarded and s.result == Unknown
```

## Story: Preserve a device result when the renderer retires

> As a user, a device result is saved before it is uploaded, survives the
> screen closing, and an operation whose outcome is unclear is never run
> again.

### A settled result is durable before upload and upload never repeats the call

The journal keeps a settled result even after the renderer retires. Upload
sends only the exact settled result; a failed upload leaves it for an
explicit retry, which uploads again and never calls the executor. Once
settled, the call count and the attempt never change, and neither does a
known result.

```quint
pure def canUploadResult(s: DeviceAttempt, exactAttempt: bool): bool =
  s.phase == Settled and not(s.uploaded) and exactAttempt
pure def uploadResult(s: DeviceAttempt, exactAttempt: bool, serverAccepted: bool): DeviceAttempt =
  { ...s, uploaded: serverAccepted }
pure def alwaysUploadMeansSettled(s: DeviceAttempt): bool = s.uploaded implies s.phase == Settled
pure def stepSettledNeverReplays(before: DeviceAttempt, after: DeviceAttempt): bool =
  before.phase == Settled implies
    (after.phase == Settled and after.calls == before.calls and after.operationId == before.operationId and
      after.attemptId == before.attemptId and (before.result != Unknown implies after.result == before.result))
pure def sometimesRetiredEffectRetained(s: DeviceAttempt): bool = s.phase == Settled and s.calls == 1 and s.retired
pure def sometimesExactResultUploaded(s: DeviceAttempt): bool = s.uploaded and s.result == Applied
```

## Story: Present a stored device receipt in the reviewed timezone

> As a user, a device receipt or review shows its time with the precision it
> was stored in, in the timezone I reviewed it in.

### Visible date precision follows the stored instant

The device formats a stored instant in the reviewed timezone for
availability, receipt and review screens. A time with a nonzero UTC second
or millisecond shows seconds; a nonzero millisecond also shows three
fractional digits; otherwise it shows minutes. Locale and timezone rules
come from the host's date formatter.

```quint
type DatePrecision = MinuteLabel | SecondLabel | MillisecondLabel
pure def receiptDatePrecision(seconds: int, milliseconds: int): DatePrecision =
  if (milliseconds != 0) MillisecondLabel else if (seconds != 0) SecondLabel else MinuteLabel
pure val secondsValues = Set(0, 1, 59)
pure val millisecondsValues = Set(0, 1, 999)
pure def lawFractionalReceiptRetainsPrecision(seconds: int, milliseconds: int): bool =
  milliseconds != 0 implies receiptDatePrecision(seconds, milliseconds) == MillisecondLabel
pure def lawMinuteReceiptHasNoExtraPrecision(seconds: int, milliseconds: int): bool =
  receiptDatePrecision(seconds, milliseconds) == MinuteLabel implies seconds == 0 and milliseconds == 0
```
