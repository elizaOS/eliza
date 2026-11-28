# Turn trajectories

Sources are `runtime/{trajectory-recorder,trajectory-usage-rollup,trajectory-gate,trajectory-provider-attribution,trajectory-semantic-stage-sink,trace-correlation}.vibe` and `services/{trajectory-json,trajectory-semantic-stage,trajectory-types}.vibe`. A trajectory is the record of one turn: the model calls and actions it made, bound to the run that made them, and the token usage they spent. The active trace index that enriches a run's traces is [traces](./traces.md). A trajectory is diagnostic evidence kept on the device that recorded it. It leaves the runtime only when the operator explicitly exports it, for example in a diagnostic bundle; there is no export for training.

## Story: Record a turn's trajectory

> As an operator, I want each turn with persistence enabled to leave one
> trajectory of its model calls and actions, bound to its run and with its
> token usage summed, so that I can see what the agent did and what it cost.
> I want an export to keep trajectories from currently excluded sources local.

### A trajectory starts only while persistence is enabled

The operator's persistence setting, resolved by the precedence order below, decides whether a turn records a trajectory at all. A later change of the setting affects only trajectories started after it. Each trajectory has a fresh positive identity and names the run and the source that started it.

```quint
type TrajectoryStatus = Running | Finished | Errored
type StepKind = ModelCall | ActionCall
type TrajectoryStep = { kind: StepKind, runId: str, promptTokens: int, completionTokens: int }
type Trajectory = { id: int, runId: str, source: str, status: TrajectoryStatus, steps: List[TrajectoryStep], promptTokens: int, completionTokens: int, exported: bool }
type Trajectories = { persistence: bool, sources: str -> bool, trajectories: List[Trajectory] }
pure val initial: Trajectories = { persistence: false, sources: Map(), trajectories: List() }
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
  s.trajectories.every(t => t.runId != "" and t.steps.every(stage => stage.runId == t.runId))
pure def sometimesModelCallAndAction(s: Trajectories): bool =
  s.trajectories.some(t => t.steps.some(stage => stage.kind == ModelCall) and t.steps.some(stage => stage.kind == ActionCall))
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
pure def promptSum(steps: List[TrajectoryStep]): int = steps.foldl(0, (total, stage) => total + stage.promptTokens)
pure def completionSum(steps: List[TrajectoryStep]): int = steps.foldl(0, (total, stage) => total + stage.completionTokens)
pure def alwaysUsageIsTheSumOfSteps(s: Trajectories): bool =
  s.trajectories.every(t => t.promptTokens == promptSum(t.steps) and t.completionTokens == completionSum(t.steps))
```

### A recorded stage is one of exactly eight kinds

A decision stage recorded inside a turn names its kind from one shared vocabulary of exactly eight: messageHandler, planner, tool, toolSearch, evaluation, subPlanner, compaction and factsAndRelationships. Producers and readers of semantic stages use this one list; no second stage vocabulary exists.

```quint
pure val recordedStageKinds: Set[str] = Set("messageHandler", "planner", "tool", "toolSearch", "evaluation", "subPlanner", "compaction", "factsAndRelationships")
pure val stageKindValues = Set("messageHandler", "planner", "tool", "toolSearch", "evaluation", "subPlanner", "compaction", "factsAndRelationships", "reply", "")
pure def lawRecordedStageKindsAreExactlyEight(stageKind: str): bool =
  recordedStageKinds.contains(stageKind) iff (stageKind == "messageHandler" or stageKind == "planner" or stageKind == "tool" or stageKind == "toolSearch" or stageKind == "evaluation" or stageKind == "subPlanner" or stageKind == "compaction" or stageKind == "factsAndRelationships")
```

### A semantic stage record is accepted only when it is a valid schema version 1 stage

