# Bounded-concurrency batch processing

Every per-item attempt releases its permit before retry delay or exhaustion callback. Source [batch-queue.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/utils/batch-queue.ts). The configured retry budget and explicit per-item attempt override determine admission; payload fields named maxRetries have no special meaning.

## Story: Process every batch item with independent outcomes

As a caller I receive outcomes in submitted order while retries and failures remain isolated per item.

### Configured parallelism limits running attempts across all batches

Each item has a fixed total-attempt budget. Per-item override and optional shutdown cap are resolved before processing starts.

Discovered by the proof: construction precedes every submitted invocation,
and resolved concurrency and attempt counts are positive integers. An
unconfigured processor has no items. Otherwise a fabricated unconfigured
processor could retain running work while construction shrinks its permit
count, or a fabricated configured processor could submit a zero-attempt
item. The numeric codec supplies these resolved integer observations;
this projection does not claim raw JavaScript-number normalization.

Item and batch IDs identify invocation occurrences. Equal payload values
remain separate invocations. IDs are positive and an item ID occurs once,
so selecting one item cannot mutate a completed sibling with the same ID.

```quint
type ItemPhase = ItemWaiting | ItemRunning | ItemBackoff | ItemExhausting | ItemSucceeded | ItemFailed
type ProcessorItem = { id: int, batch: int, payload: str, phase: ItemPhase, attempts: int, retryCount: int, maxAttempts: int, exhaustedCallbackFailed: bool }
type Processor = { configured: bool, maxParallel: int, defaultAttempts: int, maxCap: int, hasCap: bool, items: List[ProcessorItem] }
pure val initial: Processor = { configured: false, maxParallel: 0, defaultAttempts: 1, maxCap: 1, hasCap: false, items: List() }
pure val maxParallelValues = Set(1, 2)
pure val defaultAttemptsValues = Set(1, 3)
pure val maxCapValues = Set(1, 2)
pure val itemIdValues = Set(1, 2, 3)
pure val batchIdValues = Set(1, 2)
pure val perItemAttemptsValues = Set(0, 1, 3)
pure val payloadValues = Set("one", "two")
pure def canConfigureProcessor(s: Processor, maxParallel: int, defaultAttempts: int, maxCap: int, hasCap: bool): bool = not(s.configured) and maxParallel > 0 and defaultAttempts > 0 and maxCap > 0
pure def configureProcessor(s: Processor, maxParallel: int, defaultAttempts: int, maxCap: int, hasCap: bool): Processor = { ...s, configured: true, maxParallel: maxParallel, defaultAttempts: defaultAttempts, maxCap: maxCap, hasCap: hasCap }
pure def attemptBudget(s: Processor, perItemAttempts: int): int = {
  val chosen = if (perItemAttempts >= 1) perItemAttempts else s.defaultAttempts
  if (s.hasCap and chosen > s.maxCap) s.maxCap else chosen
}
pure def canSubmitItem(s: Processor, itemId: int, batchId: int, payload: str, perItemAttempts: int): bool = s.configured and itemId > 0 and batchId > 0 and not(s.items.some(j => j.id == itemId))
pure def submitItem(s: Processor, itemId: int, batchId: int, payload: str, perItemAttempts: int): Processor = { ...s, items: s.items.append({id: itemId, batch: batchId, payload: payload, phase: ItemWaiting, attempts: 0, retryCount: 0, maxAttempts: attemptBudget(s, perItemAttempts), exhaustedCallbackFailed: false}) }
pure def canStartItem(s: Processor, itemId: int): bool = s.items.select(j => j.phase == ItemRunning).length() < s.maxParallel and s.items.some(j => j.id == itemId and j.phase == ItemWaiting and j.attempts < j.maxAttempts)
pure def startItem(s: Processor, itemId: int): Processor = { ...s, items: s.items.listMap(j => if (j.id == itemId) { ...j, phase: ItemRunning, attempts: j.attempts + 1 } else j) }
pure def alwaysProcessorConcurrency(s: Processor): bool = s.items.select(j => j.phase == ItemRunning).length() <= s.maxParallel
pure def alwaysAttemptBudgets(s: Processor): bool = s.items.every(j => j.attempts >= 0 and j.attempts <= j.maxAttempts and j.maxAttempts > 0 and j.retryCount >= 0 and j.retryCount <= j.attempts)
pure def alwaysProcessorConstruction(s: Processor): bool =
  (not(s.configured) implies s.items.length() == 0) and
  (s.configured implies s.maxParallel > 0 and s.defaultAttempts > 0 and s.maxCap > 0)
pure def alwaysProcessorInvocationIds(s: Processor): bool =
  s.items.every(j => j.id > 0 and j.batch > 0 and s.items.select(other => other.id == j.id).length() == 1)
pure def alwaysRunningAttemptOwnsRetryHistory(s: Processor): bool =
  s.items.every(j => j.phase == ItemRunning implies j.retryCount < j.attempts)
pure def sometimesBatchItemsRunTogether(s: Processor): bool = s.items.select(j => j.phase == ItemRunning).length() > 1
```

