# Hosted inference

The cloud admits each metered inference request against the organization's
current policy and credit, sends it to a provider at most once, and charges
it exactly once, even when the caller loses a reply. One request is the
state machine. Credential checks, the admission gate's reopening, request
adaptation and stream settlement are the boundaries around it and are
stated as laws. How a charge is split across credit grants is
[credits](./credits.md). Provider truth, HTTP transport and pricing tables
are outside the model.

## Story: Admit a metered request exactly once

> As an organization paying for inference, I want each request held under the
> current policy, sent to the provider at most once and charged exactly once,
> so that a lost reply or a retry never spends twice and a refused request
> never spends at all.

### A released request is never charged and a settled one is charged once

An ordinary request first reserves a lease under the current policy
generation, with no policy change in progress. A released request was never
sent to the provider and is never charged; a settled one is charged once in
the ledger and once in the admission gate. A request with no hold has
dispatched nothing.

```quint
type InferencePhase = NoHold | Leased | Dispatched | Recovering | Released | Settled
type CallerState = CallerReady | CallerWaiting | CallerAuthorized | CallerAmbiguous | CallerRefused | CallerCancelled
type InferenceRequest = { phase: InferencePhase, caller: CallerState, deferred: bool, generation: int, carried: int, fenceOpen: bool, credentialActive: bool, attempts: int, replied: bool, dispatches: int, invoked: bool, refills: int, recoveryOwner: int, publishedBy: int, ledgerDebit: int, gateDebit: int }
pure val initial: InferenceRequest = { phase: NoHold, caller: CallerReady, deferred: false, generation: 1, carried: 1, fenceOpen: false, credentialActive: true, attempts: 0, replied: false, dispatches: 0, invoked: false, refills: 0, recoveryOwner: 0, publishedBy: 0, ledgerDebit: 0, gateDebit: 0 }
pure def currentPolicy(r: InferenceRequest): bool = r.carried == r.generation and not(r.fenceOpen)
pure def canReserve(r: InferenceRequest): bool = r.phase == NoHold and r.caller == CallerReady and not(r.deferred) and r.attempts == 0 and currentPolicy(r)
pure def reserve(r: InferenceRequest): InferenceRequest = { ...r, phase: Leased }
pure def canExpireLease(r: InferenceRequest): bool = r.phase == Leased
pure def expireLease(r: InferenceRequest): InferenceRequest = { ...r, phase: Released }
pure def alwaysReleasedIsNeverCharged(r: InferenceRequest): bool = r.phase == Released implies not(r.invoked) and r.ledgerDebit == 0 and r.gateDebit == 0
pure def alwaysSettledIsChargedOnce(r: InferenceRequest): bool = r.phase == Settled implies r.ledgerDebit == 1 and r.gateDebit == 1
pure def alwaysUnheldRequestHasNoDispatch(r: InferenceRequest): bool = r.phase == NoHold implies r.dispatches == 0 and not(r.invoked) and r.ledgerDebit == 0
```

### The dispatch mark is durable before the caller may call the provider

The caller marks the dispatch in the gate and waits for its
acknowledgement. A deferred request, one with no lease, marks directly, and
only while its credential is still active. Marking again after a lost reply
replays the same dispatch and never adds a second one; a request makes at
most three mark attempts. Only an acknowledged caller may call the provider,
once.

