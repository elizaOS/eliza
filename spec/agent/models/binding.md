# Model binding

The text backend the launch chose, the account state the owner sees, the
credential push and the cloud link plugins use. The backend is fixed for
the life of the process: the owner's cloud account, the owner's own key for
an OpenAI-compatible endpoint, or none ([launch](../host/launch.md)). An
account, backend or embeddings change is a new launch, decided by the host.
Retry, fallback and cancellation are core [models](../../core/models.md):
the cloud and own-key text handlers are each registered twice, so core
retries a transient refusal once. This spec decides which handler a backend
serves, how a cloud refusal maps onto core's outcomes and onto the account
state, and when a pushed credential takes effect.

Text and image description use the cloud client's chat completion (an image
description is a chat completion with an image part); the own-key handler
classifies its HTTP failures into the same refusal vocabulary: a spent quota
is insufficient credits, and a timeout, a conflict or an overloaded bad
request without a validation complaint is a provider issue. HTTP, the
credential value and the client stay in the shell (`models/*.vibe`); the
credential lives in memory only and appears in no state here. Source: the
develop cloud plugin's text and image handlers, the pinned embedded host's
credential routes and the device hosts' provider settings.

## Story: Answer with the backend the host chose

> As the owner, I want my agent to think with the account or key I chose
> when it started, and with nothing else, so that I know who answers and
> who is paid.

### The binding is set once from an admitted launch and never changes while the process runs

The process binds after the launch is admitted, with the public view of the
launch frame. The binding keeps only the credential's version, and keeps it
exactly when the backend needs one.

```quint
import launch.* from "../host/launch"
type BindPhase = Unbound | Bound
type AccountFailure = CredentialInvalid({ version: int }) | InsufficientCredits | LimitReached({ retryAt: int }) | ProviderIssue
type AccountState = Usable | Failing({ failure: AccountFailure })
type LastCloudFailure = NoCloudFailure | CloudFailedAt({ failure: AccountFailure, at: int })
type Call = { id: int, credentialVersion: int }
type ModelBinding = { phase: BindPhase, backend: Backend, account: OwnerAccount, embeddings: Embeddings, google: GoogleConsent,
  credentialVersion: int, accountState: AccountState, lastCloudFailure: LastCloudFailure, calls: List[Call], nextCall: int, clock: int }
pure val initial: ModelBinding = { phase: Unbound, backend: NoBackend, account: NoAccount, embeddings: NoEmbeddings,
  google: { gmailChanges: false, calendarEdits: false }, credentialVersion: 0, accountState: Usable, lastCloudFailure: NoCloudFailure, calls: List(), nextCall: 0, clock: 0 }
pure val viewValues = Set({ epoch: 1, credentialVersion: 1 }, { epoch: 1, credentialVersion: 0 }, { epoch: 2, credentialVersion: 2 })
pure def canBind(s: ModelBinding, doc: LaunchDocument, view: FrameView): bool =
  s.phase == Unbound and documentAdmitted(doc) and view.epoch >= 1 and view.credentialVersion >= 0 and (needsCredential(doc.backend) implies view.credentialVersion >= 1)
pure def bind(s: ModelBinding, doc: LaunchDocument, view: FrameView): ModelBinding =
  { ...s, phase: Bound, backend: doc.backend, account: doc.account, embeddings: doc.embeddings, google: doc.google,
    credentialVersion: if (needsCredential(doc.backend)) view.credentialVersion else 0 }
pure def alwaysUnboundHoldsNothing(s: ModelBinding): bool = s.phase == Unbound implies
  (s.backend == NoBackend and s.credentialVersion == 0 and s.calls.length() == 0 and s.nextCall == 0 and s.accountState == Usable and s.lastCloudFailure == NoCloudFailure)
pure def alwaysCredentialFollowsBackend(s: ModelBinding): bool = s.credentialVersion >= 0 and (s.phase == Bound implies (needsCredential(s.backend) iff s.credentialVersion >= 1))
pure def stepBindingFixedOnceBound(before: ModelBinding, after: ModelBinding): bool = before.phase == Bound implies
  (after.phase == Bound and after.backend == before.backend and after.account == before.account and after.embeddings == before.embeddings and after.google == before.google)
pure def sometimesBoundToCloud(s: ModelBinding): bool = s.phase == Bound and isCloud(s.backend)
pure def sometimesBoundWithoutBackend(s: ModelBinding): bool = s.phase == Bound and s.backend == NoBackend
```

