lemma TrajectoryIdsBridge(s: Trajectories)
  ensures alwaysTrajectoryIdentitiesUnique(s) <==> (forall t :: t in s.trajectories ==> (t.id > 0 && |ProofLib.Filter((other: Trajectory) => (other.id == t.id), s.trajectories)| == 1))
{}

lemma TrajectoryAtBridge(s: Trajectories, id: int)
  ensures trajectoryAt(s, id) == (if 0 < |ProofLib.Filter((t: Trajectory) => (t.id == id), s.trajectories)| then ProofLib.Filter((t: Trajectory) => (t.id == id), s.trajectories)[0] else noTrajectory)
{}

lemma TrajectoryAtIndex(s: Trajectories, id: int, i: int)
  requires alwaysTrajectoryIdentitiesUnique(s)
  requires 0 <= i < |s.trajectories| && s.trajectories[i].id == id
  ensures trajectoryAt(s, id) == s.trajectories[i]
  ensures forall j :: 0 <= j < |s.trajectories| && j != i ==> s.trajectories[j].id != id
{
  var xs := s.trajectories;
  var row := xs[i];
  var p := (t: Trajectory) => (t.id == id);
  TrajectoryIdsBridge(s);
  TrajectoryAtBridge(s, id);
  assert row in xs;
  ProofLib.FilterSamePredicate(p, (other: Trajectory) => (other.id == row.id), xs);
  ProofLib.FilterCountOneIffUnique(p, xs, (t: Trajectory) => t.id, i);
  ProofLib.FilterSubset(p, xs);
  ProofLib.FilterMember(p, xs, ProofLib.Filter(p, xs)[0]);
}

lemma TrajectoryIdsPointwise(s: Trajectories, t: Trajectories)
  requires alwaysTrajectoryIdentitiesUnique(s)
  requires |s.trajectories| == |t.trajectories|
  requires forall i :: 0 <= i < |s.trajectories| ==> s.trajectories[i].id == t.trajectories[i].id
  ensures alwaysTrajectoryIdentitiesUnique(t)
{
  TrajectoryIdsBridge(s);
  TrajectoryIdsBridge(t);
  forall row | row in t.trajectories
    ensures row.id > 0 && |ProofLib.Filter((other: Trajectory) => (other.id == row.id), t.trajectories)| == 1
  {
    var i :| 0 <= i < |t.trajectories| && t.trajectories[i] == row;
    assert s.trajectories[i] in s.trajectories;
    ProofLib.FilterLengthPointwise((other: Trajectory) => (other.id == row.id), (other: Trajectory) => (other.id == row.id), s.trajectories, t.trajectories);
  }
}

lemma TrajectoryOthersKept(s: Trajectories, t: Trajectories, id: int)
  requires |s.trajectories| == |t.trajectories|
  requires forall j :: 0 <= j < |s.trajectories| && s.trajectories[j].id != id ==> t.trajectories[j] == s.trajectories[j]
  requires forall j :: 0 <= j < |s.trajectories| && s.trajectories[j].id == id ==> s.trajectories[j].status.Running?
  ensures stepEndedTrajectoryIsSealed(s, t)
{
  forall row | row in s.trajectories && !row.status.Running?
    ensures exists u :: u in t.trajectories && u.id == row.id && u.status == row.status && u.steps == row.steps && u.promptTokens == row.promptTokens && u.completionTokens == row.completionTokens
  {
    var j :| 0 <= j < |s.trajectories| && s.trajectories[j] == row;
    assert t.trajectories[j] in t.trajectories;
  }
}

