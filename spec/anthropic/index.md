# Anthropic inference

The Anthropic provider supports text tiers, native tools, structured
output, prompt caching, extended and adaptive thinking, streaming text,
multimodal attachments, OAuth and API key authentication, CLI fallback,
and image description. The shell owns credential resolution, wire
sanitization, retry backoff, usage telemetry, and HTTP or CLI transport.

## Story: Ask an Anthropic model for a complete response

> As a model caller, I want native tool results, extended thinking,
> prompt-cache budgets, error classification, and requested output bounds
> respected, with an incomplete generation reported as failure after
> billed usage is recorded.

### Transport must support the request and keeps the requested output budget

Native messages, tools, tool choice and schemas require the Messages API
transport (authenticated by API key or OAuth bearer token). Tool use and
native structured output take the complete-response path. Auth modes are
parsed before dispatch and absence stays visible. A caller-supplied max
token count above the model's configured capacity is refused without
clipping, while an omitted cap uses the model's full capacity.

```quint
type AnthropicAuth = NoAnthropicAuth | AnthropicApi | AnthropicOAuth | AnthropicCli
type AnthropicTransport = RefuseAnthropic | CliWhole | CliStream | SdkWhole | SdkStream
type AnthropicInput = { hasNativeMessages: bool, hasTools: bool, hasToolChoice: bool, hasSchema: bool, wantsStream: bool, streamingAllowed: bool }
pure def anthropicTransport(auth: AnthropicAuth, input: AnthropicInput): AnthropicTransport =
  if (auth == NoAnthropicAuth) RefuseAnthropic
  else if (auth == AnthropicCli) {
    if (input.hasNativeMessages or input.hasTools or input.hasToolChoice or input.hasSchema) RefuseAnthropic
    else if (input.wantsStream and input.streamingAllowed) CliStream else CliWhole
  } else if (input.wantsStream and input.streamingAllowed and not(input.hasTools or input.hasToolChoice or input.hasSchema)) SdkStream
  else SdkWhole
pure def lawAnthropicToolsStayOnSdk(auth: AnthropicAuth, input: AnthropicInput): bool =
  (input.hasTools or input.hasToolChoice or input.hasSchema) implies
    (anthropicTransport(auth, input) == SdkWhole or anthropicTransport(auth, input) == RefuseAnthropic)
pure def lawOAuthMatchesApiTransport(input: AnthropicInput): bool =
  anthropicTransport(AnthropicOAuth, input) == anthropicTransport(AnthropicApi, input)
type AnthropicOutputCap = AutoCap | AskedCap({ tokens: int })
pure def anthropicOutputBudget(capacity: int, cap: AnthropicOutputCap): int =
  if (capacity <= 0) 0
  else match cap {
    | AutoCap => capacity
    | AskedCap(c) => if (c.tokens > 0 and c.tokens <= capacity) c.tokens else 0
  }
pure def lawExplicitAnthropicBudgetIsExact(capacity: int, tokens: int): bool =
  anthropicOutputBudget(capacity, AskedCap({ tokens: tokens })) == 0 or anthropicOutputBudget(capacity, AskedCap({ tokens: tokens })) == tokens
pure def lawAutoCapUsesFullCapacity(capacity: int): bool =
  capacity > 0 implies anthropicOutputBudget(capacity, AutoCap) == capacity
```

### Temperature and nucleus sampling are mutually exclusive

If both are requested, temperature wins. A locked model's explicit
temperature normalizes to one. Extended or adaptive thinking drops
nucleus sampling and normalizes temperature to one. When only top-p is
sent to an unlocked model, omit temperature. Effort wins over a fixed
chain-of-thought budget when supported by the model, unsupported models
drop effort, models without extended effort clamp xhigh and max to high,
and always-adaptive models map a positive budget to adaptive thinking.