### No text handler is ever served by a model on the device

`TEXT_SMALL` and `TEXT_LARGE` come from the backend, `IMAGE_DESCRIPTION`
only from the cloud, and `TEXT_EMBEDDING` only from `localInference` when
the launch asks for local embeddings.

```quint
type ModelHandler = TextSmall | TextLarge | ImageDescription | TextEmbedding
type HandlerSource = FromCloud | FromOwnKey | FromLocalInference | NotRegistered
pure def isCloud(backend: Backend): bool = match backend { | CloudBackend(_) => true | _ => false }
pure def handlerSource(backend: Backend, embeddings: Embeddings, handler: ModelHandler): HandlerSource =
  if (handler == TextEmbedding) (if (embeddings == NoEmbeddings) NotRegistered else FromLocalInference)
  else if (isCloud(backend)) FromCloud
  else if (isOwnKey(backend) and handler != ImageDescription) FromOwnKey
  else NotRegistered
pure val backendValues = Set(NoBackend,
  CloudBackend({ baseUrl: "https://cloud.example", baseUrlShape: HttpsOrigin, smallModel: "", largeModel: "", imageModel: "" }),
  OwnKeyBackend({ baseUrl: "https://own.example/v1", baseUrlShape: HttpsWithPath, smallModel: "small", largeModel: "large" }))
pure val embeddingsValues = Set(NoEmbeddings, LocalEmbeddings({ dimensions: 384 }))
pure def lawNoTextHandlerFromALocalModel(backend: Backend, embeddings: Embeddings, handler: ModelHandler): bool =
  handler != TextEmbedding implies handlerSource(backend, embeddings, handler) != FromLocalInference
pure def lawImageDescriptionOnlyFromTheCloud(backend: Backend, embeddings: Embeddings): bool =
  handlerSource(backend, embeddings, ImageDescription) != NotRegistered iff isCloud(backend)
```

### A model call starts only for a handler the backend serves, with the credential the binding holds

A launch with no backend never calls a model, so its account state stays
usable. Each call remembers the credential version it was sent with.
The next call number starts at zero and advances for each admitted call.

```quint
pure val nowValues = Set(0, 5, 10)
pure val idValues = Set(0, 1, 2)
pure def clockAt(s: ModelBinding, now: int): int = if (now > s.clock) now else s.clock
pure def servedByBackend(backend: Backend, handler: ModelHandler): bool = {
  val source = handlerSource(backend, NoEmbeddings, handler)
  source == FromCloud or source == FromOwnKey
}
pure def canStartCall(s: ModelBinding, handler: ModelHandler, now: int): bool =
  s.phase == Bound and servedByBackend(s.backend, handler) and not(limitedAt(s.accountState, clockAt(s, now)))
pure def startCall(s: ModelBinding, handler: ModelHandler, now: int): ModelBinding =
  { ...s, calls: s.calls.append({ id: s.nextCall, credentialVersion: s.credentialVersion }), nextCall: s.nextCall + 1, clock: clockAt(s, now) }
pure def alwaysCallsUseAHeldCredential(s: ModelBinding): bool =
  s.nextCall >= 0 and s.calls.every(c => c.id >= 0 and c.id < s.nextCall and c.credentialVersion >= 1 and c.credentialVersion <= s.credentialVersion)
pure def alwaysNoBackendNeverCalls(s: ModelBinding): bool = s.backend == NoBackend implies
  (s.nextCall == 0 and s.accountState == Usable and s.lastCloudFailure == NoCloudFailure)
pure def stepClockNeverGoesBack(before: ModelBinding, after: ModelBinding): bool = after.clock >= before.clock
pure def sometimesOwnKeyAnswered(s: ModelBinding): bool = isOwnKey(s.backend) and s.nextCall >= 1 and s.calls.length() == 0 and s.accountState == Usable
```

