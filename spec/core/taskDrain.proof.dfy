// Per-call identity remains stable across asynchronous drain lifecycle steps.

lemma start_ensures(s: TaskDrain, id: int, querySupported: bool, updateSupported: bool, deleteSupported: bool)
  ensures (inv(s) ==> canStart(s, id) ==> alwaysOneCallPerIdentity(start(s, id, querySupported, updateSupported, deleteSupported)))
  ensures (inv(s) ==> canStart(s, id) ==> stepDisposalIsPermanent(s, start(s, id, querySupported, updateSupported, deleteSupported)))
{
  if inv(s) && canStart(s, id) {
    var after := start(s, id, querySupported, updateSupported, deleteSupported);
    DrainIdentityShape(s);
    DrainIdentitiesDistinct(s.calls);
    var added := after.calls[|s.calls|];
    assert after.calls == s.calls + [added] && added.id == id && id > 0;
    ProofLib.DistinctByConcat(s.calls, [added], (call: DrainCall) => call.id);
    DrainIdentitiesDistinct(after.calls);
    DrainIdentityShape(after);
  }
}

lemma registered_ensures(s: TaskDrain, id: int, success: bool, querySupported: bool)
  ensures (inv(s) ==> canRegistered(s, id) ==> alwaysOneCallPerIdentity(registered(s, id, success, querySupported)))
  ensures (inv(s) ==> canRegistered(s, id) ==> stepDisposalIsPermanent(s, registered(s, id, success, querySupported)))
{
  if inv(s) && canRegistered(s, id) {
    var after := registered(s, id, success, querySupported);
    DrainMapIdentities(s, after);
  }
}

lemma lookupCompleted_ensures(s: TaskDrain, id: int, matchingIds: seq<string>, success: bool)
  ensures (inv(s) ==> canLookupCompleted(s, id) ==> alwaysOneCallPerIdentity(lookupCompleted(s, id, matchingIds, success)))
  ensures (inv(s) ==> canLookupCompleted(s, id) ==> stepDisposalIsPermanent(s, lookupCompleted(s, id, matchingIds, success)))
{
  if inv(s) && canLookupCompleted(s, id) {
    var after := lookupCompleted(s, id, matchingIds, success);
    DrainMapIdentities(s, after);
  }
}

lemma duplicatesCompleted_ensures(s: TaskDrain, id: int)
  ensures (inv(s) ==> canDuplicatesCompleted(s, id) ==> alwaysOneCallPerIdentity(duplicatesCompleted(s, id)))
  ensures (inv(s) ==> canDuplicatesCompleted(s, id) ==> stepDisposalIsPermanent(s, duplicatesCompleted(s, id)))
{
  if inv(s) && canDuplicatesCompleted(s, id) {
    var after := duplicatesCompleted(s, id);
    DrainMapIdentities(s, after);
  }
}

lemma created_ensures(s: TaskDrain, id: int, task: string, success: bool)
  ensures (inv(s) ==> canCreated(s, id) ==> alwaysOneCallPerIdentity(created(s, id, task, success)))
  ensures (inv(s) ==> canCreated(s, id) ==> stepDisposalIsPermanent(s, created(s, id, task, success)))
{
  if inv(s) && canCreated(s, id) {
    var after := created(s, id, task, success);
    DrainMapIdentities(s, after);
  }
}

lemma reconcile_ensures(s: TaskDrain, id: int)
  ensures (inv(s) ==> canReconcile(s, id) ==> alwaysOneCallPerIdentity(reconcile(s, id)))
  ensures (inv(s) ==> canReconcile(s, id) ==> stepDisposalIsPermanent(s, reconcile(s, id)))
{
  if inv(s) && canReconcile(s, id) {
    var after := reconcile(s, id);
    DrainMapIdentities(s, after);
  }
}

lemma dispose_ensures(s: TaskDrain, id: int, deleteSupported: bool)
  ensures (inv(s) ==> canDispose(s, id) ==> alwaysOneCallPerIdentity(dispose(s, id, deleteSupported)))
  ensures (inv(s) ==> canDispose(s, id) ==> stepDisposalIsPermanent(s, dispose(s, id, deleteSupported)))
{
  if inv(s) && canDispose(s, id) {
    var after := dispose(s, id, deleteSupported);
    DrainIdentityShape(s);
    DrainIdentitiesDistinct(s.calls);
    var added := after.calls[|s.calls|];
    assert after.calls == s.calls + [added] && added.id == id && id > 0;
    ProofLib.DistinctByConcat(s.calls, [added], (call: DrainCall) => call.id);
    DrainIdentitiesDistinct(after.calls);
    DrainIdentityShape(after);
  }
}

