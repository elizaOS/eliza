# Original device read completion

A device read the user approved and shared completes the request that asked
for it, in the original conversation. [Device action custody](./execution.md)
owns the approval and the typed receipt; this spec follows one eligible
receipt to the answer.

## Story: Complete the original request with the result I explicitly shared

> As a user, a device read I shared completes the request that asked for it,
> only for me and only once, even if the answer is lost.

### Only the original receipt under its durable binding opens a completion

The binding is set once on the pending approval: agent, owner,
installation, enrollment, proposal digest, request scope, fingerprint,
original message, conversation, room and host context revision. Completion
needs the owner role, the current authenticated device, and a posted
proposal, digest, receipt attempt and request that match the binding; a
changed host revision, fingerprint or original message refuses it. Only a
typed, successful, nonworkflow read qualifies. The plugin that owns a
result's kind registers its admission: whether only a named read counts,
whether it must be an actual read of the selected item, and its byte limit,
65,536 UTF-8 bytes unless the plugin registers another. Receipt and history
reads authorize nothing, and oversize evidence is refused intact.

```quint
type CompletionKey = { proposal: str, digest: str, attempt: str, request: str, conversation: str, userMessage: str }
type CompletionAdmission = { ownerRole: bool, authenticatedDevice: bool, bindingMatches: bool,
  originalCurrent: bool, hostRevisionMatches: bool, resultAdmitted: bool, deadlineOpen: bool, aborted: bool }
type ReadAdmission = { namedReadOnly: bool, actualItemOnly: bool, byteLimit: int }
pure val defaultReadAdmission: ReadAdmission = { namedReadOnly: false, actualItemOnly: false, byteLimit: 65536 }
pure def qualifiesReadResult(admission: ReadAdmission, workflow: bool, namedRead: bool, done: bool,
  applied: bool, operationIdString: bool, typed: bool, actualItem: bool, bytes: int): bool =
  not(workflow) and (not(admission.namedReadOnly) or namedRead) and done and applied and operationIdString and typed and
    (not(admission.actualItemOnly) or actualItem) and bytes >= 0 and bytes <= admission.byteLimit
pure val admissionValues = Set(defaultReadAdmission, { namedReadOnly: true, actualItemOnly: false, byteLimit: 65536 },
  { namedReadOnly: false, actualItemOnly: true, byteLimit: 1048576 })
pure val bytesValues = Set(0, 65535, 65536, 65537)
pure def lawWorkflowReceiptsCannotStartOriginalCompletion(admission: ReadAdmission, namedRead: bool, done: bool,
  applied: bool, operationIdString: bool, typed: bool, actualItem: bool, bytes: int): bool =
  not(qualifiesReadResult(admission,true,namedRead,done,applied,operationIdString,typed,actualItem,bytes))
pure def lawReadStaysWithinItsRegisteredLimit(admission: ReadAdmission, namedRead: bool, done: bool,
  applied: bool, operationIdString: bool, typed: bool, actualItem: bool, bytes: int): bool =
  qualifiesReadResult(admission,false,namedRead,done,applied,operationIdString,typed,actualItem,bytes) implies
    (bytes <= admission.byteLimit and (admission.actualItemOnly implies actualItem) and (admission.namedReadOnly implies namedRead))
pure def completionAllowed(registered: CompletionKey, supplied: CompletionKey, facts: CompletionAdmission): bool =
  registered == supplied and facts.ownerRole and facts.authenticatedDevice and facts.bindingMatches and facts.hostRevisionMatches and
    facts.originalCurrent and facts.resultAdmitted and facts.deadlineOpen and not(facts.aborted)
pure val originalKey: CompletionKey = { proposal: "proposal", digest: "digest", attempt: "attempt", request: "requested", conversation: "chat", userMessage: "user" }
pure val registeredValues = Set(originalKey, { ...originalKey, attempt: "another" })
pure val suppliedValues = Set(originalKey, { ...originalKey, conversation: "other" }, { ...originalKey, attempt: "another" })
pure val admittedFacts: CompletionAdmission = { ownerRole: true, authenticatedDevice: true, bindingMatches: true,
  originalCurrent: true, hostRevisionMatches: true, resultAdmitted: true, deadlineOpen: true, aborted: false }
pure val factsValues = Set(admittedFacts, { ...admittedFacts, ownerRole: false }, { ...admittedFacts, originalCurrent: false },
  { ...admittedFacts, deadlineOpen: false }, { ...admittedFacts, aborted: true })
pure def lawForeignCompletionRefused(registered: CompletionKey, supplied: CompletionKey, facts: CompletionAdmission): bool =
  registered != supplied implies not(completionAllowed(registered, supplied, facts))
pure def lawChangedOriginalRefused(registered: CompletionKey, supplied: CompletionKey, facts: CompletionAdmission): bool =
  not(facts.originalCurrent and facts.hostRevisionMatches and facts.bindingMatches) implies not(completionAllowed(registered, supplied, facts))
```

