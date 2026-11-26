# OpenAI-compatible inference

Select an OpenAI-compatible upstream for text and structured output.
Embed text, tokenize, generate or describe images, transcribe audio,
synthesize speech, and perform research through their own model handlers.

## Story: Use an OpenAI-compatible model for the requested capability

> As a runtime caller, I want a configured provider for my operation and
> truthful output that follows its requested shape.

### Confidential and capability requirements are routing constraints

The shell parses endpoint settings, model tier, operation override, and
the explicitly configured failover target. An endpoint that cannot honor
the requested operation, structured output, or confidentiality is
ineligible. Confidential requests keep the kernel's confidential
dispatch boundary. A stale first-party base URL belonging to a different
selected provider is never reused for another provider's credentials.
Text-only providers such as Cerebras do not accept media or embedding
operations unless an explicit per-capability endpoint override is set.

```quint
type OpenAiOperation = TextNano | TextSmall | TextMedium | TextLarge | TextMega | ResponseHandler | ActionPlanner | ReasoningSmall | ReasoningLarge | EmbedText | EncodeTokens | DecodeTokens | CreateImage | DescribeImage | TranscribeAudio | SpeakText | RunResearch
type OpenAiProviderMode = ProviderOpenAi | ProviderCerebras | ProviderEvoLink | ProviderOpenRouter
type OpenAiEndpoint = { address: str, modelId: str, acceptsOperation: bool, acceptsSchema: bool, confidential: bool }
pure def suitableOpenAiEndpoint(endpoint: OpenAiEndpoint, needsSchema: bool, needsConfidential: bool): bool =
  endpoint.address != "" and endpoint.modelId != "" and endpoint.acceptsOperation and
    (needsSchema implies endpoint.acceptsSchema) and (needsConfidential implies endpoint.confidential)
pure val endpointValues: Set[OpenAiEndpoint] = Set(
  { address: "public", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: false },
  { address: "private", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true },
  { address: "private", modelId: "speech", acceptsOperation: false, acceptsSchema: false, confidential: true })
pure def lawConfidentialOpenAiNeverSelectsPublic(endpoint: OpenAiEndpoint, needsSchema: bool): bool =
  not(endpoint.confidential) implies not(suitableOpenAiEndpoint(endpoint, needsSchema, true))
pure def openAiRequiresEndpoint(operation: OpenAiOperation): bool =
  operation != EncodeTokens and operation != DecodeTokens
pure def openAiModelId(explicitModel: str, configuredModel: str, defaultModel: str): str =
  if (explicitModel != "") explicitModel else if (configuredModel != "") configuredModel else defaultModel
pure def openAiBaseUrlAllowedForProvider(baseOwner: str, selectedProvider: str): bool =
  baseOwner == "" or selectedProvider == "" or baseOwner == selectedProvider
pure def lawDifferentFirstPartyBaseRejected(baseOwner: str, selectedProvider: str): bool =
  (baseOwner != "" and selectedProvider != "" and baseOwner != selectedProvider) implies
    not(openAiBaseUrlAllowedForProvider(baseOwner, selectedProvider))
pure def openAiSupportsCapability(provider: OpenAiProviderMode, operation: OpenAiOperation, hasCapabilityOverride: bool): bool =
  if (provider != ProviderCerebras or hasCapabilityOverride) true
  else (operation != EmbedText and operation != CreateImage and operation != DescribeImage and operation != TranscribeAudio and operation != SpeakText and operation != RunResearch)
pure def lawCerebrasBlocksUnoverriddenMedia(operation: OpenAiOperation): bool =
  (operation == EmbedText or operation == CreateImage or operation == DescribeImage or operation == TranscribeAudio or operation == SpeakText or operation == RunResearch) implies
    not(openAiSupportsCapability(ProviderCerebras, operation, false))
```

### An attempt can change upstream only before publishing any output

Provider parsing, a bounded timeout, and response-schema normalization
are shell responsibilities. Report a first visible text or tool event as
progress before exposing it. Before this boundary a retryable failure may
select one eligible fallback. An output-size failure, invalid response
shape, provider terminal rejection, or failure after visible progress
cannot be turned into success by concatenating responses from different
attempts. A caller's abort ends the request, and terminal phases remain
final. Outgoing tool definitions request wire strict mode only when the
request contains tools and every tool in the batch satisfies strict wire
schema rules.

