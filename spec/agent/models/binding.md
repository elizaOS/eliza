# Model binding

The text backend the launch chose, the account state the owner sees, the
credential push and the cloud link plugins use. The backend is fixed for
the life of the process: the owner's cloud account, the owner's own key for
an OpenAI-compatible endpoint, or none ([launch](../host/launch.md)). An
account, backend or embeddings change is a new launch, decided by the host.
Retry, fallback and cancellation are core [models](../../core/models.md):
the cloud and own-key text handlers are each registered twice, so core
retries a transient refusal once. A rate-limited call is re-sent once by the
turn that made it, never by the transport ([planning](../conversation/planning.md)).
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
launch frame and whether the backend is a Cerebras route for rate limits: an
own-key endpoint whose host is `cerebras.ai` or under it, never the cloud.
The binding keeps only the credential's version, and keeps it exactly when
the backend needs one.

```quint
import launch.* from "../host/launch"
type BindPhase = Unbound | Bound
type AccountFailure = CredentialInvalid({ version: int }) | InsufficientCredits | LimitReached({ retryAt: int }) | ProviderIssue
type AccountState = Usable | Failing({ failure: AccountFailure })
type LastCloudFailure = NoCloudFailure | CloudFailedAt({ failure: AccountFailure, at: int })
type Call = { id: int, credentialVersion: int }
type ModelBinding = { phase: BindPhase, backend: Backend, account: OwnerAccount, embeddings: Embeddings, google: GoogleConsent,
  credentialVersion: int, cerebrasRoute: bool, accountState: AccountState, providerRetryAt: int, rateLimitCallId: int, lastCloudFailure: LastCloudFailure, calls: List[Call], nextCall: int, clock: int }
pure val initial: ModelBinding = { phase: Unbound, backend: NoBackend, account: NoAccount, embeddings: NoEmbeddings,
  google: { gmailChanges: false, calendarEdits: false }, credentialVersion: 0, cerebrasRoute: false, accountState: Usable, providerRetryAt: 0, rateLimitCallId: -1, lastCloudFailure: NoCloudFailure, calls: List(), nextCall: 0, clock: 0 }
pure val viewValues = Set({ epoch: 1, credentialVersion: 1 }, { epoch: 1, credentialVersion: 0 }, { epoch: 2, credentialVersion: 2 })
pure def canBind(s: ModelBinding, doc: LaunchDocument, view: FrameView, cerebrasRoute: bool): bool =
  s.phase == Unbound and documentAdmitted(doc) and view.epoch >= 1 and view.credentialVersion >= 0 and (needsCredential(doc.backend) implies view.credentialVersion >= 1)
    and (cerebrasRoute implies isOwnKey(doc.backend))
pure def bind(s: ModelBinding, doc: LaunchDocument, view: FrameView, cerebrasRoute: bool): ModelBinding =
  { ...s, phase: Bound, backend: doc.backend, account: doc.account, embeddings: doc.embeddings, google: doc.google,
    credentialVersion: if (needsCredential(doc.backend)) view.credentialVersion else 0, cerebrasRoute: cerebrasRoute }
pure def alwaysUnboundHoldsNothing(s: ModelBinding): bool = s.phase == Unbound implies
  (s.backend == NoBackend and s.credentialVersion == 0 and s.calls.length() == 0 and s.nextCall == 0 and s.accountState == Usable and s.lastCloudFailure == NoCloudFailure)
pure def alwaysCredentialFollowsBackend(s: ModelBinding): bool = s.credentialVersion >= 0 and (s.phase == Bound implies (needsCredential(s.backend) iff s.credentialVersion >= 1))
pure def stepBindingFixedOnceBound(before: ModelBinding, after: ModelBinding): bool = before.phase == Bound implies
  (after.phase == Bound and after.backend == before.backend and after.account == before.account and after.embeddings == before.embeddings and after.google == before.google and after.cerebrasRoute == before.cerebrasRoute)
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
the call. Each call starts with a fresh `Idempotency-Key`, and every later
attempt of the call (core sends it again on the second registration and on
its fallback model) carries the key of the attempt before it, with one
exception: when the cloud itself answered that attempt `503
provider_unavailable` and the call has not taken a fresh key yet, the next
attempt takes one. That 503 is the cloud's own refusal for a provider call
that failed or was refused: the cloud closed that attempt's hold and
delivered no generation, though it usually charges a provider failure its
full quote. Under the same key the cloud could only refuse the retry `409
already_dispatched`, and the outage the retry is there for would end the
turn as a provider issue. A call takes at most one fresh key, so an outage
costs it at most two charged attempts, as pressing Retry once would: every
later attempt keeps that key, and the cloud answers it `409
already_dispatched` without a provider call or a charge. Every other attempt
keeps its key: a lost connection, and a 5xx without the cloud's refusal body
(a gateway or proxy in front of the cloud may answer while the cloud still
runs and charges the generation), are answered `409 already_dispatched`
instead of running and charging the generation again. An own-key provider's
refusal keeps its key too. For a rate limit, the transport
never re-sends it;
the refusal carries the time left until the provider's retry time, and the turn
that made the call waits for that, at most five seconds, and sends it once more
([planning](../conversation/planning.md)).

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
type RetryKey = SameKey | FreshKey
pure def cloudClosedAttempt(cloudRoute: bool, refusalStatus: int, bodyCode: str): bool =
  cloudRoute and refusalStatus == 503 and bodyCode == "provider_unavailable"
pure def retryKey(cloudRoute: bool, refusalStatus: int, bodyCode: str, freshKeyTaken: bool): RetryKey =
  if (cloudClosedAttempt(cloudRoute, refusalStatus, bodyCode) and not(freshKeyTaken)) FreshKey else SameKey
pure def lawOnlyTheCloudsOwnOutageRefusalTakesAFreshKey(cloudRoute: bool, refusalStatus: int, bodyCode: str, freshKeyTaken: bool): bool =
  (retryKey(cloudRoute, refusalStatus, bodyCode, freshKeyTaken) == FreshKey)
    iff (cloudRoute and refusalStatus == 503 and bodyCode == "provider_unavailable" and not(freshKeyTaken))
pure def lawACallTakesAtMostOneFreshKey(cloudRoute: bool, refusalStatus: int, bodyCode: str): bool =
  retryKey(cloudRoute, refusalStatus, bodyCode, true) == SameKey
pure def lawABare5xxKeepsItsKey(refusalStatus: int, freshKeyTaken: bool): bool = retryKey(true, refusalStatus, "", freshKeyTaken) == SameKey
pure def lawAnOwnKeyRefusalKeepsItsKey(refusalStatus: int, bodyCode: str, freshKeyTaken: bool): bool = retryKey(false, refusalStatus, bodyCode, freshKeyTaken) == SameKey
```

