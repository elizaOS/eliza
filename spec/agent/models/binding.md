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
classifies its HTTP failures into the same refusal vocabulary. HTTP, the
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
type AccountState = Usable | CredentialInvalid({ version: int }) | InsufficientCredits | LimitReached({ retryAt: int }) | ProviderIssue
type LastCloudFailure = NoCloudFailure | CloudFailedAt({ kind: AccountState, at: int })
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
pure def isOwnKey(backend: Backend): bool = match backend { | OwnKeyBackend(_) => true | _ => false }
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
  s.calls.every(c => c.id >= 0 and c.id < s.nextCall and c.credentialVersion >= 1 and c.credentialVersion <= s.credentialVersion and s.calls.select(d => d.id == c.id).length() == 1)
pure def alwaysNoBackendNeverCalls(s: ModelBinding): bool = s.backend == NoBackend implies
  (s.nextCall == 0 and s.accountState == Usable and s.lastCloudFailure == NoCloudFailure)
pure def stepClockNeverGoesBack(before: ModelBinding, after: ModelBinding): bool = after.clock >= before.clock
pure def sometimesOwnKeyAnswered(s: ModelBinding): bool = isOwnKey(s.backend) and s.nextCall >= 1 and s.calls.length() == 0 and s.accountState == Usable
```

### Only a network failure, an outage or a provider issue is retried, and a rate limit ends the call

Core retries `RefusedConnection` and `RetryEnvelope` on the second
registration. A rate limit is core's exhausted budget, which removes the
provider's remaining registration; every other refusal ends the call.

```quint
import models as M from "../../core/models"
type CloudError = CloudCredentialInvalid | CloudInsufficientCredits | CloudAllowanceExhausted({ resetsAt: int }) | CloudRateLimited({ retryAt: int })
  | CloudConsentRequired | CloudUnavailable({ retryAfter: int }) | CloudProviderIssue | CloudNetwork
pure def outcomeOf(e: CloudError): M::Outcome = match e {
  | CloudNetwork => M::RefusedConnection
  | CloudUnavailable(_) => M::RetryEnvelope
  | CloudProviderIssue => M::RetryEnvelope
  | CloudRateLimited(_) => M::ExhaustedBudget
  | CloudInsufficientCredits => M::FundingDenied
  | CloudAllowanceExhausted(_) => M::FundingDenied
  | _ => M::ProcessingDenied
}
pure def transient(e: CloudError): bool = match e { | CloudNetwork => true | CloudUnavailable(_) => true | CloudProviderIssue => true | _ => false }
pure val eValues = Set(CloudCredentialInvalid, CloudInsufficientCredits, CloudAllowanceExhausted({ resetsAt: 10 }), CloudRateLimited({ retryAt: 5 }),
  CloudRateLimited({ retryAt: 10 }), CloudConsentRequired, CloudUnavailable({ retryAfter: 5 }), CloudProviderIssue, CloudNetwork)
pure def lawOnlyTransientRefusalsAreRetried(e: CloudError): bool = (M::retryable(outcomeOf(e)) and outcomeOf(e) != M::ExhaustedBudget) iff transient(e)
pure def lawRateLimitExhaustsTheProvider(e: CloudError): bool = (match e { | CloudRateLimited(_) => true | _ => false }) iff outcomeOf(e) == M::ExhaustedBudget
```

## Story: Keep the account state honest

> As the owner, I want to see why my agent cannot answer, from what the
> cloud last said and nothing older, so that I fix the right thing.

### Each refusal is one account state, and the last failure records its kind and time without text

`credential_invalid`, `insufficient_credits` (credits or a spent allowance),
`limit_reached` with its retry time, and `provider_issue` (outage, provider
issue, network, or anything else) are the one failure vocabulary: turns put
them on the reply and status reports them. `lastCloudFailure` is
`{kind, at, retryAt?}`; it never holds message text or a credential.

```quint
type CallResult = CallAnswered | CallRefused({ error: CloudError })
pure def accountStateOf(e: CloudError, version: int): AccountState = match e {
  | CloudCredentialInvalid => CredentialInvalid({ version: version })
  | CloudInsufficientCredits => InsufficientCredits
  | CloudAllowanceExhausted(_) => InsufficientCredits
  | CloudRateLimited(x) => LimitReached({ retryAt: x.retryAt })
  | _ => ProviderIssue
}
pure def resultKind(result: CallResult, version: int): AccountState = match result { | CallAnswered => Usable | CallRefused(r) => accountStateOf(r.error, version) }
pure def accountStateName(st: AccountState): str = match st {
  | Usable => "usable" | CredentialInvalid(_) => "credential_invalid" | InsufficientCredits => "insufficient_credits" | LimitReached(_) => "limit_reached" | ProviderIssue => "provider_issue"
}
pure def retryAtOf(st: AccountState): int = match st { | LimitReached(x) => x.retryAt | _ => -1 }
pure def callVersion(calls: List[Call], id: int): int = calls.select(c => c.id == id).nthOr(0, { id: -1, credentialVersion: 0 }).credentialVersion
pure val resultValues = Set(CallAnswered, CallRefused({ error: CloudCredentialInvalid }), CallRefused({ error: CloudInsufficientCredits }),
  CallRefused({ error: CloudRateLimited({ retryAt: 5 }) }), CallRefused({ error: CloudRateLimited({ retryAt: 10 }) }), CallRefused({ error: CloudProviderIssue }), CallRefused({ error: CloudNetwork }))