```quint
type OpenAiPhase = AwaitingOpenAi | CallingOpenAi | PartialOpenAi | CompleteOpenAi | FailedOpenAi | CancelledOpenAi
type OpenAiAttempt = PrimaryOpenAi | FallbackOpenAi
type OpenAiFailure = RetryableOpenAi | ProviderRefusedOpenAi | InvalidShapeOpenAi | OutputIncompleteOpenAi
type OpenAiRun = { phase: OpenAiPhase, attempt: OpenAiAttempt, fallbackEligible: bool, requiresSchema: bool, confidentiality: bool }
pure val initial: OpenAiRun = { phase: AwaitingOpenAi, attempt: PrimaryOpenAi, fallbackEligible: false, requiresSchema: false, confidentiality: false }
pure def canBeginOpenAi(s: OpenAiRun, primary: OpenAiEndpoint, needsSchema: bool, needsConfidential: bool): bool =
  s.phase == AwaitingOpenAi and suitableOpenAiEndpoint(primary, needsSchema, needsConfidential)
pure def beginOpenAi(s: OpenAiRun, primary: OpenAiEndpoint, fallback: OpenAiEndpoint, needsSchema: bool, needsConfidential: bool): OpenAiRun =
  { ...s, phase: CallingOpenAi, fallbackEligible: fallback != primary and suitableOpenAiEndpoint(fallback, needsSchema, needsConfidential), requiresSchema: needsSchema, confidentiality: needsConfidential }
pure def canPublishOpenAiPiece(s: OpenAiRun, attempt: OpenAiAttempt): bool =
  (s.phase == CallingOpenAi or s.phase == PartialOpenAi) and s.attempt == attempt and not(s.requiresSchema)
pure def publishOpenAiPiece(s: OpenAiRun, attempt: OpenAiAttempt): OpenAiRun =
  { ...s, phase: PartialOpenAi }
pure def canAcceptOpenAi(s: OpenAiRun, attempt: OpenAiAttempt, terminal: bool, shapeMatches: bool): bool =
  (s.phase == CallingOpenAi or s.phase == PartialOpenAi) and s.attempt == attempt and terminal and (s.requiresSchema implies shapeMatches)
pure def acceptOpenAi(s: OpenAiRun, attempt: OpenAiAttempt, terminal: bool, shapeMatches: bool): OpenAiRun =
  { ...s, phase: CompleteOpenAi }
pure def canFailOpenAi(s: OpenAiRun, attempt: OpenAiAttempt): bool =
  (s.phase == CallingOpenAi or s.phase == PartialOpenAi) and s.attempt == attempt
pure def failOpenAi(s: OpenAiRun, attempt: OpenAiAttempt, failure: OpenAiFailure): OpenAiRun =
  if (s.phase == CallingOpenAi and s.attempt == PrimaryOpenAi and s.fallbackEligible and failure == RetryableOpenAi)
    { ...s, attempt: FallbackOpenAi }
  else { ...s, phase: FailedOpenAi }
pure def canCancelOpenAi(s: OpenAiRun): bool = s.phase == CallingOpenAi or s.phase == PartialOpenAi
pure def cancelOpenAi(s: OpenAiRun): OpenAiRun = { ...s, phase: CancelledOpenAi }
pure def stepPartialOpenAiKeepsAttempt(before: OpenAiRun, after: OpenAiRun): bool =
  before.phase == PartialOpenAi implies after.attempt == before.attempt
pure def stepOpenAiNeverUncancels(before: OpenAiRun, after: OpenAiRun): bool =
  before.phase == CancelledOpenAi implies before == after
pure def stepOpenAiTerminalRemains(before: OpenAiRun, after: OpenAiRun): bool =
  (before.phase == CompleteOpenAi or before.phase == FailedOpenAi or before.phase == CancelledOpenAi) implies before == after
pure def openAiBatchToolsStrict(toolCount: int, allToolsStrict: bool): bool =
  toolCount > 0 and allToolsStrict
pure def lawMixedToolsNeverEmitStrict(toolCount: int): bool =
  not(openAiBatchToolsStrict(toolCount, false))
pure val primaryValues = Set({ address: "primary", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true })
pure val fallbackValues = Set({ address: "", modelId: "", acceptsOperation: false, acceptsSchema: false, confidential: false }, { address: "backup", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true })
pure def sometimesOpenAiFallbackFinishes(s: OpenAiRun): bool = s.phase == CompleteOpenAi and s.attempt == FallbackOpenAi
pure val eval_witness_sometimesOpenAiFallbackFinishes = (("beginOpenAi", { address: "primary", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true }, { address: "backup", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true }, true, true), ("failOpenAi", PrimaryOpenAi, RetryableOpenAi), ("acceptOpenAi", FallbackOpenAi, true, true))
```

### Tokenizer cache keys distinguish concrete model encodings

Cache only the tokenizer selected for the resolved encoding. An
unrecognized model uses the fallback encoding selected by the shell
(`o200k_base` for 4o/5/reasoning-family models, `cl100k_base` otherwise).
Failed initialization leaves the cache empty for that encoding and can be
retried. Cache population has no effect on the input or output token IDs.

```quint
pure def openAiTokenizerKey(resolvedEncoding: str, fallbackEncoding: str): str =
  if (resolvedEncoding == "") fallbackEncoding else resolvedEncoding
pure def openAiFallbackEncoding(modernFamily: bool): str =
  if (modernFamily) "o200k_base" else "cl100k_base"
pure def lawKnownTokenizerKeepsEncoding(resolvedEncoding: str, fallbackEncoding: str): bool =
  resolvedEncoding != "" implies openAiTokenizerKey(resolvedEncoding, fallbackEncoding) == resolvedEncoding
pure def lawFallbackEncodingIsNonEmpty(modernFamily: bool): bool =
  openAiFallbackEncoding(modernFamily) != ""
```

