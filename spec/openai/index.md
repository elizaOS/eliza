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
dispatch boundary.

```quint
type OpenAiOperation = TextNano | TextSmall | TextMedium | TextLarge | TextMega | ResponseHandler | ActionPlanner | EmbedText | EncodeTokens | DecodeTokens | CreateImage | DescribeImage | TranscribeAudio | SpeakText | RunResearch
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
```

### An attempt can change upstream only before publishing any output

Provider parsing, a bounded timeout, and response-schema normalization
are shell responsibilities. Report a first visible text or tool event as
progress before exposing it. Before this boundary a retryable failure may
select one eligible fallback. An output-size failure, invalid response
shape, provider terminal rejection, or failure after visible progress
cannot be turned into success by concatenating responses from different
attempts. A caller's abort ends the request.

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
pure val primaryValues = Set({ address: "primary", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true })
pure val fallbackValues = Set({ address: "", modelId: "", acceptsOperation: false, acceptsSchema: false, confidential: false }, { address: "backup", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true })
pure def sometimesOpenAiFallbackFinishes(s: OpenAiRun): bool = s.phase == CompleteOpenAi and s.attempt == FallbackOpenAi
pure val eval_witness_sometimesOpenAiFallbackFinishes = (("beginOpenAi", { address: "primary", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true }, { address: "backup", modelId: "text", acceptsOperation: true, acceptsSchema: true, confidential: true }, true, true), ("failOpenAi", PrimaryOpenAi, RetryableOpenAi), ("acceptOpenAi", FallbackOpenAi, true, true))
```

### Tokenizer cache keys distinguish concrete model encodings

Cache only the tokenizer selected for the resolved encoding. An
unrecognized model uses the fallback encoding selected by the shell.
Failed initialization leaves the cache empty for that encoding and can be
retried. Cache population has no effect on the input or output token IDs.

```quint
pure def openAiTokenizerKey(resolvedEncoding: str, fallbackEncoding: str): str =
  if (resolvedEncoding == "") fallbackEncoding else resolvedEncoding
pure def lawKnownTokenizerKeepsEncoding(resolvedEncoding: str, fallbackEncoding: str): bool =
  resolvedEncoding != "" implies openAiTokenizerKey(resolvedEncoding, fallbackEncoding) == resolvedEncoding
```

### A cooling route does not resend before the provider's reset

Cooldown keys bind endpoint, credential slot, and concrete model.
A different eligible concrete model can be selected while the primary
cools down. Server refill times are passed as observations, independent
of retry scheduling. The shell keeps short transient retries within one
shared caller budget and does not retry after cancellation.

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