### A tool call the provider could not parse, or a streamed answer silent for a minute, ends the call without a retry

A refusal body that says the provider could not parse a tool call out of
the model's own generation (`code` `parser_error`, or `type`
`generation_error` with `param` `tool_calls`, flat or inside an `error`
envelope) is a bad request of its own: the request was sound and the sample
failed, so the transport never re-sends it and the turn decides whether it
gets one more try ([planning](../conversation/planning.md)). A streamed
answer whose provider sends no bytes for 60 seconds, first its headers and
then each next chunk, is abandoned and not re-sent, and the turn ends with
its failure reply. Only the time between bytes before the provider's
`[DONE]` marker is bounded, never the whole answer. The marker ends
collection even if the HTTP connection remains open. A parse failure and
a silent stream both count as a provider issue in the account state.

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
text. An answer with neither text nor a tool call is a provider issue, and
that is the only answer refused for what it holds: the text and the tool
arguments reach the caller whole at any length, as develop's handlers
returned them, so a long answer is never turned into a failure. A call
sends an output cap only when the caller or its admitted lease sets one;
otherwise the backend owns the output limit. A
streamed call asks for its token use (`stream_options.include_usage`), which
the provider sends in a last chunk without choices, and a call that is not
streamed sends no stream options. A tool's parameter schema is sent without
its `pattern` constraints: a provider may refuse a whole call over one
(Cerebras does on a closed object), and the action validates its arguments
against its own schema when it runs. A Cerebras own-key endpoint, and a Cloud
call for a model Cloud serves on Cerebras (Qwen 3.8 27B, GPT-OSS 120B, GLM 4.7
or Gemma 4 31B), is sent its tools as strict only when every one of them is:
Cerebras refuses a whole call whose tools mix strict and non-strict schemas,
Cloud forwards each tool's strictness unchanged, and a planner call that
offers actions also offers its non-strict context restore. Any other call gets each
tool's own strictness. Token use carries the provider's
cache-read and reasoning counts when supplied, including an explicit zero.
A missing count stays absent, so a streamed call is measured as a whole one is.

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