```quint
pure def canStartMark(r: InferenceRequest, deferred: bool): bool =
  r.attempts < 3 and (r.caller == CallerReady or r.caller == CallerAmbiguous) and
  r.phase != Released and r.phase != Settled and r.phase != Recovering and
  (if (r.phase == NoHold) deferred else deferred == r.deferred)
pure def startMark(r: InferenceRequest, deferred: bool): InferenceRequest = { ...r, caller: CallerWaiting, attempts: r.attempts + 1, replied: false, deferred: deferred }
pure def canPersistMark(r: InferenceRequest): bool =
  r.caller == CallerWaiting and not(r.replied) and (not(r.deferred) or r.credentialActive) and
  (r.phase == Dispatched or (currentPolicy(r) and ((r.deferred and r.phase == NoHold) or (not(r.deferred) and r.phase == Leased))))
pure def persistMark(r: InferenceRequest): InferenceRequest =
  { ...r, phase: Dispatched, replied: true, dispatches: if (r.phase == Dispatched) r.dispatches else r.dispatches + 1 }
pure def canAcceptAck(r: InferenceRequest): bool = r.caller == CallerWaiting and r.replied
pure def acceptAck(r: InferenceRequest): InferenceRequest = { ...r, caller: CallerAuthorized, replied: false }
pure def canLoseAck(r: InferenceRequest): bool = r.caller == CallerWaiting
pure def loseAck(r: InferenceRequest): InferenceRequest = { ...r, caller: CallerAmbiguous, replied: false }
pure def canInvokeProvider(r: InferenceRequest): bool = r.caller == CallerAuthorized and not(r.invoked) and r.phase != Released
pure def invokeProvider(r: InferenceRequest): InferenceRequest = { ...r, invoked: true }
pure def alwaysAtMostOneDispatch(r: InferenceRequest): bool = r.dispatches >= 0 and r.dispatches <= 1
pure def alwaysProviderCalledOnlyWhenAuthorized(r: InferenceRequest): bool =
  r.invoked implies r.caller == CallerAuthorized and r.dispatches == 1 and r.phase != NoHold and r.phase != Released
pure def stepAuthorizedOnlyByAcknowledgement(before: InferenceRequest, after: InferenceRequest): bool =
  (before.caller != CallerAuthorized and after.caller == CallerAuthorized) implies (before.caller == CallerWaiting and before.replied)
pure def stepFirstDispatchUnderCurrentPolicy(before: InferenceRequest, after: InferenceRequest): bool =
  after.dispatches > before.dispatches implies currentPolicy(before) and (not(before.deferred) or before.credentialActive)
pure val fair_acceptAck = "weak"
pure val fair_loseAck = "weak"
pure def leadsToMarkReturns(r: InferenceRequest, later: InferenceRequest): bool = r.caller == CallerWaiting implies later.caller != CallerWaiting
```

### An acknowledgement stands for the one recorded dispatch

A leased request has dispatched nothing yet, and a dispatched one has
dispatched once. A mark's reply arrives only for a waiting caller whose
dispatch is recorded, and an acknowledged caller's request holds that one
dispatch and is past its lease.

```quint
pure def alwaysAcknowledgementFollowsTheDispatch(r: InferenceRequest): bool =
  (r.phase == Leased implies r.dispatches == 0) and
  (r.phase == Dispatched implies r.dispatches == 1) and
  (r.replied implies r.caller == CallerWaiting and r.dispatches == 1 and r.phase != NoHold and r.phase != Leased) and
  (r.caller == CallerAuthorized implies r.dispatches == 1 and r.phase != NoHold and r.phase != Leased)
```

### A stale policy refuses a deferred mark, which may refill once

A policy change opens a fence and then advances the generation; a revoked
credential stays revoked. The gate answers a first deferred mark under a
superseded generation, or while the fence is open, with a refusal and
records nothing. The refused caller may read the policy once, after the
fence closes, and try again under the generation it read; a refusal that
stands ends the request with nothing held.

```quint
pure def canOpenFence(r: InferenceRequest): bool = not(r.fenceOpen)
pure def openFence(r: InferenceRequest): InferenceRequest = { ...r, fenceOpen: true }
pure def canAbortFence(r: InferenceRequest): bool = r.fenceOpen
pure def abortFence(r: InferenceRequest): InferenceRequest = { ...r, fenceOpen: false }
pure def advancePolicy(r: InferenceRequest): InferenceRequest = { ...r, generation: r.generation + 1, fenceOpen: false }
pure def canRevokeCredential(r: InferenceRequest): bool = r.credentialActive
pure def revokeCredential(r: InferenceRequest): InferenceRequest = { ...r, credentialActive: false }
pure def canRefuseStaleMark(r: InferenceRequest): bool = r.caller == CallerWaiting and not(r.replied) and r.deferred and r.phase == NoHold and not(currentPolicy(r))
pure def refuseStaleMark(r: InferenceRequest): InferenceRequest = { ...r, caller: CallerRefused }
pure def canRefillPolicy(r: InferenceRequest): bool = r.caller == CallerRefused and r.refills == 0 and not(r.fenceOpen)
pure def refillPolicy(r: InferenceRequest): InferenceRequest = { ...r, carried: r.generation, refills: 1, caller: CallerReady, attempts: 0 }
pure def canSettleRefused(r: InferenceRequest): bool = r.caller == CallerRefused
pure def settleRefused(r: InferenceRequest): InferenceRequest = { ...r, caller: CallerCancelled }
pure def alwaysRefusedSpendsNothing(r: InferenceRequest): bool = r.caller == CallerRefused implies r.phase == NoHold and r.dispatches == 0 and not(r.invoked)
pure def alwaysOneRefillOfAKnownPolicy(r: InferenceRequest): bool = r.refills >= 0 and r.refills <= 1 and r.carried >= 1 and r.carried <= r.generation
pure def sometimesRefilledRequestReachesProvider(r: InferenceRequest): bool = r.refills == 1 and r.invoked
pure def sometimesRefusalSettlesAtZero(r: InferenceRequest): bool = r.caller == CallerCancelled and r.phase == NoHold and r.refills == 1
```