A semantic stage is the transport-safe copy of one recorded stage, attached to a trajectory step. Converting a recorded stage first normalizes its payload into plain JSON (a non-finite number becomes null; dates, big integers, functions and cyclic references become text; an absent value is left out) and leaves out an empty parent identity. The result of the conversion, and every stage read back from storage, then goes through one parser, which accepts a record only when it holds no unknown top-level key, carries schema version 1, has a present stage identity, names one of the eight recorded kinds, starts at a non-negative time, ends no earlier than it starts, reports its latency as exactly its end minus its start, has its optional iteration and retry index absent or non-negative integers, has its optional parent stage present and different from the stage itself, and has a payload holding only the model, tool, toolSearch, evaluation, cache and factsAndRelationships keys whose content is plain JSON (finite numbers, plain objects, no cycle). Every identity must also be trimmed and at most 256 characters; the model takes that text check, the counter check and the JSON check as given facts of the input. The parser refuses anything else with a typed invalid-stage error and never repairs it.

```quint
type SemanticStageInput = { onlyKnownKeys: bool, schemaVersion: int, stageId: str, kind: str, startedAt: int, endedAt: int, latencyMs: int, countersWellFormed: bool, hasParent: bool, parentStageId: str, identitiesWellFormed: bool, payloadKeys: List[str], payloadIsJson: bool }
pure val semanticStageSchemaVersion = 1
pure val semanticStagePayloadKeys: Set[str] = Set("model", "tool", "toolSearch", "evaluation", "cache", "factsAndRelationships")
pure val semanticStageValues = Set(
  { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "planner", startedAt: 1, endedAt: 4, latencyMs: 3, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("model"), payloadIsJson: true },
  { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-b", kind: "tool", startedAt: 0, endedAt: 0, latencyMs: 0, countersWellFormed: true, hasParent: true, parentStageId: "stage-a", identitiesWellFormed: true, payloadKeys: List("tool", "cache"), payloadIsJson: true },
  { onlyKnownKeys: true, schemaVersion: 2, stageId: "stage-a", kind: "planner", startedAt: 1, endedAt: 4, latencyMs: 3, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("model"), payloadIsJson: true },
  { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "reply", startedAt: 1, endedAt: 4, latencyMs: 3, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("model"), payloadIsJson: true },
  { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "planner", startedAt: 1, endedAt: 4, latencyMs: 2, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("model"), payloadIsJson: true },
  { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "planner", startedAt: 1, endedAt: 4, latencyMs: 3, countersWellFormed: true, hasParent: true, parentStageId: "stage-a", identitiesWellFormed: true, payloadKeys: List("model"), payloadIsJson: true },
  { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "planner", startedAt: 1, endedAt: 4, latencyMs: 3, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("prompt"), payloadIsJson: true },
  { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "tool", startedAt: 0, endedAt: 2, latencyMs: 2, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("tool"), payloadIsJson: true }
)
pure def acceptsSemanticStage(semanticStage: SemanticStageInput): bool =
  semanticStage.onlyKnownKeys
    and semanticStage.schemaVersion == semanticStageSchemaVersion
    and semanticStage.stageId != ""
    and recordedStageKinds.contains(semanticStage.kind)
    and semanticStage.startedAt >= 0
    and semanticStage.endedAt >= semanticStage.startedAt
    and semanticStage.latencyMs == semanticStage.endedAt - semanticStage.startedAt
    and semanticStage.countersWellFormed
    and (not(semanticStage.hasParent) or (semanticStage.parentStageId != "" and semanticStage.parentStageId != semanticStage.stageId))
    and semanticStage.identitiesWellFormed
    and semanticStage.payloadKeys.every(key => semanticStagePayloadKeys.contains(key))
    and semanticStage.payloadIsJson
pure def lawAcceptedStageHasSchemaVersionOne(semanticStage: SemanticStageInput): bool =
  acceptsSemanticStage(semanticStage) implies semanticStage.schemaVersion == 1
pure def lawAcceptedStageNamesARecordedKind(semanticStage: SemanticStageInput): bool =
  acceptsSemanticStage(semanticStage) implies recordedStageKinds.contains(semanticStage.kind)
pure def lawAcceptedLatencyIsTheElapsedTime(semanticStage: SemanticStageInput): bool =
  acceptsSemanticStage(semanticStage) implies (semanticStage.latencyMs >= 0 and semanticStage.latencyMs == semanticStage.endedAt - semanticStage.startedAt)
pure def lawAcceptedStageIsNotItsOwnParent(semanticStage: SemanticStageInput): bool =
  (acceptsSemanticStage(semanticStage) and semanticStage.hasParent) implies semanticStage.parentStageId != semanticStage.stageId
pure def lawAcceptedPayloadHoldsOnlyStageKeys(semanticStage: SemanticStageInput): bool =
  acceptsSemanticStage(semanticStage) implies semanticStage.payloadKeys.every(key => semanticStagePayloadKeys.contains(key))
```

