# Durable evaluator evidence and output

The runtime-facing [evaluator interface](./evaluators.md) exposes incremental
evidence and a source-bound checkpoint. The assistant owns its persistence
and executes callbacks around the core contract. This model follows
[the pinned progress implementation](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/plugins/plugin-assistant/src/services/evaluator-progress.ts)
and its [runner](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/plugins/plugin-assistant/src/services/evaluator.ts).

One instance represents a durable key scoped by agent, room, entity, evaluator
name and schema version. An authorized runtime holds the private snapshot
handle. Captured revisions represent stable hashes of complete canonical
messages. The adapter validates scope, unique persisted message IDs, and the
selected, deferred and removed source partition before exposing a batch.
The runner supplies the original validated output identity and exact prompt
binding. The scope and each parsed app payload retain their full value across
these boundaries.

## Story: Resume validated output without redoing its inference

As an incremental evaluator, I can resume the exact output of an interrupted
batch with its original evidence and prompt binding. Before durable staging
and commit the progress record and captured sources must still match.

### Only the selected sources references removals and trigger fence output

Every selected and reference revision and the original trigger must match.
A previously removed source must still be absent. Newly arrived messages
and unrelated changes remain eligible for a later batch.

```quint
type SourceRevision = { sourceId: str, revision: str }
type Evidence = { evidenceId: str, trigger: SourceRevision, selected: List[SourceRevision], removed: List[str], references: List[SourceRevision] }
pure val noEvidence: Evidence = { evidenceId: "", trigger: { sourceId: "", revision: "" }, selected: List(), removed: List(), references: List() }
pure def evidenceCurrent(evidence: Evidence, observed: List[SourceRevision]): bool =
  observed.includes(evidence.trigger) and evidence.selected.every(source => observed.includes(source)) and
  evidence.references.every(source => observed.includes(source)) and
  evidence.removed.every(id => not(observed.some(source => source.sourceId == id)))
pure def lawCurrentEvidenceKeepsExactTrigger(evidence: Evidence, observed: List[SourceRevision]): bool =
  evidenceCurrent(evidence, observed) implies observed.includes(evidence.trigger)
pure def lawRemovalBlocksRestoredSource(evidence: Evidence, observed: List[SourceRevision], id: str): bool =
  evidence.removed.includes(id) and observed.some(source => source.sourceId == id) implies not(evidenceCurrent(evidence, observed))
pure val sourceA: SourceRevision = { sourceId: "message-a", revision: "a1" }
pure val sourceB: SourceRevision = { sourceId: "message-b", revision: "b1" }
pure val revisedA: SourceRevision = { ...sourceA, revision: "a2" }
pure val sourceC: SourceRevision = { sourceId: "message-c", revision: "c1" }
pure val initialEvidence: Evidence = { evidenceId: "batch-a", trigger: sourceB, selected: List(sourceB), removed: List("deleted"), references: List(sourceA) }
pure val evidenceValues = Set(initialEvidence, { ...initialEvidence, evidenceId: "batch-b", selected: List(sourceA, sourceB), references: List() })
pure val observedValues = Set(List(), List(sourceA, sourceB), List(sourceA, sourceB, sourceC), List(revisedA, sourceB), List(sourceA, sourceB, {sourceId: "deleted", revision: "d1"}))
pure val idValues = Set("message-a", "message-b", "deleted")
```

### Durable staging retains the first output and its binding until settlement

A fresh stage requires the exact private handle, an unchanged progress record
and fresh evidence. A storage failure preserves the previous record. An exact
replay of the staged output performs no write. A different staged output or
binding is a conflict. A fresh snapshot captures durable staged evidence
ahead of any candidate evidence.

