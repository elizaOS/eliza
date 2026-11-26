# Workflow budgets, context compaction and model routing

A workflow run enforces token, model-call and cost ceilings, bounds step context
so multi-step chains do not grow quadratically, schedules independent DAG steps
in parallel waves without crossing approval or control barriers, and routes fast
evaluations and short drafts to the fast model tier. [Execution](./execution.md)
owns the worker slot and wakeups; [generated code](./generated.md) owns the
replay journal.

## Story: Bound workflow tokens, model calls and cost across multi-step runs

> As the owner, I want every workflow run to stay within explicit token,
> model-call and cost ceilings so a multi-step or looped workflow never runs
> away with my budget.

### Every model call is admitted only within remaining run and step ceilings

A run starts with default ceilings of 100,000 tokens, 16,000 tokens per step,
32 model calls and 5,000,000 micro-units of cost, and may be configured before
any model call runs. Each admitted model call accounts for its tokens, increments
the call count by one and records its cost. A call's tokens are its estimated
prompt tokens plus the output bound it is sent with as its maximum: the smaller
of 4,096 tokens and what remains under the step and run token ceilings, so the
ceilings bound everything a run can spend; a call with no output room left is
not admitted. Reaching any ceiling exhausts the
budget so no further model call is admitted. A call exceeding any remaining
ceiling exhausts the budget without admitting the call. Halting a budget is
permanent.

```quint
type BudgetPhase = BudgetOpen | BudgetExhausted | BudgetHalted
type RunBudget = {
  phase: BudgetPhase,
  maxRunTokens: int,
  maxStepTokens: int,
  maxModelCalls: int,
  maxCostMicros: int,
  tokensUsed: int,
  modelCallsUsed: int,
  costMicrosUsed: int
}
pure val defaultMaxRunTokens: int = 100000
pure val defaultMaxStepTokens: int = 16000
pure val defaultMaxModelCalls: int = 32
pure val defaultMaxCostMicros: int = 5000000
pure val draftOutputTokens: int = 4096
pure def draftOutputBound(b: RunBudget, promptTokens: int): int =
  val stepRoom = b.maxStepTokens - promptTokens
  val runRoom = b.maxRunTokens - b.tokensUsed - promptTokens
  val room = if (stepRoom < runRoom) stepRoom else runRoom
  if (draftOutputTokens < room) draftOutputTokens else room
pure def lawDraftOutputBoundFitsCeilings(b: RunBudget, promptTokens: int): bool =
  (promptTokens >= 0 and draftOutputBound(b, promptTokens) >= 1) implies
    (promptTokens + draftOutputBound(b, promptTokens) <= b.maxStepTokens and b.tokensUsed + promptTokens + draftOutputBound(b, promptTokens) <= b.maxRunTokens)
pure val promptTokensValues = Set(0, 10, 4000, 16000, 20000)
pure val initial: RunBudget = {
  phase: BudgetOpen,
  maxRunTokens: defaultMaxRunTokens,
  maxStepTokens: defaultMaxStepTokens,
  maxModelCalls: defaultMaxModelCalls,
  maxCostMicros: defaultMaxCostMicros,
  tokensUsed: 0,
  modelCallsUsed: 0,
  costMicrosUsed: 0
}
pure def canConfigureBudget(b: RunBudget, maxRunTokens: int, maxStepTokens: int, maxModelCalls: int, maxCostMicros: int): bool =
  b.phase == BudgetOpen and b.tokensUsed == 0 and b.modelCallsUsed == 0 and b.costMicrosUsed == 0 and
    maxRunTokens >= 1 and maxStepTokens >= 1 and maxStepTokens <= maxRunTokens and maxModelCalls >= 1 and maxCostMicros >= 1
pure def configureBudget(b: RunBudget, maxRunTokens: int, maxStepTokens: int, maxModelCalls: int, maxCostMicros: int): RunBudget = {
  ...b, maxRunTokens: maxRunTokens, maxStepTokens: maxStepTokens, maxModelCalls: maxModelCalls, maxCostMicros: maxCostMicros
}
pure def withinBudget(b: RunBudget, tokens: int, costMicros: int): bool =
  tokens >= 0 and costMicros >= 0 and tokens <= b.maxStepTokens and
    b.tokensUsed + tokens <= b.maxRunTokens and
    b.modelCallsUsed + 1 <= b.maxModelCalls and
    b.costMicrosUsed + costMicros <= b.maxCostMicros
pure def canAdmitModelCall(b: RunBudget, tokens: int, costMicros: int): bool =
  b.phase == BudgetOpen and withinBudget(b, tokens, costMicros)
pure def admitModelCall(b: RunBudget, tokens: int, costMicros: int): RunBudget = {
  val nextTokens = b.tokensUsed + tokens
  val nextCalls = b.modelCallsUsed + 1
  val nextCost = b.costMicrosUsed + costMicros
  val exhausted = nextTokens == b.maxRunTokens or nextCalls == b.maxModelCalls or nextCost == b.maxCostMicros
  { ...b, phase: if (exhausted) BudgetExhausted else BudgetOpen, tokensUsed: nextTokens, modelCallsUsed: nextCalls, costMicrosUsed: nextCost }
}
pure def canRefuseOverBudget(b: RunBudget, tokens: int, costMicros: int): bool =
  b.phase == BudgetOpen and tokens >= 0 and costMicros >= 0 and not(withinBudget(b, tokens, costMicros))
pure def refuseOverBudget(b: RunBudget, tokens: int, costMicros: int): RunBudget = { ...b, phase: BudgetExhausted }
pure def canHaltBudget(b: RunBudget): bool = b.phase != BudgetHalted
pure def haltBudget(b: RunBudget): RunBudget = { ...b, phase: BudgetHalted }
pure val maxRunTokensValues = Set(0, 10, 100)
pure val maxStepTokensValues = Set(0, 10, 50)
pure val maxModelCallsValues = Set(0, 1, 3)
pure val maxCostMicrosValues = Set(0, 10, 100)
pure val tokensValues = Set(0, 5, 10, 20000)
pure val costMicrosValues = Set(0, 5, 10, 6000000)
pure def alwaysBudgetBounds(b: RunBudget): bool =
  b.maxRunTokens >= 1 and b.maxStepTokens >= 1 and b.maxStepTokens <= b.maxRunTokens and
    b.maxModelCalls >= 1 and b.maxCostMicros >= 1 and
    b.tokensUsed >= 0 and b.tokensUsed <= b.maxRunTokens and
    b.modelCallsUsed >= 0 and b.modelCallsUsed <= b.maxModelCalls and
    b.costMicrosUsed >= 0 and b.costMicrosUsed <= b.maxCostMicros
pure def alwaysOpenHasRemainingCapacity(b: RunBudget): bool =
  b.phase == BudgetOpen implies (b.tokensUsed < b.maxRunTokens and b.modelCallsUsed < b.maxModelCalls and b.costMicrosUsed < b.maxCostMicros)
pure def stepBudgetMonotonic(before: RunBudget, after: RunBudget): bool =
  after.tokensUsed >= before.tokensUsed and after.modelCallsUsed >= before.modelCallsUsed and after.costMicrosUsed >= before.costMicrosUsed
pure def stepHaltedStaysHalted(before: RunBudget, after: RunBudget): bool =
  before.phase == BudgetHalted implies after.phase == BudgetHalted
pure def sometimesModelCallAdmitted(b: RunBudget): bool = b.modelCallsUsed > 0 and b.phase == BudgetOpen
pure def sometimesBudgetExhausted(b: RunBudget): bool = b.phase == BudgetExhausted
pure def sometimesBudgetHalted(b: RunBudget): bool = b.phase == BudgetHalted
```

