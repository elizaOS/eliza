// spec/pty/policy.md, "Sessions respect capacity, unique ids, and safe stop semantics"

lemma EntriesBridge(pool: PtyPool)
  ensures alwaysPoolIdsUnique(pool) <==> ProofLib.DistinctBy(pool.entries, (b: PoolEntry) => b.sessionId)
{
  var xs := pool.entries;
  assert alwaysPoolIdsUnique(pool) <==> forall a :: a in xs ==> |ProofLib.Filter((b: PoolEntry) => (b.sessionId == a.sessionId), xs)| == 1;
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((b: PoolEntry) => (b.sessionId == xs[i].sessionId), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].sessionId != xs[i].sessionId
  {
    ProofLib.FilterCountOneIffUnique((b: PoolEntry) => (b.sessionId == xs[i].sessionId), xs, (b: PoolEntry) => b.sessionId, i);
  }
  if ProofLib.DistinctBy(xs, (b: PoolEntry) => b.sessionId) {
    forall a | a in xs ensures |ProofLib.Filter((b: PoolEntry) => (b.sessionId == a.sessionId), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == a;
    }
  }
}

lemma startPoolSession_ensures(pool: PtyPool, sessionId: string, cwdConfined: bool)
  ensures (inv(pool) ==> canStartPoolSession(pool, sessionId, cwdConfined) ==> alwaysPoolWithinCapacity(startPoolSession(pool, sessionId, cwdConfined)))
  ensures (inv(pool) ==> canStartPoolSession(pool, sessionId, cwdConfined) ==> alwaysPoolIdsUnique(startPoolSession(pool, sessionId, cwdConfined)))
  ensures (inv(pool) ==> canStartPoolSession(pool, sessionId, cwdConfined) ==> stepPoolEpochMonotonic(pool, startPoolSession(pool, sessionId, cwdConfined)))
{
  if inv(pool) && canStartPoolSession(pool, sessionId, cwdConfined) {
    var after := startPoolSession(pool, sessionId, cwdConfined);
    EntriesBridge(pool);
    EntriesBridge(after);
    ProofLib.DistinctByConcat(pool.entries, [PoolEntry(sessionId, pool.nextEpoch, PoolStatus.PoolLive)], (b: PoolEntry) => b.sessionId);
  }
}

lemma exitPoolSession_ensures(pool: PtyPool, sessionId: string)
  ensures (inv(pool) ==> canExitPoolSession(pool, sessionId) ==> alwaysPoolWithinCapacity(exitPoolSession(pool, sessionId)))
  ensures (inv(pool) ==> canExitPoolSession(pool, sessionId) ==> alwaysPoolIdsUnique(exitPoolSession(pool, sessionId)))
  ensures (inv(pool) ==> canExitPoolSession(pool, sessionId) ==> stepPoolEpochMonotonic(pool, exitPoolSession(pool, sessionId)))
{
  if inv(pool) && canExitPoolSession(pool, sessionId) {
    var after := exitPoolSession(pool, sessionId);
    EntriesBridge(pool);
    EntriesBridge(after);
    assert |after.entries| == |pool.entries|;
    assert forall i :: 0 <= i < |after.entries| ==> after.entries[i].sessionId == pool.entries[i].sessionId;
  }
}

lemma stopPoolSession_ensures(pool: PtyPool, sessionId: string, killSucceeded: bool)
  ensures (inv(pool) ==> canStopPoolSession(pool, sessionId, killSucceeded) ==> alwaysPoolWithinCapacity(stopPoolSession(pool, sessionId, killSucceeded)))
  ensures (inv(pool) ==> canStopPoolSession(pool, sessionId, killSucceeded) ==> alwaysPoolIdsUnique(stopPoolSession(pool, sessionId, killSucceeded)))
  ensures (inv(pool) ==> canStopPoolSession(pool, sessionId, killSucceeded) ==> stepPoolEpochMonotonic(pool, stopPoolSession(pool, sessionId, killSucceeded)))
{
  if inv(pool) && canStopPoolSession(pool, sessionId, killSucceeded) {
    var after := stopPoolSession(pool, sessionId, killSucceeded);
    EntriesBridge(pool);
    EntriesBridge(after);
    var p := (e: PoolEntry) => (e.sessionId != sessionId);
    assert after.entries == ProofLib.Filter(p, pool.entries);
    ProofLib.FilterKeepsDistinctBy(p, pool.entries, (b: PoolEntry) => b.sessionId);
  }
}

lemma reapPoolSession_ensures(pool: PtyPool, sessionId: string)
  ensures (inv(pool) ==> canReapPoolSession(pool, sessionId) ==> alwaysPoolWithinCapacity(reapPoolSession(pool, sessionId)))
  ensures (inv(pool) ==> canReapPoolSession(pool, sessionId) ==> alwaysPoolIdsUnique(reapPoolSession(pool, sessionId)))
  ensures (inv(pool) ==> canReapPoolSession(pool, sessionId) ==> stepPoolEpochMonotonic(pool, reapPoolSession(pool, sessionId)))
{
  if inv(pool) && canReapPoolSession(pool, sessionId) {
    var after := reapPoolSession(pool, sessionId);
    EntriesBridge(pool);
    EntriesBridge(after);
    var p := (e: PoolEntry) => (e.sessionId != sessionId);
    assert after.entries == ProofLib.Filter(p, pool.entries);
    ProofLib.FilterKeepsDistinctBy(p, pool.entries, (b: PoolEntry) => b.sessionId);
  }
}
