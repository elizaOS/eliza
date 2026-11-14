# Evaluator processing contracts

Core exposes [the registered evaluator interface](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/types/evaluator.ts)
and its [component registry](./registries.md). The
[pinned assistant runner](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/plugins/plugin-assistant/src/services/evaluator.ts)
owns batch execution around those callbacks. [Durable progress](./evaluatorProgress.md)
owns snapshots, staging, checkpoint writes and reconciliation.

One instance represents a captured invocation of the runner's batch, on the
current-message, legacy complete-turn, or incremental route. Candidate and
processor handles refer to the original callbacks retained by the invocation.
The shell observes dynamic opt-ins, normalizes priority with 100 as default,
and supplies the stable locale name order and original positions for ties.
All prompt, state, model output, processor results and diagnostics retain
their full payload at the boundary.

## Story: Prepare the evaluator batch without blocking peer callbacks

As an evaluator author I can opt into the correct input scope or decline a
run. A peer's shouldRun or prepare failure leaves my eligible entry available.

### Incremental post-turn input takes precedence over current message scope

A current-message-only batch receives the current message and its provider
context with no inherited response history. Incremental evidence is
source-bound. The normal route retains the complete turn. Only post-turn
background entries that opt into incremental processing enter background
scheduling. Other eligible post-turn entries execute inline.

```quint
type EvaluatorInput = CompleteTurn | CurrentMessage | IncrementalEvidence
pure def evaluatorInput(postTurn: bool, incremental: bool, currentOnly: bool): EvaluatorInput =
  if (postTurn and incremental) IncrementalEvidence else if (currentOnly) CurrentMessage else CompleteTurn
pure def backgroundEligible(postTurn: bool, incremental: bool, asynchronous: bool): bool =
  postTurn and incremental and asynchronous
pure def lawIncrementalTakesScopePrecedence(currentOnly: bool): bool =
  evaluatorInput(true, true, currentOnly) == IncrementalEvidence
pure def lawBackgroundRequiresIncremental(postTurn: bool, asynchronous: bool): bool =
  not(backgroundEligible(postTurn, false, asynchronous))
```

### Gates finish before provider composition and preparation finishes before inference

Candidate gate callbacks may settle in any order. A durable staged section
bypasses shouldRun. Provider composition and shared transcript capture happen
after the gates settle. Preparation may then settle in any order. A local
resolver that is enabled must yield defined output or an explicit failure.
Staged output bypasses that resolver.