```quint
type ProgressFailure = NoProgressFailure | InvalidSnapshot | StaleEvidence | ProgressConflict | ProgressWriteFailed | ProgressNotStaged | ProgressEffectFailed | ReconciliationWriteFailed
type PendingOutput = { evidence: Evidence, payload: int, binding: str }
type ProgressRecord = { epoch: int, pending: PendingOutput, completed: List[SourceRevision], checkpoint: int, audit: int }
type ProgressSnapshot = { handle: int, expected: int, evidence: Evidence }
type ReconciliationPhase = NoReconciliation | PreparedReconciliation | ReducersRetired | ProgressRetired | ReconciliationRecorded
type Reconciliation = { phase: ReconciliationPhase, audit: int, previous: ProgressRecord, capturedSources: List[SourceRevision], reprocess: Set[str] }
type EvaluatorProgress = { record: ProgressRecord, snapshot: ProgressSnapshot, nextHandle: int, nextAudit: int, observed: List[SourceRevision], failure: ProgressFailure, plan: Reconciliation }
pure val noOutput: PendingOutput = { evidence: noEvidence, payload: 0, binding: "" }
pure val firstRecord: ProgressRecord = { epoch: 0, pending: noOutput, completed: List(), checkpoint: 0, audit: 0 }
pure val noSnapshot: ProgressSnapshot = { handle: 0, expected: 0, evidence: noEvidence }
pure val noPlan: Reconciliation = { phase: NoReconciliation, audit: 0, previous: firstRecord, capturedSources: List(), reprocess: Set() }
pure val initial: EvaluatorProgress = { record: firstRecord, snapshot: noSnapshot, nextHandle: 1, nextAudit: 1, observed: List(), failure: NoProgressFailure, plan: noPlan }
pure val handleValues = Set(0, 1, 2, 3)
pure val payloadValues = Set(1, 2)
pure val bindingValues = Set("prompt-a", "prompt-b")
pure val checkpointValues = Set(0, 1, 2)
pure val reprocessValues = Set(Set(), Set("message-a"), Set("message-b"), Set("message-a", "message-b"))
pure def refreshSources(s: EvaluatorProgress, observed: List[SourceRevision]): EvaluatorProgress = { ...s, observed: observed }
pure def canCapture(s: EvaluatorProgress, evidence: Evidence): bool =
  evidenceCurrent(if (s.record.pending.payload > 0) s.record.pending.evidence else evidence, s.observed) and
  (s.plan.phase == NoReconciliation or s.plan.phase == ReconciliationRecorded)
pure def capture(s: EvaluatorProgress, evidence: Evidence): EvaluatorProgress = {
  val selected = if (s.record.pending.payload > 0) s.record.pending.evidence else evidence
  { ...s, snapshot: { handle: s.nextHandle, expected: s.record.epoch, evidence: selected }, nextHandle: s.nextHandle + 1, failure: NoProgressFailure }
}
pure def snapshotStatus(s: EvaluatorProgress, handle: int): ProgressFailure =
  if (handle <= 0 or handle != s.snapshot.handle) InvalidSnapshot
  else if (s.snapshot.expected != s.record.epoch) ProgressConflict
  else if (not(evidenceCurrent(s.snapshot.evidence, s.observed))) StaleEvidence
  else NoProgressFailure
pure def canStageOutput(s: EvaluatorProgress, handle: int, payload: int): bool = s.snapshot.handle > 0 and payload > 0
pure def stageOutput(s: EvaluatorProgress, handle: int, payload: int, binding: str, durable: bool): EvaluatorProgress = {
  val status = snapshotStatus(s, handle)
  val pending = s.record.pending
  val epoch = s.record.epoch + 1
  if (status != NoProgressFailure) { ...s, failure: status }
  else if (pending.payload > 0) { ...s, failure: if (pending.payload == payload and pending.binding == binding) NoProgressFailure else ProgressConflict }
  else if (not(durable)) { ...s, failure: ProgressWriteFailed }
  else {
    { ...s, record: { ...s.record, epoch: epoch, pending: { evidence: s.snapshot.evidence, payload: payload, binding: binding } }, snapshot: { ...s.snapshot, expected: epoch }, failure: NoProgressFailure }
  }
}
pure def alwaysProgressEpochsOrdered(s: EvaluatorProgress): bool = s.record.epoch >= 0 and s.snapshot.expected >= 0 and s.snapshot.expected <= s.record.epoch and s.nextHandle > 0 and s.snapshot.handle >= 0 and s.snapshot.handle < s.nextHandle
pure def stepStageKeepsExactPayload(before: EvaluatorProgress, via: str, after: EvaluatorProgress): bool =
  via == "stageOutput" and before.record.pending.payload > 0 implies after.record.pending.payload == before.record.pending.payload and after.record.pending.binding == before.record.pending.binding
pure def stepFailedStageKeepsRecord(before: EvaluatorProgress, via: str, after: EvaluatorProgress): bool =
  via == "stageOutput" and after.failure != NoProgressFailure implies after.record == before.record
pure def sometimesStagedOutputRetained(s: EvaluatorProgress): bool = s.record.pending.payload > 0
pure def sometimesConflictingOutputRetained(s: EvaluatorProgress): bool = s.record.pending.payload > 0 and s.failure == ProgressConflict
```

