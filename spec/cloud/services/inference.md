# Chat completions

`POST /api/v1/chat/completions` answers a live credential with an
OpenAI-compatible chat completion, streamed or whole, from a model of
[the price table](./models.md), charged over one hold of
[metering](../shared/metering.md). It is the only inference route; an image
description is a chat completion with an image part. Sources are develop
`packages/cloud/api/v1/chat/completions/route.ts`,
`packages/cloud/shared/src/lib/services/{ai-billing,inference-provider-outcome}.ts`
and the Quint models `ChatSdkStreamSettlement` and `sse_segmentation`.

The shell runs the deployment's `inference` capability gate
([the deployment](../deployment.md)), `admitCompletion`, `dispatchVerdict`,
`M::markDispatched`, the provider and one `closeHold`, each stage's store
work in its own transaction. The hold's caller is the organization. The
shell supplies the validated `Idempotency-Key` UUID, or the server request
ID when absent, as the model's `requestId`. A repeated key returns
`409 already_dispatched` before another provider call can start. Wire shapes
are the Effect Schemas of `src/services/chat-request.schema.ts`. Every
answer is `Cache-Control: no-store`.

## Story: Answer a chat completion once and charge it once

> As the developer of an agent's cloud provider, I want each chat completion
> admitted only when my account can pay for it, sent to the provider once
> and charged once for what it used, so that a refused, cancelled or failed
> call never costs more than it should.

### A request passes the ingress limit, authentication, the plan limit, the body, the model, the quote and the hold in that order, and the first that fails answers

The ingress limit is 600 requests a minute per client address; the plan
limit is the plan's chat completions limit ([plans](../billing/plans.md))
per organization, and an unreadable policy answers `503`. The body accepts
exactly `acceptedFields`, passed to the provider as sent: an agent's planning
turn, with its sampling settings, its function tools and tool choice, the
assistant's earlier tool calls and their tool results, and a
`prompt_cache_key` of at most 1,024 characters that keeps one
conversation's turns on the provider's prompt cache. Another field is
refused `400 invalid_request` with reason `unsupported_field`, and so are
empty `messages` and an image part with neither a URL nor a data URL (an
unknown part kind fails the schema the same way). The model is the one
`Mo::chooseModel` gives. `funding` is read in the hold's transaction: the
allowance as `E::meteredAllowance` gives it and the free credit balance. A
request refused at the ingress limit or at authentication is answered before
its plan window is counted or its body read.

