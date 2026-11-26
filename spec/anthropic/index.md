# Anthropic inference

The Anthropic provider supports text tiers, native tools, structured
output, streaming text, and image description. The shell owns
credential resolution and the SDK or configured CLI session.

## Story: Ask an Anthropic model for a complete response

> As a model caller, I want native tool results and requested output bounds
> respected, with an incomplete generation reported as failure.

### Transport must support the request and keeps the requested output budget

Native messages, tools, tool choice and schemas require the API transport.
Tool use and native structured output take the complete-response path.
Auth modes are parsed before dispatch and absence stays visible. A
caller-supplied max token count above the model's configured capacity
is refused without clipping.

```quint
type AnthropicAuth = NoAnthropicAuth | AnthropicApi | AnthropicCli
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
type AnthropicOutputCap = AutoCap | AskedCap({ tokens: int })
pure def anthropicOutputBudget(capacity: int, cap: AnthropicOutputCap): int =
  if (capacity <= 0) 0
  else match cap {
    | AutoCap => capacity
    | AskedCap(c) => if (c.tokens > 0 and c.tokens <= capacity) c.tokens else 0
  }
pure def lawExplicitAnthropicBudgetIsExact(capacity: int, tokens: int): bool =
  anthropicOutputBudget(capacity, AskedCap({ tokens: tokens })) == 0 or anthropicOutputBudget(capacity, AskedCap({ tokens: tokens })) == tokens
```

### Temperature and nucleus sampling are mutually exclusive

If both are requested, temperature wins. A locked model's explicit
temperature normalizes to one. Extended thinking drops nucleus sampling
and normalizes temperature to one. When only top-p is sent to an
unlocked model, omit temperature.

```quint
type AnthropicSampling = DefaultSampling | RequestedTemperature | RequestedTopP | TemperatureOne
pure def anthropicSampling(hasTemperature: bool, hasTopP: bool, temperatureLocked: bool, thinkingOn: bool): AnthropicSampling =
  if (thinkingOn or (temperatureLocked and (hasTemperature or not(hasTopP)))) TemperatureOne
  else if (hasTemperature) RequestedTemperature
  else if (hasTopP) RequestedTopP
  else DefaultSampling
pure def lawThinkingUsesTemperatureOne(hasTemperature: bool, hasTopP: bool, temperatureLocked: bool): bool =
  anthropicSampling(hasTemperature, hasTopP, temperatureLocked, true) == TemperatureOne
```

### Completion follows the provider terminal reason

Streaming pieces are visible while a streamed reply is active. The
adapter captures accounting evidence separately from delivery. Completion
requires a terminal reason that permits a complete result and, when
requested, a decoded native response object. Cancellation, truncation,
and provider error cannot complete.

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
pure def stepAnthropicTerminalRemains(before: AnthropicRun, after: AnthropicRun): bool =
  (before.phase == AnthropicComplete or before.phase == AnthropicFailed or before.phase == AnthropicCancelled) implies before == after
pure val inputValues = Set({ hasNativeMessages: false, hasTools: false, hasToolChoice: false, hasSchema: false, wantsStream: true, streamingAllowed: true }, { hasNativeMessages: true, hasTools: true, hasToolChoice: true, hasSchema: true, wantsStream: true, streamingAllowed: true })
pure val capValues = Set(AutoCap, AskedCap({ tokens: 2 }), AskedCap({ tokens: 10 }))
pure def sometimesAnthropicToolFinishes(s: AnthropicRun): bool =
  s.phase == AnthropicComplete and s.expectsObject and s.chosenTransport == SdkWhole and s.reportedUsage
pure val eval_witness_sometimesAnthropicToolFinishes = (("beginAnthropic", AnthropicApi, { hasNativeMessages: true, hasTools: true, hasToolChoice: true, hasSchema: true, wantsStream: true, streamingAllowed: true }, 5, AskedCap({ tokens: 2 })), ("finishAnthropic", EndTool, true, true))
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