```quint
type RunPhase = CapturingBatch | GatingBatch | ComposingBatch | PreparingBatch | InferringBatch | ValidatingBatch | ApplyingBatch | FinishedBatch | FailedBatch
type LanePhase = GatePending | GateSkipped | GateFailed | PreparePending | PrepareFailed | PreparedLane | ParsedLane | ProcessingLane | SettledLane | FailedLane
type GateResult = DeclineGate | AcceptGate | FailGate
type PrepareResult = PrepareModel | PrepareResolved | PrepareFailure
type ModelResult = ModelSucceeded | ModelFailed | ModelNotNeeded
type OutputSource = StagedOutput | ResolvedOutput | ModelOutput
type Candidate = { evaluatorRef: int, name: str, priority: int, nameOrder: int, processorCount: int, stagedPayload: int }
type CandidateOrder = { valid: bool, previous: Candidate }
type EvalLane = { position: int, candidate: Candidate, phase: LanePhase, binding: str, resolved: int, outputSource: OutputSource, output: int, completed: int, processorErrors: int, staged: bool }
type Evaluators = { rejectedBinding: bool, route: EvaluatorInput, background: bool, phase: RunPhase, lanes: List[EvalLane], model: ModelResult, cursor: int, batchFailure: bool }
pure val missingCandidate: Candidate = { evaluatorRef: 0, name: "", priority: 100, nameOrder: 0, processorCount: 0, stagedPayload: 0 }
pure val missingLane: EvalLane = { position: -1, candidate: missingCandidate, phase: GateSkipped, binding: "", resolved: 0, outputSource: ModelOutput, output: 0, completed: 0, processorErrors: 0, staged: false }
pure val initial: Evaluators = { rejectedBinding: false, route: CompleteTurn, background: false, phase: CapturingBatch, lanes: List(), model: ModelNotNeeded, cursor: 0, batchFailure: false }
pure val exampleOne: Candidate = { evaluatorRef: 1, name: "facts", priority: 100, nameOrder: 1, processorCount: 2, stagedPayload: 0 }
pure val exampleTwo: Candidate = { evaluatorRef: 2, name: "links", priority: 100, nameOrder: 2, processorCount: 0, stagedPayload: 10 }
pure val candidatesValues = Set(List(exampleOne, exampleTwo), List(exampleOne), List({ ...exampleOne, processorCount: 0 }), List(exampleTwo), List())
pure val positionValues = Set(0, 1)
pure val bindingValues = Set("binding-original", "binding-changed")
pure val payloadValues = Set(0, 10, 20)
pure def capturedLane(candidate: Candidate, position: int): EvalLane =
  { ...missingLane, position: position, candidate: candidate, phase: if (candidate.stagedPayload > 0) PreparePending else GatePending }
pure val laneValues = Set(capturedLane(exampleOne, 0), capturedLane(exampleTwo, 1))
pure def precedes(left: Candidate, right: Candidate): bool =
  left.priority < right.priority or (left.priority == right.priority and left.nameOrder <= right.nameOrder)
pure val initialOrder: CandidateOrder = { valid: true, previous: missingCandidate }
pure def orderedCandidates(candidates: List[Candidate]): bool =
  candidates.foldl(initialOrder, (order, candidate) =>
    { valid: order.valid and (order.previous.evaluatorRef == 0 or precedes(order.previous, candidate)), previous: candidate }).valid
pure def canOpenBatch(s: Evaluators, route: EvaluatorInput, background: bool, candidates: List[Candidate]): bool =
  s.phase == CapturingBatch and orderedCandidates(candidates) and (not(background) or route == IncrementalEvidence) and
  candidates.every(candidate => candidate.evaluatorRef > 0 and candidate.processorCount >= 0 and candidate.stagedPayload >= 0 and
    (candidate.stagedPayload > 0 implies route == IncrementalEvidence))
pure def openBatch(s: Evaluators, route: EvaluatorInput, background: bool, candidates: List[Candidate]): Evaluators =
  { ...s, route: route, background: background, phase: GatingBatch,
    lanes: candidates.foldl(List(), (lanes, candidate) => lanes.append(capturedLane(candidate, lanes.length()))) }
pure def laneAt(s: Evaluators, position: int): EvalLane = s.lanes.nthOr(position, missingLane)
pure def withLane(position: int, replacement: EvalLane, s: Evaluators): Evaluators =
  { ...s, lanes: s.lanes.listMap(lane => if (lane.position == position) replacement else lane) }
pure def canSettleGate(s: Evaluators, position: int): bool = s.phase == GatingBatch and laneAt(s, position).phase == GatePending
pure def settleGate(s: Evaluators, position: int, decision: GateResult): Evaluators =
  withLane(position, { ...laneAt(s, position), phase: if (decision == AcceptGate) PreparePending else if (decision == DeclineGate) GateSkipped else GateFailed }, s)
pure def canCloseGates(s: Evaluators): bool = s.phase == GatingBatch and s.lanes.every(lane => lane.phase != GatePending)
pure def closeGates(s: Evaluators): Evaluators =
  { ...s, phase: if (s.lanes.some(lane => lane.phase == PreparePending)) ComposingBatch else FinishedBatch }
pure def canCompleteComposition(s: Evaluators): bool = s.phase == ComposingBatch
pure def completeComposition(s: Evaluators, ok: bool): Evaluators =
  { ...s, phase: if (ok) PreparingBatch else FailedBatch, batchFailure: not(ok) }
pure def canSettlePreparation(s: Evaluators, position: int, preparation: PrepareResult, payload: int): bool =
  s.phase == PreparingBatch and laneAt(s, position).phase == PreparePending and payload >= 0 and
  (laneAt(s, position).candidate.stagedPayload == 0 or preparation != PrepareResolved)
pure def settlePreparation(s: Evaluators, position: int, preparation: PrepareResult, payload: int, binding: str): Evaluators = {
  val lane = laneAt(s, position)
  val failed = preparation == PrepareFailure or (preparation == PrepareResolved and payload == 0)
  withLane(position, { ...lane, phase: if (failed) PrepareFailed else PreparedLane, binding: binding,
    resolved: if (preparation == PrepareResolved and not(failed)) payload else 0 }, s)
}
pure def sometimesPreparationSettlesOutOfOrder(s: Evaluators): bool =
  s.phase == PreparingBatch and laneAt(s, 0).phase == PreparePending and laneAt(s, 1).phase == PreparedLane
pure def sometimesEvaluatorSkipped(s: Evaluators): bool = s.lanes.some(lane => lane.phase == GateSkipped)
```

## Story: Apply output in priority order under the original custody

As a host I apply only admitted output and retain a recoverable receipt if a
later processor or durable progress write fails.