### A caller that gives up before the provider returns its hold

A caller that has not called the provider may cancel a leased or marked
request, including after an ambiguous mark; an acknowledged caller may
decline to call the provider. Either releases the hold with nothing charged.

```quint
pure def canCancelBeforeProvider(r: InferenceRequest): bool = (r.caller == CallerReady or r.caller == CallerAmbiguous) and (r.phase == Leased or r.phase == Dispatched)
pure def cancelBeforeProvider(r: InferenceRequest): InferenceRequest = { ...r, phase: Released, caller: CallerCancelled }
pure def canAbandonAuthorized(r: InferenceRequest): bool = r.phase == Dispatched and r.caller == CallerAuthorized and not(r.invoked)
pure def abandonAuthorized(r: InferenceRequest): InferenceRequest = { ...r, phase: Released, caller: CallerCancelled }
pure def stepTerminalStateIsFinal(before: InferenceRequest, after: InferenceRequest): bool =
  (before.phase == Released or before.phase == Settled) implies after.phase == before.phase
pure def sometimesAbandonedDispatchReleases(r: InferenceRequest): bool = r.phase == Released and r.dispatches == 1 and not(r.invoked)
```

### A dispatched request is charged once, by its caller or by recovery

A caller that called the provider settles the known charge in the ledger and
the gate together. Otherwise, after the lease lapses, a recovery owner
claims the request, debits the ledger idempotently, and only the owner that
published the balance to the gate may finish it. A later recovery owner
supersedes an earlier one; the ledger debit is never undone.

```quint
pure def canSettleKnown(r: InferenceRequest): bool = r.phase == Dispatched and r.invoked
pure def settleKnown(r: InferenceRequest): InferenceRequest = { ...r, phase: Settled, ledgerDebit: 1, gateDebit: 1 }
pure def canClaimRecovery(r: InferenceRequest): bool = r.phase == Dispatched or r.phase == Recovering
pure def claimRecovery(r: InferenceRequest): InferenceRequest = { ...r, phase: Recovering, recoveryOwner: r.recoveryOwner + 1 }
pure def canDebitRecovery(r: InferenceRequest): bool = r.phase == Recovering
pure def debitRecovery(r: InferenceRequest): InferenceRequest = { ...r, ledgerDebit: 1 }
pure def canPublishRecovery(r: InferenceRequest, owner: int): bool = r.phase == Recovering and r.recoveryOwner == owner and r.ledgerDebit == 1
pure def publishRecovery(r: InferenceRequest, owner: int): InferenceRequest = { ...r, gateDebit: 1, publishedBy: owner }
pure def canFinishRecovery(r: InferenceRequest, owner: int): bool = r.phase == Recovering and r.recoveryOwner == owner and r.publishedBy == owner
pure def finishRecovery(r: InferenceRequest, owner: int): InferenceRequest = { ...r, phase: Settled }
pure val ownerValues = Set(1, 2)
pure def alwaysRecoveryHoldsTheDispatch(r: InferenceRequest): bool = r.phase == Recovering implies r.dispatches == 1
pure def alwaysGateNeverAheadOfLedger(r: InferenceRequest): bool = r.gateDebit >= 0 and r.gateDebit <= r.ledgerDebit and r.ledgerDebit <= 1
pure def alwaysChargedOnlyAfterDispatch(r: InferenceRequest): bool = r.ledgerDebit > 0 implies r.dispatches == 1 and (r.phase == Recovering or r.phase == Settled)
pure def stepLedgerDebitIsDurable(before: InferenceRequest, after: InferenceRequest): bool = after.ledgerDebit >= before.ledgerDebit
pure def stepRecoverySettlesOnlyByItsPublisher(before: InferenceRequest, after: InferenceRequest): bool =
  (before.phase == Recovering and after.phase == Settled) implies (before.publishedBy == before.recoveryOwner and before.gateDebit == 1)
pure def sometimesRecoverySettlesAfterTakeover(r: InferenceRequest): bool = r.phase == Settled and r.recoveryOwner == 2
pure def sometimesKnownChargeSettles(r: InferenceRequest): bool = r.phase == Settled and r.invoked and r.recoveryOwner == 0
pure val weight_persistMark = 4
pure val weight_acceptAck = 4
pure val weight_invokeProvider = 4
```