### A call sends its caller's temperature only to a model that takes one

OpenAI's reasoning models refuse every temperature but their own default,
so a call to one sends no `temperature` and the model samples at its
default. They are the ids `o` followed by a digit (`o1`, `o3-mini`,
`o4-mini`) and the `gpt-5` family other than its `-chat` models, read as
the hint rule reads the id, on the cloud and on any own-key endpoint. Every
other model gets the temperature its caller names, from the call or from
the launch's sampling settings ([models](../../core/models.md)), and a
call that names none sends none. The model id decides before the call is
sent; a provider's refusal of a temperature is never retried without one.

```quint
type SamplingControl = TakesTemperature | DefaultTemperatureOnly
pure def temperatureSent(control: SamplingControl, named: bool): bool = named and control == TakesTemperature
pure val controlValues = Set(TakesTemperature, DefaultTemperatureOnly)
pure def lawNoTemperatureIsInvented(control: SamplingControl): bool = not(temperatureSent(control, false))
pure def lawADefaultOnlyModelGetsNoTemperature(named: bool): bool = not(temperatureSent(DefaultTemperatureOnly, named))
pure def lawAModelThatTakesOneGetsTheNamedTemperature(named: bool): bool = temperatureSent(TakesTemperature, named) == named
```

### A Qwen call on a Cerebras route sends the prompt cache key its caller names, and no call invents one

A caller names its prompt cache key (the planner's is its agent's) in
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

### A Qwen call on a Cerebras route reads a tool call the model wrote as text as that call, when it names an offered tool

`qwen-3.8-27b` sometimes writes its tool call into the text in its own
template instead of the structured field: a `<tool_call>` block holding a
`<function=NAME>` with a `<parameter=KEY>` value for each argument, or one
JSON object with `name` and `arguments`. On the routes that take reasoning
hints, a call that offers tools and leaves the model free to use them (its
tool choice is not `none`) and gets an answer with no structured tool call
reads each such block as a tool call when every block parses and names a
tool the call offered: the answer carries those calls, with fresh ids, and
its text without the blocks. A value is read as JSON when the tool's schema
gives that parameter a type other than string and it parses, and as the
written text otherwise. A block that does not parse or names a tool the
call did not offer leaves the whole text as it was, for the turn to refuse
([planning](../conversation/planning.md)). Any other model, route or call,
and an answer that already has a structured tool call, reads its text as
text.