### A completion deadline is the earlier of ten minutes after claim and thirty minutes after creation

Before an execution claim the deadline is the proposal's expiry. Once
claimed, it is the earlier of ten minutes after the claim and thirty minutes
after the proposal was created, and a completion needs it still in the
future.

```quint
pure def completionDeadline(hasClaim: bool, expiry: int, creation: int, claim: int): int =
  if (not(hasClaim)) expiry else if (claim + 600000 < creation + 1800000) claim + 600000 else creation + 1800000
pure def lawDeadlineCannotOutliveEitherClaimBound(expiry: int, creation: int, claim: int): bool =
  completionDeadline(true,expiry,creation,claim) <= claim + 600000 and completionDeadline(true,expiry,creation,claim) <= creation + 1800000
```

### A consumed hint is never reused

The client keeps the exact hint once the receipt is confirmed done for its
attempt, and consumes it before sending the request, so a transport failure
cannot start the same continuation again. A local cancellation consumes it
too, even when the cancel request then fails.

```quint
pure def hintAvailable(confirmed: bool, exactAttempt: bool, exactOrigin: bool, typedRead: bool, clientConsumed: bool): bool =
  confirmed and exactAttempt and exactOrigin and typedRead and not(clientConsumed)
pure def mayConsumeHint(retained: bool, exactHint: bool, consumed: bool, aborted: bool): bool =
  retained and exactHint and not(consumed or aborted)
pure def lawUnknownClientHintCannotBeConsumed(exactHint: bool, consumed: bool, aborted: bool): bool =
  not(mayConsumeHint(false, exactHint, consumed, aborted))
pure def lawConsumedHintIsNeverReused(retained: bool, exactHint: bool, aborted: bool, confirmed: bool, exactAttempt: bool, exactOrigin: bool, typedRead: bool): bool =
  not(mayConsumeHint(retained, exactHint, true, aborted)) and not(hintAvailable(confirmed, exactAttempt, exactOrigin, typedRead, true))
```

### The answer uses at most one model call, runs no tool and binds to the original sources

A request bound to an original reviewed purpose whose after-read intent
matches takes that purpose's route; otherwise a formatter that a plugin
registered for the result's kind formats it; otherwise the planner answers
from the original prompt and the typed result. Only the planner calls a
model, at most once, and no route runs a tool; authority is rechecked after
the call is allowed, and a failed recheck never retries it. The answer must
be nonblank, rendered exactly from source parts bound to the original agent,
room and message, and pass egress; an abort suppresses it. It is published
only to the current client, in the original request and conversation, under
a new message, never the user's.