### A cooling route does not resend before the provider's reset

Cooldown keys bind endpoint, credential slot, and concrete model.
A different eligible concrete model can be selected while the primary
cools down, and a healthy primary stays selected. Server refill times are
passed as observations, independent of retry scheduling, and a bounded
local hold never exceeds the provider's stated reset. The shell keeps
short transient retries within one shared caller budget, does not retry
after cancellation, and never retries permanent quota failures, provider
tool-call parse failures, attempt idle timeouts, or retry delays that
outlast the transient lane.

```quint
type OpenAiCooldown = { resetAt: int, attempts: int, attemptLimit: int }
pure def mayRetryOpenAi(cooldown: OpenAiCooldown, wallTime: int, retryable: bool, visible: bool, cancelled: bool): bool =
  retryable and not(visible or cancelled) and wallTime >= cooldown.resetAt and
    cooldown.attempts >= 0 and cooldown.attempts < cooldown.attemptLimit
pure val cooldownValues: Set[OpenAiCooldown] = Set(
  { resetAt: 4, attempts: 1, attemptLimit: 2 },
  { resetAt: 0, attempts: 2, attemptLimit: 2 })
pure def lawOpenAiRespectsCooldown(cooldown: OpenAiCooldown, wallTime: int, retryable: bool, visible: bool, cancelled: bool): bool =
  wallTime < cooldown.resetAt implies not(mayRetryOpenAi(cooldown, wallTime, retryable, visible, cancelled))
pure def openAiCooldownHoldMs(retryAfterMs: int, maxHoldMs: int, boundHold: bool): int =
  if (retryAfterMs <= 0) 0
  else if (boundHold and maxHoldMs > 0 and retryAfterMs > maxHoldMs) maxHoldMs
  else retryAfterMs
pure def lawOpenAiHoldNeverExceedsReset(retryAfterMs: int, maxHoldMs: int, boundHold: bool): bool =
  retryAfterMs >= 0 implies (openAiCooldownHoldMs(retryAfterMs, maxHoldMs, boundHold) >= 0 and openAiCooldownHoldMs(retryAfterMs, maxHoldMs, boundHold) <= retryAfterMs)
pure def openAiSelectModel(primaryModel: str, fallbackModel: str, primaryCooling: bool, fallbackCooling: bool): str =
  if (primaryCooling and fallbackModel != "" and fallbackModel != primaryModel and not(fallbackCooling)) fallbackModel else primaryModel
pure def lawOpenAiHealthyPrimaryStaysSelected(primaryModel: str, fallbackModel: str, fallbackCooling: bool): bool =
  openAiSelectModel(primaryModel, fallbackModel, false, fallbackCooling) == primaryModel
pure def openAiErrorRetryable(status: int, permanentQuota: bool, toolCallParseError: bool, idleTimeout: bool, retryOutlastsLane: bool, transientMessage: bool): bool =
  not(permanentQuota or toolCallParseError or idleTimeout or retryOutlastsLane) and
    (status == 408 or status == 409 or status == 429 or (status >= 500 and status < 600) or ((status == 0 or status == 400) and transientMessage))
pure def lawOpenAiTerminalClassesNeverRetry(status: int, transientMessage: bool): bool =
  not(openAiErrorRetryable(status, true, false, false, false, transientMessage)) and
    not(openAiErrorRetryable(status, false, true, false, false, transientMessage)) and
    not(openAiErrorRetryable(status, false, false, true, false, transientMessage)) and
    not(openAiErrorRetryable(status, false, false, false, true, transientMessage))
```

### Tools are sent strict only when every tool in the request is strict

OpenAI applies strict structured outputs per request, so a tool is sent with
`strict: true` only when every tool in that request is strict and wire-strict
(every object closed, every property required); otherwise no tool carries
`strict`.

```quint
pure def sendStrict(toolCount: int, strictCount: int): bool = toolCount > 0 and strictCount == toolCount
pure def lawMixedBatchSendsNoStrict(toolCount: int, strictCount: int): bool =
  strictCount < toolCount implies not(sendStrict(toolCount, strictCount))
pure val toolCountValues = Set(0, 1, 3)
pure val strictCountValues = Set(0, 1, 3)
```

### Reported usage carries the cached prompt tokens the provider reports

A response's usage reports prompt, completion and total tokens, and, when the
provider reports `prompt_tokens_details.cached_tokens`, the cached prompt
tokens as cache reads; a provider that reports no details adds no cache field.

```quint
pure def reportedCacheRead(reported: bool, cached: int): int = if (reported) cached else -1
pure def lawUnreportedCacheIsAbsent(cached: int): bool = reportedCacheRead(false, cached) == -1
pure def lawReportedCacheIsKept(cached: int): bool = cached >= 0 implies reportedCacheRead(true, cached) == cached
pure val cachedValues = Set(0, 896, 1920)
```