```quint
pure def writtenCallsRead(family: ReasoningFamily, cerebrasRoute: bool, freeToolChoice: bool, structuredCalls: int, writtenAllOffered: bool): bool =
  family == QwenReasoning and cerebrasRoute and freeToolChoice and structuredCalls == 0 and writtenAllOffered
pure val structuredCallsValues = Set(0, 1, 2)
pure def lawOnlyQwenOnACerebrasRouteReadsWrittenCalls(family: ReasoningFamily, cerebrasRoute: bool, freeToolChoice: bool, structuredCalls: int, writtenAllOffered: bool): bool =
  writtenCallsRead(family, cerebrasRoute, freeToolChoice, structuredCalls, writtenAllOffered) implies (family == QwenReasoning and cerebrasRoute)
pure def lawAWrittenCallNamingAnUnofferedToolIsNeverRead(family: ReasoningFamily, cerebrasRoute: bool, freeToolChoice: bool, structuredCalls: int): bool =
  not(writtenCallsRead(family, cerebrasRoute, freeToolChoice, structuredCalls, false))
pure def lawAStructuredCallKeepsTheTextAsText(family: ReasoningFamily, cerebrasRoute: bool, freeToolChoice: bool, writtenAllOffered: bool): bool =
  not(writtenCallsRead(family, cerebrasRoute, freeToolChoice, 1, writtenAllOffered))
pure def lawACallOfferingNoFreeChoiceReadsNoWrittenCall(family: ReasoningFamily, cerebrasRoute: bool, structuredCalls: int, writtenAllOffered: bool): bool =
  not(writtenCallsRead(family, cerebrasRoute, false, structuredCalls, writtenAllOffered))
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
  val provider = failureOf(e, callVersion(s.calls, id))
  val failure = heldFailure(provider, t, s.cerebrasRoute)
  val ignored = staleRefusal(failure, s.credentialVersion)
  val limitCallId = match provider { | LimitReached(_) => id | _ => s.rateLimitCallId }
  { ...s, calls: s.calls.select(c => c.id != id), clock: t,
    accountState: if (ignored) s.accountState else afterFailure(s.accountState, failure, t),
    providerRetryAt: if (ignored or retryAtOf(provider) <= s.providerRetryAt) s.providerRetryAt else retryAtOf(provider),
    rateLimitCallId: limitCallId,
    lastCloudFailure: if (ignored) s.lastCloudFailure else CloudFailedAt({ failure: failure, at: t }) }
}
pure def alwaysFailingAccountHasALastFailure(s: ModelBinding): bool = s.accountState != Usable implies s.lastCloudFailure != NoCloudFailure
pure def failedAt(f: LastCloudFailure): int = match f { | CloudFailedAt(x) => x.at | NoCloudFailure => 0 }
pure def alwaysLastFailureIsNotInTheFuture(s: ModelBinding): bool = failedAt(s.lastCloudFailure) <= s.clock
pure def sometimesInsufficientCredits(s: ModelBinding): bool = s.accountState == Failing({ failure: InsufficientCredits })
pure def sometimesCredentialInvalid(s: ModelBinding): bool = accountStateName(s.accountState) == "credential_invalid"
pure def sometimesProviderIssue(s: ModelBinding): bool = s.accountState == Failing({ failure: ProviderIssue })
```

### A cloud refusal that names spent credits or a spent allowance carries Cloud's own code, and no other refusal carries one

`insufficient_credits` stands for every cloud `402` and for an own-key
provider's spent quota, so it cannot tell a client that the account has no
plan allowance and no credits left. A refusal of a call on the cloud route
whose `402` body names `insufficient_credits` or `allowance_exhausted`
carries that code as its `cloudCode`. A `402` whose body names neither, any
other status, an own-key provider's refusal and a call the binding refuses
itself (a rate limit still in force) carry none, and each keeps its failure
kind.

```quint
type FundsCode = NoFundsCode | CreditsSpent | AllowanceSpent
pure def fundsCodeOf(cloudRoute: bool, refusalStatus: int, bodyCode: str): FundsCode =
  if (not(cloudRoute) or refusalStatus != 402) NoFundsCode
  else if (bodyCode == "insufficient_credits") CreditsSpent
  else if (bodyCode == "allowance_exhausted") AllowanceSpent
  else NoFundsCode
pure def fundsCodeName(code: FundsCode): str = match code { | NoFundsCode => "" | CreditsSpent => "insufficient_credits" | AllowanceSpent => "allowance_exhausted" }
pure val refusalStatusValues = Set(400, 401, 402, 429, 502, 503, 504)
pure val bodyCodeValues = Set("", "insufficient_credits", "allowance_exhausted", "payment_required", "rate_limited", "provider_unavailable")
pure def lawOnlyACloud402NamingFundsCarriesACode(cloudRoute: bool, refusalStatus: int, bodyCode: str): bool =
  fundsCodeOf(cloudRoute, refusalStatus, bodyCode) != NoFundsCode implies (cloudRoute and refusalStatus == 402)
pure def lawTheCodeIsTheOneCloudNamed(cloudRoute: bool, refusalStatus: int, bodyCode: str): bool =
  fundsCodeName(fundsCodeOf(cloudRoute, refusalStatus, bodyCode)) == "" or fundsCodeName(fundsCodeOf(cloudRoute, refusalStatus, bodyCode)) == bodyCode
pure def lawAnOwnKeyRefusalCarriesNoCode(refusalStatus: int, bodyCode: str): bool = fundsCodeOf(false, refusalStatus, bodyCode) == NoFundsCode
```