### Only a network failure, an outage or a provider issue is retried, and a rate limit ends the call

The handlers read a refusal as the cloud client's `CloudError`; the own-key
handler classifies its HTTP failures into the same variants. Core retries
`RefusedConnection` and `RetryEnvelope` on the second registration. A rate
limit is core's exhausted budget, which removes the provider's remaining
registration; a refused request is a bad request; every other refusal ends
the call.

```quint
import models as M from "../../core/models"
import client as C from "../../cloud/client"
pure def outcomeOf(e: C::CloudError): M::Outcome = match e {
  | CloudNetwork => M::RefusedConnection
  | CloudUnavailable(_) => M::RetryEnvelope
  | CloudProviderIssue => M::RetryEnvelope
  | CloudRateLimited(_) => M::ExhaustedBudget
  | CloudInsufficientCredits => M::FundingDenied
  | CloudAllowanceExhausted(_) => M::FundingDenied
  | CloudRefused(_) => M::BadRequest
  | _ => M::ProcessingDenied
}
pure def transient(e: C::CloudError): bool = match e { | CloudNetwork => true | CloudUnavailable(_) => true | CloudProviderIssue => true | _ => false }
pure def rateLimited(e: C::CloudError): bool = match e { | CloudRateLimited(_) => true | _ => false }
pure def lawOnlyTransientRefusalsAreRetried(e: C::CloudError): bool = (M::retryable(outcomeOf(e)) and outcomeOf(e) != M::ExhaustedBudget) iff transient(e)
pure def lawRateLimitExhaustsTheProvider(e: C::CloudError): bool = rateLimited(e) iff outcomeOf(e) == M::ExhaustedBudget
```

### A tool call, a structured answer and the token use reach the caller as one result

A call that offers tools, names the tool to use or asks for a schema gets one
result: the text, every tool call with its arguments, the finish reason and
the token use. Any other call gets the text alone. Tool results follow the
call that asked for them; a result no call asked for is sent as the person's
text. An answer with neither text nor a tool call is a provider issue.

```quint
type ChatAsk = { offersTools: bool, choosesTool: bool, asksSchema: bool }
type ChatAnswer = { textBlank: bool, toolCalls: int }
type ChatReturn = AnswerText | AnswerResult | AnswerProviderIssue
pure def wantsResult(ask: ChatAsk): bool = ask.offersTools or ask.choosesTool or ask.asksSchema
pure def chatReturn(ask: ChatAsk, answer: ChatAnswer): ChatReturn =
  if (answer.textBlank and answer.toolCalls == 0) AnswerProviderIssue
  else if (wantsResult(ask)) AnswerResult
  else AnswerText
pure val askValues = Set({ offersTools: false, choosesTool: false, asksSchema: false }, { offersTools: true, choosesTool: false, asksSchema: false },
  { offersTools: true, choosesTool: true, asksSchema: false }, { offersTools: false, choosesTool: false, asksSchema: true })
pure val answerValues = Set({ textBlank: true, toolCalls: 0 }, { textBlank: true, toolCalls: 1 }, { textBlank: false, toolCalls: 0 }, { textBlank: false, toolCalls: 2 })
pure def lawAnEmptyAnswerIsAProviderIssue(ask: ChatAsk, answer: ChatAnswer): bool =
  (answer.textBlank and answer.toolCalls == 0) iff chatReturn(ask, answer) == AnswerProviderIssue
pure def lawOnlyAToolOrSchemaCallGetsTheResult(ask: ChatAsk, answer: ChatAnswer): bool =
  chatReturn(ask, answer) != AnswerProviderIssue implies (chatReturn(ask, answer) == AnswerResult iff wantsResult(ask))
pure def lawToolCallsAreNeverDroppedForText(ask: ChatAsk, answer: ChatAnswer): bool =
  (answer.toolCalls > 0 and not(wantsResult(ask))) implies chatReturn(ask, answer) == AnswerText
```

