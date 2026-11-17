# Device execution

The device's half of a [device request](./index.md): one operation on the
device that reviewed it, from its journal reservation through the single
executor call to the result it reports back. The agent owns the request,
its claim and its ambiguity; this machine owns what the device knows and
does. It runs on the device and is exported as `DeviceExecution` from
`@elizaos/agent/client`; the native executors and review screens implement
it, and the operation shapes are `operations.md`.

The journal is a durable store on the device, owned by the current
connection; it keeps one entry per proposal, written by atomic
compare-and-edit. The shell checks that an entry belongs to this owner,
agent, origin, enrollment, proposal digest and operation hash before it
answers for it. Its size bounds are the platform's.

## Story: Approve a device operation on the screen that reviewed it

> As the owner, I want a device operation to run only after I approve it on
> the screen that reviewed it, or directly when I allowed that, and only
> after the agent claimed it for this device, so that it runs at most once.

### An effect needs review unless the current request may act directly

Authority needs a live, exact context: the screen still shows the reviewed
proposal, the context is not sensitive (a locked or private screen) and the
proposal has not expired. With it, the owner's review is approval. Without
review, the request in front of the owner acts directly only when the
owner's preference allows direct action and the operation is eligible for
it. Anything else has no authority.

```quint
import index as R from "./index"
type Authority = NoAuthority | Approval | DirectRequest
type AuthorityCheck = { live: bool, nonsensitive: bool, unexpired: bool, exact: bool, forceReview: bool, requestEligible: bool, reviewed: bool }
pure def authorityOf(check: AuthorityCheck): Authority =
  if (not(check.live and check.nonsensitive and check.unexpired and check.exact)) NoAuthority
  else if (check.reviewed) Approval
  else if (not(check.forceReview) and check.requestEligible) DirectRequest
  else NoAuthority
pure def lawForcedReviewNeedsApproval(check: AuthorityCheck): bool = (check.forceReview and not(check.reviewed)) implies authorityOf(check) == NoAuthority
```

### Dispatch needs an exact reservation and the agent's claim

With authority, the journal reserves the exact operation. A new entry, or
an earlier reservation of the same operation that never got a claim, is
this attempt; any other entry sends the owner to action history and nothing
runs. The device then approves and claims the request; the agent's claim
gives the attempt id (its session claim token), and the journal records
the entry as applying with that attempt before anything is called. A
retired screen claims nothing.

```quint
type JournalAnswer = NewEntry | UnclaimedReservation | OtherEntry
type NoEffectProof = NeverCalled | RefusedByExecutor | RefusedOnReadback
type DeviceResult = Applied | NoEffect({ proof: NoEffectProof }) | Unknown
type AttemptPhase = Proposed | Reserved | Applying | Called | Settled({ result: DeviceResult }) | NeedsHistory
type DeviceAttempt = { phase: AttemptPhase, operationId: str, attemptId: int, authority: Authority, retired: bool, calls: int, uploads: int }
pure val initial: DeviceAttempt = { phase: Proposed, operationId: "", attemptId: 0, authority: NoAuthority, retired: false, calls: 0, uploads: 0 }
pure val operationIdValues = Set("", "op1")
pure val attemptIdValues = Set(0, 1, 2)
pure val checkValues = Set(
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: true, requestEligible: true, reviewed: true },
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: false, requestEligible: true, reviewed: false },
  { live: true, nonsensitive: true, unexpired: true, exact: true, forceReview: true, requestEligible: true, reviewed: false },
  { live: false, nonsensitive: true, unexpired: true, exact: true, forceReview: false, requestEligible: true, reviewed: true })
pure def isSettled(phase: AttemptPhase): bool = match phase { | Settled(x) => true | _ => false }
pure def holdsClaim(phase: AttemptPhase): bool = phase == Applying or phase == Called or isSettled(phase)
pure def canReserve(s: DeviceAttempt, operationId: str, check: AuthorityCheck): bool = s.phase == Proposed and not(s.retired) and operationId != "" and authorityOf(check) != NoAuthority
pure def reserve(s: DeviceAttempt, operationId: str, check: AuthorityCheck, journal: JournalAnswer): DeviceAttempt =
  { ...s, phase: if (journal == OtherEntry) NeedsHistory else Reserved, operationId: operationId, authority: authorityOf(check) }
pure def canAcceptClaim(s: DeviceAttempt, attemptId: int): bool = s.phase == Reserved and not(s.retired) and attemptId > 0
pure def acceptClaim(s: DeviceAttempt, attemptId: int): DeviceAttempt = { ...s, phase: Applying, attemptId: attemptId }
pure def canRetire(s: DeviceAttempt): bool = not(s.retired)
pure def retire(s: DeviceAttempt): DeviceAttempt = { ...s, retired: true }
pure def alwaysClaimBeforeDispatch(s: DeviceAttempt): bool =
  (s.phase != Proposed implies (s.operationId != "" and s.authority != NoAuthority)) and (holdsClaim(s.phase) iff s.attemptId > 0) and s.attemptId >= 0
pure def sometimesExistingEntryGoesToHistory(s: DeviceAttempt): bool = s.phase == NeedsHistory
```