## Story: Compact step context, batch independent DAG steps and route fast evaluations

> As the owner, I want multi-step workflows to compact oversized step outputs,
> execute independent steps in parallel waves without crossing approval barriers,
> and route fast evaluations and short drafts to the fast model tier.

### Step context compaction bounds every prompt input to the configured window

When a prior step output fits within the context window, it is passed through
unchanged. When it exceeds the window, compaction preserves a bounded head and
tail so the prompt input never exceeds the window, preventing quadratic context
growth across multi-step workflows.

```quint
pure val defaultContextWindowChars: int = 12000
pure def compactedLength(inputChars: int, windowChars: int): int =
  if (windowChars <= 0 or inputChars <= 0) 0 else if (inputChars <= windowChars) inputChars else windowChars
pure val inputCharsValues = Set(0, 500, 2000, 12000, 65536)
pure val windowCharsValues = Set(0, 512, 12000)
pure def lawCompactionNeverExceedsWindow(inputChars: int, windowChars: int): bool =
  windowChars >= 0 implies compactedLength(inputChars, windowChars) <= windowChars
pure def lawShortOutputStaysWhole(inputChars: int, windowChars: int): bool =
  (inputChars >= 0 and inputChars <= windowChars) implies compactedLength(inputChars, windowChars) == inputChars
```

### Parallel DAG waves batch only ready non-barrier steps

An execution wave includes a step only when all of its predecessor steps have
completed, the step is not already done, and it is neither a device approval
barrier nor a conditional control-flow barrier.

```quint
pure def waveAdmitsStep(depsReady: bool, alreadyDone: bool, approvalBarrier: bool, controlBarrier: bool): bool =
  depsReady and not(alreadyDone) and not(approvalBarrier) and not(controlBarrier)
pure def lawApprovalBarrierStopsBatching(depsReady: bool, alreadyDone: bool, controlBarrier: bool): bool =
  not(waveAdmitsStep(depsReady, alreadyDone, true, controlBarrier))
pure def lawUnsatisfiedDependencyNeverBatches(alreadyDone: bool, approvalBarrier: bool, controlBarrier: bool): bool =
  not(waveAdmitsStep(false, alreadyDone, approvalBarrier, controlBarrier))
```

### Fast evaluations and short step drafts route to the fast model tier

Code synthesis always uses the large model tier. Fast evaluation scoring,
compaction summaries, and short step drafts up to 2,000 characters route to the
fast model tier for low-latency Cerebras-compatible execution; larger step drafts
use the large model tier.

```quint
type ModelTier = FastEvalTier | LargeDraftTier
type CallPurpose = DraftWorkflowCode | ModelDraftStep | FastEvaluation | CompactSummary
pure val fastDraftThresholdChars: int = 2000
pure def routeModelTier(purpose: CallPurpose, inputChars: int): ModelTier =
  match purpose {
    | DraftWorkflowCode => LargeDraftTier
    | FastEvaluation => FastEvalTier
    | CompactSummary => FastEvalTier
    | ModelDraftStep => if (inputChars <= fastDraftThresholdChars) FastEvalTier else LargeDraftTier
  }
pure def lawCodeSynthesisUsesLargeTier(inputChars: int): bool =
  routeModelTier(DraftWorkflowCode, inputChars) == LargeDraftTier
pure def lawFastEvalUsesFastTier(inputChars: int): bool =
  routeModelTier(FastEvaluation, inputChars) == FastEvalTier
pure def lawShortDraftUsesFastTier(inputChars: int): bool =
  inputChars <= fastDraftThresholdChars implies routeModelTier(ModelDraftStep, inputChars) == FastEvalTier
```