### A rate limit names whether the model provider or Cloud set it, and no other refusal names one

A rate limit on an own-key endpoint names the provider. The cloud route
names `provider` when Cloud sends `provider_rate_limited` and `cloud`
when it sends `cloud_gate_rate_limited`. If the reason is missing or
unrecognized, the origin is unknown. Other refusals and refusals from the
binding itself leave the origin unset.

```quint
type LimitOrigin = NoLimitOrigin | ProviderSetLimit | CloudSetLimit
pure def limitOriginOf(cloudRoute: bool, limited: bool, bodyReason: str): LimitOrigin =
  if (not(limited)) NoLimitOrigin
  else if (not(cloudRoute) or bodyReason == "provider_rate_limited") ProviderSetLimit
  else if (bodyReason == "cloud_gate_rate_limited") CloudSetLimit
  else NoLimitOrigin
pure def limitOriginName(origin: LimitOrigin): str = match origin { | NoLimitOrigin => "" | ProviderSetLimit => "provider" | CloudSetLimit => "cloud" }
pure val limitedValues = Set(true, false)
pure val bodyReasonValues = Set("", "provider_rate_limited", "cloud_gate_rate_limited", "google_not_configured")
pure def lawOnlyARateLimitNamesAnOrigin(cloudRoute: bool, limited: bool, bodyReason: str): bool =
  (limitOriginOf(cloudRoute, limited, bodyReason) != NoLimitOrigin) implies limited
pure def lawAnOwnKeyLimitIsTheProviders(bodyReason: str): bool = limitOriginOf(false, true, bodyReason) == ProviderSetLimit
pure def lawCloudsOwnLimitNamesCloud(bodyReason: str): bool =
  (limitOriginOf(true, true, bodyReason) == CloudSetLimit) iff (bodyReason == "cloud_gate_rate_limited")
pure def lawAnUnmarkedCloudLimitHasNoOrigin(bodyReason: str): bool =
  (limitOriginOf(true, true, bodyReason) == NoLimitOrigin)
    iff not(Set("provider_rate_limited", "cloud_gate_rate_limited").contains(bodyReason))
```

### No call starts before a rate limit's retry time, and a provider issue does not lift a limit still in force

A refused credential, spent credits or a newer limit replace a limit.
The binding keeps the call number of the last rate limit it received.
When an active hold refuses another call, the refusal carries that
number internally. A re-send can use it to identify the limit its own
call met, even if another call received a limit with the same retry time.

```quint
pure def limitedBy(f: AccountFailure, t: int): bool = match f { | LimitReached(x) => t < x.retryAt | _ => false }
pure def limitedAt(st: AccountState, t: int): bool = match st { | Failing(x) => limitedBy(x.failure, t) | Usable => false }
pure def afterFailure(st: AccountState, failure: AccountFailure, t: int): AccountState =
  if (failure == ProviderIssue and limitedAt(st, t)) st else Failing({ failure: failure })
pure def stepNoCallBeforeRetryAt(before: ModelBinding, via: str, after: ModelBinding): bool = via == "startCall" implies not(limitedAt(before.accountState, after.clock))
pure def alwaysActiveLimitNamesASettledCall(s: ModelBinding): bool = limitedAt(s.accountState, s.clock) implies
  (s.rateLimitCallId >= 0 and s.rateLimitCallId < s.nextCall and not(s.calls.some(c => c.id == s.rateLimitCallId)))
pure def stepChangedLimitNamesTheNewlyRefusedCall(before: ModelBinding, via: str, after: ModelBinding): bool =
  after.rateLimitCallId != before.rateLimitCallId implies
    (via == "refuseCall" and lastFailureKind(after.lastCloudFailure) == "limit_reached" and before.calls.some(c => c.id == after.rateLimitCallId) and not(after.calls.some(c => c.id == after.rateLimitCallId)))
pure def sometimesLimitReached(s: ModelBinding): bool = limitedAt(s.accountState, s.clock)
pure def sometimesProviderIssueKeepsTheLimit(s: ModelBinding): bool =
  limitedAt(s.accountState, s.clock) and lastFailureKind(s.lastCloudFailure) == "provider_issue"
```

