# Original device read completion

AlphaPhone sends the original device-read correlation through
`apps/app/src/runtime/connection-ui.tsx` at `8d44dfe52`. Eliza
`c518127a` handles it in `packages/agent/src/api/device-action-routes.ts`
and `plugins/plugin-assistant/src/services/device-actions/{service,read-completion,client-coordinator}.ts`.
[Device action custody](./mobileDeviceExecution.md) owns the preceding
approval and typed receipt. This model follows one eligible receipt's
onward path to an answer in the original conversation.
[Approved read synthesis](./readCompletionAnswer.md) owns the answer's
source and inference rules.

## Story: Complete the original request with the result I explicitly shared

### Only the original receipt and owner can open the continuation

The durable binding is set once on a pending approval. It captures the
agent, owner, installation, enrollment, proposal digest, request scope,
fingerprint, original message, conversation, room and host context
revision. The API requires the OWNER role for completion. The posted
proposal, digest, receipt attempt and original request coordinates must
match the durable binding and current authenticated device. The
acknowledged proposal must carry a valid successful result and its
completion deadline must be in the future. Before a claim the deadline
is the proposal expiry. With an execution claim, use the earlier of
ten minutes after that claim and thirty minutes after proposal creation.
A callback can be refused if
the host revision, request fingerprint or original canonical memory
changed. A positive completion admission starts from typed original
receipt evidence, never from an arbitrary renderer payload.

Receipt and history reads authorize no continuation. An original read
uses a nonworkflow proposal, and a named Calendar operation qualifies
only for reading. Messages and voicemail require an actual read of the
selected item. Other than Notes and Messages, the serialized complete
typed result must fit 65,536 UTF-8 bytes. Notes and Messages have their
own result limits. Oversize evidence is refused intact.

The client retains the exact hint after the receipt is confirmed done
for its attempt. It consumes the retained hint before the request, so
transport failure cannot launch the same local continuation again.
The consumer checks the exact action owner object, live conversation,
epoch, visibility, and Cloud credential lifetime before and after the
request. The local cancellation consumes the hint even when sending the
cancel request subsequently fails.