## Story: Keep the account state honest

> As the owner, I want to see why my agent cannot answer, from what the
> cloud last said and nothing older, so that I fix the right thing.

### Each refusal is one account state, and the last failure records its kind and time without text

`credential_invalid`, `insufficient_credits` (credits or a spent allowance),
`limit_reached` with its retry time, and `provider_issue` (an outage, a
provider issue, a network failure, or a refused request or consent) are the one failure vocabulary: turns put
them on the reply and status reports them. `lastCloudFailure` is
`{kind, at, retryAt?}`; it never holds message text or a credential.

```quint
pure def failureOf(e: C::CloudError, version: int): AccountFailure = match e {
  | CloudCredentialInvalid(_) => CredentialInvalid({ version: version })
  | CloudInsufficientCredits => InsufficientCredits
  | CloudAllowanceExhausted(_) => InsufficientCredits
  | CloudRateLimited(x) => LimitReached({ retryAt: x.retryAt })
  | _ => ProviderIssue
}
pure def failureName(f: AccountFailure): str = match f {
  | CredentialInvalid(_) => "credential_invalid" | InsufficientCredits => "insufficient_credits" | LimitReached(_) => "limit_reached" | ProviderIssue => "provider_issue"
}
pure def accountStateName(st: AccountState): str = match st { | Usable => "usable" | Failing(x) => failureName(x.failure) }
pure def retryAtOf(f: AccountFailure): int = match f { | LimitReached(x) => x.retryAt | _ => -1 }
pure def lastFailureKind(f: LastCloudFailure): str = match f { | CloudFailedAt(x) => failureName(x.failure) | NoCloudFailure => "" }
pure def callVersion(calls: List[Call], id: int): int = calls.select(c => c.id == id).nthOr(0, { id: -1, credentialVersion: 0 }).credentialVersion
pure def canRefuseCall(s: ModelBinding, id: int): bool = s.calls.some(c => c.id == id)
pure def refuseCall(s: ModelBinding, id: int, now: int, e: C::CloudError): ModelBinding = {
  val t = clockAt(s, now)
  val failure = failureOf(e, callVersion(s.calls, id))
  val ignored = staleRefusal(failure, s.credentialVersion)
  { ...s, calls: s.calls.select(c => c.id != id), clock: t,
    accountState: if (ignored) s.accountState else afterFailure(s.accountState, failure, t),
    lastCloudFailure: if (ignored) s.lastCloudFailure else CloudFailedAt({ failure: failure, at: t }) }
}
pure def alwaysFailingAccountHasALastFailure(s: ModelBinding): bool = s.accountState != Usable implies s.lastCloudFailure != NoCloudFailure
pure def failedAt(f: LastCloudFailure): int = match f { | CloudFailedAt(x) => x.at | NoCloudFailure => 0 }
pure def alwaysLastFailureIsNotInTheFuture(s: ModelBinding): bool = failedAt(s.lastCloudFailure) <= s.clock
pure def sometimesInsufficientCredits(s: ModelBinding): bool = s.accountState == Failing({ failure: InsufficientCredits })
pure def sometimesCredentialInvalid(s: ModelBinding): bool = accountStateName(s.accountState) == "credential_invalid"
pure def sometimesProviderIssue(s: ModelBinding): bool = s.accountState == Failing({ failure: ProviderIssue })
```

