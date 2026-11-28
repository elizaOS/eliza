# Trajectory inspector

## Story: Inspect the phases of an agent turn

> As a developer with access to an agent run, I can inspect the current or completed turn and drill into its handle, plan, action and evaluate phases.

### Known calls and events are assigned to their canonical phase

The boundary normalizes a model call's step type, falling back to its purpose. Provider reads and tool/evaluator events carry their source kind. The inspector applies the same projection to the desktop view and the detail view.

```quint
type TurnPhase = HandlePhase | PlanPhase | ActionPhase | EvaluatePhase | UnknownPhase
type TraceKind = ModelCall({ label: str }) | ProviderRead | ToolInvocation | EvaluationRecord
pure def phaseOfModelCall(label: str): TurnPhase =
  if (Set("should_respond", "compose_state").contains(label)) HandlePhase
  else if (Set("reasoning", "response", "action").contains(label)) PlanPhase
  else if (Set("evaluation", "evaluator", "observation_extraction", "turn_complete").contains(label)) EvaluatePhase
  else UnknownPhase
pure def phaseOfRecord(record: TraceKind): TurnPhase = match record {
  | ModelCall(call) => phaseOfModelCall(call.label)
  | ProviderRead => HandlePhase
  | ToolInvocation => ActionPhase
  | EvaluationRecord => EvaluatePhase
}
pure def phaseRecords(items: List[TraceKind], phase: TurnPhase): List[TraceKind] = items.select(record => phaseOfRecord(record) == phase)
pure def lawPhaseProjectionKeepsOnlyItsOwnRecords(items: List[TraceKind], phase: TurnPhase): bool =
  phaseRecords(items, phase).every(record => phaseOfRecord(record) == phase)
```

### An active turn highlights only its latest completed phase before evaluation

Idle, skipped, or failed phases retain their status. A completed turn does not
show an active phase. When fetching trajectory routes, only HTTP `404` and `503`
classify a route as unavailable. A `should_respond` verdict of `IGNORE`, `STOP`,
or `SKIP` skips the turn, whereas `RESPOND`, `REPLY`, and `ANSWER` never skip.

```quint
type PhaseProgress = PhaseIdle | PhaseDone | PhaseSkipped | PhaseErrored | PhaseActive
type TurnProgress = { handling: PhaseProgress, planning: PhaseProgress, acting: PhaseProgress, evaluating: PhaseProgress }
pure def showProgress(progress: TurnProgress, running: bool): TurnProgress =
  if (not(running) or progress.evaluating != PhaseIdle) progress
  else if (progress.acting != PhaseIdle)
    if (progress.acting == PhaseDone) { ...progress, acting: PhaseActive } else progress
  else if (progress.planning != PhaseIdle)
    if (progress.planning == PhaseDone) { ...progress, planning: PhaseActive } else progress
  else if (progress.handling == PhaseDone) { ...progress, handling: PhaseActive } else progress
pure def lawCompletedTurnKeepsPhaseProgress(progress: TurnProgress): bool = showProgress(progress, false) == progress
pure def lawEvaluationStatusDoesNotChange(progress: TurnProgress, running: bool): bool =
  showProgress(progress, running).evaluating == progress.evaluating
pure def routeUnavailable(status: int): bool = status == 404 or status == 503
pure def lawOnly404And503AreUnavailable(status: int): bool =
  routeUnavailable(status) iff (status == 404 or status == 503)
pure def verdictSkipsTurn(verdict: str): bool = Set("IGNORE", "STOP", "SKIP").contains(verdict)
pure def lawRespondNeverSkipsTurn(verdict: str): bool =
  Set("RESPOND", "REPLY", "ANSWER").contains(verdict) implies not(verdictSkipsTurn(verdict))
pure val statusValues = Set(200, 401, 404, 500, 503)
pure val verdictValues = Set("RESPOND", "REPLY", "ANSWER", "IGNORE", "STOP", "SKIP")
pure val itemsValues = Set(List(), List(ModelCall({ label: "reasoning" }), ProviderRead, ToolInvocation, EvaluationRecord))
pure val progressValues = Set({ handling: PhaseDone, planning: PhaseDone, acting: PhaseIdle, evaluating: PhaseIdle }, { handling: PhaseDone, planning: PhaseDone, acting: PhaseDone, evaluating: PhaseDone })
```