lemma startTrajectory_ensures(s: Trajectories, id: int, runId: string, source: string)
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> alwaysTrajectoryIdentitiesUnique(startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> alwaysStepsBelongToTheirRun(startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> alwaysUsageIsTheSumOfSteps(startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> alwaysEmptyNameHasNoMetadata(startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> alwaysExportedTrajectoryHasEnded(startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> stepStartRequiresPersistence(s, "startTrajectory", startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> stepPersistenceChangeKeepsTrajectories(s, "startTrajectory", startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> stepEndedTrajectoryIsSealed(s, startTrajectory(s, id, runId, source)))
  ensures (inv(s) ==> canStartTrajectory(s, id, runId, source) ==> stepExportOnlyIncludedSources(s, "startTrajectory", startTrajectory(s, id, runId, source)))
{
  if inv(s) && canStartTrajectory(s, id, runId, source) {
    var after := startTrajectory(s, id, runId, source);
    var row := after.trajectories[|after.trajectories| - 1];
    assert after.trajectories == s.trajectories + [row];
    TrajectoryIdsBridge(s);
    TrajectoryIdsBridge(after);
    forall entry | entry in after.trajectories
      ensures entry.id > 0 && |ProofLib.Filter((other: Trajectory) => (other.id == entry.id), after.trajectories)| == 1
    {
      var p := (other: Trajectory) => (other.id == entry.id);
      ProofLib.FilterAppend(p, s.trajectories, row);
      if entry == row {
        ProofLib.FilterNone(p, s.trajectories);
      } else {
        assert entry in s.trajectories;
      }
    }
  }
}

lemma recordStep_ensures(s: Trajectories, id: int, kind: StepKind, promptTokens: int, completionTokens: int)
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> alwaysTrajectoryIdentitiesUnique(recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> alwaysStepsBelongToTheirRun(recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> alwaysUsageIsTheSumOfSteps(recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> alwaysEmptyNameHasNoMetadata(recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> alwaysExportedTrajectoryHasEnded(recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> stepStartRequiresPersistence(s, "recordStep", recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> stepPersistenceChangeKeepsTrajectories(s, "recordStep", recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> stepEndedTrajectoryIsSealed(s, recordStep(s, id, kind, promptTokens, completionTokens)))
  ensures (inv(s) ==> canRecordStep(s, id, kind, promptTokens, completionTokens) ==> stepExportOnlyIncludedSources(s, "recordStep", recordStep(s, id, kind, promptTokens, completionTokens)))
{
  if inv(s) && canRecordStep(s, id, kind, promptTokens, completionTokens) {
    var after := recordStep(s, id, kind, promptTokens, completionTokens);
    var i :| 0 <= i < |s.trajectories| && s.trajectories[i].id == id;
    TrajectoryAtIndex(s, id, i);
    TrajectoryIdsPointwise(s, after);
    TrajectoryOthersKept(s, after, id);
    var old_ := s.trajectories[i];
    var x := TrajectoryStep(kind, old_.runId, promptTokens, completionTokens);
    assert old_ in s.trajectories;
    ProofLib.FoldLeftAppend((total: int, stage: TrajectoryStep) => (total + stage.promptTokens), 0, old_.steps, x);
    ProofLib.FoldLeftAppend((total: int, stage: TrajectoryStep) => (total + stage.completionTokens), 0, old_.steps, x);
    forall row | row in after.trajectories
      ensures row.promptTokens == promptSum(row.steps) && row.completionTokens == completionSum(row.steps)
    {
      var j :| 0 <= j < |after.trajectories| && after.trajectories[j] == row;
      assert s.trajectories[j] in s.trajectories;
    }
  }
}

lemma endTrajectory_ensures(s: Trajectories, id: int, ok: bool)
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> alwaysTrajectoryIdentitiesUnique(endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> alwaysStepsBelongToTheirRun(endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> alwaysUsageIsTheSumOfSteps(endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> alwaysEmptyNameHasNoMetadata(endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> alwaysExportedTrajectoryHasEnded(endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> stepStartRequiresPersistence(s, "endTrajectory", endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> stepPersistenceChangeKeepsTrajectories(s, "endTrajectory", endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> stepEndedTrajectoryIsSealed(s, endTrajectory(s, id, ok)))
  ensures (inv(s) ==> canEndTrajectory(s, id, ok) ==> stepExportOnlyIncludedSources(s, "endTrajectory", endTrajectory(s, id, ok)))
{
  if inv(s) && canEndTrajectory(s, id, ok) {
    var after := endTrajectory(s, id, ok);
    var i :| 0 <= i < |s.trajectories| && s.trajectories[i].id == id;
    TrajectoryAtIndex(s, id, i);
    TrajectoryIdsPointwise(s, after);
    TrajectoryOthersKept(s, after, id);
  }
}

lemma exportTrajectory_ensures(s: Trajectories, id: int)
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> alwaysTrajectoryIdentitiesUnique(exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> alwaysStepsBelongToTheirRun(exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> alwaysUsageIsTheSumOfSteps(exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> alwaysEmptyNameHasNoMetadata(exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> alwaysExportedTrajectoryHasEnded(exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> stepStartRequiresPersistence(s, "exportTrajectory", exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> stepPersistenceChangeKeepsTrajectories(s, "exportTrajectory", exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> stepEndedTrajectoryIsSealed(s, exportTrajectory(s, id)))
  ensures (inv(s) ==> canExportTrajectory(s, id) ==> stepExportOnlyIncludedSources(s, "exportTrajectory", exportTrajectory(s, id)))
{
  if inv(s) && canExportTrajectory(s, id) {
    var after := exportTrajectory(s, id);
    var i :| 0 <= i < |s.trajectories| && s.trajectories[i].id == id;
    TrajectoryAtIndex(s, id, i);
    TrajectoryIdsPointwise(s, after);
    forall row | row in s.trajectories && !row.status.Running?
      ensures exists u :: u in after.trajectories && u.id == row.id && u.status == row.status && u.steps == row.steps && u.promptTokens == row.promptTokens && u.completionTokens == row.completionTokens
    {
      var j :| 0 <= j < |s.trajectories| && s.trajectories[j] == row;
      assert after.trajectories[j] in after.trajectories;
    }
    forall row | row in after.trajectories
      ensures !row.exported || !row.status.Running?
      ensures !row.exported || exists b :: b in s.trajectories && b.id == row.id && (b.exported || !excluded(s, b.source))
    {
      var j :| 0 <= j < |after.trajectories| && after.trajectories[j] == row;
      assert s.trajectories[j] in s.trajectories;
    }
  }
}