### A list of semantic stages is accepted only when every stage is valid and no two share an identity

A step's stage list, read back from storage or converted from the recorder in recorded order, is accepted only when every stage in it is accepted alone and each stage identity occurs once. Two stages with the same identity refuse the whole list, whatever their other fields hold.

```quint
pure val semanticStagesValues = Set(
  List(),
  List({ onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "planner", startedAt: 1, endedAt: 4, latencyMs: 3, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("model"), payloadIsJson: true }),
  List({ onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-a", kind: "planner", startedAt: 1, endedAt: 4, latencyMs: 3, countersWellFormed: true, hasParent: false, parentStageId: "", identitiesWellFormed: true, payloadKeys: List("model"), payloadIsJson: true }, { onlyKnownKeys: true, schemaVersion: 1, stageId: "stage-b", kind: "tool", startedAt: 0, endedAt: 0, latencyMs: 0, countersWellFormed: true, hasParent: true, parentStageId: "stage-a", identitiesWellFormed: true, payloadKeys: List("tool", "cache"), payloadIsJson: true })
)
pure def acceptsSemanticStages(semanticStages: List[SemanticStageInput]): bool =
  semanticStages.every(entry => acceptsSemanticStage(entry))
    and semanticStages.every(entry => semanticStages.select(other => other.stageId == entry.stageId).length() == 1)
pure def lawAcceptedStagesAreEachAccepted(semanticStages: List[SemanticStageInput], semanticStage: SemanticStageInput): bool =
  (acceptsSemanticStages(semanticStages) and semanticStages.includes(semanticStage)) implies acceptsSemanticStage(semanticStage)
pure val otherStageValues = semanticStageValues
pure def lawRepeatedStageIdentityIsRefused(semanticStages: List[SemanticStageInput], semanticStage: SemanticStageInput, otherStage: SemanticStageInput): bool =
  otherStage.stageId == semanticStage.stageId implies not(acceptsSemanticStages(semanticStages.append(semanticStage).append(otherStage)))
```

### Every recorded stage starts a trajectory file write and is mirrored only into an open step of a running trajectories service

The recorder wrapped by the semantic-stage fan-out starts the trajectory file write of every recorded stage without waiting for it. It also mirrors the stage into the turn's database trajectory step, but only when the turn has a current step identity and a running trajectories service that accepts semantic stages. A file write that later fails, or a mirror that fails, is warned and reported as diagnostic only; neither fails the turn.

```quint
type StageFanOut = { fileWriteStarted: bool, mirrored: bool, reportedFailures: int, turnFails: bool }
pure def fanOutStage(hasStepId: bool, hasStageLogger: bool, fileFails: bool, mirrorFails: bool): StageFanOut = {
  val mirrorAttempted = hasStepId and hasStageLogger
  { fileWriteStarted: true, mirrored: mirrorAttempted and not(mirrorFails), reportedFailures: (if (fileFails) 1 else 0) + (if (mirrorAttempted and mirrorFails) 1 else 0), turnFails: false }
}
pure def lawFileWriteAlwaysStarts(hasStepId: bool, hasStageLogger: bool, fileFails: bool, mirrorFails: bool): bool =
  fanOutStage(hasStepId, hasStageLogger, fileFails, mirrorFails).fileWriteStarted
pure def lawMirrorOnlyIntoAnOpenStep(hasStepId: bool, hasStageLogger: bool, fileFails: bool, mirrorFails: bool): bool =
  fanOutStage(hasStepId, hasStageLogger, fileFails, mirrorFails).mirrored iff (hasStepId and hasStageLogger and not(mirrorFails))
pure def lawStageFailuresAreReportedNotThrown(hasStepId: bool, hasStageLogger: bool, fileFails: bool, mirrorFails: bool): bool = {
  val fanOut = fanOutStage(hasStepId, hasStageLogger, fileFails, mirrorFails)
  not(fanOut.turnFails) and (fileFails implies fanOut.reportedFailures >= 1) and ((hasStepId and hasStageLogger and mirrorFails) implies fanOut.reportedFailures >= 1)
}
```