### Commit acknowledges selected evidence only after all reducers succeed

Commit checks the current record again, requires staged output, and rejects
edited selected sources, changed references, a changed trigger, or restored
removals. Durable success replaces only selected revisions, removes exact
removed IDs and clears the staged output. An absent checkpoint update keeps
the prior checkpoint. Failed reducers, failed writes and stale evidence keep
the staged record pending. The source checks precede writes under ordered room
ownership. A storage transaction spanning reducer and source writes is
outside this contract.

```quint
pure def acknowledged(prior: List[SourceRevision], evidence: Evidence): List[SourceRevision] =
  prior.select(source => not(evidence.removed.includes(source.sourceId)) and
    not(evidence.selected.some(selected => selected.sourceId == source.sourceId))).concat(evidence.selected)
pure def canCommitProgress(s: EvaluatorProgress, handle: int, checkpoint: int): bool = s.snapshot.handle > 0 and checkpoint >= 0
pure def commitProgress(s: EvaluatorProgress, handle: int, effectsSucceeded: bool, checkpoint: int, durable: bool): EvaluatorProgress = {
  val status = snapshotStatus(s, handle)
  val epoch = s.record.epoch + 1
  if (status != NoProgressFailure) { ...s, failure: status }
  else if (s.record.pending.payload == 0) { ...s, failure: ProgressNotStaged }
  else if (not(effectsSucceeded)) { ...s, failure: ProgressEffectFailed }
  else if (not(durable)) { ...s, failure: ProgressWriteFailed }
  else {
    { ...s, record: { ...s.record, epoch: epoch, pending: noOutput, completed: acknowledged(s.record.completed, s.snapshot.evidence), checkpoint: if (checkpoint == 0) s.record.checkpoint else checkpoint }, snapshot: { ...s.snapshot, expected: epoch }, failure: NoProgressFailure }
  }
}
pure def stepFailedCommitKeepsRecord(before: EvaluatorProgress, via: str, after: EvaluatorProgress): bool =
  via == "commitProgress" and after.failure != NoProgressFailure implies after.record == before.record
pure def stepCommitUsesCapturedSources(before: EvaluatorProgress, via: str, after: EvaluatorProgress): bool =
  via == "commitProgress" and after.failure == NoProgressFailure implies
    after.record.pending.payload == 0 and after.record.completed == acknowledged(before.record.completed, before.snapshot.evidence) and evidenceCurrent(before.snapshot.evidence, before.observed)
pure def sometimesFailedReducersRetainOutput(s: EvaluatorProgress): bool = s.failure == ProgressEffectFailed and s.record.pending.payload > 0
pure def sometimesProgressCommitted(s: EvaluatorProgress): bool = s.record.completed.length() > 0 and s.record.pending.payload == 0
```

## Story: Retire stale evidence with a recoverable audit record

As an operator, I can reconcile pending and completed derived evidence after
an edit or removal. The prepared journal retains the exact prior progress,
and the durable progress pointer identifies completion even if the final
audit write fails.

