# Model binding

The text backend the launch chose, the account state the owner sees, the
credential push and the cloud link plugins use. The backend is fixed for
the life of the process: the owner's cloud account, the owner's own key for
an OpenAI-compatible endpoint, or none ([launch](../host/launch.md)). An
account, backend or embeddings change is a new launch, decided by the host.
Retry, fallback and cancellation are core [models](../../core/models.md):
the cloud and own-key text handlers are each registered twice, so core
retries a transient refusal once. A rate-limited call whose dispatch reached
the provider once is re-sent once by the turn that made it, never by the
transport ([planning](../conversation/planning.md)).
This spec decides which handler a backend serves, what a call sends, how a
cloud refusal maps onto core's outcomes and onto the account state, how long
a rate limit holds the account, and when a pushed credential takes effect.

Text and image description use the cloud client's chat completion (an image
description is a chat completion with an image part); the own-key handler
classifies its HTTP failures into the same refusal vocabulary: a spent quota
is insufficient credits, and a timeout, a conflict or a bad request without
a validation complaint that says the provider is overloaded or rate limited
(`rate` as a word, or a rate limit in any spelling, never the `rate` inside
`generate`) is a provider issue. HTTP, the
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
launch frame and whether an own-key endpoint's host is `cerebras.ai` or under
it, which sets how long a rate limit holds the account. The binding keeps only
the credential's version, and keeps it exactly when the backend needs one.

```quint
import launch.* from "../host/launch"
type BindPhase = Unbound | Bound
type AccountFailure = CredentialInvalid({ version: int }) | InsufficientCredits | LimitReached({ retryAt: int, providerRetryAt: int }) | ProviderIssue
type AccountState = Usable | Failing({ failure: AccountFailure })
type LastCloudFailure = NoCloudFailure | CloudFailedAt({ failure: AccountFailure, at: int })
type Call = { id: int, credentialVersion: int }
type ModelBinding = { phase: BindPhase, backend: Backend, account: OwnerAccount, embeddings: Embeddings, google: GoogleConsent,
  credentialVersion: int, maxHold: int, accountState: AccountState, lastCloudFailure: LastCloudFailure, calls: List[Call], nextCall: int, clock: int }
pure val initial: ModelBinding = { phase: Unbound, backend: NoBackend, account: NoAccount, embeddings: NoEmbeddings,
  google: { gmailChanges: false, calendarEdits: false }, credentialVersion: 0, maxHold: 0, accountState: Usable, lastCloudFailure: NoCloudFailure, calls: List(), nextCall: 0, clock: 0 }
pure val viewValues = Set({ epoch: 1, credentialVersion: 1 }, { epoch: 1, credentialVersion: 0 }, { epoch: 2, credentialVersion: 2 })
pure def canBind(s: ModelBinding, doc: LaunchDocument, view: FrameView): bool =
  s.phase == Unbound and documentAdmitted(doc) and view.epoch >= 1 and view.credentialVersion >= 0 and (needsCredential(doc.backend) implies view.credentialVersion >= 1)
pure def bind(s: ModelBinding, doc: LaunchDocument, view: FrameView, cerebrasRoute: bool): ModelBinding =
  { ...s, phase: Bound, backend: doc.backend, account: doc.account, embeddings: doc.embeddings, google: doc.google,
    credentialVersion: if (needsCredential(doc.backend)) view.credentialVersion else 0, maxHold: rateLimitHold(doc.backend, cerebrasRoute) }
pure def alwaysUnboundHoldsNothing(s: ModelBinding): bool = s.phase == Unbound implies
  (s.backend == NoBackend and s.credentialVersion == 0 and s.calls.length() == 0 and s.nextCall == 0 and s.accountState == Usable and s.lastCloudFailure == NoCloudFailure)
pure def alwaysCredentialFollowsBackend(s: ModelBinding): bool = s.credentialVersion >= 0 and (s.phase == Bound implies (needsCredential(s.backend) iff s.credentialVersion >= 1))
pure def stepBindingFixedOnceBound(before: ModelBinding, after: ModelBinding): bool = before.phase == Bound implies
  (after.phase == Bound and after.backend == before.backend and after.account == before.account and after.embeddings == before.embeddings and after.google == before.google and after.maxHold == before.maxHold)
pure def sometimesBoundToCloud(s: ModelBinding): bool = s.phase == Bound and isCloud(s.backend)
pure def sometimesBoundWithoutBackend(s: ModelBinding): bool = s.phase == Bound and s.backend == NoBackend
```