### No call starts before a rate limit's retry time, and a provider issue does not lift a limit still in force

A refused credential, spent credits or a newer limit replace a limit.

```quint
pure def limitedBy(f: AccountFailure, t: int): bool = match f { | LimitReached(x) => t < x.retryAt | _ => false }
pure def limitedAt(st: AccountState, t: int): bool = match st { | Failing(x) => limitedBy(x.failure, t) | Usable => false }
pure def afterFailure(st: AccountState, failure: AccountFailure, t: int): AccountState =
  if (failure == ProviderIssue and limitedAt(st, t)) st else Failing({ failure: failure })
pure def stepNoCallBeforeRetryAt(before: ModelBinding, via: str, after: ModelBinding): bool = via == "startCall" implies not(limitedAt(before.accountState, after.clock))
pure def sometimesLimitReached(s: ModelBinding): bool = limitedAt(s.accountState, s.clock)
pure def sometimesProviderIssueKeepsTheLimit(s: ModelBinding): bool =
  limitedAt(s.accountState, s.clock) and lastFailureKind(s.lastCloudFailure) == "provider_issue"
```

### An answer clears the account state, except a limit not yet over

An answer records no failure: the last failure stays for status to report.

```quint
pure def afterSuccess(st: AccountState, t: int): AccountState = if (limitedAt(st, t)) st else Usable
pure def canAnswerCall(s: ModelBinding, id: int): bool = s.calls.some(c => c.id == id)
pure def answerCall(s: ModelBinding, id: int, now: int): ModelBinding = {
  val t = clockAt(s, now)
  { ...s, calls: s.calls.select(c => c.id != id), clock: t, accountState: afterSuccess(s.accountState, t) }
}
pure def lawAnswerLeavesOnlyALimitInForce(st: AccountState, t: int): bool =
  afterSuccess(st, t) == Usable or (afterSuccess(st, t) == st and limitedAt(st, t))
pure def sometimesLimitClearedByAnAnswer(s: ModelBinding): bool =
  s.accountState == Usable and lastFailureKind(s.lastCloudFailure) == "limit_reached"
```

### A pushed credential replaces the key only at a higher version of the launch account, and needs no restart

`PUT /api/host/cloud-credential {version, credential, expiresAt, account}`
is Root only: `credential` is the cloud device key and `expiresAt` its
expiry as a nonnegative integer of milliseconds since the Unix epoch.
The shell swaps the key behind the cloud client's credential getter in
memory only. Calls in flight go on. Malformed requests receive 400 and
refused pushes receive 409 with their reason. A new sign-in of the same
account after the key expired or was revoked pushes this way; another
account is a new launch.

```quint
type PushVerdict = PushAccepted | PushNotCloud | PushStaleVersion | PushOtherAccount
pure def pushVerdict(s: ModelBinding, version: int, account: OwnerAccount): PushVerdict =
  if (s.phase != Bound or not(isCloud(s.backend))) PushNotCloud
  else if (account != s.account) PushOtherAccount
  else if (version <= s.credentialVersion) PushStaleVersion
  else PushAccepted
pure val versionValues = Set(1, 2, 3)
pure val accountValues = Set(SignedIn({ userId: "user1", organizationId: "org1" }), SignedIn({ userId: "user2", organizationId: "org1" }), NoAccount)
pure def canPushCredential(s: ModelBinding, version: int, account: OwnerAccount): bool = pushVerdict(s, version, account) == PushAccepted
pure def pushCredential(s: ModelBinding, version: int, account: OwnerAccount): ModelBinding =
  { ...s, credentialVersion: version, accountState: if (credentialRefused(s.accountState)) Usable else s.accountState }
pure def credentialRefused(st: AccountState): bool = accountStateName(st) == "credential_invalid"
pure def stepPushKeepsCallsAndOtherStates(before: ModelBinding, via: str, after: ModelBinding): bool = via == "pushCredential" implies
  (after.calls == before.calls and after.credentialVersion > before.credentialVersion and not(credentialRefused(after.accountState))
    and (not(credentialRefused(before.accountState)) implies after.accountState == before.accountState))
pure def sometimesCredentialInvalidClearedByPush(s: ModelBinding): bool =
  s.credentialVersion >= 2 and s.accountState == Usable and lastFailureKind(s.lastCloudFailure) == "credential_invalid"
```

