# Computer use action batching

## Story: Execute a bounded sequence of desktop actions in a single LLM turn

> As an agent, I can submit a bounded sequence of desktop actions (such as click, type, press Enter, wait, screenshot) in one call instead of burning one LLM round-trip per primitive action, stopping immediately on the first failed step when `stopOnError` is enabled.

### A batch tracks its step count, progress, error policy, and terminal state

Batches are strictly bounded by `maxSteps`, execute sequentially from step zero to `totalSteps`, and transition cleanly to `BatchCompleted` or `BatchAborted`.

```quint
type BatchStatus = BatchReady | BatchExecuting | BatchCompleted | BatchAborted

type BatchMachine = {
  status: BatchStatus,
  maxSteps: int,
  totalSteps: int,
  completedSteps: int,
  failedSteps: int,
  stopOnError: bool,
  abortedAtStep: int
}

pure val initial: BatchMachine = {
  status: BatchReady,
  maxSteps: 16,
  totalSteps: 0,
  completedSteps: 0,
  failedSteps: 0,
  stopOnError: true,
  abortedAtStep: -1
}

pure def canStartBatch(b: BatchMachine, stepCount: int, stopOnError: bool): bool =
  b.status == BatchReady and stepCount >= 1 and stepCount <= b.maxSteps

pure def startBatch(b: BatchMachine, stepCount: int, stopOnError: bool): BatchMachine = {
  ...b,
  status: BatchExecuting,
  totalSteps: stepCount,
  completedSteps: 0,
  failedSteps: 0,
  stopOnError: stopOnError,
  abortedAtStep: -1
}

pure def canAdvanceStep(b: BatchMachine, succeeded: bool): bool =
  b.status == BatchExecuting and b.completedSteps < b.totalSteps

pure def advanceStep(b: BatchMachine, succeeded: bool): BatchMachine = {
  val nextCompleted = b.completedSteps + 1
  val nextFailed = if (succeeded) b.failedSteps else b.failedSteps + 1
  if (not(succeeded) and b.stopOnError) {
    ...b,
    status: BatchAborted,
    completedSteps: nextCompleted,
    failedSteps: nextFailed,
    abortedAtStep: b.completedSteps
  } else if (nextCompleted == b.totalSteps) {
    ...b,
    status: BatchCompleted,
    completedSteps: nextCompleted,
    failedSteps: nextFailed
  } else {
    ...b,
    completedSteps: nextCompleted,
    failedSteps: nextFailed
  }
}

pure def canAbortBatch(b: BatchMachine): bool =
  b.status == BatchExecuting

pure def abortBatch(b: BatchMachine): BatchMachine = {
  ...b,
  status: BatchAborted,
  abortedAtStep: b.completedSteps
}

pure def canResetBatch(b: BatchMachine): bool =
  b.status == BatchCompleted or b.status == BatchAborted

pure def resetBatch(b: BatchMachine): BatchMachine = {
  ...b,
  status: BatchReady,
  totalSteps: 0,
  completedSteps: 0,
  failedSteps: 0,
  abortedAtStep: -1
}
```

### Batch invariants guarantee bounded execution, exact completion accounting, and clean stop-on-error halts

Completed and failed step counts never exceed `totalSteps`, a completed batch ran every step, and an aborted batch records the exact zero-based step index where execution halted.

```quint
pure def alwaysBatchCountsValid(b: BatchMachine): bool =
  b.maxSteps >= 1 and b.totalSteps >= 0 and b.totalSteps <= b.maxSteps and
  b.completedSteps >= 0 and b.completedSteps <= b.totalSteps and
  b.failedSteps >= 0 and b.failedSteps <= b.completedSteps

pure def alwaysReadyIsZeroed(b: BatchMachine): bool =
  b.status == BatchReady implies (b.totalSteps == 0 and b.completedSteps == 0 and b.failedSteps == 0 and b.abortedAtStep == -1)

pure def alwaysExecutingHasRemainingSteps(b: BatchMachine): bool =
  b.status == BatchExecuting implies (b.totalSteps >= 1 and b.completedSteps < b.totalSteps and b.abortedAtStep == -1)

pure def alwaysCompletedRanAllSteps(b: BatchMachine): bool =
  b.status == BatchCompleted implies (b.totalSteps >= 1 and b.completedSteps == b.totalSteps and b.abortedAtStep == -1)

pure def alwaysAbortedRecordsStep(b: BatchMachine): bool =
  b.status == BatchAborted implies (b.totalSteps >= 1 and b.abortedAtStep >= 0 and b.abortedAtStep < b.totalSteps)

pure def stepProgressWithinBatch(before: BatchMachine, after: BatchMachine): bool =
  (before.status == BatchExecuting and after.status != BatchReady) implies
    (after.totalSteps == before.totalSteps and after.completedSteps >= before.completedSteps)

pure def sometimesMultiStepBatchCompletes(b: BatchMachine): bool =
  b.status == BatchCompleted and b.totalSteps >= 3 and b.failedSteps == 0

pure def sometimesStopOnErrorAbortsEarly(b: BatchMachine): bool =
  b.status == BatchAborted and b.abortedAtStep == 1 and b.completedSteps < b.totalSteps

pure val stepCountValues = Set(0, 1, 3, 17)
pure val eval_witness_sometimesMultiStepBatchCompletes = (("startBatch", 3, true), ("advanceStep", true), ("advanceStep", true), ("advanceStep", true))
pure val eval_witness_sometimesStopOnErrorAbortsEarly = (("startBatch", 3, true), ("advanceStep", true), ("advanceStep", false))
```