### No text handler is ever served by a model on the device

`TEXT_SMALL` and `TEXT_LARGE` come from the backend, `IMAGE_DESCRIPTION`
from the backend too (the cloud's image model, or the own key's large
model), and `TEXT_EMBEDDING` only from `localInference` when the launch asks
for local embeddings.

```quint
type ModelHandler = TextSmall | TextLarge | ImageDescription | TextEmbedding
type HandlerSource = FromCloud | FromOwnKey | FromLocalInference | NotRegistered
pure def isCloud(backend: Backend): bool = match backend { | CloudBackend(_) => true | _ => false }
pure def handlerSource(backend: Backend, embeddings: Embeddings, handler: ModelHandler): HandlerSource =
  if (handler == TextEmbedding) (if (embeddings == NoEmbeddings) NotRegistered else FromLocalInference)
  else if (isCloud(backend)) FromCloud
  else if (isOwnKey(backend)) FromOwnKey
  else NotRegistered
pure val backendValues = Set(NoBackend,
  CloudBackend({ baseUrl: "https://cloud.example", baseUrlShape: HttpsOrigin, smallModel: "", largeModel: "", imageModel: "" }),
  OwnKeyBackend({ baseUrl: "https://own.example/v1", baseUrlShape: HttpsWithPath, smallModel: "small", largeModel: "large" }))
pure val embeddingsValues = Set(NoEmbeddings, LocalEmbeddings({ dimensions: 384 }))
pure def lawNoTextHandlerFromALocalModel(backend: Backend, embeddings: Embeddings, handler: ModelHandler): bool =
  handler != TextEmbedding implies handlerSource(backend, embeddings, handler) != FromLocalInference
pure def lawImageDescriptionOnlyFromTheBackend(backend: Backend, embeddings: Embeddings): bool =
  handlerSource(backend, embeddings, ImageDescription) != NotRegistered iff (isCloud(backend) or isOwnKey(backend))
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

### Only a network failure, an outage or a provider issue is retried, and a rate limit ends the call for its turn to re-send once

The handlers read a refusal as the cloud client's `CloudError`; the own-key
handler classifies its HTTP failures into the same variants. Core retries
`RefusedConnection` and `RetryEnvelope` on the second registration. A rate
limit is core's exhausted budget, which removes the provider's remaining
registration; a refused request is a bad request; every other refusal ends
the call. Both attempts of one call carry the same `Idempotency-Key`, fresh
for each call, so a connection lost after the cloud dispatched the first
attempt is answered `409 already_dispatched` instead of running and charging
the generation again; for a rate limit, the transport never re-sends it;
the refusal carries the time left until the retry time the provider named,
and no wait at all when it named none, and unless the call's dispatch
already tried the provider again, the turn that made the call waits for
that, at most five seconds and five seconds when it names none, and sends
it once more ([planning](../conversation/planning.md)).

A refusal can also come inside a streamed answer, as a `data:` frame that
holds `error` in place of choices. It is read as the HTTP refusal it names,
with its body: the status is the frame's numeric `code`, else the status of
the cloud refusal code the frame carries as its `error`; a frame naming
neither is a provider issue, as a malformed frame is. The provider's own
code and message come from `provider_code` and `provider_message` when the
frame carries them, and its wait from `retryAfterMs` or `retryAfterSeconds`
as a `Retry-After` header in whole seconds would give it. A cloud refusal,
in a body or a frame, carries a provider's code, parameter and message
beside its own `error` as `code`, `param` and `providerMessage`, and they
are read as the same fields of a provider's own body.

```quint
import models as M from "../../core/models"
import client as C from "../../cloud/client"
pure def providerRetryAtOf(f: AccountFailure): int = match f { | LimitReached(x) => x.providerRetryAt | _ => -1 }
pure def refusalWait(f: AccountFailure, t: int): int = if (providerRetryAtOf(f) <= 0) -1 else if (providerRetryAtOf(f) > t) providerRetryAtOf(f) - t else 0
pure def lawAHintlessLimitCarriesNoWait(t: int): bool = refusalWait(LimitReached({ retryAt: 0, providerRetryAt: 0 }), t) < 0
pure def lawANamedWaitEndsAtTheProviderRetryTime(failure: AccountFailure, t: int): bool = refusalWait(failure, t) > 0 implies t + refusalWait(failure, t) == providerRetryAtOf(failure)
pure val unreadableFrameStatus = 502
pure def namesAStatus(status: int): bool = status >= 400 and status <= 599
pure def frameStatus(frameCode: int, codeStatus: int): int = if (namesAStatus(frameCode)) frameCode else if (namesAStatus(codeStatus)) codeStatus else unreadableFrameStatus
pure val frameCodeValues = Set(-1, 0, 400, 429)
pure val codeStatusValues = Set(-1, 429, 503)
pure def lawAFrameKeepsTheStatusItNames(frameCode: int, codeStatus: int): bool = namesAStatus(frameCode) implies frameStatus(frameCode, codeStatus) == frameCode
pure def lawACloudRefusalFrameTakesItsCodesStatus(frameCode: int, codeStatus: int): bool = (not(namesAStatus(frameCode)) and namesAStatus(codeStatus)) implies frameStatus(frameCode, codeStatus) == codeStatus
pure def lawAFrameNamingNoStatusIsUnreadable(frameCode: int): bool = not(namesAStatus(frameCode)) implies frameStatus(frameCode, -1) == unreadableFrameStatus
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