pure def canFinishCall(s: ModelBinding, id: int): bool = s.calls.some(c => c.id == id)
pure def finishCall(s: ModelBinding, id: int, now: int, result: CallResult): ModelBinding = {
  val t = clockAt(s, now)
  val kind = resultKind(result, callVersion(s.calls, id))
  val ignored = staleRefusal(kind, s.credentialVersion)
  { ...s, calls: s.calls.select(c => c.id != id), clock: t,
    accountState: if (kind == Usable) afterSuccess(s.accountState, t) else if (ignored) s.accountState else afterFailure(s.accountState, kind, t),
    lastCloudFailure: if (kind == Usable or ignored) s.lastCloudFailure else CloudFailedAt({ kind: kind, at: t }) }
}
pure def lawEveryRefusalIsAnAccountFailure(e: CloudError, version: int): bool = accountStateOf(e, version) != Usable
pure def alwaysFailingAccountHasALastFailure(s: ModelBinding): bool = s.accountState != Usable implies s.lastCloudFailure != NoCloudFailure
pure def lastFailureKind(f: LastCloudFailure): str = match f { | CloudFailedAt(x) => accountStateName(x.kind) | NoCloudFailure => "" }
pure def lastFailureAt(f: LastCloudFailure): int = match f { | CloudFailedAt(x) => x.at | NoCloudFailure => 0 }
pure def alwaysLastFailureNamesAFailure(s: ModelBinding): bool = lastFailureKind(s.lastCloudFailure) != "usable" and lastFailureAt(s.lastCloudFailure) <= s.clock
pure def sometimesInsufficientCredits(s: ModelBinding): bool = s.accountState == InsufficientCredits
```

### No call starts before a rate limit's retry time, and a provider issue does not lift a limit still in force

A refused credential, spent credits or a newer limit replace a limit.

```quint
pure def limitedAt(st: AccountState, t: int): bool = match st { | LimitReached(x) => t < x.retryAt | _ => false }
pure def afterFailure(st: AccountState, kind: AccountState, t: int): AccountState = if (kind == ProviderIssue and limitedAt(st, t)) st else kind
pure def stepNoCallBeforeRetryAt(before: ModelBinding, via: str, after: ModelBinding): bool = via == "startCall" implies not(limitedAt(before.accountState, after.clock))
pure def sometimesLimitReached(s: ModelBinding): bool = limitedAt(s.accountState, s.clock)
pure def sometimesProviderIssueKeepsTheLimit(s: ModelBinding): bool =
  limitedAt(s.accountState, s.clock) and lastFailureKind(s.lastCloudFailure) == "provider_issue"
```

### An answer clears the account state, except a limit not yet over

```quint
pure def afterSuccess(st: AccountState, t: int): AccountState = if (limitedAt(st, t)) st else Usable
pure def lawAnswerLeavesOnlyALimitInForce(st: AccountState, t: int): bool =
  afterSuccess(st, t) == Usable or (afterSuccess(st, t) == st and limitedAt(st, t))
pure def sometimesLimitClearedByAnAnswer(s: ModelBinding): bool =
  s.accountState == Usable and lastFailureKind(s.lastCloudFailure) == "limit_reached"