### The executor is called at most once, for a live claim

Calling the executor needs the applying entry. If the screen retired, the
proposal was withdrawn or its deadline passed before the call, the attempt
settles with no effect and the executor is never called. The call is the
`CallExecutor` effect, emitted once, for the claimed attempt.

```quint
type DeviceEffect = CallExecutor({ operationId: str, attemptId: int }) | SendReceipt({ attemptId: int, outcome: R::ReceiptOutcome }) | SendReview({ attemptId: int, review: R::ReviewOutcome })
type AttemptStep = { state: DeviceAttempt, out: List[DeviceEffect] }
pure def isCall(e: DeviceEffect): bool = match e { | CallExecutor(x) => true | _ => false }
pure def canInvokeExecutor(s: DeviceAttempt): bool = s.phase == Applying
pure def invokeExecutor(s: DeviceAttempt): AttemptStep =
  if (s.retired) { state: { ...s, phase: Settled({ result: NoEffect({ proof: NeverCalled }) }) }, out: List() }
  else { state: { ...s, phase: Called, calls: 1 }, out: List(CallExecutor({ operationId: s.operationId, attemptId: s.attemptId })) }
pure def alwaysAtMostOneCall(s: DeviceAttempt): bool =
  s.calls >= 0 and s.calls <= 1 and (s.phase == Called implies s.calls == 1) and ((holdsClaim(s.phase) and s.phase != Applying) or s.calls == 0)
pure def stepExecutorCalledOnceForTheClaim(before: DeviceAttempt, via: str, after: DeviceAttempt, out: List[DeviceEffect]): bool =
  (after.calls != before.calls or out.some(e => isCall(e))) implies
    (via == "invokeExecutor" and before.phase == Applying and not(before.retired) and before.calls == 0 and before.attemptId > 0 and out == List(CallExecutor({ operationId: before.operationId, attemptId: before.attemptId })))
pure def sometimesDirectRequestApplied(s: DeviceAttempt): bool = s.authority == DirectRequest and s.phase == Settled({ result: Applied })
pure def sometimesRetiredBeforeCallRanNothing(s: DeviceAttempt): bool = s.retired and s.calls == 0 and s.phase == Settled({ result: NoEffect({ proof: NeverCalled }) })
```

### No effect needs a trusted refusal or no call

The executor answers with its typed result: applied, or a typed refusal or
failure that says it did nothing. Anything else after the call (a lost
reply, a thrown error, a malformed result) is unknown, never applied and
never no effect. A screen that is gone when the answer comes keeps it.

```quint
type ExecutorAnswer = AnswerApplied | AnswerRefused | AnswerLost
pure def answerResult(answer: ExecutorAnswer): DeviceResult =
  if (answer == AnswerApplied) Applied else if (answer == AnswerRefused) NoEffect({ proof: RefusedByExecutor }) else Unknown
pure def canSettleCall(s: DeviceAttempt): bool = s.phase == Called
pure def settleCall(s: DeviceAttempt, answer: ExecutorAnswer): DeviceAttempt = { ...s, phase: Settled({ result: answerResult(answer) }) }
pure def alwaysNeverCalledMeansNoCall(s: DeviceAttempt): bool = s.phase == Settled({ result: NoEffect({ proof: NeverCalled }) }) implies s.calls == 0
pure def sometimesRefusedAfterTheCall(s: DeviceAttempt): bool = s.calls == 1 and s.phase == Settled({ result: NoEffect({ proof: RefusedByExecutor }) })
pure def sometimesLostReplyIsUnknown(s: DeviceAttempt): bool = s.calls == 1 and s.phase == Settled({ result: Unknown })
```

### An abandoned entry closes without running again

An entry no live screen owns is closed while the agent still awaits its
claim. A reservation never reached the call, so it settles with no effect
under the agent's attempt. An applying entry may have been called before
the process stopped, so it settles as unknown. Nothing is dispatched again.

```quint
pure def canCloseAbandoned(s: DeviceAttempt, attemptId: int): bool =
  s.retired and attemptId > 0 and (s.phase == Reserved or ((s.phase == Applying or s.phase == Called) and attemptId == s.attemptId))
pure def closeAbandoned(s: DeviceAttempt, attemptId: int): DeviceAttempt =
  if (s.phase == Reserved) { ...s, phase: Settled({ result: NoEffect({ proof: NeverCalled }) }), attemptId: attemptId }
  else { ...s, phase: Settled({ result: Unknown }) }
pure def sometimesAbandonedCallIsUnknown(s: DeviceAttempt): bool = s.retired and s.calls == 1 and s.phase == Settled({ result: Unknown })
```

### An unknown result is resolved only by exact readback

