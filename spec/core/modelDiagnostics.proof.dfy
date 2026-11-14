lemma PromiseFilters(s: ModelDiagnostics)
  ensures alwaysPromiseIdentity(s) == (forall p :: p in s.promises ==> p.id > 0 && |ProofLib.Filter((other: DiagnosticPromise) => (other.id == p.id), s.promises)| == 1)
{}

lemma PromiseMapPreserves(before: ModelDiagnostics, after: ModelDiagnostics)
  requires inv(before)
  requires |before.promises| == |after.promises|
  requires before.drains == after.drains
  requires forall i :: 0 <= i < |before.promises| ==> before.promises[i].id == after.promises[i].id
  ensures inv(after)
{
  PromiseFilters(before); PromiseFilters(after);
  forall p | p in after.promises
    ensures p.id > 0 && |ProofLib.Filter((other: DiagnosticPromise) => (other.id == p.id), after.promises)| == 1
  {
    var i :| 0 <= i < |after.promises| && after.promises[i] == p;
    ProofLib.FilterLengthPointwise((other: DiagnosticPromise) => (other.id == p.id), (other: DiagnosticPromise) => (other.id == p.id), before.promises, after.promises);
    assert before.promises[i].id == p.id;
  }
  forall d, id | d in after.drains && id in d.batch
    ensures exists p :: p in after.promises && p.id == id
  {
    var existing :| existing in before.promises && existing.id == id;
    var i :| 0 <= i < |before.promises| && before.promises[i] == existing;
    assert after.promises[i] in after.promises;
  }
}

lemma trackWrite_ensures(s: ModelDiagnostics, promiseId: int)
  ensures (inv(s) ==> canTrackWrite(s, promiseId) ==> alwaysPromiseIdentity(trackWrite(s, promiseId)))
  ensures (inv(s) ==> canTrackWrite(s, promiseId) ==> alwaysDrainBatchExists(trackWrite(s, promiseId)))
{
  if inv(s) && canTrackWrite(s, promiseId) {
    var after := trackWrite(s, promiseId);
    if exists p :: p in s.promises && p.id == promiseId {
      PromiseMapPreserves(s, after);
    } else {
      PromiseFilters(s); PromiseFilters(after);
      var added := DiagnosticPromise(promiseId, true, false, "");
      forall p | p in after.promises
        ensures p.id > 0 && |ProofLib.Filter((other: DiagnosticPromise) => (other.id == p.id), after.promises)| == 1
      {
        ProofLib.FilterAppend((other: DiagnosticPromise) => (other.id == p.id), s.promises, added);
        if p.id == promiseId {
          ProofLib.FilterNone((other: DiagnosticPromise) => (other.id == p.id), s.promises);
        } else {
          assert p in s.promises;
        }
      }
      forall d, id | d in after.drains && id in d.batch
        ensures exists p :: p in after.promises && p.id == id
      {
        var existing :| existing in s.promises && existing.id == id;
        assert existing in after.promises;
      }
    }
  }
}

lemma settleWrite_ensures(s: ModelDiagnostics, promiseId: int, errorId: string)
  ensures (inv(s) ==> canSettleWrite(s, promiseId, errorId) ==> alwaysPromiseIdentity(settleWrite(s, promiseId, errorId)))
  ensures (inv(s) ==> canSettleWrite(s, promiseId, errorId) ==> alwaysDrainBatchExists(settleWrite(s, promiseId, errorId)))
{
  if inv(s) && canSettleWrite(s, promiseId, errorId) { PromiseMapPreserves(s, settleWrite(s, promiseId, errorId)); }
}

lemma removeWrite_ensures(s: ModelDiagnostics, promiseId: int)
  ensures (inv(s) ==> canRemoveWrite(s, promiseId) ==> alwaysPromiseIdentity(removeWrite(s, promiseId)))
  ensures (inv(s) ==> canRemoveWrite(s, promiseId) ==> alwaysDrainBatchExists(removeWrite(s, promiseId)))
{
  if inv(s) && canRemoveWrite(s, promiseId) { PromiseMapPreserves(s, removeWrite(s, promiseId)); }
}

lemma SnapshotParts(s: ModelDiagnostics, drainId: int)
  ensures forall i :: 0 <= i < |s.drains| && s.drains[i].id == drainId ==> snapshotDrain(s, drainId).drains[i].batch == (var active := ProofLib.Filter((p: DiagnosticPromise) => p.active, s.promises); seq(|active|, j requires 0 <= j < |active| => active[j].id))
{}

lemma snapshotDrain_ensures(s: ModelDiagnostics, drainId: int)
  ensures (inv(s) ==> canSnapshotDrain(s, drainId) ==> alwaysPromiseIdentity(snapshotDrain(s, drainId)))
  ensures (inv(s) ==> canSnapshotDrain(s, drainId) ==> alwaysDrainBatchExists(snapshotDrain(s, drainId)))
{
  if inv(s) && canSnapshotDrain(s, drainId) {
    var after := snapshotDrain(s, drainId);
    SnapshotParts(s, drainId);
    forall d, id | d in after.drains && id in d.batch
      ensures exists p :: p in after.promises && p.id == id
    {
      var i :| 0 <= i < |after.drains| && after.drains[i] == d;
      if s.drains[i].id == drainId {
        var active := ProofLib.Filter((p: DiagnosticPromise) => p.active, s.promises);
        var j :| 0 <= j < |d.batch| && d.batch[j] == id;
        assert active[j].id == id;
        ProofLib.FilterMember((p: DiagnosticPromise) => p.active, s.promises, active[j]);
      } else {
        assert d == s.drains[i];
      }
    }
  }
}