### A tool call the provider could not parse, or a streamed answer silent for a minute, ends the call without a retry

A refusal body or stream frame that says the provider could not parse a
tool call out of the model's own generation (`code` or `provider_code`
`parser_error`, or `type` `generation_error` with `param` `tool_calls`, flat
or inside an `error` envelope) is a bad request of its own: the request was sound and the sample
failed, so the transport never re-sends it and the turn decides whether it
gets one more try ([planning](../conversation/planning.md)). A streamed
answer whose provider sends no bytes for 60 seconds, first its headers and
then each next chunk, is abandoned and not re-sent, and the turn ends with
its failure reply. Only the time between bytes is bounded, never the whole
answer, so a long answer is never cut. Both are a provider issue in the
account state.

```quint
type ShellRefusal = ToolCallUnparsed | SilentStream
pure val streamIdleSeconds = 60
pure def shellOutcome(r: ShellRefusal): M::Outcome = match r { | ToolCallUnparsed => M::BadRequest | SilentStream => M::ProcessingDenied }
pure val rValues = Set(ToolCallUnparsed, SilentStream)
pure def lawAShellRefusalIsNeverRetried(r: ShellRefusal): bool = not(M::retryable(shellOutcome(r)))
pure def lawOnlyAParseFailureIsABadRequest(r: ShellRefusal): bool = (shellOutcome(r) == M::BadRequest) iff (r == ToolCallUnparsed)
```

### A tool call, a structured answer and the token use reach the caller as one result