### Failure releases capacity before backoff and exhaustion callbacks

Retry refusal or exhausted budget produces a failed item. Exhaustion callback failure cannot change an already failed result or replay successful siblings.

Discovered by the proof: a running attempt has already started, while its
retry counter counts only earlier failed attempts. Thus that counter is
strictly smaller than the current attempt count. Without this fact a
fabricated attempt zero could succeed, or a failed running attempt could
increment its retry counter beyond its attempt count. A holder composes
the processor's complete `wellFormed` contract, including those domain
facts, rather than a selected pair of its rules.

```quint
pure def canFinishItemAttempt(s: Processor, itemId: int, ok: bool, retry: bool): bool = s.items.some(j => j.id == itemId and j.phase == ItemRunning)
pure def finishItemAttempt(s: Processor, itemId: int, ok: bool, retry: bool): Processor = { ...s, items: s.items.listMap(j => if (j.id != itemId) j else { ...j, phase: if (ok) ItemSucceeded else if (retry and j.attempts < j.maxAttempts) ItemBackoff else ItemExhausting, retryCount: j.retryCount + (if (not(ok) and retry and j.attempts < j.maxAttempts) 1 else 0) }) }
pure def canFinishBackoff(s: Processor, itemId: int): bool = s.items.some(j => j.id == itemId and j.phase == ItemBackoff)
pure def finishBackoff(s: Processor, itemId: int): Processor = { ...s, items: s.items.listMap(j => if (j.id == itemId) { ...j, phase: ItemWaiting } else j) }
pure def canFinishExhaustion(s: Processor, itemId: int, callbackOk: bool): bool = s.items.some(j => j.id == itemId and j.phase == ItemExhausting)
pure def finishExhaustion(s: Processor, itemId: int, callbackOk: bool): Processor = { ...s, items: s.items.listMap(j => if (j.id == itemId) { ...j, phase: ItemFailed, exhaustedCallbackFailed: not(callbackOk) } else j) }
pure def batchOutcomes(s: Processor, batchId: int): List[ProcessorItem] = s.items.select(j => j.batch == batchId)
pure def alwaysSuccessHasAttempt(s: Processor): bool = s.items.every(j => j.phase == ItemSucceeded implies j.attempts > 0)
pure def wellFormed(s: Processor): bool =
  alwaysProcessorConcurrency(s) and alwaysAttemptBudgets(s) and alwaysSuccessHasAttempt(s) and
  alwaysProcessorConstruction(s) and alwaysProcessorInvocationIds(s) and alwaysRunningAttemptOwnsRetryHistory(s)
pure def stepCompletedItemsAreStable(before: Processor, after: Processor): bool = before.items.every(j => (j.phase == ItemSucceeded or j.phase == ItemFailed) implies after.items.some(other => other == j))
pure def sometimesExhaustionCallbackFailsSafely(s: Processor): bool = s.items.some(j => j.phase == ItemFailed and j.exhaustedCallbackFailed)
pure val fair_startItem = "strong"
pure val fair_finishItemAttempt = "strong"
pure val fair_finishBackoff = "strong"
pure val fair_finishExhaustion = "strong"
pure def leadsToItemsSettled(s: Processor, later: Processor): bool = s.items.every(j => later.items.some(done => done.id == j.id and (done.phase == ItemSucceeded or done.phase == ItemFailed)))
```