```quint
type AnthropicEffort = NoEffort | EffortLow | EffortMedium | EffortHigh | EffortXHigh | EffortMax
type AnthropicThinking = ThinkingOff | ThinkingAdaptive({ effort: AnthropicEffort }) | ThinkingBudget({ budgetTokens: int })
pure def anthropicEffectiveEffort(requested: AnthropicEffort, supportsEffort: bool, supportsExtended: bool): AnthropicEffort =
  if (requested == NoEffort or not(supportsEffort)) NoEffort
  else if ((requested == EffortXHigh or requested == EffortMax) and not(supportsExtended)) EffortHigh
  else requested
pure def anthropicThinkingMode(requested: AnthropicEffort, supportsEffort: bool, supportsExtended: bool, cotBudget: int, alwaysAdaptive: bool): AnthropicThinking = {
  val eff = anthropicEffectiveEffort(requested, supportsEffort, supportsExtended)
  if (eff != NoEffort) ThinkingAdaptive({ effort: eff })
  else if (cotBudget > 0) {
    if (alwaysAdaptive) ThinkingAdaptive({ effort: NoEffort })
    else ThinkingBudget({ budgetTokens: cotBudget })
  } else ThinkingOff
}
pure def lawEffortUnsupportedDropsEffort(requested: AnthropicEffort, supportsExtended: bool): bool =
  anthropicEffectiveEffort(requested, false, supportsExtended) == NoEffort
pure def lawExtendedEffortClampedToHigh(requested: AnthropicEffort): bool =
  (requested == EffortXHigh or requested == EffortMax) implies
    anthropicEffectiveEffort(requested, true, false) == EffortHigh
pure def lawEffortWinsOverCotBudget(requested: AnthropicEffort, supportsExtended: bool, cotBudget: int, alwaysAdaptive: bool): bool = {
  val mode = anthropicThinkingMode(requested, true, supportsExtended, cotBudget, alwaysAdaptive)
  requested != NoEffort implies match mode {
    | ThinkingAdaptive(a) => a.effort != NoEffort
    | _ => false
  }
}
type AnthropicSampling = DefaultSampling | RequestedTemperature | RequestedTopP | TemperatureOne
pure def anthropicSampling(hasTemperature: bool, hasTopP: bool, temperatureLocked: bool, thinkingOn: bool): AnthropicSampling =
  if (thinkingOn or (temperatureLocked and (hasTemperature or not(hasTopP)))) TemperatureOne
  else if (hasTemperature) RequestedTemperature
  else if (hasTopP) RequestedTopP
  else DefaultSampling
pure def lawThinkingUsesTemperatureOne(hasTemperature: bool, hasTopP: bool, temperatureLocked: bool): bool =
  anthropicSampling(hasTemperature, hasTopP, temperatureLocked, true) == TemperatureOne
```

### Prompt caching and strict tool budgets stay within Anthropic wire limits

Anthropic allows at most four prompt-cache breakpoints per request,
spent in priority order on the system prompt, the tools catalog tail,
and remaining stable prompt segments. Strict tool schemas are kept
strict only when at most twenty strict tools and at most twenty-four
optional parameters appear across the strict tool surface; larger
surfaces downgrade to non-strict for the request. Native structured
response schemas exceeding twenty-four optional parameters are rejected
before dispatch.