A call that offers tools, names the tool to use or asks for a schema gets one
result: the text, every tool call with its arguments, the finish reason and
the token use. Any other call gets the text alone. Tool results follow the
call that asked for them; a result no call asked for is sent as the person's
text. An answer with neither text nor a tool call is a provider issue. A call
sends an output cap only when the caller or its admitted lease sets one;
otherwise the backend owns the output limit. A
streamed call asks for its token use (`stream_options.include_usage`), which
the provider sends in a last chunk without choices, and a call that is not
streamed sends no stream options. The token use carries the prompt tokens
the provider read from its prompt cache, when it names any, so a streamed
call is measured as a whole one is.

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
pure def usageAsked(streamed: bool): bool = streamed
pure def lawOnlyAStreamAsksForItsTokenUse(streamed: bool): bool = usageAsked(streamed) iff streamed
```

### A call sends an output cap only when its caller names one, and a thinking hint sets the reasoning effort only on a model that documents it

No handler adds an output cap of its own: a call that names none, or asks
to omit it, sends neither `max_tokens` nor `max_completion_tokens`, and the
model's own maximum applies. A caller's `providerOptions.eliza.thinking`
hint is `low` (bounded reasoning) or `off`. It becomes `reasoning_effort`
only for a Cerebras model that documents the value, on the cloud and on an
own-key endpoint whose host is `cerebras.ai` or under it: `low` is `low` on
`qwen-3.8-27b` and `gpt-oss-120b`; `off` is `none` on `qwen-3.8-27b`,
`zai-glm-4.7` and `gemma-4-31b`, and `low` on `gpt-oss-120b`. The shell
reads the model id without a `cerebras/` or `openai/` prefix and without a
`:` suffix. Any other model, any other endpoint, or no hint sends no effort,
and the hint itself never reaches the wire.

```quint
type ThinkingHint = NoThinkingHint | ThinkingLow | ThinkingOff
type ReasoningFamily = QwenReasoning | GptOssReasoning | OffOnlyReasoning | OtherReasoning
type ReasoningEffort = ProviderDefault | EffortLow | EffortNone
pure def effortFor(family: ReasoningFamily, hint: ThinkingHint): ReasoningEffort = match hint {
  | ThinkingLow => if (family == QwenReasoning or family == GptOssReasoning) EffortLow else ProviderDefault
  | ThinkingOff => if (family == GptOssReasoning) EffortLow else if (family == QwenReasoning or family == OffOnlyReasoning) EffortNone else ProviderDefault
  | NoThinkingHint => ProviderDefault
}
type CapAsk = NoCapAsked | CapAsked({ tokens: int })
pure def capSent(asked: CapAsk, omit: bool): CapAsk = if (omit) NoCapAsked else asked
pure val familyValues = Set(QwenReasoning, GptOssReasoning, OffOnlyReasoning, OtherReasoning)
pure val hintValues = Set(NoThinkingHint, ThinkingLow, ThinkingOff)
pure val askedValues = Set(NoCapAsked, CapAsked({ tokens: 256 }))
pure def lawNoHintSendsNoEffort(family: ReasoningFamily): bool = effortFor(family, NoThinkingHint) == ProviderDefault
pure def lawAnUndocumentedModelGetsNoEffort(hint: ThinkingHint): bool = effortFor(OtherReasoning, hint) == ProviderDefault
pure def lawLowNeverTurnsReasoningOff(family: ReasoningFamily): bool = effortFor(family, ThinkingLow) != EffortNone
pure def lawNoCapUnlessTheCallerNamesOne(omit: bool): bool = capSent(NoCapAsked, omit) == NoCapAsked
pure def lawOmittingDropsTheCap(asked: CapAsk): bool = capSent(asked, true) == NoCapAsked
```

### A Qwen call on a Cerebras route sends the conversation cache key its caller names, and no call invents one

A caller names its conversation's prompt cache key in
`providerOptions.cerebras.promptCacheKey`. It is sent as
`prompt_cache_key` only on the routes that take reasoning hints (the cloud,
and an own-key endpoint whose host is `cerebras.ai` or under it) and only
for `qwen-3.8-27b`, read as the hint rule reads the id, so the cloud's
`cerebras/qwen-3.8-27b` sends it too. Any other model or endpoint sends no
key, and a call whose caller names none sends none: the provider then
chooses its own cache affinity.

```quint
pure def cacheKeySent(family: ReasoningFamily, cerebrasRoute: bool, named: bool): bool =
  named and cerebrasRoute and family == QwenReasoning
pure def lawNoKeyIsInvented(family: ReasoningFamily, cerebrasRoute: bool): bool = not(cacheKeySent(family, cerebrasRoute, false))
pure def lawOnlyQwenOnACerebrasRouteSendsTheKey(family: ReasoningFamily, cerebrasRoute: bool): bool =
  cacheKeySent(family, cerebrasRoute, true) iff (cerebrasRoute and family == QwenReasoning)
