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

The inspector starts from the phase statuses before adding any active highlight. Idle, skipped, or failed phases retain their status. For a completed turn it returns the supplied statuses as they are.

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
pure val itemsValues = Set(List(), List(ModelCall({ label: "reasoning" }), ProviderRead, ToolInvocation, EvaluationRecord))
pure val progressValues = Set({ handling: PhaseDone, planning: PhaseDone, acting: PhaseIdle, evaluating: PhaseIdle }, { handling: PhaseDone, planning: PhaseDone, acting: PhaseDone, evaluating: PhaseDone })
```