```quint
import types.* from "../shared/types"
import metering as M from "../shared/metering"
import rateLimit as R from "../shared/rateLimit"
import requestAuth as RA from "../identity/requestAuth"
import entitlements as E from "../billing/entitlements"
import plans as P from "../billing/plans"
import models as Mo from "./models"
type ContentPart = TextPart | ImagePart | SourcelessImagePart
type TokenAsk = NoAsk | AskFor({ tokens: int })
type ChatBody = { fields: Set[str], model: str, messageCount: int, parts: List[ContentPart], inputChars: CharCount, maxCompletionTokens: TokenAsk, maxTokens: TokenAsk }
type Arrival = { ingress: R::Window, auth: RA::Admission, policy: E::PolicyAnswer, planWindow: R::Window, body: ChatBody, organization: str, requestId: str, now: Millis }
type Catalog = { profile: List[Mo::ProfiledModel], prices: List[Mo::PriceRow] }
type Funding = { allowanceAvailable: Micros, creditAvailable: Micros }
type Stage = AtIngress | AtAuth | AtPlanLimit | AtBody | AtModel | AtQuote | AtHold
type AdmittedCall = { model: Mo::Model, counts: Mo::TokenCounts, outputCap: int, quote: Micros, lane: M::FundingLane, hold: M::Hold }
type CompletionAdmission = RefusedAt({ stage: Stage, refusal: Refusal }) | Admit({ call: AdmittedCall })
pure val acceptedFields: Set[str] = Set("model", "messages", "stream", "stream_options", "temperature", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format", "tools", "tool_choice",
  "top_p", "stop", "seed", "frequency_penalty", "presence_penalty", "prompt_cache_key")
pure val ingressLimit: R::RateLimit = R::perMinute("chatIngress", 600)
pure def planLimit(plan: P::PlanKey): R::RateLimit =
  R::perMinute(P::planRateLimitName(P::CompletionsRequests), P::requestsPerMinute(plan, P::CompletionsRequests))
pure def checkOf(w: R::Window, rule: R::RateLimit): List[R::Check] = List({ window: w, rule: rule })
pure def planOf(policy: E::PolicyAnswer): P::PlanKey = match policy { | PolicyOf(x) => x.policy.planKey | PolicyUnavailable => P::Free }
pure def hasImage(b: ChatBody): bool = b.parts.includes(ImagePart)
pure def bodyAccepted(b: ChatBody): bool = b.fields.subseteq(acceptedFields) and b.messageCount >= 1 and not(b.parts.includes(SourcelessImagePart))
pure def bodyRefusal(b: ChatBody): Refusal = if (b.fields.subseteq(acceptedFields)) refuse(InvalidRequest) else refuseFor(InvalidRequest, UnsupportedField)
pure def inferenceHoldKey(organization: str, requestId: str): HoldKey = { service: MeteredInference, caller: organization, requestId: requestId, part: WholeRequest }
pure def holdStage(a: Arrival, model: Mo::Model, counts: Mo::TokenCounts, outputCap: int, funding: Funding): CompletionAdmission = {
  val lane = E::fundingLane(a.policy)
  val quote = Mo::callCost(model, counts)
  val verdict = M::admission(M::initial, true, lane, quote, funding.allowanceAvailable, funding.creditAvailable)
  match verdict {
    | RefuseHold(x) => RefusedAt({ stage: AtHold, refusal: refuse(x.code) })
    | _ => Admit({ call: { model: model, counts: counts, outputCap: outputCap, quote: quote, lane: lane,
        hold: M::reserve(M::initial, inferenceHoldKey(a.organization, a.requestId), quote, lane, funding.allowanceAvailable, funding.creditAvailable, a.now) } })
  }
}
pure def quoteStage(a: Arrival, model: Mo::Model, outputTokens: int, funding: Funding): CompletionAdmission = {
  val counts = quoteCounts(a.body.inputChars, heldOutput(callerCapped(a.body), outputTokens))
  if (Mo::countsInBound(counts) and outputTokens <= Mo::maxTokensPerSide) holdStage(a, model, counts, outputTokens, funding) else RefusedAt({ stage: AtQuote, refusal: refuse(InvalidRequest) })
}
pure def afterModel(a: Arrival, model: Mo::Model, funding: Funding): CompletionAdmission = {
  val limit = outputLimit(a.body.maxCompletionTokens, a.body.maxTokens, model.defaultMaxTokens)
  match limit {
    | NoAsk => RefusedAt({ stage: AtModel, refusal: Mo::modelRefusal })
    | AskFor(x) => quoteStage(a, model, x.tokens, funding)
  }
}
pure def afterAuth(a: Arrival, catalog: Catalog, funding: Funding): CompletionAdmission = {
  val plan = checkOf(a.planWindow, planLimit(planOf(a.policy)))
  val choice = Mo::chooseModel(catalog.profile, catalog.prices, a.body.model, hasImage(a.body))
  if (a.policy == E::PolicyUnavailable) RefusedAt({ stage: AtPlanLimit, refusal: E::policyRefusal })
  else if (not(R::admitsAll(plan, a.now))) RefusedAt({ stage: AtPlanLimit, refusal: R::groupRefusal(plan, a.now) })
  else if (not(bodyAccepted(a.body))) RefusedAt({ stage: AtBody, refusal: bodyRefusal(a.body) })
  else match choice {
    | Unavailable => RefusedAt({ stage: AtModel, refusal: Mo::modelRefusal })
    | Chosen(m) => afterModel(a, m.model, funding)
  }
}
pure def admitCompletion(a: Arrival, catalog: Catalog, funding: Funding): CompletionAdmission = {
  val ingress = checkOf(a.ingress, ingressLimit)
  val auth = a.auth
  if (not(R::admitsAll(ingress, a.now))) RefusedAt({ stage: AtIngress, refusal: R::groupRefusal(ingress, a.now) })
  else match auth {
    | Caller(c) => afterAuth(a, catalog, funding)
    | Denied(d) => RefusedAt({ stage: AtAuth, refusal: d.refusal })
    | Anonymous => RefusedAt({ stage: AtAuth, refusal: refuseFor(AuthenticationRequired, CredentialUnknown) })
  }
}
pure def arrivalOf(ingress: R::Window, auth: RA::Admission, policy: E::PolicyAnswer, planWindow: R::Window, body: ChatBody): Arrival =
  { ingress: ingress, auth: auth, policy: policy, planWindow: planWindow, body: body, organization: "o1", requestId: "r1", now: 1000 }
pure def authWellFormed(auth: RA::Admission): bool = match auth { | Denied(d) => wellFormed(d.refusal) | _ => true }
pure def isCaller(auth: RA::Admission): bool = match auth { | Caller(c) => true | _ => false }
pure def isEarlyRefusal(a: Arrival): bool = not(isCaller(a.auth)) or not(R::admitsAll(checkOf(a.ingress, ingressLimit), a.now))
pure def lawEarlyRefusalsIgnoreLaterStages(ingress: R::Window, auth: RA::Admission, policy: E::PolicyAnswer, planWindow: R::Window, body: ChatBody, otherBody: ChatBody, catalog: Catalog, funding: Funding): bool = {
  val a = arrivalOf(ingress, auth, policy, planWindow, body)
  isEarlyRefusal(a) implies admitCompletion({ ...a, planWindow: R::initial, body: otherBody, policy: E::PolicyUnavailable }, catalog, funding) == admitCompletion(a, catalog, funding)
}
pure val fullIngress: R::Window = { start: 0, end: 60000, count: 600, ceiling: 600, clock: 0, last: R::Admitted }
pure val fullPlan: R::Window = { start: 0, end: 60000, count: 60, ceiling: 60, clock: 0, last: R::Admitted }
pure val ingressValues: Set[R::Window] = Set(R::initial, fullIngress)
pure val planWindowValues: Set[R::Window] = Set(R::initial, fullPlan)
pure val authValues: Set[RA::Admission] = Set(RA::Caller({ kind: DeviceKeyCredential, expiresAt: 900000 }), RA::Anonymous, RA::Denied({ refusal: refuseFor(AuthenticationRequired, CredentialRevoked) }))
pure val policyValues: Set[E::PolicyAnswer] = E::pValues.map(p => E::PolicyOf({ policy: p })).union(Set(E::PolicyUnavailable))
pure val textBody: ChatBody = { fields: Set("model", "messages"), model: "m1", messageCount: 1, parts: List(TextPart), inputChars: 40, maxCompletionTokens: NoAsk, maxTokens: NoAsk }
pure val bodyValues: Set[ChatBody] = Set(textBody, { ...textBody, parts: List(TextPart, ImagePart), maxTokens: AskFor({ tokens: 100 }) },
  { ...textBody, fields: Set("model", "messages", "tools", "seed") }, { ...textBody, fields: Set("model", "messages", "functions") }, { ...textBody, messageCount: 0 }, { ...textBody, parts: List(SourcelessImagePart) },
  { ...textBody, model: "m9" }, { ...textBody, maxTokens: AskFor({ tokens: 9 }), maxCompletionTokens: AskFor({ tokens: 3000000 }) })
pure val otherBodyValues: Set[ChatBody] = bodyValues
pure val catalogValues: Set[Catalog] = {
  val seeing = { profile: List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: true, defaultMaxTokens: Mo::OutputDefaultOf({ tokens: 4096 }) }), prices: List({ modelId: "m1", inputPer1K: 3, cachedInputPer1K: 1, outputPer1K: 15 }) }
  Set({ profile: List(), prices: List() }, seeing, { ...seeing, profile: List({ id: "m1", provider: "p1", upstreamModel: "u1", vision: false, defaultMaxTokens: Mo::NoOutputDefault }) })
}
pure val fundingValues: Set[Funding] = Set({ allowanceAvailable: 0, creditAvailable: 0 }, { allowanceAvailable: 0, creditAvailable: 20 }, { allowanceAvailable: 5, creditAvailable: 5 }, { allowanceAvailable: 0, creditAvailable: -1 })
```

