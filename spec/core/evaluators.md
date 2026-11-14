# Evaluator processing contracts

Core defines the evaluator contract and registry. The host composes the runner. The current interface uses shouldRun, prepare, resolveOutput, prompt, parse and ordered processors. Sources include [evaluator.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/types/evaluator.ts), [runtime.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime.ts) and [response-handler-evaluators.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/response-handler-evaluators.ts).

## Story: Evaluate complete source-bound evidence

As an evaluator author I process explicitly scoped complete input and preserve the source revision through background inference.

### Each evaluator owns a separately gated processing lane

Processor count is the declared processor list length. One lane failing does not change sibling lanes.

```quint
type EvaluatorPhase = Registered | GatePending | PreparePending | Prepared | InferPending | Parsed | Processing | Succeeded | Skipped | EvaluationFailed
type InputScope = CompleteTurn | CurrentMessage
type OutputSource = ModelOutput | StagedOutput | ResolvedOutput
type EvaluationLane = { name: str, phase: EvaluatorPhase, scope: InputScope, incremental: bool, background: bool, requiredProcessors: int, completedProcessors: int, capturedRevision: int, inputBytes: str, leaseHeld: bool, outputReady: bool, outputSource: OutputSource, receiptIds: Set[str], progressRevision: int, errors: int }
type Evaluators = { lanes: List[EvaluationLane], sourceRevision: int, completeTurnBytes: str, currentMessageBytes: str }
pure val initial: Evaluators = { lanes: List(), sourceRevision: 0, completeTurnBytes: "", currentMessageBytes: "" }
pure val nameValues = Set("facts", "relationships")
pure val processorsValues = Set(0, 1, 2)
pure val bytesValues = Set("complete first source", "complete second source")
pure val receiptIdValues = Set("effect-a", "effect-b")
pure val noLane: EvaluationLane = { name: "", phase: Registered, scope: CompleteTurn, incremental: false, background: false, requiredProcessors: 0, completedProcessors: 0, capturedRevision: 0, inputBytes: "", leaseHeld: false, outputReady: false, outputSource: ModelOutput, receiptIds: Set(), progressRevision: -1, errors: 0 }
pure def lane(s: Evaluators, name: str): EvaluationLane = s.lanes.select(e => e.name == name).nthOr(0, noLane)
pure def replaceLane(name: str, updated: EvaluationLane, s: Evaluators): Evaluators = { ...s, lanes: s.lanes.listMap(e => if (e.name == name) updated else e) }
pure def canRegisterEvaluator(s: Evaluators, name: str, scope: InputScope, incremental: bool, background: bool, processors: int): bool = name != "" and processors >= 0 and not(s.lanes.some(e => e.name == name))
pure def registerEvaluator(s: Evaluators, name: str, scope: InputScope, incremental: bool, background: bool, processors: int): Evaluators = { ...s, lanes: s.lanes.append({ ...noLane, name: name, scope: scope, incremental: incremental, background: background, requiredProcessors: processors }) }
pure def canUpdateSources(s: Evaluators, bytes: str, currentBytes: str): bool = s.lanes.every(e => not(e.leaseHeld))
pure def updateSources(s: Evaluators, bytes: str, currentBytes: str): Evaluators = { ...s, sourceRevision: s.sourceRevision + 1, completeTurnBytes: bytes, currentMessageBytes: currentBytes }
pure def canBeginEvaluator(s: Evaluators, name: str): bool = lane(s, name).name != "" and lane(s, name).phase == Registered and s.lanes.every(e => not(e.leaseHeld))
pure def beginEvaluator(s: Evaluators, name: str): Evaluators = replaceLane(name, { ...lane(s, name), phase: GatePending, leaseHeld: true }, s)
pure def canFinishGate(s: Evaluators, name: str, shouldRun: bool): bool = lane(s, name).phase == GatePending
pure def finishGate(s: Evaluators, name: str, shouldRun: bool): Evaluators = replaceLane(name, { ...lane(s, name), phase: if (shouldRun) PreparePending else Skipped, leaseHeld: shouldRun }, s)
pure def canFinishPrepare(s: Evaluators, name: str): bool = lane(s, name).phase == PreparePending and lane(s, name).leaseHeld
pure def finishPrepare(s: Evaluators, name: str): Evaluators = replaceLane(name, { ...lane(s, name), phase: Prepared, capturedRevision: s.sourceRevision, inputBytes: if (lane(s, name).scope == CurrentMessage) s.currentMessageBytes else s.completeTurnBytes }, s)
pure def alwaysEvaluatorNamesUnique(s: Evaluators): bool = s.lanes.every(e => s.lanes.select(other => other.name == e.name).length() == 1)
pure def alwaysAtMostOneRoomLease(s: Evaluators): bool = s.lanes.select(e => e.leaseHeld).length() <= 1
pure def alwaysProcessorProgressBounded(s: Evaluators): bool = s.lanes.every(e => e.completedProcessors >= 0 and e.completedProcessors <= e.requiredProcessors)
pure def sometimesEvaluatorSkipped(s: Evaluators): bool = s.lanes.some(e => e.phase == Skipped)
```