### Stale evidence prepares an audit before any reducer can retire it

The runner detects edits or removal of observed selected, reference or
completed revisions. Changed and removed IDs and retained supporting sources
reported by the reconciliation callback become eligible for reprocessing.
A successful reducer receipt is required before retiring the captured
progress. IDs reported as additional support must exist in the captured room.

```quint
pure def staleObserved(s: EvaluatorProgress): List[SourceRevision] = {
  val selected = s.record.pending.evidence.selected.concat(s.record.pending.evidence.references)
  val completed = s.record.completed.select(source => not(selected.some(inFlight => inFlight.sourceId == source.sourceId)))
  completed.concat(selected).select(source => not(s.observed.includes(source)))
}
pure def canPrepareReconciliation(s: EvaluatorProgress): bool =
  (s.plan.phase == NoReconciliation or s.plan.phase == ReconciliationRecorded) and staleObserved(s).length() > 0
pure def prepareReconciliation(s: EvaluatorProgress, durable: bool): EvaluatorProgress = {
  val affected = staleObserved(s).foldl(Set(), (ids, source) => ids.union(Set(source.sourceId)))
  if (not(durable)) { ...s, failure: ReconciliationWriteFailed }
  else { ...s, nextAudit: s.nextAudit + 1,
    plan: { phase: PreparedReconciliation, audit: s.nextAudit, previous: s.record, capturedSources: s.observed, reprocess: affected }, failure: NoProgressFailure }
}
pure def canRetireReducers(s: EvaluatorProgress, reprocess: Set[str]): bool = s.plan.phase == PreparedReconciliation
pure def retireReducers(s: EvaluatorProgress, reprocess: Set[str], effectsSucceeded: bool): EvaluatorProgress =
  if (not(effectsSucceeded)) { ...s, failure: ProgressEffectFailed }
  else if (not(reprocess.forall(id => s.plan.capturedSources.some(source => source.sourceId == id)))) { ...s, failure: StaleEvidence }
  else { ...s, plan: { ...s.plan, phase: ReducersRetired, reprocess: s.plan.reprocess.union(reprocess) }, failure: NoProgressFailure }
pure def canRetireProgress(s: EvaluatorProgress): bool = s.plan.phase == ReducersRetired
pure def retireProgress(s: EvaluatorProgress, durable: bool): EvaluatorProgress =
  if (s.record.epoch != s.plan.previous.epoch) { ...s, failure: ProgressConflict }
  else if (not(durable)) { ...s, failure: ReconciliationWriteFailed }
  else { ...s, record: { ...s.record, epoch: s.record.epoch + 1, pending: noOutput, completed: s.record.completed.select(source => not(s.plan.reprocess.contains(source.sourceId))), checkpoint: 0, audit: s.plan.audit }, plan: { ...s.plan, phase: ProgressRetired }, failure: NoProgressFailure }
pure def canFinishReconciliation(s: EvaluatorProgress): bool = s.plan.phase == ProgressRetired and s.record.audit == s.plan.audit
pure def finishReconciliation(s: EvaluatorProgress, durable: bool): EvaluatorProgress =
  if (not(durable)) { ...s, failure: ReconciliationWriteFailed }
  else { ...s, plan: { ...s.plan, phase: ReconciliationRecorded }, failure: NoProgressFailure }
pure def alwaysRetiredProgressLinksAudit(s: EvaluatorProgress): bool =
  s.plan.phase == ProgressRetired or s.plan.phase == ReconciliationRecorded implies s.record.audit == s.plan.audit
pure def stepFailedReconciliationKeepsOriginal(before: EvaluatorProgress, via: str, after: EvaluatorProgress): bool =
  (via == "retireReducers" or via == "retireProgress" or via == "finishReconciliation") implies after.plan.previous == before.plan.previous
pure def sometimesAuditRecoversAfterWriteFailure(s: EvaluatorProgress): bool = s.plan.phase == ProgressRetired and s.failure == ReconciliationWriteFailed and s.record.audit == s.plan.audit
```