```quint
type AnswerKind = BoundPurposeAnswer | FormatterAnswer | PlannerAnswer
type AnswerRoute = { boundPurpose: bool, purposeIntent: bool, formatterRegistered: bool }
pure def routeApprovedRead(route: AnswerRoute): AnswerKind =
  if (route.boundPurpose and route.purposeIntent) BoundPurposeAnswer
  else if (route.formatterRegistered) FormatterAnswer else PlannerAnswer
pure val routeValues = Set({ boundPurpose: false, purposeIntent: false, formatterRegistered: false },
  { boundPurpose: true, purposeIntent: true, formatterRegistered: true },
  { boundPurpose: true, purposeIntent: false, formatterRegistered: true })
pure def permitsAnswerModelCall(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  kind == PlannerAnswer and calls == 0 and authorityCurrent and not(aborted)
pure val callsValues = Set(0, 1, 2)
type AnswerOperation = RequestModel | RunNewTool
pure def permitsAnswerOperation(kind: AnswerKind, operation: AnswerOperation, calls: int,
  authorityCurrent: bool, aborted: bool): bool =
  operation == RequestModel and permitsAnswerModelCall(kind,calls,authorityCurrent,aborted)
type AnswerProof = { aborted: bool, terminalFailure: bool, textNonblank: bool, sameOriginalScope: bool,
  hasRenderedSourceBinding: bool, exactRenderedText: bool, egressAllowed: bool }
pure def acceptsReadAnswer(answerFacts: AnswerProof): bool =
  not(answerFacts.aborted or answerFacts.terminalFailure) and answerFacts.textNonblank and answerFacts.sameOriginalScope and
    answerFacts.hasRenderedSourceBinding and answerFacts.exactRenderedText and answerFacts.egressAllowed
pure val goodAnswer: AnswerProof = { aborted: false, terminalFailure: false, textNonblank: true,
  sameOriginalScope: true, hasRenderedSourceBinding: true, exactRenderedText: true, egressAllowed: true }
pure val answerFactsValues = Set(goodAnswer, { ...goodAnswer, aborted: true }, { ...goodAnswer, exactRenderedText: false },
  { ...goodAnswer, sameOriginalScope: false }, { ...goodAnswer, egressAllowed: false })
pure def mayPublishAnswer(clientCurrent: bool, heldAccount: bool, credentialCurrent: bool, expected: CompletionKey, received: CompletionKey, replyMessage: str): bool =
  clientCurrent and (not(heldAccount) or credentialCurrent) and
    received.request == expected.request and received.conversation == expected.conversation and
    received.userMessage == expected.userMessage and replyMessage != expected.userMessage
pure val expectedValues = registeredValues
pure val receivedValues = suppliedValues
pure val replyMessageValues = Set("user", "answer")
pure def lawBoundPurposeTakesPrecedence(route: AnswerRoute): bool =
  (route.boundPurpose and route.purposeIntent) implies routeApprovedRead(route) == BoundPurposeAnswer
pure def lawSecondModelCallRefused(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  calls > 0 implies not(permitsAnswerModelCall(kind, calls, authorityCurrent, aborted))
pure def lawOnlyThePlannerCallsAModel(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  kind != PlannerAnswer implies not(permitsAnswerModelCall(kind, calls, authorityCurrent, aborted))
pure def lawAnswerNeverRunsTools(kind: AnswerKind, calls: int, authorityCurrent: bool, aborted: bool): bool =
  not(permitsAnswerOperation(kind, RunNewTool, calls, authorityCurrent, aborted))
pure def lawReplyDoesNotOutliveAbort(answerFacts: AnswerProof): bool =
  answerFacts.aborted implies not(acceptsReadAnswer(answerFacts))
pure def lawAnswerNeverReusesUserMessage(clientCurrent: bool, heldAccount: bool, credentialCurrent: bool, expected: CompletionKey, received: CompletionKey): bool =
  not(mayPublishAnswer(clientCurrent, heldAccount, credentialCurrent, expected, received, expected.userMessage))
```

### A durable claim prevents reinference after a lost outcome

Each durable change compares the complete prior binding of the proposal's
row. Claiming fixes the receipt attempt and the reply deadline before
inference, and allows it once. A successful result becomes prepared with
the exact reply and a deterministic memory ID; a failure after the claim
becomes cancelled if the signal aborted and unknown otherwise, and an
unconfirmed retirement leaves the row claimed for recovery. None of these
admits new inference.

A prepared or delivered reply can be read again under the exact binding.
Its memory is written once with the stored reply ID, or an exact prior
memory is acknowledged without another append; a conflicting memory yields
no reply. The row becomes delivered only after that memory is observed, so
a lost response recovers the same reply without another inference.
Cancellation moves a pending, claimed or prepared row to cancelled, leaves
a delivered, cancelled or unknown row as it is, and never erases a stored
memory. Pending and claimed rows have no reply or memory yet.