```quint
pure def anthropicSegmentBreakpointBudget(maxBreakpoints: int, cacheSystem: bool, cacheTools: bool): int = {
  val cap = if (maxBreakpoints < 0) 0 else if (maxBreakpoints > 4) 4 else maxBreakpoints
  val reserved = (if (cacheSystem) 1 else 0) + (if (cacheTools) 1 else 0)
  if (cap > reserved) cap - reserved else 0
}
pure def lawCacheBreakpointsWithinCap(maxBreakpoints: int, cacheSystem: bool, cacheTools: bool): bool = {
  val cap = if (maxBreakpoints < 0) 0 else if (maxBreakpoints > 4) 4 else maxBreakpoints
  val used = (if (cacheSystem) 1 else 0) + (if (cacheTools) 1 else 0)
  val seg = anthropicSegmentBreakpointBudget(maxBreakpoints, cacheSystem, cacheTools)
  seg >= 0 and (used <= cap implies used + seg == cap) and (used > cap implies seg == 0)
}
pure def anthropicStrictToolsAllowed(strictToolCount: int, optionalParamCount: int): bool =
  strictToolCount >= 0 and optionalParamCount >= 0 and strictToolCount <= 20 and optionalParamCount <= 24
pure def anthropicResponseSchemaAllowed(optionalParamCount: int): bool =
  optionalParamCount >= 0 and optionalParamCount <= 24
pure def lawOverBudgetStrictToolsDowngrade(strictToolCount: int, optionalParamCount: int): bool =
  (strictToolCount > 20 or optionalParamCount > 24) implies
    not(anthropicStrictToolsAllowed(strictToolCount, optionalParamCount))
```

### Provider errors classify retryability and failover without retrying credit or auth failures

Rate limits, overload, server failures, and timeouts are retryable and
eligible for provider failover. Credit-balance exhaustion,
authentication failures, invalid client requests, and stream
disconnections are never retried, and credit-balance or client errors do
not trigger provider failover.

```quint
type AnthropicErrorKind = CreditBalanceError | AuthFailureError | RateLimitError | OverloadedError | ServerRetryableError | TimeoutError | ClientInvalidError | StreamDisconnectedError
pure def anthropicIsRetryable(kind: AnthropicErrorKind): bool =
  kind == RateLimitError or kind == OverloadedError or kind == ServerRetryableError or kind == TimeoutError
pure def anthropicTriggersProviderFallback(kind: AnthropicErrorKind): bool =
  kind == RateLimitError or kind == OverloadedError or kind == ServerRetryableError or kind == TimeoutError
pure def lawCreditBalanceNeverRetriesOrFailsOver(kind: AnthropicErrorKind): bool =
  kind == CreditBalanceError implies (not(anthropicIsRetryable(kind)) and not(anthropicTriggersProviderFallback(kind)))
pure def lawAuthFailureNeverRetries(kind: AnthropicErrorKind): bool =
  kind == AuthFailureError implies not(anthropicIsRetryable(kind))
pure def lawTransientFailuresRetryAndFailOver(kind: AnthropicErrorKind): bool =
  (kind == RateLimitError or kind == OverloadedError or kind == ServerRetryableError or kind == TimeoutError) implies
    (anthropicIsRetryable(kind) and anthropicTriggersProviderFallback(kind))
```

### Completion follows the provider terminal reason

Streaming pieces are visible while a streamed reply is active. The
adapter captures accounting evidence separately from delivery so billed
usage is reported even when an output limit or refusal causes failure.
Every running or completed request holds an accepted transport.
Completion requires a terminal reason that permits a complete result
and, when requested, a decoded native response object. Cancellation,
truncation, and provider error cannot complete.