### A single merged call serves fresh sections and local output survives model failure

The runner submits fresh prepared sections in one model invocation. Staged
and resolved sections retain their own output. Failed model admission still
allows those independent sections to run. For a background batch, the
runner re-prepares the captured entries under a new room lease and compares
each fresh entry's candidate binding before any staging or processor. A
staged entry keeps its original binding. The authorization and complete
reference-restoration contract belongs to the evidence input boundary.

```quint
pure def fresh(lane: EvalLane): bool = lane.phase == PreparedLane and lane.candidate.stagedPayload == 0 and lane.resolved == 0
pure def canClosePreparation(s: Evaluators): bool =
  s.phase == PreparingBatch and s.lanes.every(lane => lane.phase != PreparePending)
pure def closePreparation(s: Evaluators): Evaluators =
  { ...s, phase: if (s.lanes.some(lane => fresh(lane))) InferringBatch else if (s.lanes.some(lane => lane.phase == PreparedLane)) (if (s.background) ValidatingBatch else ApplyingBatch) else FinishedBatch }
pure def canSettleModel(s: Evaluators): bool = s.phase == InferringBatch
pure def settleModel(s: Evaluators, ok: bool): Evaluators =
  { ...s, phase: if (ok or s.lanes.some(lane => lane.phase == PreparedLane and not(fresh(lane)))) (if (s.background) ValidatingBatch else ApplyingBatch) else FailedBatch,
    model: if (ok) ModelSucceeded else ModelFailed, batchFailure: not(ok) }
pure def rawSource(lane: EvalLane): OutputSource =
  if (lane.candidate.stagedPayload > 0) StagedOutput else if (lane.resolved > 0) ResolvedOutput else ModelOutput
pure def rawPayload(lane: EvalLane, modelPayload: int): int =
  if (lane.candidate.stagedPayload > 0) lane.candidate.stagedPayload else if (lane.resolved > 0) lane.resolved else modelPayload
pure def lawStagedPayloadWins(lane: EvalLane, modelPayload: int): bool =
  lane.candidate.stagedPayload > 0 implies rawPayload(lane, modelPayload) == lane.candidate.stagedPayload and rawSource(lane) == StagedOutput
type ReturnedBinding = { position: int, binding: str }
pure val bindingsValues = Set(List(), List({position: 0, binding: "binding-original"}), List({position: 0, binding: "binding-changed"}))
pure def currentBindingsAgree(s: Evaluators, bindings: List[ReturnedBinding]): bool =
  s.lanes.every(lane => (lane.phase == PreparedLane and lane.candidate.stagedPayload == 0) implies
    bindings.includes({ position: lane.position, binding: lane.binding }))
pure def canCheckBackgroundBindings(s: Evaluators): bool = s.phase == ValidatingBatch
pure def checkBackgroundBindings(s: Evaluators, bindings: List[ReturnedBinding], reprepareSucceeded: bool): Evaluators = {
  val unchanged = currentBindingsAgree(s, bindings)
  val admitted = reprepareSucceeded and unchanged
  { ...s, phase: if (admitted) ApplyingBatch else FailedBatch, rejectedBinding: not(unchanged),
    batchFailure: s.batchFailure or not(admitted) }
}
pure def sometimesBackgroundSourceChanged(s: Evaluators): bool = s.phase == FailedBatch and s.rejectedBinding
pure def sometimesLocalOutputSurvivesModelFailure(s: Evaluators): bool =
  s.phase == ApplyingBatch and s.model == ModelFailed
```

### Ordered processors continue after failure with no progress acknowledgment

The shell supplies the captured order of prepared entries and processors,
with equal priorities ordered by locale name and original position. A missing
or invalid section appends an evaluator error. An incremental section stages
validated raw output before its first effect. Each processor can succeed,
fail, or return no effect. A failed result or exception is retained, the
remaining processors continue, and that evaluator cannot commit progress.
Peer sections can still finish. A storage failure during commit leaves the
durable staged output available for replay.