### A request is admitted only for a live caller under its plan limit, held under the policy's lane at its quote, and otherwise refused well formed

The output cap is the output the request allows: `max_completion_tokens`,
else `max_tokens`, else the selected upstream model’s configured maximum
generation length. An HTTPS provider receives an output cap only when the
caller explicitly asked for `max_completion_tokens` or `max_tokens`; an
uncapped request omits both fields so the model's full native output length
applies without a cloud-imposed cap. Workers AI applies its own short default
when `max_tokens` is missing (256 tokens on many of its models), which would
cut an uncapped reply off, so a Workers AI call always receives the output cap,
the configured maximum when the caller set none. The quote counts a token per four input characters, rounded up, none
of them as read from a prompt cache, and the output it holds: the whole cap
when the caller set one, and for a call that set none the smaller of the cap
and `uncappedHoldTokens` (500, develop's `DEFAULT_OUTPUT_TOKENS`). An uncapped
call is mostly a short agent turn, so holding the model's full maximum would
hold far more than it spends and refuse a funded account that still has a few
cents; settlement charges what was used, beyond the hold from free credits
([metering](../shared/metering.md)). A
model with no configured maximum requires a caller cap. An uncapped request
for it is refused `400 model_unavailable` before any hold or provider call.
A side that is negative or over `Mo::maxTokensPerSide` is refused
`400 invalid_request`. A fresh server request id names no hold, so
`M::admission` is asked about `M::initial` and never replays. Refusals of the
rate limiter, `requestAuth` and metering pass through unchanged.

```quint
pure def tokensOf(chars: CharCount): int = if (chars <= 0) 0 else (chars + 3) / 4
pure def outputLimit(maxCompletionTokens: TokenAsk, maxTokens: TokenAsk, defaultMaxTokens: Mo::OutputDefault): TokenAsk =
  if (maxCompletionTokens != NoAsk) maxCompletionTokens
  else if (maxTokens != NoAsk) maxTokens
  else match defaultMaxTokens { | OutputDefaultOf(x) => AskFor({ tokens: x.tokens }) | NoOutputDefault => NoAsk }
pure def quoteCounts(chars: CharCount, outputTokens: int): Mo::TokenCounts =
  { inputTokens: tokensOf(chars), cachedTokens: 0, outputTokens: outputTokens }
pure val uncappedHoldTokens: int = 500
pure def callerCapped(b: ChatBody): bool = b.maxCompletionTokens != NoAsk or b.maxTokens != NoAsk
pure def heldOutput(capped: bool, outputCap: int): int = if (capped) outputCap else M::minOf(outputCap, uncappedHoldTokens)
pure def wireOutputCap(capped: bool, workersAi: bool, outputCap: int): TokenAsk = if (capped or workersAi) AskFor({ tokens: outputCap }) else NoAsk
pure def lawAnUncappedCallHoldsAtMostItsEstimateAndCapsOnlyWorkersAi(ingress: R::Window, auth: RA::Admission, policy: E::PolicyAnswer, planWindow: R::Window, body: ChatBody, catalog: Catalog, funding: Funding): bool = {
  val a = arrivalOf(ingress, auth, policy, planWindow, body)
  val result = admitCompletion(a, catalog, funding)
  match result {
    | Admit(x) => x.call.counts.outputTokens <= x.call.outputCap
        and (callerCapped(body) implies (x.call.counts.outputTokens == x.call.outputCap and wireOutputCap(true, false, x.call.outputCap) == AskFor({ tokens: x.call.outputCap })))
        and (not(callerCapped(body)) implies (x.call.counts.outputTokens <= uncappedHoldTokens
          and wireOutputCap(false, false, x.call.outputCap) == NoAsk
          and wireOutputCap(false, true, x.call.outputCap) == AskFor({ tokens: x.call.outputCap })
          and outputLimit(NoAsk, NoAsk, x.call.model.defaultMaxTokens) == AskFor({ tokens: x.call.outputCap })))
    | RefusedAt(r) => true
  }
}
pure val charsValues = Set(-1, 0, 1, 4, 5, 8000000, 8000001)
pure def lawEveryInputCharacterIsQuoted(chars: CharCount): bool = chars >= 0 implies (tokensOf(chars) * 4 >= chars and tokensOf(chars) * 4 < chars + 4)
pure def lawAnAdmittedCallIsHeldAtItsQuote(ingress: R::Window, auth: RA::Admission, policy: E::PolicyAnswer, planWindow: R::Window, body: ChatBody, catalog: Catalog, funding: Funding): bool = {
  val a = arrivalOf(ingress, auth, policy, planWindow, body)
  val result = admitCompletion(a, catalog, funding)
  authWellFormed(auth) implies match result {
    | Admit(x) => not(RA::isAnonymous(auth)) and policy != E::PolicyUnavailable and R::admitsAll(checkOf(planWindow, planLimit(planOf(policy))), a.now)
        and bodyAccepted(body) and x.call.model.id == body.model and (hasImage(body) implies x.call.model.vision)
        and Mo::countsInBound(x.call.counts) and x.call.quote == Mo::callCost(x.call.model, x.call.counts) and x.call.lane == E::fundingLane(policy)
        and x.call.hold.phase == M::Reserved and x.call.hold.quote == x.call.quote and x.call.hold.reserved >= x.call.quote
        and M::holdKeyOf(x.call.hold) == inferenceHoldKey(a.organization, a.requestId)
    | RefusedAt(r) => wellFormed(r.refusal)
  }
}
```

### A call reaches the provider only while its caller is connected and its standing and lane are unchanged

Just before `M::markDispatched` the shell runs `requestAuth` again and reads
the lane. A caller who has gone gets no answer (the log records 499), a lost
credential answers what `requestAuth` answers now, a changed lane answers
`409 billing_state_conflict`, and each releases the hold.

The chosen provider receives the chat payload with the model's upstream ID.
For HTTPS, the shell posts to the provider's `/chat/completions` endpoint
with its configured API key. For Workers AI, the shell invokes `run` on the
profile's named binding with the upstream model ID and requests the raw
response. Both transports use the same response checks, framing and
settlement. The provider call is cancelled after 800 seconds.

```quint
type DispatchVerdict = Dispatch | Withdraw({ refusal: Refusal }) | CallerGone
pure val providerTimeout: Millis = 800 * millisPerSecond
pure def dispatchVerdict(standing: RA::Admission, heldLane: M::FundingLane, laneNow: M::FundingLane, connected: bool): DispatchVerdict =
  if (not(connected)) CallerGone
  else match standing {
    | Caller(c) => if (laneNow == heldLane) Dispatch else Withdraw({ refusal: refuse(BillingStateConflict) })
    | Denied(d) => Withdraw({ refusal: d.refusal })
    | Anonymous => Withdraw({ refusal: refuseFor(AuthenticationRequired, CredentialUnknown) })
  }
pure val standingValues: Set[RA::Admission] = authValues
pure def withdrawnWellFormed(v: DispatchVerdict): bool = match v { | Withdraw(w) => wellFormed(w.refusal) | _ => true }
pure def lawAWithdrawnCallIsAnsweredWellFormed(standing: RA::Admission, heldLane: M::FundingLane, laneNow: M::FundingLane, connected: bool): bool =
  authWellFormed(standing) implies withdrawnWellFormed(dispatchVerdict(standing, heldLane, laneNow, connected))
```

### A dispatched call is charged its reported usage, what it delivered when the caller hung up, and its quote when nothing was reported

A finished response or a failed stream is charged any usable usage report
already received. When either has no such report, including a provider
connection failure before streaming begins, it is charged the quote.
A hang-up cancels the provider call itself
and is charged the larger of the quoted and reported input tokens, all at
the input price, and a token per four delivered characters, each capped at
`Mo::maxTokensPerSide`.
Delivered characters are those of each delta sent: its text, its reasoning
text and its tool calls' names and arguments.

```quint
type UsageReport = NoUsage | Usage({ usage: Mo::ProviderUsage })
type CompletionEnd = Finished({ report: UsageReport }) | HungUp({ reportedInput: int, deliveredChars: CharCount }) | ProviderRejected({ status: int }) | ProviderFailed({ report: UsageReport })
type CompletionCharge = ChargeCounts({ counts: Mo::TokenCounts }) | ChargeQuote | ReleaseHold
pure val noTokens: Mo::TokenCounts = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }
pure def chargeOfUsage(u: Mo::ProviderUsage): CompletionCharge = {
  val billed = Mo::billedUsage(u)
  match billed { | Reported(r) => ChargeCounts({ counts: r.counts }) | Unreadable => ChargeQuote }
}
pure def chargeOfReport(report: UsageReport): CompletionCharge = match report { | NoUsage => ChargeQuote | Usage(u) => chargeOfUsage(u.usage) }
pure def hangUpCounts(quoted: Mo::TokenCounts, reportedInput: int, deliveredChars: CharCount): Mo::TokenCounts =
  { inputTokens: Mo::billedSide(quoted.inputTokens, reportedInput), cachedTokens: 0, outputTokens: Mo::billedSide(tokensOf(deliveredChars), 0) }
pure def chargeOf(dispatched: bool, end: CompletionEnd, quoted: Mo::TokenCounts): CompletionCharge =
  if (not(dispatched)) ReleaseHold
  else match end {
    | Finished(f) => chargeOfReport(f.report)
    | HungUp(h) => ChargeCounts({ counts: hangUpCounts(quoted, h.reportedInput, h.deliveredChars) })
    | ProviderRejected(r) => ChargeCounts({ counts: noTokens })
    | ProviderFailed(f) => chargeOfReport(f.report)
  }
pure def closeHold(h: M::Hold, charge: CompletionCharge, model: Mo::Model, creditFree: Micros): M::Hold = match charge {
  | ChargeCounts(c) => M::settleKnown(h, Mo::callCost(model, c.counts), creditFree)
  | ChargeQuote => M::settleUnknown(h)
  | ReleaseHold => M::release(h)
}
pure def closeAllowed(h: M::Hold, charge: CompletionCharge, model: Mo::Model, creditFree: Micros): bool = match charge {
  | ChargeCounts(c) => M::canSettleKnown(h, Mo::callCost(model, c.counts), creditFree)
  | ChargeQuote => M::canSettleUnknown(h)
  | ReleaseHold => M::canRelease(h)
}
pure def lawAMissingReportChargesTheQuote(dispatched: bool, end: CompletionEnd, quoted: Mo::TokenCounts): bool =
  (dispatched and (end == Finished({ report: NoUsage }) or end == ProviderFailed({ report: NoUsage }))) implies chargeOf(dispatched, end, quoted) == ChargeQuote
pure def lawAProviderReportDeterminesTheCharge(u: Mo::ProviderUsage, quoted: Mo::TokenCounts): bool = {
  val report = Usage({ usage: u })
  val billed = Mo::billedUsage(u)
  val expected = match billed { | Reported(r) => ChargeCounts({ counts: r.counts }) | Unreadable => ChargeQuote }
  chargeOf(true, Finished({ report: report }), quoted) == expected and chargeOf(true, ProviderFailed({ report: report }), quoted) == expected
}
pure val quotedValues: Set[Mo::TokenCounts] = Set(noTokens, { inputTokens: 10, cachedTokens: 0, outputTokens: 500 })
pure val endValues: Set[CompletionEnd] = {
  val used = { promptTokens: 10, cachedTokens: 0, completionTokens: 7, reasoningTokens: 2 }
  Set(Finished({ report: NoUsage }), Finished({ report: Usage({ usage: used }) }), Finished({ report: Usage({ usage: { ...used, promptTokens: -1 } }) }),
    HungUp({ reportedInput: 12, deliveredChars: 9 }), HungUp({ reportedInput: 0, deliveredChars: 0 }), ProviderRejected({ status: 400 }),
    ProviderFailed({ report: NoUsage }), ProviderFailed({ report: Usage({ usage: used }) }), ProviderFailed({ report: Usage({ usage: { ...used, promptTokens: -1 } }) }))
}
pure def lawAHangUpPaysForWhatItGot(reportedInput: int, deliveredChars: CharCount, quoted: Mo::TokenCounts): bool = {
  val c = hangUpCounts(quoted, reportedInput, deliveredChars)
  Mo::countsInBound(quoted) implies (chargeOf(true, HungUp({ reportedInput: reportedInput, deliveredChars: deliveredChars }), quoted) == ChargeCounts({ counts: c })
    and Mo::countsInBound(c) and c.inputTokens >= quoted.inputTokens and c.inputTokens >= M::minOf(reportedInput, Mo::maxTokensPerSide)
    and c.outputTokens >= M::minOf(tokensOf(deliveredChars), Mo::maxTokensPerSide))
}
pure val reportedInputValues = Set(-1, 0, 12, 3000000)
pure val deliveredCharsValues = Set(-1, 0, 9, 9000000)
```

### A call never dispatched releases its hold, and a provider rejection before any output is charged nothing and answered with a well-formed refusal

A rejection is a provider answer with a status of `rejectionStatuses`
before any byte was delivered; any other failure after dispatch (a 5xx, the
timeout, the network, a failure mid-stream) is `ProviderFailed`. A mid-stream
failure retains any usage report received before it. A provider
`400` or `422` (a parameter or a strict `json_schema` it cannot serve)
answers `400 invalid_request`, a `413` answers `413 content_too_large`, a
`429` answers `429 rate_limited` with the reason `provider_rate_limited`,
so it is never taken for Cloud's own limit, and any other failure answers
`503 provider_unavailable`. Only the last two are retryable, and both carry
a retry time. A stated `Retry-After` is kept for either refusal so neither the
agent nor other callers send before the provider is ready. Without a wait
from the provider, an outage waits five seconds and a rate limit waits four.
The agent's turn has a separate five-second retry budget. Closure
preserves the original hold key. A closed hold refuses a second settlement
or release.

```quint
pure val rejectionStatuses: Set[int] = Set(400, 401, 402, 403, 404, 405, 406, 409, 410, 413, 415, 422, 429)
pure def endOfFailure(status: int, delivered: bool): CompletionEnd =
  if (not(delivered) and rejectionStatuses.contains(status)) ProviderRejected({ status: status }) else ProviderFailed({ report: NoUsage })
pure val pricedModel: Mo::Model = { id: "m1", provider: "p1", upstreamModel: "u1", vision: false, defaultMaxTokens: Mo::NoOutputDefault, inputPer1K: 3, cachedInputPer1K: 1, outputPer1K: 15 }
pure def lawEveryCallClosesItsHoldOnce(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, dispatched: bool, end: CompletionEnd, quoted: Mo::TokenCounts, creditFree: Micros): bool = {
  val held = M::reserve(M::initial, inferenceHoldKey("o1", "r1"), quote, lane, allowanceAvailable, creditAvailable, 0)
  val sent = if (dispatched) M::markDispatched(held, 0) else held
  val charge = chargeOf(dispatched, end, quoted)
  val closed = closeHold(sent, charge, pricedModel, creditFree)
  (M::fundable(lane, quote, allowanceAvailable, creditAvailable) and creditFree >= 0 and Mo::countsInBound(quoted)) implies
    (closeAllowed(sent, charge, pricedModel, creditFree) and (closed.phase == M::Released iff not(dispatched)) and (closed.phase == M::Settled iff dispatched)
     and (closed.phase == M::Released implies closed.charged == 0) and (charge == ChargeQuote implies closed.charged == quote)
     and closed.key == held.key and not(M::canRelease(closed) or M::canSettleUnknown(closed) or M::canSettleKnown(closed, 0, creditFree)))
}
pure val statusValues = Set(0, 400, 413, 429, 500)
pure def lawOnlyAnUndeliveredRejectionIsFree(status: int, delivered: bool, quoted: Mo::TokenCounts): bool =
  (chargeOf(true, endOfFailure(status, delivered), quoted) == ChargeCounts({ counts: noTokens })) iff (not(delivered) and rejectionStatuses.contains(status))
pure val providerPause: Millis = 5 * millisPerSecond
pure val rateLimitPause: Millis = 4 * millisPerSecond
pure def failureWait(status: int, hint: Millis): Millis =
  if (hint >= 0) hint else if (status == 429) rateLimitPause else providerPause
pure def failureRefusal(end: CompletionEnd, retryAt: Millis): Refusal = match end {
  | ProviderRejected(r) => if (r.status == 400 or r.status == 422) refuse(InvalidRequest) else if (r.status == 413) refuse(ContentTooLarge)
      else if (r.status == 429) { code: RateLimited, reason: ProviderRateLimited, wait: RetryAt({ retryAtMs: retryAt }) } else refuseUntil(ProviderUnavailable, retryAt)
  | _ => refuseUntil(ProviderUnavailable, retryAt)
}
pure def lawFailureRefusalsAreWellFormed(status: int, delivered: bool, retryAt: Millis): bool = {
  val r = failureRefusal(endOfFailure(status, delivered), retryAt)
  wellFormed(r) and (retryableOf(r) iff (r.code == ProviderUnavailable or r.code == RateLimited))
}
pure def lawOnlyAnUndeliveredProviderRateLimitIsARateLimit(status: int, delivered: bool, retryAt: Millis): bool =
  (failureRefusal(endOfFailure(status, delivered), retryAt).code == RateLimited) iff (status == 429 and not(delivered))
pure def lawAProviderRateLimitNamesTheProvider(status: int, delivered: bool, retryAt: Millis): bool =
  (failureRefusal(endOfFailure(status, delivered), retryAt).code == RateLimited) implies (failureRefusal(endOfFailure(status, delivered), retryAt).reason == ProviderRateLimited)
pure val hintValues = Set(-1, 0, 1000, 4000, 4001, 59000)
pure def lawProviderRetryTimeIsKept(status: int, hint: Millis): bool =
  if (hint >= 0) failureWait(status, hint) == hint
  else failureWait(status, hint) == (if (status == 429) rateLimitPause else providerPause)
```

### A provider's refusal of the request passes on its listed code and parameter and nothing else

A provider `400` may say what was wrong with the request, flat or inside an
`error` envelope. The `400 invalid_request` answer carries the provider's
`code` when it is one of `requestFaultCodes` and its `param` when it is one
of `requestFaultParams`, beside the refusal's own fields, so the agent can
tell a tool call the provider could not parse out of the model's own
generation (`parser_error`, sent once more by the turn) and a context that
is too long (`context_length_exceeded`) from a request it must change. Any
other value is left out, and so is every other field of the provider's
body: its message can echo the request, and a billing, quota or credential
code speaks of the deployment's provider account, not the caller's. A
refusal with any other status passes nothing on, and its body is not read.

```quint
type ProviderFault = { code: str, param: str }
pure val requestFaultCodes: Set[str] = Set("parser_error", "context_length_exceeded", "context_window_exceeded", "input_too_long", "invalid_json_schema",
  "schema_validation_error", "wrong_api_format", "unsupported_parameter", "unsupported_value", "invalid_value", "invalid_type", "invalid_request", "tool_use_failed")
pure val requestFaultParams: Set[str] = Set("tool_calls", "messages", "tools", "response_format")
pure val noFault: ProviderFault = { code: "", param: "" }
pure def readsFault(status: int): bool = status == 400
pure def passedFault(status: int, faultCode: str, faultParam: str): ProviderFault =
  if (not(readsFault(status))) noFault
  else { code: if (requestFaultCodes.contains(faultCode)) faultCode else "", param: if (requestFaultParams.contains(faultParam)) faultParam else "" }
pure val faultCodeValues = Set("", "parser_error", "insufficient_quota")
pure val faultParamValues = Set("", "tool_calls", "prompt")
pure def lawOnlyAListedFaultIsPassed(status: int, faultCode: str, faultParam: str): bool = {
  val fault = passedFault(status, faultCode, faultParam)
  (fault.code == "" or (status == 400 and fault.code == faultCode and requestFaultCodes.contains(faultCode)))
    and (fault.param == "" or (status == 400 and fault.param == faultParam and requestFaultParams.contains(faultParam)))
}
pure def lawAParseFailureReachesTheAgent(faultParam: str): bool = passedFault(400, "parser_error", faultParam).code == "parser_error"
pure def lawAnUnreadRefusalPassesNothing(status: int, faultCode: str, faultParam: str): bool = not(readsFault(status)) implies passedFault(status, faultCode, faultParam) == noFault
```

## Story: Stream a reply in the shape clients read

> As the developer of an agent's cloud provider, I want a streamed reply as
> server-sent chunks that end in `[DONE]`, a failure I can tell from a short
> success, and a whole reply when I do not stream, so that one OpenAI
> client library reads every answer.

A whole reply is one `chat.completion`. A streamed reply is
`text/event-stream` of `data:` lines, each a `chat.completion.chunk` whose
deltas carry text and tool calls as the provider sent them. Both response
shapes name the cloud's listed model ID. A stream starts only
once the provider accepted the call; a failure before that is a refusal.

### A stream ends in exactly one [DONE] unless the caller hung up, and completes only when the provider finished

A finished stream sends its chunks, one usage chunk when the request asked
(`stream_options.include_usage`) and the provider reported usage, then
`data: [DONE]`; a failure after the start sends one error chunk, then
`[DONE]`; a caller who hangs up is sent nothing more.

```quint
type StreamEnding = StreamFinished | StreamFailed | StreamHungUp
type Frame = Delta({ seq: int }) | UsageChunk | ErrorChunk | Done
pure val errorFrame: Frame = ErrorChunk
pure def streamFrames(deltas: List[int], ending: StreamEnding, usageAsked: bool, usageReported: bool): List[Frame] = {
  val body = deltas.listMap(d => Delta({ seq: d }))
  if (ending == StreamFinished) body.concat(if (usageAsked and usageReported) List(UsageChunk, Done) else List(Done))
  else if (ending == StreamFailed) body.concat(List(ErrorChunk, Done))
  else body
}
pure def completes(frames: List[Frame]): bool = frames.length() > 0 and frames.nthOr(frames.length() - 1, errorFrame) == Done and not(frames.includes(ErrorChunk))
pure def countOf(frames: List[Frame], f: Frame): int = frames.select(g => g == f).length()
pure val deltasValues = Set(List(), List(1), List(1, 2, 3))
pure def lawEveryUnbrokenStreamEndsInOneDone(deltas: List[int], ending: StreamEnding, usageAsked: bool, usageReported: bool): bool = {
  val frames = streamFrames(deltas, ending, usageAsked, usageReported)
  (ending != StreamHungUp implies (frames.nthOr(frames.length() - 1, errorFrame) == Done and countOf(frames, Done) == 1))
    and (ending == StreamHungUp implies countOf(frames, Done) == 0)
}
pure def lawOnlyAFinishedStreamCompletes(deltas: List[int], ending: StreamEnding, usageAsked: bool, usageReported: bool): bool =
  completes(streamFrames(deltas, ending, usageAsked, usageReported)) iff ending == StreamFinished
pure def lawUsageIsSentOnceAndOnlyAsReported(deltas: List[int], ending: StreamEnding, usageAsked: bool, usageReported: bool): bool = {
  val n = countOf(streamFrames(deltas, ending, usageAsked, usageReported), UsageChunk)
  n <= 1 and (n == 1 iff (ending == StreamFinished and usageAsked and usageReported))
}
pure def lawOnlyAFailedStreamSendsAnError(deltas: List[int], ending: StreamEnding, usageAsked: bool, usageReported: bool): bool =
  countOf(streamFrames(deltas, ending, usageAsked, usageReported), ErrorChunk) == (if (ending == StreamFailed) 1 else 0)
```

### Reading the provider's stream yields the same events however its bytes were split

The cloud reads the provider's lines for usage and delivered characters: a
line feed ends a line, carriage returns are dropped, and a non-empty line is
one event. `src/services/sse.ts` holds this law as its `//@` contract, on
code points decoded at UTF-8 boundaries.

```quint
type SseReader = { fragment: List[int], events: List[int] }
pure val carriageReturn: int = 13
pure val lineFeed: int = 10
pure val emptyReader: SseReader = { fragment: List(), events: List() }
pure def endLine(p: SseReader): SseReader = {
  val payload = p.fragment.select(c => c != carriageReturn)
  { fragment: List(), events: if (payload.length() == 0) p.events else p.events.append(payload.nthOr(0, 0)) }
}
pure def readSymbol(p: SseReader, c: int): SseReader = if (c == lineFeed) endLine(p) else { fragment: p.fragment.append(c), events: p.events }
pure def readChunk(p: SseReader, chunk: List[int]): SseReader = chunk.foldl(p, (q, c) => readSymbol(q, c))
pure val firstValues = Set(List(), List(65, 10), List(65, 13), List(10, 66, 13, 10, 67))
pure val secondValues = Set(List(), List(10), List(13, 10, 68), List(69))
pure def lawChunkBoundariesDoNotChangeEvents(first: List[int], second: List[int]): bool =
  readChunk(readChunk(emptyReader, first), second) == readChunk(emptyReader, first.concat(second))
```