### Background output is revalidated under a new room lease

Stored staged output takes precedence over a local resolver and model output. A stale source revision cannot reach a processor.

```quint
pure def canBeginInference(s: Evaluators, name: str): bool = lane(s, name).phase == Prepared
pure def beginInference(s: Evaluators, name: str): Evaluators = replaceLane(name, { ...lane(s, name), phase: InferPending, leaseHeld: not(lane(s, name).background) }, s)
pure def canAdmitOutput(s: Evaluators, name: str, staged: bool, resolved: bool): bool = lane(s, name).phase == InferPending and lane(s, name).capturedRevision == s.sourceRevision and s.lanes.every(e => e.name == name or not(e.leaseHeld))
pure def admitOutput(s: Evaluators, name: str, staged: bool, resolved: bool): Evaluators = replaceLane(name, { ...lane(s, name), phase: Parsed, outputReady: true, leaseHeld: true, outputSource: if (staged) StagedOutput else if (resolved) ResolvedOutput else ModelOutput }, s)
pure def canDiscardStaleOutput(s: Evaluators, name: str): bool = lane(s, name).phase == InferPending and lane(s, name).capturedRevision != s.sourceRevision
pure def discardStaleOutput(s: Evaluators, name: str): Evaluators = replaceLane(name, { ...lane(s, name), phase: Registered, leaseHeld: false, outputReady: false }, s)
pure def alwaysAppliedOutputUsesCurrentSources(s: Evaluators): bool = s.lanes.every(e => (e.phase == Parsed or e.phase == Processing) implies (e.outputReady and e.leaseHeld and e.capturedRevision == s.sourceRevision))
pure def sometimesStagedOutputWins(s: Evaluators): bool = s.lanes.some(e => e.phase == Parsed and e.outputSource == StagedOutput)
pure def sometimesBackgroundSourceChanged(s: Evaluators): bool = s.lanes.some(e => e.phase == InferPending and e.capturedRevision != s.sourceRevision)
```

## Story: Commit processors and incremental progress honestly

As a host I retain effect evidence, isolate errors and commit incremental progress only after every processor succeeds.

### Processors settle under room ownership and preserve effect identity

A replay requires an existing receipt identity. New applied effects add their durable receipt once.

```quint
pure def canBeginProcessors(s: Evaluators, name: str): bool = lane(s, name).phase == Parsed
pure def beginProcessors(s: Evaluators, name: str): Evaluators = replaceLane(name, { ...lane(s, name), phase: Processing }, s)
pure def canFinishProcessor(s: Evaluators, name: str, receiptId: str, replayed: bool): bool = lane(s, name).phase == Processing and lane(s, name).completedProcessors < lane(s, name).requiredProcessors and (not(replayed) or lane(s, name).receiptIds.contains(receiptId))
pure def finishProcessor(s: Evaluators, name: str, receiptId: str, replayed: bool): Evaluators = replaceLane(name, { ...lane(s, name), completedProcessors: lane(s, name).completedProcessors + 1, receiptIds: if (receiptId == "") lane(s, name).receiptIds else lane(s, name).receiptIds.union(Set(receiptId)) }, s)
pure def canCommitEvaluator(s: Evaluators, name: str): bool = lane(s, name).phase == Processing and lane(s, name).completedProcessors == lane(s, name).requiredProcessors and lane(s, name).capturedRevision == s.sourceRevision
pure def commitEvaluator(s: Evaluators, name: str): Evaluators = replaceLane(name, { ...lane(s, name), phase: Succeeded, leaseHeld: false, progressRevision: if (lane(s, name).incremental) s.sourceRevision else lane(s, name).progressRevision }, s)
pure def canFailEvaluator(s: Evaluators, name: str): bool = lane(s, name).phase == GatePending or lane(s, name).phase == PreparePending or lane(s, name).phase == InferPending or lane(s, name).phase == Parsed or lane(s, name).phase == Processing
pure def failEvaluator(s: Evaluators, name: str): Evaluators = replaceLane(name, { ...lane(s, name), phase: EvaluationFailed, leaseHeld: false, errors: lane(s, name).errors + 1 }, s)
pure def alwaysSuccessfulEvaluatorCompletedProcessors(s: Evaluators): bool = s.lanes.every(e => e.phase == Succeeded implies e.completedProcessors == e.requiredProcessors)
pure def alwaysFailedEvaluatorKeepsError(s: Evaluators): bool = s.lanes.every(e => e.phase == EvaluationFailed implies e.errors > 0)
pure def sometimesFailureIsolated(s: Evaluators): bool = s.lanes.some(a => a.phase == EvaluationFailed and s.lanes.some(b => b.name != a.name and b.phase == Succeeded))
pure def sometimesIncrementalProgressCommitted(s: Evaluators): bool = s.lanes.some(e => e.phase == Succeeded and e.incremental and e.progressRevision >= 0)
```
