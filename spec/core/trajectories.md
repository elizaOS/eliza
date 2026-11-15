# Turn trajectories

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/runtime/trajectory-recorder.ts`, `trajectory-usage-rollup.ts`, `trajectory-gate.ts`, `trajectory-provider-attribution.ts`, `trajectory-semantic-stage-sink.ts` and `trace-correlation.ts`, and `packages/core/src/services/trajectory-json.ts`, `trajectory-semantic-stage.ts` and `trajectory-types.ts`. A trajectory is the record of one turn: the model calls and actions it made, bound to the run that made them, and the token usage they spent. The process-wide export exclusion of a source is [trajectory sources](./trajectorySources.md); the active trace index that enriches a run's traces is [traces](./traces.md). A trajectory is diagnostic evidence kept on the device that recorded it; nothing here exports it for training.

## Story: Record a turn's trajectory

> As an operator, I want each turn the agent takes to leave one trajectory
> of its model calls and actions, bound to its run and with its token usage
> summed, so that I can see what the agent did and what it cost, while a
> source I excluded never leaves the runtime.

### A trajectory starts only while persistence is enabled

The operator's persistence setting, resolved by the precedence order below, decides whether a turn records a trajectory at all. A later change of the setting affects only trajectories started after it. Each trajectory has a fresh positive identity and names the run and the source that started it.

```quint
import trajectorySources as TS from "./trajectorySources"
type TrajectoryStatus = Running | Finished | Errored
type StepKind = ModelCall | ActionCall
type TrajectoryStep = { kind: StepKind, runId: str, promptTokens: int, completionTokens: int }
type Trajectory = { id: int, runId: str, source: str, status: TrajectoryStatus, steps: List[TrajectoryStep], promptTokens: int, completionTokens: int, exported: bool }
type Trajectories = { persistence: bool, sources: TS::TrajectorySources, trajectories: List[Trajectory] }
pure val initial: Trajectories = { persistence: false, sources: TS::initial, trajectories: List() }
pure val idValues = Set(1, 2)
pure val runIdValues = Set("run-a", "run-b")
pure val sourceValues = Set("live-chat", "synthetic")
pure def known(s: Trajectories, id: int): bool = s.trajectories.some(t => t.id == id)
pure val noTrajectory: Trajectory = { id: 0, runId: "", source: "", status: Errored, steps: List(), promptTokens: 0, completionTokens: 0, exported: false }
pure def trajectoryAt(s: Trajectories, id: int): Trajectory = s.trajectories.select(t => t.id == id).nthOr(0, noTrajectory)
pure def configurePersistence(s: Trajectories, hardDisabled: bool, explicit: LoggingChoice, protectedProfile: bool, testProfile: bool, productionProfile: bool): Trajectories =
  { ...s, persistence: trajectoryEnabled(hardDisabled, explicit, protectedProfile, testProfile, productionProfile) }
pure def canStartTrajectory(s: Trajectories, id: int, runId: str, source: str): bool = s.persistence and id > 0 and not(known(s, id)) and runId != "" and source != ""
pure def startTrajectory(s: Trajectories, id: int, runId: str, source: str): Trajectories =
  { ...s, trajectories: s.trajectories.append({ id: id, runId: runId, source: source, status: Running, steps: List(), promptTokens: 0, completionTokens: 0, exported: false }) }
pure def stepStartRequiresPersistence(before: Trajectories, via: str, after: Trajectories): bool =
  via == "startTrajectory" implies before.persistence
pure def stepPersistenceChangeKeepsTrajectories(before: Trajectories, via: str, after: Trajectories): bool =
  via == "configurePersistence" implies after.trajectories == before.trajectories
pure def alwaysTrajectoryIdentitiesUnique(s: Trajectories): bool =
  s.trajectories.every(t => t.id > 0 and s.trajectories.select(other => other.id == t.id).length() == 1)
```

### Each recorded step is bound to its trajectory's run

A model call or an action is recorded as one step of a running trajectory, carrying that trajectory's run identity. A step never names another run, so a run's evidence cannot be attributed to a different turn.

```quint
pure val promptTokensValues = Set(0, 3)
pure val completionTokensValues = Set(0, 2)
pure def canRecordStep(s: Trajectories, id: int, kind: StepKind, promptTokens: int, completionTokens: int): bool =
  trajectoryAt(s, id).status == Running and known(s, id) and promptTokens >= 0 and completionTokens >= 0
pure def recordStep(s: Trajectories, id: int, kind: StepKind, promptTokens: int, completionTokens: int): Trajectories =
  { ...s, trajectories: s.trajectories.listMap(t => if (t.id == id) { ...t, steps: t.steps.append({ kind: kind, runId: t.runId, promptTokens: promptTokens, completionTokens: completionTokens }), promptTokens: t.promptTokens + promptTokens, completionTokens: t.completionTokens + completionTokens } else t) }
pure def alwaysStepsBelongToTheirRun(s: Trajectories): bool =
  s.trajectories.every(t => t.runId != "" and t.steps.every(step => step.runId == t.runId))