### Only the current recovery owner's publication finishes a recovery

An owner publishes only while it is the current recovery owner, so the last
publisher is never newer than the current owner, and a recovering request
whose current owner has published carries its gate debit.

```quint
pure def alwaysPublisherIsNeverNewerThanTheOwner(r: InferenceRequest): bool =
  r.publishedBy <= r.recoveryOwner and
  ((r.phase == Recovering and r.publishedBy == r.recoveryOwner) implies r.gateDebit == 1)
```

### Every finished request passed exactly one credential boundary

A request through the combined proxy is either admitted there, with its
credential check, or, when it never reached admission, is checked on its own
when its dispatch is disposed. Never both and never neither.

```quint
type DispatchOutcome = DispatchSucceeded | RefusedLocally | ThrewBeforeAdmission | ThrewAfterAdmission | CancelledBeforePreflight
pure def proxyAdmissions(dispatchOutcome: DispatchOutcome): int = if (dispatchOutcome == DispatchSucceeded or dispatchOutcome == ThrewAfterAdmission) 1 else 0
pure def standaloneChecks(dispatchOutcome: DispatchOutcome): int = if (proxyAdmissions(dispatchOutcome) == 0) 1 else 0
pure def lawOneCredentialBoundary(dispatchOutcome: DispatchOutcome): bool = proxyAdmissions(dispatchOutcome) + standaloneChecks(dispatchOutcome) == 1
```

## Story: Check an API key against current revocation

> As an organization, I want a revoked or expired key to stop working at once,
> even where a cached verdict says otherwise.

### A cached allowance never bypasses the revocation gate

Where the gate can revoke a key, a cached allowance still asks the gate and
is refused for an expired key; a cached denial is refused without asking.
With no cache, the origin decides and then the gate. Where there is no gate,
only the origin's current answer allows. A stale verdict is refreshed in the
background and never changes the answer of the request that found it.

```quint
type CachedVerdict = CacheEmpty | CacheForeign | FreshAllow | StaleAllow | FreshDeny | StaleDeny
type KeyCheck = { cached: CachedVerdict, revocationGate: bool, expired: bool, originAllows: bool, gateAllows: bool }
type KeyVerdict = KeyAllowed | KeyDenied
pure def cachedAllows(v: CachedVerdict): bool = v == FreshAllow or v == StaleAllow
pure def cachedDenies(v: CachedVerdict): bool = v == FreshDeny or v == StaleDeny
pure def keyVerdict(keyCheck: KeyCheck): KeyVerdict =
  if (not(keyCheck.revocationGate)) (if (keyCheck.originAllows and not(keyCheck.expired)) KeyAllowed else KeyDenied)
  else if (cachedDenies(keyCheck.cached)) KeyDenied
  else if (cachedAllows(keyCheck.cached)) (if (not(keyCheck.expired) and keyCheck.gateAllows) KeyAllowed else KeyDenied)
  else if (keyCheck.originAllows and not(keyCheck.expired) and keyCheck.gateAllows) KeyAllowed else KeyDenied
pure def lawAllowedKeyPassedTheGate(keyCheck: KeyCheck): bool =
  (keyCheck.revocationGate and keyVerdict(keyCheck) == KeyAllowed) implies (keyCheck.gateAllows and not(keyCheck.expired))
pure def lawWithoutGateOnlyTheOriginAllows(keyCheck: KeyCheck): bool =
  (not(keyCheck.revocationGate) and keyVerdict(keyCheck) == KeyAllowed) implies (keyCheck.originAllows and not(keyCheck.expired))
pure def lawCachedDenialIsServed(keyCheck: KeyCheck): bool =
  (keyCheck.revocationGate and cachedDenies(keyCheck.cached)) implies keyVerdict(keyCheck) == KeyDenied
pure val keyCheckValues = Set(
  { cached: FreshAllow, revocationGate: true, expired: false, originAllows: true, gateAllows: true },
  { cached: StaleAllow, revocationGate: true, expired: false, originAllows: false, gateAllows: false },
  { cached: FreshAllow, revocationGate: true, expired: true, originAllows: true, gateAllows: true },
  { cached: StaleDeny, revocationGate: true, expired: false, originAllows: true, gateAllows: true },
  { cached: CacheEmpty, revocationGate: true, expired: false, originAllows: true, gateAllows: false },
  { cached: CacheForeign, revocationGate: false, expired: false, originAllows: true, gateAllows: false },
  { cached: FreshAllow, revocationGate: false, expired: false, originAllows: false, gateAllows: true })
```