```quint
type AnthropicPhase = AnthropicIdle | AnthropicRunning | AnthropicComplete | AnthropicFailed | AnthropicCancelled
type AnthropicFinish = EndTurn | EndTool | EndStop | EndLimit | EndRefusal | EndFailure
type AnthropicRun = { phase: AnthropicPhase, chosenTransport: AnthropicTransport, expectsObject: bool, reportedUsage: bool }
pure val initial: AnthropicRun = { phase: AnthropicIdle, chosenTransport: RefuseAnthropic, expectsObject: false, reportedUsage: false }
pure def canBeginAnthropic(s: AnthropicRun, auth: AnthropicAuth, input: AnthropicInput, capacity: int, cap: AnthropicOutputCap): bool =
  s.phase == AnthropicIdle and anthropicTransport(auth, input) != RefuseAnthropic and anthropicOutputBudget(capacity, cap) > 0
pure def beginAnthropic(s: AnthropicRun, auth: AnthropicAuth, input: AnthropicInput, capacity: int, cap: AnthropicOutputCap): AnthropicRun =
  { ...s, phase: AnthropicRunning, chosenTransport: anthropicTransport(auth, input), expectsObject: input.hasSchema }
pure def canFinishAnthropic(s: AnthropicRun): bool = s.phase == AnthropicRunning
pure def finishAnthropic(s: AnthropicRun, reason: AnthropicFinish, nativeShapeValid: bool, usageAvailable: bool): AnthropicRun =
  { ...s, phase: if ((reason == EndTurn or reason == EndTool or reason == EndStop) and (not(s.expectsObject) or nativeShapeValid)) AnthropicComplete else AnthropicFailed, reportedUsage: usageAvailable }
pure def canCancelAnthropic(s: AnthropicRun): bool = s.phase == AnthropicRunning
pure def cancelAnthropic(s: AnthropicRun): AnthropicRun = { ...s, phase: AnthropicCancelled }
pure def alwaysActiveOrCompleteHasTransport(s: AnthropicRun): bool =
  (s.phase == AnthropicRunning or s.phase == AnthropicComplete) implies s.chosenTransport != RefuseAnthropic
pure def stepAnthropicTerminalRemains(before: AnthropicRun, after: AnthropicRun): bool =
  (before.phase == AnthropicComplete or before.phase == AnthropicFailed or before.phase == AnthropicCancelled) implies before == after
pure val inputValues = Set({ hasNativeMessages: false, hasTools: false, hasToolChoice: false, hasSchema: false, wantsStream: true, streamingAllowed: true }, { hasNativeMessages: true, hasTools: true, hasToolChoice: true, hasSchema: true, wantsStream: true, streamingAllowed: true })
pure val capValues = Set(AutoCap, AskedCap({ tokens: 2 }), AskedCap({ tokens: 10 }))
pure def sometimesAnthropicToolFinishes(s: AnthropicRun): bool =
  s.phase == AnthropicComplete and s.expectsObject and s.chosenTransport == SdkWhole and s.reportedUsage
pure val eval_witness_sometimesAnthropicToolFinishes = (("beginAnthropic", AnthropicApi, { hasNativeMessages: true, hasTools: true, hasToolChoice: true, hasSchema: true, wantsStream: true, streamingAllowed: true }, 5, AskedCap({ tokens: 2 })), ("finishAnthropic", EndTool, true, true))
pure def sometimesAnthropicOAuthStreams(s: AnthropicRun): bool =
  s.phase == AnthropicComplete and not(s.expectsObject) and s.chosenTransport == SdkStream and s.reportedUsage
pure val eval_witness_sometimesAnthropicOAuthStreams = (("beginAnthropic", AnthropicOAuth, { hasNativeMessages: false, hasTools: false, hasToolChoice: false, hasSchema: false, wantsStream: true, streamingAllowed: true }, 5, AutoCap), ("finishAnthropic", EndTurn, false, true))
pure def sometimesAnthropicTruncatedReportsUsage(s: AnthropicRun): bool =
  s.phase == AnthropicFailed and s.reportedUsage
pure val eval_witness_sometimesAnthropicTruncatedReportsUsage = (("beginAnthropic", AnthropicApi, { hasNativeMessages: false, hasTools: false, hasToolChoice: false, hasSchema: false, wantsStream: false, streamingAllowed: true }, 5, AutoCap), ("finishAnthropic", EndLimit, false, true))
```

### Reported usage carries the cache read and cache write tokens the provider reports

A response's usage reports input, output and total tokens, plus the
`cache_read_input_tokens` and `cache_creation_input_tokens` the provider
reports, as cache reads and cache writes.

```quint
type CacheUsage = { reads: int, writes: int }
pure def reportedCacheUsage(reads: int, writes: int): CacheUsage = { reads: reads, writes: writes }
pure def lawCacheCountsKept(reads: int, writes: int): bool =
  reportedCacheUsage(reads, writes).reads == reads and reportedCacheUsage(reads, writes).writes == writes
pure val readsValues = Set(0, 1800)
pure val writesValues = Set(0, 200)
```