```quint
type CompletionKey = { proposal: str, digest: str, attempt: str, request: str, conversation: str, userMessage: str }
type CompletionAdmission = { ownerRole: bool, authenticatedDevice: bool, bindingMatches: bool,
  originalCurrent: bool, hostRevisionMatches: bool, resultAdmitted: bool, deadlineOpen: bool, aborted: bool }
type ReadResultKind = NotesResult | MessagesResult | VoicemailResult | CalendarNamedResult | OtherDeviceRead
pure def qualifiesReadResult(kind: ReadResultKind, workflow: bool, namedRead: bool, done: bool,
  applied: bool, operationIdString: bool, typed: bool, actualItem: bool, bytes: int): bool =
  not(workflow) and (kind != CalendarNamedResult or namedRead) and done and applied and operationIdString and typed and
    ((kind != MessagesResult and kind != VoicemailResult) or actualItem) and bytes >= 0 and
    (kind == NotesResult or kind == MessagesResult or bytes <= 65536)
pure val bytesValues = Set(0, 65535, 65536, 65537)
pure def lawWorkflowReceiptsCannotStartOriginalCompletion(kind: ReadResultKind, namedRead: bool, done: bool,
  applied: bool, operationIdString: bool, typed: bool, actualItem: bool, bytes: int): bool =
  not(qualifiesReadResult(kind,true,namedRead,done,applied,operationIdString,typed,actualItem,bytes))
pure def completionAllowed(registered: CompletionKey, supplied: CompletionKey, facts: CompletionAdmission): bool =
  registered == supplied and facts.ownerRole and facts.authenticatedDevice and facts.bindingMatches and facts.hostRevisionMatches and
    facts.resultAdmitted and facts.deadlineOpen and not(facts.aborted)
pure def mayUseOriginal(registered: CompletionKey, supplied: CompletionKey, facts: CompletionAdmission): bool =
  completionAllowed(registered,supplied,facts) and facts.originalCurrent
pure def completionDeadline(hasClaim: bool, expiry: int, creation: int, claim: int): int =
  if (not(hasClaim)) expiry else if (claim + 600000 < creation + 1800000) claim + 600000 else creation + 1800000
pure def lawDeadlineCannotOutliveEitherClaimBound(expiry: int, creation: int, claim: int): bool =
  completionDeadline(true,expiry,creation,claim) <= claim + 600000 and completionDeadline(true,expiry,creation,claim) <= creation + 1800000
pure def hintAvailable(confirmed: bool, exactAttempt: bool, exactOrigin: bool, typedRead: bool, clientConsumed: bool): bool =
  confirmed and exactAttempt and exactOrigin and typedRead and not(clientConsumed)
pure def mayConsumeHint(retained: bool, exactHint: bool, consumed: bool, aborted: bool): bool =
  retained and exactHint and not(consumed or aborted)
pure def mayPublishAnswer(clientCurrent: bool, heldAccount: bool, credentialCurrent: bool, expected: CompletionKey, received: CompletionKey, replyMessage: str): bool =
  clientCurrent and (not(heldAccount) or credentialCurrent) and
    received.request == expected.request and received.conversation == expected.conversation and
    received.userMessage == expected.userMessage and replyMessage != expected.userMessage
pure val originalKey: CompletionKey = { proposal: "proposal", digest: "digest", attempt: "attempt", request: "requested", conversation: "chat", userMessage: "user" }
pure val registeredValues = Set(originalKey, { ...originalKey, attempt: "another" })
pure val suppliedValues = Set(originalKey, { ...originalKey, conversation: "other" }, { ...originalKey, attempt: "another" })
pure val expectedValues = registeredValues
pure val receivedValues = suppliedValues
pure val replyMessageValues = Set("user", "answer")
pure val admittedFacts: CompletionAdmission = { ownerRole: true, authenticatedDevice: true, bindingMatches: true,
  originalCurrent: true, hostRevisionMatches: true, resultAdmitted: true, deadlineOpen: true, aborted: false }
pure val factsValues = Set(admittedFacts, { ...admittedFacts, ownerRole: false }, { ...admittedFacts, originalCurrent: false },
  { ...admittedFacts, deadlineOpen: false }, { ...admittedFacts, aborted: true })
pure def lawForeignCompletionRefused(registered: CompletionKey, supplied: CompletionKey, facts: CompletionAdmission): bool =
  registered != supplied implies not(completionAllowed(registered, supplied, facts))
pure def lawOriginalMemoryMustStillMatch(registered: CompletionKey, supplied: CompletionKey, facts: CompletionAdmission): bool =
  mayUseOriginal(registered,supplied,facts) implies facts.originalCurrent
pure def lawUnknownClientHintCannotBeConsumed(exactHint: bool, consumed: bool, aborted: bool): bool =
  not(mayConsumeHint(false, exactHint, consumed, aborted))
pure def lawConfirmedAttemptAndTypedReadBindHint(confirmed: bool, exactAttempt: bool, exactOrigin: bool, typedRead: bool, clientConsumed: bool): bool =
  hintAvailable(confirmed, exactAttempt, exactOrigin, typedRead, clientConsumed) implies confirmed and exactAttempt and exactOrigin and typedRead and not(clientConsumed)
pure def lawAnswerNeverReusesUserMessage(clientCurrent: bool, heldAccount: bool, credentialCurrent: bool, expected: CompletionKey, received: CompletionKey): bool =
  not(mayPublishAnswer(clientCurrent, heldAccount, credentialCurrent, expected, received, expected.userMessage))
```

### A durable claim prevents reinference after a lost outcome

The server allows one active controller for the proposal in its
runtime. Durable state changes compare the complete prior binding in
the same owner, agent and proposal row. The pending-to-claimed commit
fixes the receipt attempt and the reply deadline before inference. A
successful result becomes prepared with the exact reply and
deterministic memory ID. A generation failure after claim becomes
cancelled if the signal aborted, or unknown otherwise. When that
retirement write cannot be confirmed, the row stays claimed and
requires recovery. None of those three states admits new inference.

A prepared or delivered reply can be read again under the exact
binding, with the original canonical memory, current credential,
host revision and unexpired deadline rechecked. The host carries
the current-authority check into the same-room lease and the final
storage boundary. The write uses the stored reply ID and full content.
An exact prior memory can be acknowledged without another append.
A conflicting memory cannot yield a reply. The completion row is
marked delivered only after observing the memory write or exact prior
memory. A lost transport response can therefore recover the same
prepared bytes without another inference run.

Cancellation commits the bound row to cancelled while it is pending,
claimed or prepared. A delivered, cancelled or unknown row keeps its
durable state. An exact active controller can still be aborted
independently of whether cancellation changed that row. If an answer
has already been stored, cancellation does not erase the canonical
memory. A stale presentation is separately refused at the client.
The model follows the durable phases, presuming the source's exclusive
active controller and exact transactional acknowledgements. It
represents the canonical reply separately from its handoff, and
leaves inference text selection and eventual delivery to their own ports.
Discovered by the proof: the pending and claimed states have no
prepared reply or stored reply memory. Those identities enter only
after the current claim prepares the reply.

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