### A key not yet acknowledged is refused as unauthenticated

A native client's key is minted inactive and works only after its client
acknowledges it ([registered native clients](./nativeClients.md)). Until
then every metered request with it is refused with 401, whatever a cached
verdict says; an acknowledged key is answered as the key check decides.

```quint
pure def credentialStatus(acknowledged: bool, keyCheck: KeyCheck): int = if (acknowledged and keyVerdict(keyCheck) == KeyAllowed) 200 else 401
pure def lawUnacknowledgedKeyIsUnauthenticated(keyCheck: KeyCheck): bool = credentialStatus(false, keyCheck) == 401
pure def lawAcknowledgedKeyFollowsTheCheck(keyCheck: KeyCheck): bool = (credentialStatus(true, keyCheck) == 200) iff (keyVerdict(keyCheck) == KeyAllowed)
```

## Story: Answer a chat completion in the shape clients read

> As a client of the hosted chat completions API, I want a streamed reply as
> server-sent chunks ending in `[DONE]`, a single completion when I do not
> stream, a failure I can tell from a success, nothing cached, images in my
> messages passed to the model in place, and the provider call stopped when
> I hang up.

### A streamed reply is chunks then [DONE], a failure carries an error frame, and a hang-up ends it at once

A streamed reply is `text/event-stream`, marked `no-store`. Each event is
one `data:` line holding a `chat.completion.chunk` whose choices carry a
delta. A reply the provider finished ends with its chunks, an optional
usage chunk and `data: [DONE]`. A provider failure after streaming began
sends one error frame and then `[DONE]`, so a client never mistakes it for
a short success. A client that hangs up gets nothing more, and its request
signal aborts the provider call itself, not only the charge. A request
that is not streamed is answered once, with a single `chat.completion`
whose choice carries the whole message and its finish reason, also
`no-store`. A stream completes for the client exactly when it ends with
`[DONE]` and carries no error frame.

```quint
type StreamEnding = ProviderFinished | ProviderFailedMidStream | ClientHungUp
type CompletionFrame = ChunkFrame | UsageFrame | ErrorFrame | DoneFrame
type CompletionReply = { eventStream: bool, noStore: bool, frames: List[CompletionFrame], providerCallAborted: bool }
pure def chunkFrames(chunks: int): List[CompletionFrame] =
  if (chunks <= 0) List() else if (chunks == 1) List(ChunkFrame) else if (chunks == 2) List(ChunkFrame, ChunkFrame) else List(ChunkFrame, ChunkFrame, ChunkFrame)
pure def streamedReply(ending: StreamEnding, chunks: int, usageReported: bool): CompletionReply =
  if (ending == ProviderFinished) { eventStream: true, noStore: true, frames: chunkFrames(chunks).concat(if (usageReported) List(UsageFrame, DoneFrame) else List(DoneFrame)), providerCallAborted: false }
  else if (ending == ProviderFailedMidStream) { eventStream: true, noStore: true, frames: chunkFrames(chunks).concat(List(ErrorFrame, DoneFrame)), providerCallAborted: false }
  else { eventStream: true, noStore: true, frames: chunkFrames(chunks), providerCallAborted: true }
pure def singleReply(ending: StreamEnding): CompletionReply =
  { eventStream: false, noStore: true, frames: if (ending == ClientHungUp) List() else List(ChunkFrame), providerCallAborted: ending == ClientHungUp }
pure def clientSeesCompletion(reply: CompletionReply): bool =
  reply.frames.length() > 0 and reply.frames.nthOr(reply.frames.length() - 1, ChunkFrame) == DoneFrame and not(reply.frames.includes(ErrorFrame))
pure val chunksValues = Set(0, 1, 3)
pure def lawDoneEndsEveryDeliveredStream(ending: StreamEnding, chunks: int, usageReported: bool): bool = {
  val frames = streamedReply(ending, chunks, usageReported).frames
  ending != ClientHungUp implies (frames.nthOr(frames.length() - 1, ChunkFrame) == DoneFrame and not(frames.removeAt(frames.length() - 1).includes(DoneFrame)))
}
pure def lawOnlyAFinishedStreamCompletes(ending: StreamEnding, chunks: int, usageReported: bool): bool =
  clientSeesCompletion(streamedReply(ending, chunks, usageReported)) iff ending == ProviderFinished
pure def lawHangUpAbortsTheProviderCall(ending: StreamEnding, chunks: int, usageReported: bool): bool =
  (streamedReply(ending, chunks, usageReported).providerCallAborted iff ending == ClientHungUp) and (singleReply(ending).providerCallAborted iff ending == ClientHungUp)
pure def lawNoCompletionIsStored(ending: StreamEnding, chunks: int, usageReported: bool): bool =
  streamedReply(ending, chunks, usageReported).noStore and streamedReply(ending, chunks, usageReported).eventStream and singleReply(ending).noStore and not(singleReply(ending).eventStream)
```