### The latest copied metadata record determines exclusion

One process-wide map, shared by every runtime and module copy in the process (`trajectory-utils.vibe`), holds each source's export exclusion. Registering a nonempty trimmed name replaces its earlier record and applies to later reads from any runtime; restarting one runtime does not reset it, and there is no unregister. A source is known exactly when the map holds its name; an unknown or empty name is not excluded.

```quint
pure val nameValues = Set("", "live-chat", "synthetic")
pure def registerSource(s: Trajectories, name: str, excludeExport: bool): Trajectories = if (name == "") s else { ...s, sources: s.sources.put(name, excludeExport) }
pure def excluded(s: Trajectories, name: str): bool = name != "" and s.sources.getOr(name, false)
pure def alwaysEmptyNameHasNoMetadata(s: Trajectories): bool = not(s.sources.keys().contains(""))
pure def lawLatestRegistrationWins(s: Trajectories, name: str, excludeExport: bool): bool = name == "" or excluded(registerSource(s, name, excludeExport), name) == excludeExport
pure def lawUnknownSourceIsIncluded(s: Trajectories, name: str): bool = not(s.sources.keys().contains(name)) implies not(excluded(s, name))
pure def lawEmptySourceIsIncluded(s: Trajectories): bool = not(excluded(s, ""))
pure def sometimesSyntheticIsExcluded(s: Trajectories): bool = excluded(s, "synthetic")
```

### A trajectory from an excluded source is never exported

Export is the operator's explicit request to copy one trajectory out of the runtime, such as into a diagnostic bundle. It reads the source's exclusion as currently registered. Only an ended trajectory whose source is not excluded at that moment may leave the runtime, once. Registering an exclusion later does not recall a trajectory already exported.

```quint
pure def canExportTrajectory(s: Trajectories, id: int): bool = {
  val t = trajectoryAt(s, id)
  known(s, id) and t.status != Running and not(t.exported) and not(excluded(s, t.source))
}
pure def exportTrajectory(s: Trajectories, id: int): Trajectories =
  { ...s, trajectories: s.trajectories.listMap(t => if (t.id == id) { ...t, exported: true } else t) }
pure def stepExportOnlyIncludedSources(before: Trajectories, via: str, after: Trajectories): bool =
  via == "exportTrajectory" implies after.trajectories.every(t => not(t.exported) or before.trajectories.some(b => b.id == t.id and (b.exported or not(excluded(before, b.source)))))
pure def alwaysExportedTrajectoryHasEnded(s: Trajectories): bool = s.trajectories.every(t => t.exported implies t.status != Running)
pure def sometimesExported(s: Trajectories): bool = s.trajectories.some(t => t.exported and t.status == Finished and t.steps.length() > 0)
pure def sometimesExcludedStaysLocal(s: Trajectories): bool = s.trajectories.some(t => t.status == Finished and not(t.exported) and excluded(s, t.source))
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

Hard disable turns persistence off whatever else is set. Otherwise an
explicit setting decides, and without one, protected, test and production
profiles default off and development defaults on.

```quint
type LoggingChoice = Unspecified | Enabled | Disabled
pure def trajectoryEnabled(hardDisabled: bool, explicit: LoggingChoice, protectedProfile: bool, testProfile: bool, productionProfile: bool): bool =
  not(hardDisabled) and (if (explicit == Enabled) true else if (explicit == Disabled) false else not(protectedProfile or testProfile or productionProfile))
pure def lawHardDisableWins(explicit: LoggingChoice, protectedProfile: bool, testProfile: bool, productionProfile: bool): bool =
  not(trajectoryEnabled(true, explicit, protectedProfile, testProfile, productionProfile))
pure def lawProductionRequiresOptIn(protectedProfile: bool, testProfile: bool): bool =
  not(trajectoryEnabled(false, Unspecified, protectedProfile, testProfile, true))
```