```

### A pushed credential replaces the key only at a higher version of the launch account, and needs no restart

`PUT /api/host/cloud-credential {version, credential, expiresAt, account}`
is Root only: `credential` is the cloud device key and `expiresAt` its
expiry. The shell swaps the key behind the cloud client's credential getter,
in memory only; calls in flight go on, and every refusal is 409 with its
reason. A new sign-in of the same account after the key expired or was
revoked pushes this way; another account is a new launch.

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
  { ...s, credentialVersion: version, accountState: if (accountStateName(s.accountState) == "credential_invalid") Usable else s.accountState }
pure def stepPushKeepsCallsAndOtherStates(before: ModelBinding, via: str, after: ModelBinding): bool = via == "pushCredential" implies
  (after.calls == before.calls and after.credentialVersion > before.credentialVersion and accountStateName(after.accountState) != "credential_invalid"
    and (accountStateName(before.accountState) != "credential_invalid" implies after.accountState == before.accountState))
pure def sometimesCredentialInvalidClearedByPush(s: ModelBinding): bool =
  s.credentialVersion >= 2 and s.accountState == Usable and lastFailureKind(s.lastCloudFailure) == "credential_invalid"
```

### A refusal of a replaced credential never marks the new one invalid

A call sent with an older version that comes back `credentialInvalid`
changes neither the account state nor the last failure.

```quint
pure def staleRefusal(kind: AccountState, held: int): bool = match kind { | CredentialInvalid(x) => x.version != held | _ => false }
pure def alwaysCredentialRefusalNamesTheHeldKey(s: ModelBinding): bool = not(staleRefusal(s.accountState, s.credentialVersion))
```

### Warm answers from the binding state and never reaches the cloud

`POST /api/cloud/warm` (Root) is advisory: ready only for a cloud backend
whose account is not blocked. Blocked is a refused credential, spent
credits, or a limit still in force; status reports it as `blocked`.

```quint
type WarmAnswer = WarmReady | WarmBlocked | WarmNoCloud
pure def blocked(st: AccountState, t: int): bool = match st { | CredentialInvalid(_) => true | InsufficientCredits => true | LimitReached(x) => t < x.retryAt | _ => false }
pure def warmAnswer(backend: Backend, st: AccountState, t: int): WarmAnswer = if (not(isCloud(backend))) WarmNoCloud else if (blocked(st, t)) WarmBlocked else WarmReady
pure val stValues = Set(Usable, CredentialInvalid({ version: 1 }), InsufficientCredits, LimitReached({ retryAt: 5 }), ProviderIssue)
pure val tValues = Set(0, 5, 10)
pure def lawWarmReadyOnlyWhenATextCallWouldStart(backend: Backend, st: AccountState, t: int): bool =
  warmAnswer(backend, st, t) == WarmReady implies (servedByBackend(backend, TextSmall) and not(limitedAt(st, t)))
```

## Story: Give plugins the owner's cloud link

> As the owner, I want my mail and calendar plugins to use my cloud account
> without ever holding my key, and to change nothing I did not allow.

### Plugins reach the cloud only through the cloud service of a cloud backend, and a managed Google change needs the owner's consent

The runtime service `cloud` hands plugins the authenticated cloud client;
no plugin reads the credential. A managed Gmail change needs
`launch.google.gmailChanges`, a calendar edit `launch.google.calendarEdits`
(a refusal is `changes-off`, before any cloud call); reads need only the
link. No plugin, native module or managed-Google host is a precondition of
a cloud backend.

```quint
type GoogleOperation = GmailChange | CalendarEdit | GoogleRead
pure def googleAdmitted(backend: Backend, consent: GoogleConsent, op: GoogleOperation): bool =
  isCloud(backend) and (if (op == GmailChange) consent.gmailChanges else if (op == CalendarEdit) consent.calendarEdits else true)
pure val consentValues = Set({ gmailChanges: false, calendarEdits: false }, { gmailChanges: true, calendarEdits: false }, { gmailChanges: false, calendarEdits: true })
pure def lawGoogleChangeNeedsConsent(backend: Backend, consent: GoogleConsent): bool =
  (googleAdmitted(backend, consent, GmailChange) implies consent.gmailChanges) and (googleAdmitted(backend, consent, CalendarEdit) implies consent.calendarEdits)
pure def lawGoogleReadNeedsOnlyTheLink(backend: Backend, consent: GoogleConsent): bool = googleAdmitted(backend, consent, GoogleRead) iff isCloud(backend)
```