### An image in a message reaches the model in its place, and an image without a source refuses the request

A message's content is a string or a list of parts. Text parts and image
parts, by URL or data URL, are passed to the model in their order, each
image with its media type, so a client can ask about a picture. An image
part with no URL, or a part of a kind the adapter does not know, makes the
transcript invalid: the request is refused before any provider call.

```quint
type ContentPart = TextPart | ImagePart | SourcelessImagePart | UnknownPart
type AdaptedParts = { accepted: bool, forwarded: List[ContentPart] }
pure def partForwardable(part: ContentPart): bool = part == TextPart or part == ImagePart
pure def adaptParts(parts: List[ContentPart]): AdaptedParts =
  if (parts.every(p => partForwardable(p))) { accepted: true, forwarded: parts } else { accepted: false, forwarded: List() }
pure val partsValues = Set(List(TextPart, ImagePart), List(ImagePart, TextPart, ImagePart), List(TextPart, SourcelessImagePart), List(UnknownPart), List())
pure def lawImagesKeepTheirPlace(parts: List[ContentPart]): bool = adaptParts(parts).accepted implies adaptParts(parts).forwarded == parts
pure def lawSourcelessImageRefusesTheRequest(parts: List[ContentPart]): bool =
  (parts.includes(SourcelessImagePart) or parts.includes(UnknownPart)) implies (not(adaptParts(parts).accepted) and adaptParts(parts).forwarded == List())
```

## Story: Reopen the inference gate only after its own cooldown

> As an operator, the inference admission gate reopens after a cache
> failure only when the cooldown timer of that same failure has elapsed,
> so a late timer from an earlier failure cannot reopen it early.

### The gate reopens only on a ready record whose owning timer elapsed for the current failure generation

Each failure generation arms one timer owner; a duplicate arm for a live
or completed generation keeps the original owner. The durable ready record
names the owner and generation; a response delivered late, or from an
earlier generation, does not count. The gate's clock route answers only a
POST from its own clock identity on its own path.

```quint
type ReadyRecord = { generation: int, owner: int, ready: bool }
type TimerFacts = { ownerElapsed: bool, ownerGeneration: int }
pure def mayReopen(open: bool, record: ReadyRecord, currentGeneration: int, timer: TimerFacts): bool =
  open and record.ready and record.generation == currentGeneration and timer.ownerElapsed and timer.ownerGeneration == currentGeneration
pure def clockRouteStatus(clockIdentity: bool, clockPath: bool, post: bool): int = if (clockIdentity and clockPath and post) 200 else 404
pure val recordValues = Set({ generation: 1, owner: 1, ready: true }, { generation: 2, owner: 2, ready: true }, { generation: 2, owner: 1, ready: false })
pure val timerValues = Set({ ownerElapsed: true, ownerGeneration: 1 }, { ownerElapsed: true, ownerGeneration: 2 }, { ownerElapsed: false, ownerGeneration: 2 })
pure val currentGenerationValues = Set(1, 2)
pure def lawOldGenerationNeverReopens(open: bool, record: ReadyRecord, currentGeneration: int, timer: TimerFacts): bool = (record.generation != currentGeneration or timer.ownerGeneration != currentGeneration) implies not(mayReopen(open, record, currentGeneration, timer))
```

## Story: Adapt and settle provider responses faithfully

> As a developer calling the hosted API, I want an adapted response that says
> what the provider did, a stream charged by what was delivered, and events
> that do not depend on how the network split the stream.