lemma deleted_ensures(s: TaskDrain, id: int, success: bool)
  ensures (inv(s) ==> canDeleted(s, id) ==> alwaysOneCallPerIdentity(deleted(s, id, success)))
  ensures (inv(s) ==> canDeleted(s, id) ==> stepDisposalIsPermanent(s, deleted(s, id, success)))
{
  if inv(s) && canDeleted(s, id) {
    var after := deleted(s, id, success);
    DrainMapIdentities(s, after);
  }
}

lemma updateInterval_ensures(s: TaskDrain, id: int, interval: int, updateSupported: bool)
  ensures (inv(s) ==> canUpdateInterval(s, id) ==> alwaysOneCallPerIdentity(updateInterval(s, id, interval, updateSupported)))
  ensures (inv(s) ==> canUpdateInterval(s, id) ==> stepDisposalIsPermanent(s, updateInterval(s, id, interval, updateSupported)))
{
  if inv(s) && canUpdateInterval(s, id) {
    var after := updateInterval(s, id, interval, updateSupported);
    DrainIdentityShape(s);
    DrainIdentitiesDistinct(s.calls);
    var added := after.calls[|s.calls|];
    assert after.calls == s.calls + [added] && added.id == id && id > 0;
    ProofLib.DistinctByConcat(s.calls, [added], (call: DrainCall) => call.id);
    DrainIdentitiesDistinct(after.calls);
    DrainIdentityShape(after);
  }
}

lemma intervalRead_ensures(s: TaskDrain, id: int, rowExists: bool, bothIntervalsMatch: bool, success: bool)
  ensures (inv(s) ==> canIntervalRead(s, id) ==> alwaysOneCallPerIdentity(intervalRead(s, id, rowExists, bothIntervalsMatch, success)))
  ensures (inv(s) ==> canIntervalRead(s, id) ==> stepDisposalIsPermanent(s, intervalRead(s, id, rowExists, bothIntervalsMatch, success)))
{
  if inv(s) && canIntervalRead(s, id) {
    var after := intervalRead(s, id, rowExists, bothIntervalsMatch, success);
    DrainMapIdentities(s, after);
  }
}

lemma intervalWritten_ensures(s: TaskDrain, id: int, success: bool)
  ensures (inv(s) ==> canIntervalWritten(s, id) ==> alwaysOneCallPerIdentity(intervalWritten(s, id, success)))
  ensures (inv(s) ==> canIntervalWritten(s, id) ==> stepDisposalIsPermanent(s, intervalWritten(s, id, success)))
{
  if inv(s) && canIntervalWritten(s, id) {
    var after := intervalWritten(s, id, success);
    DrainMapIdentities(s, after);
  }
}

lemma DrainIdentityShape(s: TaskDrain)
  ensures alwaysOneCallPerIdentity(s) == (forall call :: call in s.calls ==> call.id > 0 && |ProofLib.Filter((other: DrainCall) => (other.id == call.id), s.calls)| == 1)
{}

lemma DrainIdentitiesDistinct(rows: seq<DrainCall>)
  ensures (forall call :: call in rows ==> |ProofLib.Filter((other: DrainCall) => (other.id == call.id), rows)| == 1) <==> ProofLib.DistinctBy(rows, (call: DrainCall) => call.id)
{
  if forall call :: call in rows ==> |ProofLib.Filter((other: DrainCall) => (other.id == call.id), rows)| == 1 {
    forall i, j | 0 <= i < |rows| && 0 <= j < |rows| && i != j ensures rows[i].id != rows[j].id {
      ProofLib.FilterCountOneIffUnique((other: DrainCall) => (other.id == rows[i].id), rows, (call: DrainCall) => call.id, i);
    }
  } else if ProofLib.DistinctBy(rows, (call: DrainCall) => call.id) {
    forall call | call in rows ensures |ProofLib.Filter((other: DrainCall) => (other.id == call.id), rows)| == 1 {
      var i :| 0 <= i < |rows| && rows[i] == call;
      ProofLib.FilterOne((other: DrainCall) => (other.id == call.id), rows, i);
    }
  }
}

lemma DrainMapIdentities(before: TaskDrain, after: TaskDrain)
  requires alwaysOneCallPerIdentity(before)
  requires |before.calls| == |after.calls|
  requires forall i :: 0 <= i < |before.calls| ==> before.calls[i].id == after.calls[i].id
  ensures alwaysOneCallPerIdentity(after)
{
  DrainIdentityShape(before);
  DrainIdentitiesDistinct(before.calls);
  forall i, j | 0 <= i < |after.calls| && 0 <= j < |after.calls| && i != j ensures after.calls[i].id != after.calls[j].id {}
  DrainIdentitiesDistinct(after.calls);
  DrainIdentityShape(after);
}