### A refusal of a replaced credential never marks the new one invalid

A call sent with an older version that comes back `credentialInvalid`
changes neither the account state nor the last failure.

```quint
pure def staleRefusal(f: AccountFailure, held: int): bool = match f { | CredentialInvalid(x) => x.version != held | _ => false }
pure def staleState(st: AccountState, held: int): bool = match st { | Failing(x) => staleRefusal(x.failure, held) | Usable => false }
pure def alwaysCredentialRefusalNamesTheHeldKey(s: ModelBinding): bool = not(staleState(s.accountState, s.credentialVersion))
```

### Warm answers from the binding state and never reaches the cloud

`POST /api/cloud/warm` (Root) is advisory: ready only for a cloud backend
whose account is not blocked. Blocked is a refused credential, spent
credits, or a limit still in force; status reports it as `blocked`.

```quint
type WarmAnswer = WarmReady | WarmBlocked | WarmNoCloud
pure def failureBlocks(f: AccountFailure, t: int): bool = match f {
  | CredentialInvalid(_) => true | InsufficientCredits => true | LimitReached(x) => t < x.retryAt | ProviderIssue => false
}
pure def blocked(st: AccountState, t: int): bool = match st { | Failing(x) => failureBlocks(x.failure, t) | Usable => false }
pure def warmAnswer(backend: Backend, st: AccountState, t: int): WarmAnswer = if (not(isCloud(backend))) WarmNoCloud else if (blocked(st, t)) WarmBlocked else WarmReady
pure val stValues = Set(Usable, Failing({ failure: CredentialInvalid({ version: 1 }) }), Failing({ failure: InsufficientCredits }),
  Failing({ failure: LimitReached({ retryAt: 5 }) }), Failing({ failure: ProviderIssue }))
pure val tValues = Set(0, 5, 10)
pure def lawWarmReadyOnlyWhenATextCallWouldStart(backend: Backend, st: AccountState, t: int): bool =
  warmAnswer(backend, st, t) == WarmReady implies (servedByBackend(backend, TextSmall) and not(limitedAt(st, t)))
```

## Story: Hold only the key the host admitted for this backend

> As the owner, I want the key I gave for one provider used only for that
> provider and dropped when I sign out, so that no other provider, plugin,
> log or reply ever sees it.

### A key is held only in the slot of the backend it was given for, and only as a bearer credential that slot accepts

A cloud launch holds the cloud device key and an own-key launch the
owner's provider key; a launch with no backend holds none, so a frame
credential given to it is dropped before the binding and reaches no
plugin. A key is a bearer credential: visible ASCII only (no space,
control character or line break), at least 8 characters, at most 16,384
for a cloud device key and 1,024 for an own provider key. The launch frame
refuses a credential outside the widest bound, the launch verdict refuses an
own-key launch whose key exceeds its slot's as a credential error before
binding ([launch](../host/launch.md)), and a push whose credential is
not a cloud device key is malformed. A pushed key replaces only the cloud
slot. Sign-out and an account change are new launches: the host stops this
process, and the key, held in memory only, ends with it; a push naming
another account is refused and keeps the held key. No status, route
answer, receipt or log line carries a key: the push answers with its
version and the account state alone.