### Only a provider completion becomes a completed response

The adapter accepts text, media and tool transcripts and refuses unsupported
and invalid ones before any provider call. A stop, tool call or refusal is a
completed response; a length limit, an empty refusal or a content filter is
an incomplete response with its reason; a malformed or failed reply is a
failure and a denial is a denial. Nothing else completes.

```quint
type TranscriptKind = TextTranscript | MediaTranscript | ToolTranscript | UnsupportedTranscript | InvalidTranscript
type ProviderOutcome = OutcomeStop | OutcomeTools | OutcomeRefusal | OutcomeEmptyRefusal | OutcomeLength | OutcomeFiltered | OutcomeMalformed | OutcomeDenied | OutcomeFailed
type ResponseStatus = ResponseCompleted | ResponseIncomplete | ResponseFailed | ResponseDenied
type IncompleteReason = NoReason | MaxOutputTokens | ContentFilter
type AdaptedResponse = { status: ResponseStatus, reason: IncompleteReason, keepsOutput: bool, typedRefusal: bool }
pure def adapterAccepts(kind: TranscriptKind): bool = kind == TextTranscript or kind == MediaTranscript or kind == ToolTranscript
pure def adaptResponse(providerOutcome: ProviderOutcome): AdaptedResponse =
  if (providerOutcome == OutcomeMalformed or providerOutcome == OutcomeFailed) { status: ResponseFailed, reason: NoReason, keepsOutput: false, typedRefusal: false }
  else if (providerOutcome == OutcomeDenied) { status: ResponseDenied, reason: NoReason, keepsOutput: false, typedRefusal: false }
  else if (providerOutcome == OutcomeLength or providerOutcome == OutcomeEmptyRefusal) { status: ResponseIncomplete, reason: MaxOutputTokens, keepsOutput: providerOutcome == OutcomeLength, typedRefusal: false }
  else if (providerOutcome == OutcomeFiltered) { status: ResponseIncomplete, reason: ContentFilter, keepsOutput: true, typedRefusal: false }
  else { status: ResponseCompleted, reason: NoReason, keepsOutput: true, typedRefusal: providerOutcome == OutcomeRefusal }
pure def lawCompletedOnlyFromAProviderCompletion(providerOutcome: ProviderOutcome): bool =
  adaptResponse(providerOutcome).status == ResponseCompleted implies (providerOutcome == OutcomeStop or providerOutcome == OutcomeTools or providerOutcome == OutcomeRefusal)
pure def lawIncompleteNamesItsCause(providerOutcome: ProviderOutcome): bool =
  adaptResponse(providerOutcome).status == ResponseIncomplete implies adaptResponse(providerOutcome).reason != NoReason
pure def lawRefusalIsTyped(providerOutcome: ProviderOutcome): bool = providerOutcome == OutcomeRefusal implies adaptResponse(providerOutcome).typedRefusal
pure def lawRejectedTranscriptIsNotSent(kind: TranscriptKind): bool = (kind == UnsupportedTranscript or kind == InvalidTranscript) implies not(adapterAccepts(kind))
```

### The first terminal callback chooses the stream's charge

A finished stream is charged what the provider reported, or an unknown
amount when it reported no usage. An aborted stream is charged for its
partial output, or an unknown amount when it used web search. A provider
error is free only when the provider never accepted the request and nothing
was delivered. Whichever terminal callback comes first owns the charge;
later callbacks change nothing.