```quint
type ReadPhase = ReadPending | ReadClaimed | ReadPrepared | ReadDelivered | ReadCancelled | ReadUnknown
type MemoryObservation = MemoryWritten | ExactMemory | MemoryConflict | MemoryUnconfirmed
type DeviceRead = { phase: ReadPhase, inferenceClaims: int, replyId: int, memoryId: int, appends: int, cancelledController: bool }
pure val initial: DeviceRead = { phase: ReadPending, inferenceClaims: 0, replyId: 0, memoryId: 0, appends: 0, cancelledController: false }
pure def canClaimReply(s: DeviceRead, admissible: bool, compareAndSet: bool): bool =
  s.phase == ReadPending and admissible and compareAndSet
pure def claimReply(s: DeviceRead, admissible: bool, compareAndSet: bool): DeviceRead =
  { ...s, phase: ReadClaimed, inferenceClaims: 1 }
pure def canPrepareReply(s: DeviceRead, replyId: int, admissible: bool, compareAndSet: bool): bool =
  s.phase == ReadClaimed and replyId > 0 and admissible and compareAndSet
pure def prepareReply(s: DeviceRead, replyId: int, admissible: bool, compareAndSet: bool): DeviceRead =
  { ...s, phase: ReadPrepared, replyId: replyId }
pure def canFailClaim(s: DeviceRead): bool = s.phase == ReadClaimed
pure def failClaim(s: DeviceRead, signalAborted: bool, compareAndSet: bool): DeviceRead =
  if (not(compareAndSet)) s else { ...s, phase: if (signalAborted) ReadCancelled else ReadUnknown }
pure def mayReuseReply(phase: ReadPhase, admissible: bool): bool =
  admissible and (phase == ReadPrepared or phase == ReadDelivered)
pure def canObserveMemory(s: DeviceRead, replyId: int, admissible: bool, memoryResult: MemoryObservation): bool =
  mayReuseReply(s.phase, admissible) and replyId == s.replyId and
  (memoryResult != MemoryWritten or s.memoryId == 0)
pure def observeMemory(s: DeviceRead, replyId: int, admissible: bool, memoryResult: MemoryObservation): DeviceRead =
  if (memoryResult == MemoryWritten) { ...s, memoryId: replyId, appends: s.appends + 1 }
  else if (memoryResult == ExactMemory) { ...s, memoryId: replyId } else s
pure def canDeliverReply(s: DeviceRead, admissible: bool, compareAndSet: bool): bool =
  s.phase == ReadPrepared and admissible and compareAndSet and s.memoryId == s.replyId and s.memoryId > 0
pure def deliverReply(s: DeviceRead, admissible: bool, compareAndSet: bool): DeviceRead =
  { ...s, phase: ReadDelivered }
pure def canCancelReply(s: DeviceRead, credentialsMatch: bool, transactionAccepted: bool): bool =
  credentialsMatch and transactionAccepted
pure def cancelReply(s: DeviceRead, credentialsMatch: bool, transactionAccepted: bool, ownedController: bool): DeviceRead =
  { ...s, cancelledController: s.cancelledController or ownedController,
    phase: if (s.phase == ReadPending or s.phase == ReadClaimed or s.phase == ReadPrepared) ReadCancelled else s.phase }
pure val replyIdValues = Set(0, 1, 2)
pure val weight_claimReply = 12
pure val weight_prepareReply = 12
pure val weight_observeMemory = 12
pure val weight_deliverReply = 12
pure def alwaysOneInferenceClaim(s: DeviceRead): bool =
  s.inferenceClaims >= 0 and s.inferenceClaims <= 1 and
    (s.phase == ReadPending implies s.inferenceClaims == 0) and
    ((s.phase == ReadClaimed or s.phase == ReadPrepared or s.phase == ReadDelivered) implies s.inferenceClaims == 1)
pure def alwaysMemoryKeepsExactIdentity(s: DeviceRead): bool =
  (s.memoryId != 0 implies s.memoryId == s.replyId) and
  (s.phase == ReadDelivered implies s.memoryId == s.replyId and s.memoryId > 0) and
  ((s.phase == ReadPrepared or s.phase == ReadDelivered) implies s.replyId > 0) and
  ((s.phase == ReadPending or s.phase == ReadClaimed) implies s.replyId == 0 and s.memoryId == 0)
pure def alwaysAtMostOneAppend(s: DeviceRead): bool =
  s.appends >= 0 and s.appends <= 1 and (s.memoryId == 0 implies s.appends == 0)
pure def stepCancelledReplyNeverRestarts(before: DeviceRead, after: DeviceRead): bool =
  (before.phase == ReadCancelled or before.phase == ReadUnknown) implies after.phase == before.phase and after.inferenceClaims == before.inferenceClaims
pure def stepCancelKeepsMemory(before: DeviceRead, via: str, after: DeviceRead): bool =
  via == "cancelReply" implies after.memoryId == before.memoryId
pure def sometimesCanonicalAnswerDelivered(s: DeviceRead): bool = s.phase == ReadDelivered
pure def sometimesCancelKeepsCanonicalMemory(s: DeviceRead): bool = s.phase == ReadCancelled and s.memoryId > 0
pure def sometimesUncertainInferenceCannotRestart(s: DeviceRead): bool = s.phase == ReadUnknown
```
