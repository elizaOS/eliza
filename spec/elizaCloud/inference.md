# Cloud inference routing

Eliza Cloud serves text, embedding, image, audio, video, speech, transcription,
and tokenization model handlers while letting the host disable Cloud chat-brain
slots without losing capability handlers. Outbound tool payloads enforce
batch-uniform wire strictness, warming retries never fire after output has
started, and credit balances classify cleanly by threshold.

## Story: Route Cloud inference with bounded retries and uniform wire tool schemas

> As the owner, I want Cloud inference to respect chat-brain arbitration,
> retry transient gateway warming only before output starts, send uniform
> wire strictness on tool calls, and surface accurate credit warnings.

### Chat-brain arbitration disables only chat slots while preserving capability handlers

When `ELIZAOS_CLOUD_USE_INFERENCE` is explicitly `"false"`, Cloud skips
chat-brain text slots so another provider owns them while keeping capability
handlers (embeddings, image, media, speech, transcription, tokenization)
registered.

```quint
pure def cloudSlotServedByCloud(useInferenceSetting: str, isChatSlot: bool): bool =
  if (isChatSlot and useInferenceSetting == "false") false else true
pure val useInferenceSettingValues: Set[str] = Set("", "true", "false")
pure def lawCapabilitySlotsAlwaysServed(useInferenceSetting: str): bool =
  cloudSlotServedByCloud(useInferenceSetting, false)
```

### Wire tool strictness is batch-uniform

An OpenAI-compatible or Cerebras endpoint rejects mixed `strict` flags across
tools in one request. Wire `strict: true` is emitted only when the request has
at least one tool and every tool in the batch satisfies all-required strict
schema rules.

```quint
pure def wireToolStrictMode(toolCount: int, allToolsStrict: bool): bool =
  toolCount > 0 and allToolsStrict
pure val toolCountValues: Set[int] = Set(0, 1, 4, 29)
pure def lawMixedToolsNeverEmitStrict(toolCount: int): bool =
  not(wireToolStrictMode(toolCount, false))
pure def lawEmptyToolsNeverEmitStrict(allToolsStrict: bool): bool =
  not(wireToolStrictMode(0, allToolsStrict))
```

### Credit severity classifies balance thresholds consistently

Balances below 50 cents are critical, balances from 50 to 199 cents are low,
and balances at or above 200 cents are healthy.

```quint
type CreditSeverity = CreditCritical | CreditLow | CreditHealthy
pure def creditSeverity(balanceCents: int): CreditSeverity =
  if (balanceCents < 50) CreditCritical
  else if (balanceCents < 200) CreditLow
  else CreditHealthy
pure val balanceCentsValues: Set[int] = Set(-10, 0, 49, 50, 199, 200, 1500)
pure def lawSubFiftyCentsIsCritical(balanceCents: int): bool =
  balanceCents < 50 implies creditSeverity(balanceCents) == CreditCritical
```

### Warming retries occur only before output is published and within the retry budget

A Cloud inference or media attempt may retry on transient gateway warming
(`service_unavailable`) only before any output piece has been published and
strictly below its retry budget. Once output is published or the attempt
completes or fails, no further warming retry is allowed.

```quint
type AttemptPhase = AttemptIdle | AttemptRunning | AttemptCompleted | AttemptFailed
type InferenceAttempt = {
  phase: AttemptPhase,
  retries: int,
  maxRetries: int,
  outputPublished: bool
}
pure val initial: InferenceAttempt = {
  phase: AttemptIdle,
  retries: 0,
  maxRetries: 2,
  outputPublished: false
}
pure def mayRetryWarming(attemptsUsed: int, maxAttempts: int, serviceUnavailable: bool, publishedOutput: bool): bool =
  serviceUnavailable and not(publishedOutput) and attemptsUsed >= 0 and attemptsUsed < maxAttempts
pure val attemptsUsedValues: Set[int] = Set(0, 1, 2, 3)
pure val maxAttemptsValues: Set[int] = Set(0, 1, 2, 3)
pure def lawPublishedOutputNeverRetries(attemptsUsed: int, maxAttempts: int, serviceUnavailable: bool): bool =
  not(mayRetryWarming(attemptsUsed, maxAttempts, serviceUnavailable, true))
pure def canStartAttempt(s: InferenceAttempt, maxRetries: int): bool =
  s.phase == AttemptIdle and maxRetries >= 0 and maxRetries <= 3
pure def startAttempt(s: InferenceAttempt, maxRetries: int): InferenceAttempt =
  { phase: AttemptRunning, retries: 0, maxRetries: maxRetries, outputPublished: false }
pure def canRetryAttemptWarming(s: InferenceAttempt): bool =
  s.phase == AttemptRunning and mayRetryWarming(s.retries, s.maxRetries, true, s.outputPublished)
pure def retryAttemptWarming(s: InferenceAttempt): InferenceAttempt =
  { ...s, retries: s.retries + 1 }
pure def canPublishOutput(s: InferenceAttempt): bool =
  s.phase == AttemptRunning
pure def publishOutput(s: InferenceAttempt): InferenceAttempt =
  { ...s, outputPublished: true }
pure def canCompleteAttempt(s: InferenceAttempt): bool =
  s.phase == AttemptRunning
pure def completeAttempt(s: InferenceAttempt): InferenceAttempt =
  { ...s, phase: AttemptCompleted }
pure def canFailAttempt(s: InferenceAttempt): bool =
  s.phase == AttemptRunning
pure def failAttempt(s: InferenceAttempt): InferenceAttempt =
  { ...s, phase: AttemptFailed }
pure def alwaysRetriesWithinBudget(s: InferenceAttempt): bool =
  s.retries >= 0 and s.retries <= s.maxRetries
pure def stepPublishedOutputIsSticky(before: InferenceAttempt, after: InferenceAttempt): bool =
  (before.phase == AttemptRunning and before.outputPublished) implies after.outputPublished
pure def sometimesCompletedAfterWarmingRetry(s: InferenceAttempt): bool =
  s.phase == AttemptCompleted and s.retries > 0 and s.outputPublished
pure val eval_witness_sometimesCompletedAfterWarmingRetry = (
  ("startAttempt", 2),
  ("retryAttemptWarming"),
  ("publishOutput"),
  ("completeAttempt")
)
pure val maxRetriesValues: Set[int] = Set(0, 1, 2, 3)
```