```quint
type KeySlot = CloudDeviceKey | OwnProviderKey | NoKeySlot
type KeyShape = { units: int, visibleAscii: bool }
pure def keySlot(b: Backend): KeySlot = match b { | CloudBackend(_) => CloudDeviceKey | OwnKeyBackend(_) => OwnProviderKey | NoBackend => NoKeySlot }
pure def maxKeyUnits(slot: KeySlot): int = match slot { | CloudDeviceKey => 16384 | OwnProviderKey => ownKeyMaxUnits | NoKeySlot => 0 }
pure def keyAdmitted(slot: KeySlot, shape: KeyShape): bool =
  slot != NoKeySlot and shape.visibleAscii and shape.units >= 8 and shape.units <= maxKeyUnits(slot)
pure def holdsKey(b: Backend, given: bool, shape: KeyShape): bool = given and keyAdmitted(keySlot(b), shape)
pure val shapeValues = Set({ units: 8, visibleAscii: true }, { units: 7, visibleAscii: true }, { units: 64, visibleAscii: false },
  { units: 1024, visibleAscii: true }, { units: 1025, visibleAscii: true }, { units: 16385, visibleAscii: true })
pure val slotValues = Set(CloudDeviceKey, OwnProviderKey, NoKeySlot)
pure def lawALaunchWithoutBackendHoldsNoKey(shape: KeyShape): bool = not(holdsKey(NoBackend, true, shape))
pure def lawAKeyWithSpaceOrControlIsNeverHeld(slot: KeySlot, units: int): bool = not(keyAdmitted(slot, { units: units, visibleAscii: false }))
pure def lawAnOwnKeyNeverTakesACloudSizedKey(shape: KeyShape): bool = shape.units > 1024 implies not(keyAdmitted(OwnProviderKey, shape))
pure def lawEachSlotIsWithinTheFrameBound(slot: KeySlot, shape: KeyShape): bool = keyAdmitted(slot, shape) implies shape.units <= 16384
```

## Story: Give plugins the owner's cloud link

> As the owner, I want my mail and calendar plugins to use my cloud account
> without ever holding my key, and to change nothing I did not allow.

### Plugins reach the cloud only through the cloud service of a cloud backend, and a managed Google change needs the owner's consent

The runtime service `cloud` hands plugins the authenticated cloud client;
no plugin reads the credential. A managed Gmail change needs
`launch.google.gmailChanges`, a calendar edit `launch.google.calendarEdits`
(a refusal is `changes-off`, before any cloud call); reads need only the
link for ordinary reads. The link refuses the private inbox arrival route
before any cloud call. No plugin, native module or managed-Google host is a
precondition of a cloud backend.

```quint
type GoogleOperation = GmailChange | CalendarEdit | GoogleRead
pure def googleAdmitted(backend: Backend, consent: GoogleConsent, op: GoogleOperation): bool =
  isCloud(backend) and (if (op == GmailChange) consent.gmailChanges else if (op == CalendarEdit) consent.calendarEdits else true)
pure val consentValues = Set({ gmailChanges: false, calendarEdits: false }, { gmailChanges: true, calendarEdits: false }, { gmailChanges: false, calendarEdits: true })
pure def lawGoogleChangeNeedsConsent(backend: Backend, consent: GoogleConsent): bool =
  (googleAdmitted(backend, consent, GmailChange) implies consent.gmailChanges) and (googleAdmitted(backend, consent, CalendarEdit) implies consent.calendarEdits)
pure def lawGoogleReadNeedsOnlyTheLink(backend: Backend, consent: GoogleConsent): bool = googleAdmitted(backend, consent, GoogleRead) iff isCloud(backend)
pure val privateInboxArrivalPath = "/api/v1/eliza/google/gmail/inbox-v1/arrival"
pure def pluginCloudPathAllowed(pathname: str): bool = pathname != privateInboxArrivalPath
pure val pathnameValues = Set(privateInboxArrivalPath, "/api/v1/eliza/google/gmail/read")
pure def lawPrivateInboxArrivalStaysOffThePluginLink(pathname: str): bool =
  pathname == privateInboxArrivalPath implies not(pluginCloudPathAllowed(pathname))
```