pure def sometimesModelCallAndAction(s: Trajectories): bool =
  s.trajectories.some(t => t.steps.some(step => step.kind == ModelCall) and t.steps.some(step => step.kind == ActionCall))
```

### An ended trajectory refuses later steps

Ending a trajectory records its terminal status, finished or errored. After that its steps and totals never change and it never runs again, so a late diagnostic task cannot keep a completed turn visibly running or add to it.

```quint
pure def canEndTrajectory(s: Trajectories, id: int, ok: bool): bool = known(s, id) and trajectoryAt(s, id).status == Running
pure def endTrajectory(s: Trajectories, id: int, ok: bool): Trajectories =
  { ...s, trajectories: s.trajectories.listMap(t => if (t.id == id) { ...t, status: if (ok) Finished else Errored } else t) }
pure def stepEndedTrajectoryIsSealed(before: Trajectories, after: Trajectories): bool =
  before.trajectories.every(t => t.status == Running or after.trajectories.some(u => u.id == t.id and u.status == t.status and u.steps == t.steps and u.promptTokens == t.promptTokens and u.completionTokens == t.completionTokens))
pure def sometimesErroredTrajectory(s: Trajectories): bool = s.trajectories.some(t => t.status == Errored and t.steps.length() > 0)
```

### A trajectory's usage totals equal the sum of its steps

The prompt and completion token totals of a trajectory are the sums over its steps, so the usage rolled up per trace never counts a call twice or misses one.

```quint
pure def promptSum(steps: List[TrajectoryStep]): int = steps.foldl(0, (total, step) => total + step.promptTokens)
pure def completionSum(steps: List[TrajectoryStep]): int = steps.foldl(0, (total, step) => total + step.completionTokens)
pure def alwaysUsageIsTheSumOfSteps(s: Trajectories): bool =
  s.trajectories.every(t => t.promptTokens == promptSum(t.steps) and t.completionTokens == completionSum(t.steps))
```

### A trajectory from an excluded source is never exported

Export reads the source's exclusion as currently registered. Only an ended trajectory whose source is not excluded at that moment may leave the runtime, once. Registering an exclusion later does not recall a trajectory already exported.

```quint
pure def registerSource(s: Trajectories, name: str, excludeExport: bool): Trajectories = { ...s, sources: TS::register(s.sources, name, excludeExport) }
pure def canExportTrajectory(s: Trajectories, id: int): bool = {
  val t = trajectoryAt(s, id)
  known(s, id) and t.status != Running and not(t.exported) and not(TS::excluded(s.sources, t.source))
}
pure def exportTrajectory(s: Trajectories, id: int): Trajectories =
  { ...s, trajectories: s.trajectories.listMap(t => if (t.id == id) { ...t, exported: true } else t) }
pure def stepExportOnlyIncludedSources(before: Trajectories, via: str, after: Trajectories): bool =
  via == "exportTrajectory" implies after.trajectories.every(t => not(t.exported) or before.trajectories.some(b => b.id == t.id and (b.exported or not(TS::excluded(before.sources, b.source)))))
pure def alwaysExportedTrajectoryHasEnded(s: Trajectories): bool = s.trajectories.every(t => t.exported implies t.status != Running)
pure def sometimesExported(s: Trajectories): bool = s.trajectories.some(t => t.exported and t.status == Finished and t.steps.length() > 0)
pure def sometimesExcludedStaysLocal(s: Trajectories): bool = s.trajectories.some(t => t.status == Finished and not(t.exported) and TS::excluded(s.sources, t.source))
```

### Every started trajectory reaches a terminal status

The turn that started a trajectory ends it with its own outcome, even when optional background work fails. This is a fairness assumption on the turn: an ending it can make is not put off for ever.

```quint
pure val fair_endTrajectory = "weak"
pure def leadsToTrajectoryEnds(s: Trajectories, later: Trajectories): bool =
  s.trajectories.every(t => t.status == Running implies later.trajectories.some(u => u.id == t.id and u.status != Running))
```

## Story: Respect the operator's trajectory persistence setting

> As an operator, I can disable trajectory persistence explicitly. Hard
> disable wins over all other settings. Explicit nonblank logging settings
> override environment defaults. Protected, test and production profiles
> default off. Development defaults on. Blank values are represented as
> unspecified after normalization. User-specific consent belongs to the
> host's policy boundary and must be supplied before publication.

### Trajectory persistence follows the existing precedence order

```quint
type LoggingChoice = Unspecified | Enabled | Disabled
pure def trajectoryEnabled(hardDisabled: bool, explicit: LoggingChoice, protectedProfile: bool, testProfile: bool, productionProfile: bool): bool =
  not(hardDisabled) and (if (explicit == Enabled) true else if (explicit == Disabled) false else not(protectedProfile or testProfile or productionProfile))
pure def lawHardDisableWins(explicit: LoggingChoice, protectedProfile: bool, testProfile: bool, productionProfile: bool): bool =
  not(trajectoryEnabled(true, explicit, protectedProfile, testProfile, productionProfile))
pure def lawProductionRequiresOptIn(protectedProfile: bool, testProfile: bool): bool =
  not(trajectoryEnabled(false, Unspecified, protectedProfile, testProfile, true))
```
