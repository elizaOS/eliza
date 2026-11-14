# Embedding write settlement

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are the embedding generation service, `packages/core/src/runtime/embeddings.ts`, `types/database.ts` and `quint/EmbeddingWriteSettlement.qnt`. The storage adapter compares the exact agent, entity, room and original text before updating its embedding. The model's source revision abstracts that exact tuple. Logging and notification failures follow the storage receipt and cannot reopen committed work.

## Story: Finish embedding work against its exact source

As an agent, I retry an unsuccessful inference or storage attempt within its explicit retry policy. A stored or stale receipt settles the attempt. Only stored vectors emit completion notification. Updating a source while inference runs makes its old result stale.

### An attempt captures its source before inference

```quint
type WritePhase = Idle | Inference | Writing | Retry | Logging | Notifying | Done | Exhausted
type WriteReceipt = NoReceipt | Stored | Stale
type EmbeddingWrite = { phase: WritePhase, sourceRevision: int, capturedRevision: int, attempts: int, maxAttempts: int, receipt: WriteReceipt, attemptsAtReceipt: int, sourceAtReceipt: int, notified: bool, logFailed: bool }
pure val initial: EmbeddingWrite = { phase: Idle, sourceRevision: 0, capturedRevision: 0, attempts: 0, maxAttempts: 0, receipt: NoReceipt, attemptsAtReceipt: 0, sourceAtReceipt: 0, notified: false, logFailed: false }
pure def canSubmit(s: EmbeddingWrite, maxAttempts: int): bool = s.phase == Idle and maxAttempts > 0
pure def submit(s: EmbeddingWrite, maxAttempts: int): EmbeddingWrite = { ...s, phase: Inference, capturedRevision: s.sourceRevision, attempts: 1, maxAttempts: maxAttempts }
pure val maxAttemptsValues = Set(1, 2, 4)
pure def editSource(s: EmbeddingWrite): EmbeddingWrite = { ...s, sourceRevision: s.sourceRevision + 1 }
pure def canInferenceResult(s: EmbeddingWrite, succeeded: bool): bool = s.phase == Inference
pure def inferenceResult(s: EmbeddingWrite, succeeded: bool): EmbeddingWrite = { ...s, phase: if (succeeded) Writing else if (s.attempts < s.maxAttempts) Retry else Exhausted }
pure def canRetry(s: EmbeddingWrite): bool = s.phase == Retry and s.attempts < s.maxAttempts and s.receipt == NoReceipt
pure def retry(s: EmbeddingWrite): EmbeddingWrite = { ...s, phase: Inference, attempts: s.attempts + 1 }
```

### A confirmed storage receipt closes retry ownership

```quint
pure def canWriteResult(s: EmbeddingWrite, acknowledged: bool): bool = s.phase == Writing
pure def writeResult(s: EmbeddingWrite, acknowledged: bool): EmbeddingWrite =
  if (acknowledged) { ...s, phase: Logging, receipt: if (s.sourceRevision == s.capturedRevision) Stored else Stale, attemptsAtReceipt: s.attempts, sourceAtReceipt: s.sourceRevision }
  else { ...s, phase: if (s.attempts < s.maxAttempts) Retry else Exhausted }
pure def canLogResult(s: EmbeddingWrite, succeeded: bool): bool = s.phase == Logging
pure def logResult(s: EmbeddingWrite, succeeded: bool): EmbeddingWrite = { ...s, phase: if (s.receipt == Stored) Notifying else Done, logFailed: not(succeeded) }
pure def canNotifyResult(s: EmbeddingWrite, succeeded: bool): bool = s.phase == Notifying
pure def notifyResult(s: EmbeddingWrite, succeeded: bool): EmbeddingWrite = { ...s, phase: Done, notified: succeeded }
pure def alwaysReceiptMatchesExactSource(s: EmbeddingWrite): bool = s.receipt == NoReceipt or ((s.receipt == Stored) == (s.sourceAtReceipt == s.capturedRevision))
pure def alwaysReceiptClosesRetries(s: EmbeddingWrite): bool = s.receipt == NoReceipt or (s.attempts == s.attemptsAtReceipt and (s.phase == Logging or s.phase == Notifying or s.phase == Done))
pure def alwaysOnlyStoredNotifies(s: EmbeddingWrite): bool = (s.phase == Notifying or s.notified) implies s.receipt == Stored
pure def alwaysAttemptsRespectPolicy(s: EmbeddingWrite): bool = s.attempts >= 0 and s.attempts <= s.maxAttempts
pure def sometimesStaleSourceSettles(s: EmbeddingWrite): bool = s.phase == Done and s.receipt == Stale
pure def sometimesStoredDespiteLogFailure(s: EmbeddingWrite): bool = s.phase == Done and s.receipt == Stored and s.logFailed
pure val fair_inferenceResult = "weak"
pure val fair_writeResult = "weak"
pure val fair_retry = "weak"
pure val fair_logResult = "weak"
pure val fair_notifyResult = "weak"
pure def leadsToAttemptSettles(s: EmbeddingWrite, later: EmbeddingWrite): bool = s.phase != Idle implies (later.phase == Done or later.phase == Exhausted)
```