```

## Story: Keep the account state honest

> As the owner, I want to see why my agent cannot answer, from what the
> cloud last said and nothing older, so that I fix the right thing.

### Each refusal is one account state, and the last failure records its kind and time without text

`credential_invalid`, `insufficient_credits` (credits or a spent allowance),
`limit_reached` with its retry time, and `provider_issue` (an outage, a
provider issue, a network failure, or a refused request or consent) are the one failure vocabulary: turns put
them on the reply and status reports them. A limit keeps the account's
retry time and the one the provider named, `0` when it named none.
`lastCloudFailure` is `{kind, at, retryAt?}`, with the account's `retryAt`
only when the provider named one; it never holds message text or a
credential.

```quint
pure def failureOf(e: C::CloudError, version: int): AccountFailure = match e {
  | CloudCredentialInvalid(_) => CredentialInvalid({ version: version })
  | CloudInsufficientCredits => InsufficientCredits
  | CloudAllowanceExhausted(_) => InsufficientCredits
  | CloudRateLimited(x) => LimitReached({ retryAt: x.retryAt, providerRetryAt: x.retryAt })
  | _ => ProviderIssue
}
pure def failureName(f: AccountFailure): str = match f {
  | CredentialInvalid(_) => "credential_invalid" | InsufficientCredits => "insufficient_credits" | LimitReached(_) => "limit_reached" | ProviderIssue => "provider_issue"
}
pure def accountStateName(st: AccountState): str = match st { | Usable => "usable" | Failing(x) => failureName(x.failure) }
pure def retryAtOf(f: AccountFailure): int = match f { | LimitReached(x) => x.retryAt | _ => -1 }
pure def namedRetryAt(f: AccountFailure): int = if (retryAtOf(f) > 0) retryAtOf(f) else -1
pure def lastFailureKind(f: LastCloudFailure): str = match f { | CloudFailedAt(x) => failureName(x.failure) | NoCloudFailure => "" }
pure def callVersion(calls: List[Call], id: int): int = calls.select(c => c.id == id).nthOr(0, { id: -1, credentialVersion: 0 }).credentialVersion
pure def canRefuseCall(s: ModelBinding, id: int): bool = s.calls.some(c => c.id == id)
pure def refuseCall(s: ModelBinding, id: int, now: int, e: C::CloudError): ModelBinding = {
  val t = clockAt(s, now)
  val failure = heldFailure(failureOf(e, callVersion(s.calls, id)), t, s.maxHold)
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

### A rate limit on an own key at Cerebras holds the account at most four seconds, and every other route keeps the provider's retry time

On an own-key endpoint whose host is `cerebras.ai` or under it, a rate
limit holds the account for at most four seconds after the refusal:
Cerebras's per-minute allowance refills all the time and admits a refused
request within seconds though it names a minute, and a longer hold would
refuse the turn's re-send locally and fail every call in the minute without
asking the model. Every other route, the cloud and any other own-key
endpoint, keeps the provider's whole retry time. No launch setting changes
either. The account's retry time, which status reports, is the held one,
but a refusal, the provider's own or one the hold makes, carries the wait
to the retry time the provider named; so the turn waits its five seconds
and its re-send reaches Cerebras after a shortened hold has ended.

```quint
import planning as P from "../conversation/planning"
pure val cerebrasHoldMs = 4000
pure def rateLimitHold(backend: Backend, cerebrasRoute: bool): int = if (cerebrasRoute and isOwnKey(backend)) cerebrasHoldMs else 0
pure def heldFailure(failure: AccountFailure, t: int, maxHold: int): AccountFailure = match failure {
  | LimitReached(x) => if (maxHold > 0 and x.retryAt > t + maxHold) LimitReached({ ...x, retryAt: t + maxHold }) else failure
  | _ => failure
}
pure def turnResendWait(f: AccountFailure, t: int): int =
  if (refusalWait(f, t) < 0) P::resendWait(P::RateLimitedWithoutHint, 1) else P::resendWait(P::RateLimitedFor({ hintMs: refusalWait(f, t) }), 1)
pure val failureValues = Set(LimitReached({ retryAt: 59000, providerRetryAt: 59000 }), LimitReached({ retryAt: 4500, providerRetryAt: 4500 }), LimitReached({ retryAt: 3, providerRetryAt: 3 }),
  LimitReached({ retryAt: 0, providerRetryAt: 0 }), ProviderIssue, InsufficientCredits)
pure val maxHoldValues = Set(0, 4000)
pure def lawACerebrasHoldEndsBeforeTheTurnResends(failure: AccountFailure, t: int, backend: Backend): bool = {
  val held = heldFailure(failure, t, rateLimitHold(backend, true))
  (isOwnKey(backend) and t >= 0 and providerRetryAtOf(failure) == retryAtOf(failure) and retryAtOf(held) < retryAtOf(failure))
    implies retryAtOf(held) < t + turnResendWait(held, t)
}
pure def lawEveryOtherRouteKeepsTheProviderTime(failure: AccountFailure, t: int, backend: Backend, cerebrasRoute: bool): bool =
  not(cerebrasRoute and isOwnKey(backend)) implies heldFailure(failure, t, rateLimitHold(backend, cerebrasRoute)) == failure
pure def lawAHoldNeverOutlastsTheProvider(failure: AccountFailure, t: int, maxHold: int): bool =
  retryAtOf(heldFailure(failure, t, maxHold)) <= retryAtOf(failure)
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
  Failing({ failure: LimitReached({ retryAt: 5, providerRetryAt: 5 }) }), Failing({ failure: ProviderIssue }))
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