```quint
type StreamCallback = FinishCallback | AbortCallback | ProviderErrorCallback
type ReportedUsage = UsageMissing | UsageZero | UsagePositive
type StreamCharge = ChargeActual | ChargePartial | ChargeUnknown | ChargeZero
type StreamEnd = { callback: StreamCallback, usage: ReportedUsage, webSearch: bool, delivered: bool, unaccepted: bool }
type StreamSettlement = { claimed: bool, charge: StreamCharge }
pure def streamCharge(streamEnd: StreamEnd): StreamCharge =
  if (streamEnd.callback == FinishCallback) (if (streamEnd.usage == UsageMissing) ChargeUnknown else ChargeActual)
  else if (streamEnd.callback == AbortCallback) (if (streamEnd.webSearch) ChargeUnknown else ChargePartial)
  else if (streamEnd.unaccepted and not(streamEnd.delivered)) ChargeZero else ChargeUnknown
pure def claimSettlement(settlement: StreamSettlement, streamEnd: StreamEnd): StreamSettlement =
  if (settlement.claimed) settlement else { claimed: true, charge: streamCharge(streamEnd) }
pure def lawFreeOnlyWhenNothingWasAccepted(streamEnd: StreamEnd): bool =
  streamCharge(streamEnd) == ChargeZero implies (streamEnd.callback == ProviderErrorCallback and streamEnd.unaccepted and not(streamEnd.delivered))
pure def lawMissingUsageIsUnknown(streamEnd: StreamEnd): bool =
  (streamEnd.callback == FinishCallback and streamEnd.usage == UsageMissing) implies streamCharge(streamEnd) == ChargeUnknown
pure def lawAbortedSearchIsUnknown(streamEnd: StreamEnd): bool =
  (streamEnd.callback == AbortCallback and streamEnd.webSearch) implies streamCharge(streamEnd) == ChargeUnknown
pure def lawFirstCallbackOwnsTheCharge(settlement: StreamSettlement, streamEnd: StreamEnd): bool =
  settlement.claimed implies claimSettlement(settlement, streamEnd) == settlement
pure val streamEndValues = Set(
  { callback: FinishCallback, usage: UsageMissing, webSearch: false, delivered: true, unaccepted: false },
  { callback: FinishCallback, usage: UsageZero, webSearch: true, delivered: true, unaccepted: false },
  { callback: AbortCallback, usage: UsagePositive, webSearch: true, delivered: true, unaccepted: false },
  { callback: AbortCallback, usage: UsageMissing, webSearch: false, delivered: false, unaccepted: false },
  { callback: ProviderErrorCallback, usage: UsageMissing, webSearch: false, delivered: false, unaccepted: true },
  { callback: ProviderErrorCallback, usage: UsageMissing, webSearch: false, delivered: true, unaccepted: true })
pure val settlementValues = Set({ claimed: false, charge: ChargeUnknown }, { claimed: true, charge: ChargeZero }, { claimed: true, charge: ChargeActual })
```

### Stream events do not depend on how the bytes were chunked

The metering parser reads server-sent lines: a line feed ends a line,
carriage returns are dropped, and a line with a payload yields one event.
Reading two chunks one after the other yields the same events as reading
them joined. Only the end of the stream flushes an unterminated payload; an
aborted stream keeps only its complete lines. Symbols 8 and 9 stand for
carriage return and line feed; other symbols are payload atoms.

```quint
type SseParser = { fragment: List[int], events: List[int] }
pure val emptyParser: SseParser = { fragment: List(), events: List() }
pure def emitLine(p: SseParser): SseParser = {
  val payload = p.fragment.select(c => c != 8)
  { fragment: List(), events: if (payload.length() == 0) p.events else p.events.append(payload.nthOr(0, 0)) }
}
pure def readSymbol(p: SseParser, c: int): SseParser = if (c == 9) emitLine(p) else { fragment: p.fragment.append(c), events: p.events }
pure def readChunk(p: SseParser, chunk: List[int]): SseParser = chunk.foldl(p, (q, c) => readSymbol(q, c))
pure def lawChunkBoundariesDoNotChangeEvents(first: List[int], second: List[int]): bool =
  readChunk(readChunk(emptyParser, first), second) == readChunk(emptyParser, first.concat(second))
pure def lawEndOfStreamFlushesAnUnterminatedPayload(first: List[int]): bool = {
  val parsed = readChunk(emptyParser, first)
  emitLine(parsed).events.length() == parsed.events.length() + (if (parsed.fragment.select(c => c != 8).length() > 0) 1 else 0)
}
```

### A failed tokenizer load clears only its own cache entry

The tokenizer cache keeps one load. A caller is answered from the cache only
when it holds the encoding the caller asked for. A load that fails clears
the cache only if the cache still holds that load, so a failure never
evicts a newer load.

```quint
pure def cacheAfterRejection(cachedLoad: int, rejectedLoad: int): int = if (cachedLoad == rejectedLoad) -1 else cachedLoad
pure def servesFromCache(cachedEncoding: int, wantedEncoding: int): bool = cachedEncoding >= 0 and cachedEncoding == wantedEncoding
pure def lawRejectionClearsOnlyItsOwnLoad(cachedLoad: int, rejectedLoad: int): bool =
  cachedLoad != rejectedLoad implies cacheAfterRejection(cachedLoad, rejectedLoad) == cachedLoad
```