### A rate limit holds the account for the provider's whole retry time, and for at most 4 s on a Cerebras own-key endpoint

No launch setting changes the hold. On an own-key endpoint whose host is
`cerebras.ai` or under it, a rate limit holds the account for at most
4 seconds after the refusal, so the hold ends before the turn's single
re-send, which waits at most 5 seconds
([planning](../conversation/planning.md)). Cerebras refills its per-minute
allowance all the time and admits a refused request within seconds though
its retry time names a minute; a hold for that minute would fail the
re-send without asking the model. The cloud backend and every other own-key
endpoint hold the provider's whole retry time, because a provider such as
OpenAI counts refused requests against its limit. Status reports the held
retry time, when the account takes calls again. A refusal of a rate-limited
call, and of a call refused while the account is held, reports the
provider's whole remaining retry time, the latest any refusal named.

```quint
pure val maxHoldMs = 4000
pure def heldFailure(failure: AccountFailure, t: int, cerebrasRoute: bool): AccountFailure = match failure {
  | LimitReached(x) => if (cerebrasRoute and x.retryAt > t + maxHoldMs) LimitReached({ retryAt: t + maxHoldMs }) else failure
  | _ => failure
}
pure def heldRetryAt(st: AccountState): int = match st { | Failing(x) => retryAtOf(x.failure) | Usable => -1 }
pure def reportedRetry(held: int, provider: int): int = if (held >= 0 and provider > held) provider else held
pure def reportedRetryAt(s: ModelBinding): int = reportedRetry(heldRetryAt(s.accountState), s.providerRetryAt)
pure val failureValues = Set(LimitReached({ retryAt: 60000 }), LimitReached({ retryAt: 3500 }), LimitReached({ retryAt: 3 }), ProviderIssue, InsufficientCredits)
pure def lawAHoldNeverOutlastsTheProvider(failure: AccountFailure, t: int, cerebrasRoute: bool): bool =
  retryAtOf(heldFailure(failure, t, cerebrasRoute)) <= retryAtOf(failure)
pure def lawACerebrasHoldEndsWithinFourSeconds(failure: AccountFailure, t: int): bool =
  t >= 0 implies retryAtOf(heldFailure(failure, t, true)) <= t + maxHoldMs
pure def lawOnlyTheCerebrasRouteIsShortened(failure: AccountFailure, t: int): bool = heldFailure(failure, t, false) == failure
pure def lawARefusalDuringAHoldReportsTheProviderTime(failure: AccountFailure, t: int, cerebrasRoute: bool): bool =
  (t >= 0 and limitedBy(heldFailure(failure, t, cerebrasRoute), t))
    implies reportedRetry(retryAtOf(heldFailure(failure, t, cerebrasRoute)), retryAtOf(failure)) == retryAtOf(failure)
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

### A planner warm-up is sent only while the account is not blocked, and neither its answer nor its refusal changes the account state

A planner warm-up ([planning](../conversation/planning.md)) names
`providerOptions.eliza.warmUp`. Unlike the advisory warm answer above, it
does reach the model, but only while the account is not blocked, so it
never spends a refused key, spent credits or a limit's wait. It is no
call of the account: its answer, a blank one-token answer the provider cut
off included, and its refusal leave the account state, the last failure
and the provider's retry time as they were, so a warm-up the owner never
asked for never shows them a failure or holds their first turn.

```quint
pure def warmUpSent(st: AccountState, t: int): bool = not(blocked(st, t))
pure def lawABlockedAccountSendsNoWarmUp(st: AccountState, t: int): bool = blocked(st, t) implies not(warmUpSent(st, t))
pure def lawAWarmUpNeverWaitsOutALimit(st: AccountState, t: int): bool = warmUpSent(st, t) implies not(limitedAt(st, t))
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