A fresh read of the device's own record for this attempt (the saved row,
or the native journal of a message, call or deletion) settles an unknown
result: the exact row found is applied, a definitive refusal is no effect.
Without such evidence it stays unknown. An approved deletion settles the
same way, through its own exact native receipt
([deferred deletion](../../os/android/deferredDeletion.md)).

```quint
type Readback = RowFound | DefiniteRefusal
pure def canReadBack(s: DeviceAttempt): bool = s.phase == Settled({ result: Unknown })
pure def readBack(s: DeviceAttempt, readback: Readback): DeviceAttempt =
  { ...s, phase: Settled({ result: if (readback == RowFound) Applied else NoEffect({ proof: RefusedOnReadback }) }) }
pure def stepUnknownResolvedOnlyByReadback(before: DeviceAttempt, via: str, after: DeviceAttempt): bool =
  (before.phase == Settled({ result: Unknown }) and after.phase != before.phase) implies via == "readBack"
pure def sometimesReadbackFoundNoEffect(s: DeviceAttempt): bool = s.phase == Settled({ result: NoEffect({ proof: RefusedOnReadback }) })
```

## Story: Preserve a device result when the screen retires

> As the owner, I want a device result saved before it is sent to the agent,
> kept when the screen closes, and sent again without running the operation
> again, so that a lost upload never repeats an effect.

### A settled result is durable before upload and upload never repeats the call

The journal keeps a settled result after the screen retires. Sending it is
the `SendReceipt` effect: the exact attempt and the outcome the journal
holds, applied, nothing ran or unknown. A failed send is sent again by the
history control or the next sync; the agent accepts the same receipt again
and refuses a different one. Sending never calls the executor, and a
settled entry never changes its call count, attempt or known result.

```quint
pure def receiptFor(result: DeviceResult): R::ReceiptOutcome = match result { | Applied => R::ReportedApplied | NoEffect(x) => R::ReportedNothingRan | Unknown => R::ReportedUnknown }
pure def settledResult(phase: AttemptPhase): DeviceResult = match phase { | Settled(x) => x.result | _ => Unknown }
pure def canSync(s: DeviceAttempt): bool = isSettled(s.phase)
pure def sync(s: DeviceAttempt): AttemptStep = { state: { ...s, uploads: s.uploads + 1 }, out: List(SendReceipt({ attemptId: s.attemptId, outcome: receiptFor(settledResult(s.phase)) })) }
pure def alwaysUploadFollowsSettlement(s: DeviceAttempt): bool = s.uploads >= 0 and (s.uploads > 0 implies isSettled(s.phase))
pure def stepSendingNeverCalls(before: DeviceAttempt, via: str, after: DeviceAttempt, out: List[DeviceEffect]): bool =
  (via == "sync" or via == "confirmReview") implies (after.calls == before.calls and not(out.some(e => isCall(e))))
pure def stepSettledEntryKeepsItsAttempt(before: DeviceAttempt, after: DeviceAttempt): bool =
  isSettled(before.phase) implies (isSettled(after.phase) and after.calls == before.calls and after.attemptId == before.attemptId and after.operationId == before.operationId and (settledResult(before.phase) != Unknown implies after.phase == before.phase))
pure def sometimesResultSentAfterTheScreenRetired(s: DeviceAttempt): bool = s.retired and s.calls == 1 and s.uploads > 0
pure def sometimesUploadRetried(s: DeviceAttempt): bool = s.uploads >= 2
```

### A review the owner confirms matches the saved evidence

When the agent holds the request as uncertain, the owner's review is sent
as the `SendReview` effect for the same attempt, and only as the journal's
evidence allows: applied for a saved applied result, not applied for a
saved no-effect result, and unresolved only while the result is unknown,
so a review never says more than the receipt would. Which operations may
stay unresolved is the operations' rule.

```quint
pure def reviewFor(result: DeviceResult): R::ReviewOutcome = match result { | Applied => R::ReviewedApplied | NoEffect(x) => R::ReviewedNotApplied | Unknown => R::ReviewedUnresolved }
pure def canConfirmReview(s: DeviceAttempt, review: R::ReviewOutcome): bool = isSettled(s.phase) and review == reviewFor(settledResult(s.phase))
pure def confirmReview(s: DeviceAttempt, review: R::ReviewOutcome): AttemptStep = { state: { ...s, uploads: s.uploads + 1 }, out: List(SendReview({ attemptId: s.attemptId, review: review })) }
pure val resultValues = Set(Applied, NoEffect({ proof: NeverCalled }), NoEffect({ proof: RefusedOnReadback }), Unknown)
pure def lawReviewAgreesWithTheReceipt(result: DeviceResult): bool = (reviewFor(result) == R::ReviewedApplied iff receiptFor(result) == R::ReportedApplied) and (reviewFor(result) == R::ReviewedUnresolved iff receiptFor(result) == R::ReportedUnknown)
```