```quint
pure def inactiveLane(lane: EvalLane): bool =
  lane.phase == GateSkipped or lane.phase == GateFailed or lane.phase == PrepareFailed or
  lane.phase == SettledLane or lane.phase == FailedLane
pure def canAdmitSection(s: Evaluators, modelPayload: int): bool =
  val lane = laneAt(s, s.cursor)
  s.phase == ApplyingBatch and lane.phase == PreparedLane and not(s.model == ModelFailed and fresh(lane)) and modelPayload >= 0 and
  (modelPayload == 0 or s.model == ModelSucceeded)
pure def admitSection(s: Evaluators, modelPayload: int, parsed: bool): Evaluators = {
  val lane = laneAt(s, s.cursor)
  val payload = rawPayload(lane, modelPayload)
  withLane(s.cursor, { ...lane, phase: if (parsed and payload > 0) ParsedLane else FailedLane,
    outputSource: rawSource(lane), output: payload }, s)
}
pure def canBeginProcessors(s: Evaluators): bool = s.phase == ApplyingBatch and laneAt(s, s.cursor).phase == ParsedLane
pure def beginProcessors(s: Evaluators, durable: bool): Evaluators = {
  val lane = laneAt(s, s.cursor)
  val admitted = s.route != IncrementalEvidence or durable
  withLane(s.cursor, { ...lane, phase: if (admitted) ProcessingLane else FailedLane,
    staged: s.route == IncrementalEvidence and durable }, s)
}
pure def canSettleProcessor(s: Evaluators): bool =
  s.phase == ApplyingBatch and laneAt(s, s.cursor).phase == ProcessingLane and
  laneAt(s, s.cursor).completed < laneAt(s, s.cursor).candidate.processorCount
pure def settleProcessor(s: Evaluators, ok: bool): Evaluators = {
  val lane = laneAt(s, s.cursor)
  withLane(s.cursor, { ...lane, completed: lane.completed + 1,
    processorErrors: lane.processorErrors + (if (ok) 0 else 1) }, s)
}
pure def canFinishSection(s: Evaluators): bool =
  s.phase == ApplyingBatch and laneAt(s, s.cursor).phase == ProcessingLane and
  laneAt(s, s.cursor).completed == laneAt(s, s.cursor).candidate.processorCount
pure def finishSection(s: Evaluators, durable: bool): Evaluators = {
  val lane = laneAt(s, s.cursor)
  val ok = lane.processorErrors == 0 and (s.route != IncrementalEvidence or (lane.staged and durable))
  withLane(s.cursor, { ...lane, phase: if (ok) SettledLane else FailedLane }, s)
}
pure def canAdvanceSection(s: Evaluators): bool =
  s.phase == ApplyingBatch and s.cursor < s.lanes.length() and
    (inactiveLane(laneAt(s, s.cursor)) or (s.model == ModelFailed and fresh(laneAt(s, s.cursor))))
pure def advanceSection(s: Evaluators): Evaluators = { ...s, cursor: s.cursor + 1 }
pure def canCloseBatch(s: Evaluators): bool = s.phase == ApplyingBatch and s.cursor == s.lanes.length()
pure def closeBatch(s: Evaluators): Evaluators = { ...s, phase: FinishedBatch }
pure def alwaysProcessorProgressBounded(s: Evaluators): bool =
  s.lanes.every(lane => lane.completed >= 0 and lane.completed <= lane.candidate.processorCount and
    lane.processorErrors >= 0 and lane.processorErrors <= lane.completed)
pure def alwaysSuccessfulEvaluatorCompletedProcessors(s: Evaluators): bool =
  s.lanes.every(lane => lane.phase == SettledLane implies lane.completed == lane.candidate.processorCount and lane.processorErrors == 0)
pure def alwaysIncrementalEffectsAreStaged(s: Evaluators): bool =
  s.route == IncrementalEvidence implies s.lanes.every(lane =>
    (lane.phase == ProcessingLane or lane.phase == SettledLane) implies lane.staged)
pure def sometimesProcessorFailureDoesNotPreventNextProcessor(s: Evaluators): bool =
  s.lanes.some(lane => lane.phase == ProcessingLane and lane.processorErrors > 0 and lane.completed < lane.candidate.processorCount)
pure val weight_openBatch = 5
pure val weight_settleGate = 5
pure val weight_closeGates = 5
pure val weight_completeComposition = 5
pure val weight_settlePreparation = 5
pure val weight_closePreparation = 5
pure val weight_settleModel = 5
pure val weight_admitSection = 5
pure val weight_beginProcessors = 5
pure val weight_settleProcessor = 5
pure val weight_finishSection = 5
pure val weight_advanceSection = 5
pure def sometimesFailureIsolated(s: Evaluators): bool =
  s.lanes.some(lane => lane.phase == SettledLane) and
  s.lanes.some(lane => lane.phase == GateFailed or lane.phase == PrepareFailed or lane.phase == FailedLane)
pure def sometimesIncrementalProgressCommitted(s: Evaluators): bool =
  s.route == IncrementalEvidence and s.lanes.some(lane => lane.phase == SettledLane)
```
