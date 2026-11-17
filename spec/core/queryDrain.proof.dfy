// Proofs for spec/core/queryDrain.md.
// The plan: every transition keeps the query list positional (the query at
// index i has key i + 1), keeps dirtyAgents without repeats, and either
// leaves the query list alone, changes one query (finishQuery, dispatchNext,
// finishRun), appends one (beginQuery) or only widens adapters (handoff).
// Frame lemmas below prove the query rules once for each of those shapes.

// ---- Lists without repeats ----------------------------------------------

lemma QdDirtyView(s: Drain)
  ensures alwaysDirtyKeysUnique(s) == !((exists agent :: agent in s.dirtyAgents && !((|ProofLib.Filter((other: string) => (other == agent), s.dirtyAgents)| == 1))))
{
}

lemma QdDistinctOfCounts(xs: seq<string>)
  requires !((exists agent :: agent in xs && !((|ProofLib.Filter((other: string) => (other == agent), xs)| == 1))))
  ensures ProofLib.Distinct(xs)
{
  forall i, j | 0 <= i < j < |xs| ensures xs[i] != xs[j] {
    if xs[i] == xs[j] {
      var agent := xs[i];
      assert agent in xs;
      ProofLib.FilterTwo((other: string) => (other == agent), xs, i, j);
    }
  }
}

lemma QdCountsOfDistinct(xs: seq<string>)
  requires ProofLib.Distinct(xs)
  ensures !((exists agent :: agent in xs && !((|ProofLib.Filter((other: string) => (other == agent), xs)| == 1))))
{
  forall agent | agent in xs ensures |ProofLib.Filter((other: string) => (other == agent), xs)| == 1 {
    ProofLib.FilterDistinctCountOne((other: string) => (other == agent), xs, agent);
  }
}

lemma QdDistinctOfDirty(s: Drain)
  requires alwaysDirtyKeysUnique(s)
  ensures ProofLib.Distinct(s.dirtyAgents)
{
  QdDirtyView(s);
  QdDistinctOfCounts(s.dirtyAgents);
}

lemma QdDirtyOfDistinct(t: Drain)
  requires ProofLib.Distinct(t.dirtyAgents)
  ensures alwaysDirtyKeysUnique(t)
{
  QdDirtyView(t);
  QdCountsOfDistinct(t.dirtyAgents);
}

lemma QdAddDirty(d: seq<string>, a: string)
  requires ProofLib.Distinct(d)
  ensures ProofLib.Distinct(addDirty(d, a))
  ensures forall x :: x in addDirty(d, a) <==> (x in d || x == a)
{
  if a !in d {
    var r := d + [a];
    assert addDirty(d, a) == r;
    forall i, j | 0 <= i < j < |r| ensures r[i] != r[j] {
      assert r[i] == d[i];
      assert d[i] in d;
      if j < |d| {
        assert r[j] == d[j];
      }
    }
  }
}

lemma QdRearm(f: (seq<string>, Registration) -> seq<string>, acc: seq<string>, xs: seq<Registration>)
  requires forall a, e :: f(a, e) == addDirty(a, e.agent)
  requires ProofLib.Distinct(acc)
  ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, xs))
  decreases |xs|
{
  if |xs| > 0 {
    QdAddDirty(acc, xs[0].agent);
    QdRearm(f, f(acc, xs[0]), xs[1..]);
  }
}

lemma QdRearmRegistry(s: Drain)
  requires ProofLib.Distinct(s.dirtyAgents)
  ensures ProofLib.Distinct(rearmRegistry(s))
{
  QdRearm((dirty: seq<string>, entry: Registration) => addDirty(dirty, entry.agent), s.dirtyAgents, s.registry);
}

lemma QdRearmAny(f: (seq<string>, Registration) -> seq<string>, acc: seq<string>)
  requires forall a, e :: f(a, e) == addDirty(a, e.agent)
  requires ProofLib.Distinct(acc)
  ensures forall xs: seq<Registration> :: ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, xs))
{
  forall xs: seq<Registration> ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, xs)) {
    QdRearm(f, acc, xs);
  }
}

lemma QdFilterDistinct(p: string -> bool, xs: seq<string>)
  requires ProofLib.Distinct(xs)
  ensures ProofLib.Distinct(ProofLib.Filter(p, xs))
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    var rest := xs[1..];
    forall i, j | 0 <= i < j < |rest| ensures rest[i] != rest[j] {
      assert rest[i] == xs[i + 1] && rest[j] == xs[j + 1];
    }
    QdFilterDistinct(p, rest);
    var r := ProofLib.Filter(p, xs);
    var rt := ProofLib.Filter(p, rest);
    if p(xs[0]) {
      assert r == [xs[0]] + rt;
      forall i, j | 0 <= i < j < |r| ensures r[i] != r[j] {
        if i == 0 {
          assert r[j] == rt[j - 1];
          assert rt[j - 1] in rt;
          ProofLib.FilterMember(p, rest, rt[j - 1]);
          var m :| 0 <= m < |rest| && rest[m] == rt[j - 1];
          assert rest[m] == xs[m + 1];
        } else {
          assert r[i] == rt[i - 1] && r[j] == rt[j - 1];
        }
      }
    } else {
      assert r == rt;
    }
  }
}

// ---- Set additions written as a filter --------------------------------------

lemma QdAddOne(a: seq<string>, x: string)
  ensures forall y :: y in (a + ProofLib.Filter((set_x: string) => !((set_x in a)), [x])) <==> (y in a || y == x)
{
  forall y ensures y in (a + ProofLib.Filter((set_x: string) => !((set_x in a)), [x])) <==> (y in a || y == x) {
    ProofLib.FilterMember((set_x: string) => !((set_x in a)), [x], y);
  }
}

// ---- Positional query keys -----------------------------------------------------

lemma QdKeysView(s: Drain)
  ensures alwaysQueryKeysUnique(s) == ((s.nextQuery == (|s.queries| + 1)) && !((exists query :: query in s.queries && !(((((query.key > 0) && (query.key < s.nextQuery)) && ((if ((0 <= (query.key - 1)) && ((query.key - 1) < |s.queries|)) then s.queries[(query.key - 1)] else absentQuery).key == query.key)) && (|ProofLib.Filter((other: Query) => (other.key == query.key), s.queries)| == 1))))))
{
}

lemma QdKeysPositional(s: Drain)
  requires alwaysQueryKeysUnique(s)
  ensures s.nextQuery == |s.queries| + 1
  ensures forall i :: 0 <= i < |s.queries| ==> s.queries[i].key == i + 1
{
  QdKeysView(s);
  forall i | 0 <= i < |s.queries| ensures s.queries[i].key == i + 1 {
    var query := s.queries[i];
    assert query in s.queries;
    var j := query.key - 1;
    assert 0 <= j < |s.queries| && s.queries[j].key == query.key;
    if j != i {
      ProofLib.FilterTwo((other: Query) => (other.key == query.key), s.queries, i, j);
    }
  }
}

lemma QdKeysOfPositional(t: Drain)
  requires t.nextQuery == |t.queries| + 1
  requires forall i :: 0 <= i < |t.queries| ==> t.queries[i].key == i + 1
  ensures alwaysQueryKeysUnique(t)
{
  QdKeysView(t);
  forall query | query in t.queries
    ensures (query.key > 0) && (query.key < t.nextQuery) && (if ((0 <= (query.key - 1)) && ((query.key - 1) < |t.queries|)) then t.queries[(query.key - 1)] else absentQuery).key == query.key && |ProofLib.Filter((other: Query) => (other.key == query.key), t.queries)| == 1
  {
    var i :| 0 <= i < |t.queries| && t.queries[i] == query;
    ProofLib.FilterOne((other: Query) => (other.key == query.key), t.queries, i);
  }
}

// queryFor finds the query with that key, whenever its phase is not Missing.
lemma QdQueryFor(s: Drain, key: int)
  requires alwaysQueryKeysUnique(s)
  requires !queryFor(s, key).phase.Missing?
  ensures 1 <= key <= |s.queries|
  ensures queryFor(s, key) == s.queries[key - 1]
  ensures forall i :: 0 <= i < |s.queries| ==> (s.queries[i].key == key <==> i == key - 1)
{
  QdKeysPositional(s);
}

// ---- Frames ------------------------------------------------------------------

// Transitions that leave queries, busy services and stop bookkeeping alone.
lemma QdFrameQueries(s: Drain, t: Drain)
  requires inv(s)
  requires t.queries == s.queries && t.busyServices == s.busyServices && t.nextQuery == s.nextQuery
  ensures alwaysRunningServiceOwnsBusySlot(t) && alwaysRunningServicesAreUnique(t) && alwaysQueryKeysUnique(t) && alwaysReadyHasDispatch(t)
{
  QdKeysView(s);
  QdKeysView(t);
}

lemma QdFrameStop(s: Drain, t: Drain)
  requires inv(s)
  requires t.queries == s.queries && t.nextQuery == s.nextQuery && t.stopReturned == s.stopReturned && t.stopWaiting == s.stopWaiting
  ensures alwaysStopReceiptDrainedItsSnapshot(t) && alwaysStopSnapshotUsesIssuedKeys(t)
{
}

lemma QdFrameIssued(s: Drain, t: Drain)
  requires inv(s)
  requires t.nextQuery == s.nextQuery && t.stopWaiting == s.stopWaiting
  ensures alwaysStopSnapshotUsesIssuedKeys(t)
{
}

lemma QdFrameClosedServices(s: Drain, t: Drain)
  requires inv(s)
  requires t.queries == s.queries && t.busyServices == s.busyServices && t.closedServices == s.closedServices
  ensures alwaysClosedServicesHaveNoQueries(t)
{
  forall c | c in t.closedServices ensures !pendingForService(t, c) && !(c in t.busyServices) {
    assert pendingForService(t, c) == pendingForService(s, c);
  }
}

lemma QdFrameClosedAdapters(s: Drain, t: Drain)
  requires inv(s)
  requires t.queries == s.queries && t.closedAdapters == s.closedAdapters
  ensures alwaysClosedAdaptersHaveNoQueries(t)
{
  forall c | c in t.closedAdapters ensures !pendingForAdapter(t, c) {
    assert pendingForAdapter(t, c) == pendingForAdapter(s, c);
  }
}

lemma QdFrameRetire(s: Drain, t: Drain)
  requires inv(s)
  requires t.closedServices == s.closedServices && t.closedAdapters == s.closedAdapters
  requires forall x :: x in s.retiredServices ==> x in t.retiredServices
  requires forall x :: x in s.retiredAdapters ==> x in t.retiredAdapters
  ensures alwaysCloseRequiresRetirement(t)
{
}

lemma QdFrameActive(s: Drain, t: Drain)
  requires inv(s)
  requires t.activeAdapter == s.activeAdapter && t.closedAdapters == s.closedAdapters && t.retiredAdapters == s.retiredAdapters
  ensures alwaysActiveAdapterIsOpen(t)
{
}

lemma QdFrameDispatch(s: Drain, t: Drain)
  requires t.dispatches == s.dispatches
  ensures stepDispatchUsesCurrentRegistration(s, t)
{
}

// Everything but the dirty list, the registry and the active adapter stays.
lemma QdFrameAll(s: Drain, t: Drain)
  requires inv(s)
  requires t.queries == s.queries && t.busyServices == s.busyServices && t.nextQuery == s.nextQuery
  requires t.stopReturned == s.stopReturned && t.stopWaiting == s.stopWaiting
  requires t.closedServices == s.closedServices && t.closedAdapters == s.closedAdapters
  requires t.retiredServices == s.retiredServices && t.retiredAdapters == s.retiredAdapters
  requires t.dispatches == s.dispatches
  ensures alwaysRunningServiceOwnsBusySlot(t) && alwaysRunningServicesAreUnique(t) && alwaysQueryKeysUnique(t) && alwaysReadyHasDispatch(t)
  ensures alwaysStopReceiptDrainedItsSnapshot(t) && alwaysStopSnapshotUsesIssuedKeys(t)
  ensures alwaysClosedServicesHaveNoQueries(t) && alwaysClosedAdaptersHaveNoQueries(t) && alwaysCloseRequiresRetirement(t)
  ensures stepDispatchUsesCurrentRegistration(s, t)
{
  QdFrameQueries(s, t);
  QdFrameStop(s, t);
  QdFrameClosedServices(s, t);
  QdFrameClosedAdapters(s, t);
  QdFrameRetire(s, t);
  QdFrameDispatch(s, t);
}

// One query, at index k - 1, changes and leaves the Querying phase.
// Each rule has its own lemma, so that each proof stays small.

lemma QdOneKeys(s: Drain, t: Drain, k: int)
  requires alwaysQueryKeysUnique(s)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries| && t.nextQuery == s.nextQuery
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires t.queries[k - 1].key == k
  ensures alwaysQueryKeysUnique(t)
{
  QdKeysPositional(s);
  forall i | 0 <= i < |t.queries| ensures t.queries[i].key == i + 1 {
    if i != k - 1 {
      assert t.queries[i] == s.queries[i];
    }
  }
  QdKeysOfPositional(t);
}

lemma QdOneClosedServices(s: Drain, t: Drain, k: int)
  requires alwaysClosedServicesHaveNoQueries(s)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries| && t.closedServices == s.closedServices
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires !t.queries[k - 1].phase.Querying?
  requires forall c :: c in t.busyServices && c in s.closedServices ==> c in s.busyServices
  ensures alwaysClosedServicesHaveNoQueries(t)
{
  forall c | c in t.closedServices ensures !pendingForService(t, c) && !(c in t.busyServices) {
    assert !pendingForService(s, c) && !(c in s.busyServices);
    if pendingForService(t, c) {
      var q :| q in t.queries && q.phase.Querying? && (exists e :: e in q.captured && e.service == c);
      var i :| 0 <= i < |t.queries| && t.queries[i] == q;
      assert i != k - 1;
      assert s.queries[i] in s.queries;
    }
  }
}

lemma QdOneClosedAdapters(s: Drain, t: Drain, k: int)
  requires alwaysClosedAdaptersHaveNoQueries(s)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries| && t.closedAdapters == s.closedAdapters
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires !t.queries[k - 1].phase.Querying?
  ensures alwaysClosedAdaptersHaveNoQueries(t)
{
  forall c | c in t.closedAdapters ensures !pendingForAdapter(t, c) {
    assert !pendingForAdapter(s, c);
    if pendingForAdapter(t, c) {
      var q :| q in t.queries && q.phase.Querying? && c in q.adapters;
      var i :| 0 <= i < |t.queries| && t.queries[i] == q;
      assert i != k - 1;
      assert s.queries[i] in s.queries;
    }
  }
}

lemma QdOneStop(s: Drain, t: Drain, k: int)
  requires alwaysStopReceiptDrainedItsSnapshot(s)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries| && t.stopReturned == s.stopReturned && t.stopWaiting == s.stopWaiting
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires !t.queries[k - 1].phase.Querying?
  ensures alwaysStopReceiptDrainedItsSnapshot(t)
{
  if t.stopReturned {
    forall q | q in t.queries ensures !(q.key in t.stopWaiting) || !q.phase.Querying? {
      var i :| 0 <= i < |t.queries| && t.queries[i] == q;
      if i != k - 1 {
        assert s.queries[i] in s.queries;
      }
    }
  }
}

lemma QdOneRunningBusy(s: Drain, t: Drain, k: int)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries|
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 && s.queries[i].phase.Running? ==> s.queries[i].running.registered.service in t.busyServices
  requires t.queries[k - 1].phase.Running? ==> t.queries[k - 1].running.registered.service in t.busyServices
  ensures alwaysRunningServiceOwnsBusySlot(t)
{
  forall q | q in t.queries && q.phase.Running? ensures q.running.registered.service in t.busyServices {
    var i :| 0 <= i < |t.queries| && t.queries[i] == q;
    if i != k - 1 {
      assert t.queries[i] == s.queries[i];
    }
  }
}

lemma QdOneRunningUnique(s: Drain, t: Drain, k: int)
  requires alwaysRunningServicesAreUnique(s)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries|
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires t.queries[k - 1].phase.Running? ==> forall i :: 0 <= i < |s.queries| && i != k - 1 && s.queries[i].phase.Running? ==> s.queries[i].running.registered.service != t.queries[k - 1].running.registered.service
  ensures alwaysRunningServicesAreUnique(t)
{
  forall q, o | q in t.queries && q.phase.Running? && o in t.queries && o.phase.Running? && o.running.registered.service == q.running.registered.service
    ensures o.key == q.key
  {
    var i :| 0 <= i < |t.queries| && t.queries[i] == q;
    var j :| 0 <= j < |t.queries| && t.queries[j] == o;
    if i != k - 1 && j != k - 1 {
      assert t.queries[i] == s.queries[i] && t.queries[j] == s.queries[j];
      assert s.queries[i] in s.queries && s.queries[j] in s.queries;
    } else if i != k - 1 {
      assert t.queries[i] == s.queries[i];
    } else if j != k - 1 {
      assert t.queries[j] == s.queries[j];
    }
  }
}

lemma QdOneReady(s: Drain, t: Drain, k: int)
  requires alwaysReadyHasDispatch(s)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries|
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires t.queries[k - 1].phase.Ready? ==> |t.queries[k - 1].remaining| > 0
  ensures alwaysReadyHasDispatch(t)
{
  forall q | q in t.queries && q.phase.Ready? ensures |q.remaining| > 0 {
    var i :| 0 <= i < |t.queries| && t.queries[i] == q;
    if i != k - 1 {
      assert s.queries[i] in s.queries;
    }
  }
}

lemma QdFrameOne(s: Drain, t: Drain, k: int)
  requires inv(s)
  requires 1 <= k <= |s.queries|
  requires |t.queries| == |s.queries| && t.nextQuery == s.nextQuery
  requires t.stopReturned == s.stopReturned && t.stopWaiting == s.stopWaiting
  requires t.closedServices == s.closedServices && t.closedAdapters == s.closedAdapters
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 ==> t.queries[i] == s.queries[i]
  requires t.queries[k - 1].key == k
  requires !t.queries[k - 1].phase.Querying?
  requires t.queries[k - 1].phase.Ready? ==> |t.queries[k - 1].remaining| > 0
  requires forall c :: c in t.busyServices && c in s.closedServices ==> c in s.busyServices
  requires forall i :: 0 <= i < |s.queries| && i != k - 1 && s.queries[i].phase.Running? ==> s.queries[i].running.registered.service in t.busyServices
  requires t.queries[k - 1].phase.Running? ==> t.queries[k - 1].running.registered.service in t.busyServices
  requires t.queries[k - 1].phase.Running? ==> forall i :: 0 <= i < |s.queries| && i != k - 1 && s.queries[i].phase.Running? ==> s.queries[i].running.registered.service != t.queries[k - 1].running.registered.service
  ensures alwaysClosedServicesHaveNoQueries(t) && alwaysStopReceiptDrainedItsSnapshot(t) && alwaysRunningServiceOwnsBusySlot(t) && alwaysRunningServicesAreUnique(t)
  ensures alwaysQueryKeysUnique(t) && alwaysStopSnapshotUsesIssuedKeys(t) && alwaysReadyHasDispatch(t) && alwaysClosedAdaptersHaveNoQueries(t)
{
  QdOneKeys(s, t, k);
  QdOneClosedServices(s, t, k);
  QdOneClosedAdapters(s, t, k);
  QdOneStop(s, t, k);
  QdOneRunningBusy(s, t, k);
  QdOneRunningUnique(s, t, k);
  QdOneReady(s, t, k);
  QdFrameIssued(s, t);
}

// Every query keeps everything but its adapters, which only gain `added`.

lemma QdSameKeys(s: Drain, t: Drain)
  requires alwaysQueryKeysUnique(s)
  requires |t.queries| == |s.queries| && t.nextQuery == s.nextQuery
  requires forall i :: 0 <= i < |s.queries| ==> t.queries[i].key == s.queries[i].key
  ensures alwaysQueryKeysUnique(t)
{
  QdKeysPositional(s);
  forall i | 0 <= i < |t.queries| ensures t.queries[i].key == i + 1 {
    assert t.queries[i].key == s.queries[i].key;
  }
  QdKeysOfPositional(t);
}

lemma QdAdaptersClosedServices(s: Drain, t: Drain)
  requires alwaysClosedServicesHaveNoQueries(s)
  requires |t.queries| == |s.queries| && t.closedServices == s.closedServices && t.busyServices == s.busyServices
  requires forall i :: 0 <= i < |s.queries| ==> t.queries[i].phase == s.queries[i].phase && t.queries[i].captured == s.queries[i].captured
  ensures alwaysClosedServicesHaveNoQueries(t)
{
  forall c | c in t.closedServices ensures !pendingForService(t, c) && !(c in t.busyServices) {
    assert !pendingForService(s, c);
    if pendingForService(t, c) {
      var q :| q in t.queries && q.phase.Querying? && (exists e :: e in q.captured && e.service == c);
      var i :| 0 <= i < |t.queries| && t.queries[i] == q;
      assert s.queries[i] in s.queries;
    }
  }
}

lemma QdAdaptersClosedAdapters(s: Drain, t: Drain, added: string)
  requires alwaysClosedAdaptersHaveNoQueries(s)
  requires |t.queries| == |s.queries| && t.closedAdapters == s.closedAdapters
  requires !(added in s.closedAdapters)
  requires forall i :: 0 <= i < |s.queries| ==> t.queries[i].phase == s.queries[i].phase
  requires forall i, c :: 0 <= i < |s.queries| && c in t.queries[i].adapters ==> c in s.queries[i].adapters || c == added
  ensures alwaysClosedAdaptersHaveNoQueries(t)
{
  forall c | c in t.closedAdapters ensures !pendingForAdapter(t, c) {
    assert !pendingForAdapter(s, c);
    if pendingForAdapter(t, c) {
      var q :| q in t.queries && q.phase.Querying? && c in q.adapters;
      var i :| 0 <= i < |t.queries| && t.queries[i] == q;
      assert c in s.queries[i].adapters;
      assert s.queries[i] in s.queries;
    }
  }
}

lemma QdAdaptersStop(s: Drain, t: Drain)
  requires alwaysStopReceiptDrainedItsSnapshot(s)
  requires |t.queries| == |s.queries| && t.stopReturned == s.stopReturned && t.stopWaiting == s.stopWaiting
  requires forall i :: 0 <= i < |s.queries| ==> t.queries[i].key == s.queries[i].key && t.queries[i].phase == s.queries[i].phase
  ensures alwaysStopReceiptDrainedItsSnapshot(t)
{
  if t.stopReturned {
    forall q | q in t.queries ensures !(q.key in t.stopWaiting) || !q.phase.Querying? {
      var i :| 0 <= i < |t.queries| && t.queries[i] == q;
      assert s.queries[i] in s.queries;
    }
  }
}

lemma QdAdaptersRunning(s: Drain, t: Drain)
  requires alwaysRunningServiceOwnsBusySlot(s) && alwaysRunningServicesAreUnique(s)
  requires |t.queries| == |s.queries| && t.busyServices == s.busyServices
  requires forall i :: 0 <= i < |s.queries| ==> t.queries[i].key == s.queries[i].key && t.queries[i].phase == s.queries[i].phase && t.queries[i].running == s.queries[i].running
  ensures alwaysRunningServiceOwnsBusySlot(t) && alwaysRunningServicesAreUnique(t)
{
  forall q | q in t.queries && q.phase.Running? ensures q.running.registered.service in t.busyServices {
    var i :| 0 <= i < |t.queries| && t.queries[i] == q;
    assert s.queries[i] in s.queries;
  }
  forall q, o | q in t.queries && q.phase.Running? && o in t.queries && o.phase.Running? && o.running.registered.service == q.running.registered.service
    ensures o.key == q.key
  {
    var i :| 0 <= i < |t.queries| && t.queries[i] == q;
    var j :| 0 <= j < |t.queries| && t.queries[j] == o;
    assert s.queries[i] in s.queries && s.queries[j] in s.queries;
  }
}

lemma QdAdaptersReady(s: Drain, t: Drain)
  requires alwaysReadyHasDispatch(s)
  requires |t.queries| == |s.queries|
  requires forall i :: 0 <= i < |s.queries| ==> t.queries[i].phase == s.queries[i].phase && t.queries[i].remaining == s.queries[i].remaining
  ensures alwaysReadyHasDispatch(t)
{
  forall q | q in t.queries && q.phase.Ready? ensures |q.remaining| > 0 {
    var i :| 0 <= i < |t.queries| && t.queries[i] == q;
    assert s.queries[i] in s.queries;
  }
}

lemma QdFrameAdapters(s: Drain, t: Drain, added: string)
  requires inv(s)
  requires |t.queries| == |s.queries| && t.nextQuery == s.nextQuery
  requires t.stopReturned == s.stopReturned && t.stopWaiting == s.stopWaiting
  requires t.closedServices == s.closedServices && t.closedAdapters == s.closedAdapters && t.busyServices == s.busyServices
  requires !(added in s.closedAdapters)
  requires forall i :: 0 <= i < |s.queries| ==> t.queries[i].key == s.queries[i].key && t.queries[i].phase == s.queries[i].phase && t.queries[i].captured == s.queries[i].captured && t.queries[i].running == s.queries[i].running && t.queries[i].remaining == s.queries[i].remaining
  requires forall i, c :: 0 <= i < |s.queries| && c in t.queries[i].adapters ==> c in s.queries[i].adapters || c == added
  ensures alwaysClosedServicesHaveNoQueries(t) && alwaysStopReceiptDrainedItsSnapshot(t) && alwaysRunningServiceOwnsBusySlot(t) && alwaysRunningServicesAreUnique(t)
  ensures alwaysQueryKeysUnique(t) && alwaysStopSnapshotUsesIssuedKeys(t) && alwaysReadyHasDispatch(t) && alwaysClosedAdaptersHaveNoQueries(t)
{
  QdSameKeys(s, t);
  QdAdaptersClosedServices(s, t);
  QdAdaptersClosedAdapters(s, t, added);
  QdAdaptersStop(s, t);
  QdAdaptersRunning(s, t);
  QdAdaptersReady(s, t);
  QdFrameIssued(s, t);
}

// ---- Views of generated filters -------------------------------------------

lemma QdPreserveView(s: Drain)
  ensures dirtyToPreserve(s) == ProofLib.Filter((agent: string) => keepsDirty(s, agent), s.dirtyAgents)
{
}

lemma QdPreserveDistinct(s: Drain)
  requires alwaysDirtyKeysUnique(s)
  ensures ProofLib.Distinct(dirtyToPreserve(s))
{
  QdDistinctOfDirty(s);
  QdPreserveView(s);
  QdFilterDistinct((agent: string) => keepsDirty(s, agent), s.dirtyAgents);
}

lemma QdRegistrationsView(s: Drain)
  ensures |queryRegistrations(s)| == |ProofLib.Filter((agent: string) => eligibleAgent(s, agent), s.dirtyAgents)|
  ensures forall i :: 0 <= i < |queryRegistrations(s)| ==> queryRegistrations(s)[i] == registrationFor(s, ProofLib.Filter((agent: string) => eligibleAgent(s, agent), s.dirtyAgents)[i])
{
}

// A captured registration is eligible, so it is not preserved as dirty.
lemma QdCaptured(s: Drain, e: Registration)
  requires e in queryRegistrations(s)
  ensures !(e.service in s.busyServices) && !(e.service in s.retiredServices)
  ensures !(e.agent in dirtyToPreserve(s))
{
  QdRegistrationsView(s);
  var i :| 0 <= i < |queryRegistrations(s)| && queryRegistrations(s)[i] == e;
  var a := ProofLib.Filter((agent: string) => eligibleAgent(s, agent), s.dirtyAgents)[i];
  assert a in ProofLib.Filter((agent: string) => eligibleAgent(s, agent), s.dirtyAgents);
  ProofLib.FilterMember((agent: string) => eligibleAgent(s, agent), s.dirtyAgents, a);
  assert eligibleAgent(s, a);
  assert e == registrationFor(s, a);
  assert e.agent == a;
  assert !keepsDirty(s, a);
  QdPreserveView(s);
  ProofLib.FilterMember((agent: string) => keepsDirty(s, agent), s.dirtyAgents, a);
}

lemma QdUnregisterView(s: Drain, agent: string, service: string)
  ensures unregister(s, agent, service).retiredServices == s.retiredServices + ProofLib.Filter((set_x: string) => !((set_x in s.retiredServices)), [service])
  ensures unregister(s, agent, service).dirtyAgents == (if (registrationFor(s, agent).service == service) then ProofLib.Filter((dirty: string) => (dirty != agent), s.dirtyAgents) else s.dirtyAgents)
{
}

lemma QdCloseServiceView(s: Drain, service: string)
  ensures closeService(s, service).closedServices == s.closedServices + ProofLib.Filter((set_x: string) => !((set_x in s.closedServices)), [service])
{
}

lemma QdRetireAdapterView(s: Drain, adapter: string)
  ensures retireAdapter(s, adapter).retiredAdapters == s.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.retiredAdapters)), [adapter])
{
}

lemma QdCloseAdapterView(s: Drain, adapter: string)
  ensures closeAdapter(s, adapter).closedAdapters == s.closedAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.closedAdapters)), [adapter])
{
}

lemma QdStopView(s: Drain)
  ensures |stopScheduler(s).stopWaiting| == |ProofLib.Filter((query: Query) => query.phase.Querying?, s.queries)|
  ensures forall i :: 0 <= i < |stopScheduler(s).stopWaiting| ==> stopScheduler(s).stopWaiting[i] == ProofLib.Filter((query: Query) => query.phase.Querying?, s.queries)[i].key
{
}

lemma QdHandoffView(s: Drain, oldAdapter: string, replacementAdapter: string)
  ensures handoff(s, oldAdapter, replacementAdapter).retiredAdapters == s.retiredAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.retiredAdapters)), [oldAdapter])
  ensures |handoff(s, oldAdapter, replacementAdapter).queries| == |s.queries|
  ensures forall i :: 0 <= i < |s.queries| ==> handoff(s, oldAdapter, replacementAdapter).queries[i] == (if (s.queries[i].phase.Querying? && (oldAdapter in s.queries[i].adapters)) then s.queries[i].(adapters := (s.queries[i].adapters + ProofLib.Filter((set_x: string) => !((set_x in s.queries[i].adapters)), [replacementAdapter]))) else s.queries[i])
{
}

lemma QdCloseRetiredServicesView(s: Drain)
  ensures closeRetiredServices(s).closedServices == s.closedServices + ProofLib.Filter((set_x: string) => !((set_x in s.closedServices)), ProofLib.Filter((service: string) => canCloseService(s, service), s.retiredServices))
{
}

lemma QdCloseRetiredAdaptersView(s: Drain)
  ensures closeRetiredAdapters(s).closedAdapters == s.closedAdapters + ProofLib.Filter((set_x: string) => !((set_x in s.closedAdapters)), ProofLib.Filter((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters))
{
}

lemma QdFinishRunView(s: Drain, key: int)
  ensures finishRun(s, key).busyServices == ProofLib.Filter((set_x: string) => !((set_x in [queryFor(s, key).running.registered.service])), s.busyServices)
{
}

lemma QdDispatchBusy(s: Drain, key: int, e: Registration)
  requires canDispatchNext(s, key) && e == queryFor(s, key).remaining[0].registered
  ensures dispatchNext(s, key).busyServices == (if (currentRegistration(s, queryFor(s, key).generation, e) && !((e.service in s.busyServices))) then (s.busyServices + ProofLib.Filter((set_x: string) => !((set_x in s.busyServices)), [e.service])) else s.busyServices)
{
}

lemma QdNextPendingView(s: Drain)
  ensures nextPendingQuery(s) == (if 0 < |ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)| then ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)[0] else absentQuery)
{
}

// ---- Transitions ---------------------------------------------------------------

lemma register_ensures(s: Drain, agent: string, service: string)
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysClosedServicesHaveNoQueries(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysStopReceiptDrainedItsSnapshot(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysActiveAdapterIsOpen(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysRunningServiceOwnsBusySlot(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysRunningServicesAreUnique(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysQueryKeysUnique(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysDirtyKeysUnique(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysCloseRequiresRetirement(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysStopSnapshotUsesIssuedKeys(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysReadyHasDispatch(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> alwaysClosedAdaptersHaveNoQueries(register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> stepDispatchUsesCurrentRegistration(s, register(s, agent, service)))
  ensures (inv(s) ==> canRegister(s, agent, service) ==> stepTakenClearsDirty(s, "register", register(s, agent, service)))
{
  if inv(s) && canRegister(s, agent, service) {
    var t := register(s, agent, service);
    QdDistinctOfDirty(s);
    QdAddDirty(s.dirtyAgents, agent);
    QdDirtyOfDistinct(t);
    QdFrameAll(s, t);
    QdFrameActive(s, t);
  }
}

lemma startAdapter_ensures(s: Drain, adapter: string)
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysClosedServicesHaveNoQueries(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysStopReceiptDrainedItsSnapshot(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysActiveAdapterIsOpen(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysRunningServiceOwnsBusySlot(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysRunningServicesAreUnique(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysQueryKeysUnique(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysDirtyKeysUnique(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysCloseRequiresRetirement(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysStopSnapshotUsesIssuedKeys(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysReadyHasDispatch(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> alwaysClosedAdaptersHaveNoQueries(startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> stepDispatchUsesCurrentRegistration(s, startAdapter(s, adapter)))
  ensures (inv(s) ==> canStartAdapter(s, adapter) ==> stepTakenClearsDirty(s, "startAdapter", startAdapter(s, adapter)))
{
  if inv(s) && canStartAdapter(s, adapter) {
    var t := startAdapter(s, adapter);
    QdDistinctOfDirty(s);
    QdRearmRegistry(s);
    assert t.dirtyAgents == (if s.activeAdapter != "" then rearmRegistry(s) else s.dirtyAgents);
    QdDirtyOfDistinct(t);
    QdFrameAll(s, t);
    assert t.activeAdapter == adapter;
  }
}

lemma clearUnregisteredDirty_ensures(s: Drain)
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysClosedServicesHaveNoQueries(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysStopReceiptDrainedItsSnapshot(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysActiveAdapterIsOpen(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysRunningServiceOwnsBusySlot(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysRunningServicesAreUnique(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysQueryKeysUnique(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysDirtyKeysUnique(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysCloseRequiresRetirement(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysStopSnapshotUsesIssuedKeys(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysReadyHasDispatch(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> alwaysClosedAdaptersHaveNoQueries(clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> stepDispatchUsesCurrentRegistration(s, clearUnregisteredDirty(s)))
  ensures (inv(s) ==> canClearUnregisteredDirty(s) ==> stepTakenClearsDirty(s, "clearUnregisteredDirty", clearUnregisteredDirty(s)))
{
  if inv(s) && canClearUnregisteredDirty(s) {
    var t := clearUnregisteredDirty(s);
    QdPreserveDistinct(s);
    QdDirtyOfDistinct(t);
    QdFrameAll(s, t);
    QdFrameActive(s, t);
  }
}

lemma beginQuery_ensures(s: Drain)
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysClosedServicesHaveNoQueries(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysStopReceiptDrainedItsSnapshot(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysActiveAdapterIsOpen(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysRunningServiceOwnsBusySlot(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysRunningServicesAreUnique(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysQueryKeysUnique(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysDirtyKeysUnique(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysCloseRequiresRetirement(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysStopSnapshotUsesIssuedKeys(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysReadyHasDispatch(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> alwaysClosedAdaptersHaveNoQueries(beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> stepDispatchUsesCurrentRegistration(s, beginQuery(s)))
  ensures (inv(s) ==> canBeginQuery(s) ==> stepTakenClearsDirty(s, "beginQuery", beginQuery(s)))
{
  if inv(s) && canBeginQuery(s) {
    var t := beginQuery(s);
    var captured := queryRegistrations(s);
    var nq := Query(s.nextQuery, s.generation, captured, [s.activeAdapter], QueryPhase.Querying, [], absentTaskGroup);
    assert t.queries == s.queries + [nq];
    QdKeysPositional(s);
    assert t.nextQuery == |t.queries| + 1;
    forall i | 0 <= i < |t.queries| ensures t.queries[i].key == i + 1 {
      if i < |s.queries| {
        assert t.queries[i] == s.queries[i];
      }
    }
    QdKeysOfPositional(t);
    forall e | e in captured
      ensures !(e.service in s.busyServices) && !(e.service in s.retiredServices) && !(e.service in s.closedServices) && !(e.agent in t.dirtyAgents)
    {
      QdCaptured(s, e);
    }
    QdPreserveDistinct(s);
    QdDirtyOfDistinct(t);
    forall c | c in t.closedServices ensures !pendingForService(t, c) && !(c in t.busyServices) {
      assert !pendingForService(s, c) && !(c in s.busyServices);
      if pendingForService(t, c) {
        var q :| q in t.queries && q.phase.Querying? && (exists e :: e in q.captured && e.service == c);
        if q in s.queries {
        } else {
          assert q == nq;
          var e :| e in captured && e.service == c;
          assert c in s.retiredServices;
        }
      }
    }
    forall c | c in t.closedAdapters ensures !pendingForAdapter(t, c) {
      assert !pendingForAdapter(s, c);
      if pendingForAdapter(t, c) {
        var q :| q in t.queries && q.phase.Querying? && c in q.adapters;
        if q in s.queries {
        } else {
          assert q == nq;
          assert c == s.activeAdapter;
        }
      }
    }
    if t.stopReturned {
      forall q | q in t.queries ensures !(q.key in t.stopWaiting) || !q.phase.Querying? {
        if q in s.queries {
        } else {
          assert q == nq;
          assert !(s.nextQuery in s.stopWaiting);
        }
      }
    }
    forall q | q in t.queries && q.phase.Running? ensures q.running.registered.service in t.busyServices {
      assert q in s.queries;
    }
    forall q, o | q in t.queries && q.phase.Running? && o in t.queries && o.phase.Running? && o.running.registered.service == q.running.registered.service
      ensures o.key == q.key
    {
      assert q in s.queries && o in s.queries;
    }
    forall q | q in t.queries && q.phase.Ready? ensures |q.remaining| > 0 {
      assert q in s.queries;
    }
    assert queryFor(t, s.nextQuery) == nq;
    QdFrameDispatch(s, t);
  }
}

lemma markDirty_ensures(s: Drain, agent: string)
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysClosedServicesHaveNoQueries(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysStopReceiptDrainedItsSnapshot(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysActiveAdapterIsOpen(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysRunningServiceOwnsBusySlot(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysRunningServicesAreUnique(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysQueryKeysUnique(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysDirtyKeysUnique(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysCloseRequiresRetirement(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysStopSnapshotUsesIssuedKeys(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysReadyHasDispatch(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> alwaysClosedAdaptersHaveNoQueries(markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> stepDispatchUsesCurrentRegistration(s, markDirty(s, agent)))
  ensures (inv(s) ==> canMarkDirty(s, agent) ==> stepTakenClearsDirty(s, "markDirty", markDirty(s, agent)))
{
  if inv(s) && canMarkDirty(s, agent) {
    var t := markDirty(s, agent);
    QdDistinctOfDirty(s);
    QdAddDirty(s.dirtyAgents, agent);
    QdDirtyOfDistinct(t);
    QdFrameAll(s, t);
    QdFrameActive(s, t);
  }
}

lemma closeService_ensures(s: Drain, service: string)
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysClosedServicesHaveNoQueries(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysStopReceiptDrainedItsSnapshot(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysActiveAdapterIsOpen(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysRunningServiceOwnsBusySlot(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysRunningServicesAreUnique(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysQueryKeysUnique(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysDirtyKeysUnique(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysCloseRequiresRetirement(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysStopSnapshotUsesIssuedKeys(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysReadyHasDispatch(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> alwaysClosedAdaptersHaveNoQueries(closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> stepDispatchUsesCurrentRegistration(s, closeService(s, service)))
  ensures (inv(s) ==> canCloseService(s, service) ==> stepTakenClearsDirty(s, "closeService", closeService(s, service)))
{
  if inv(s) && canCloseService(s, service) {
    var t := closeService(s, service);
    QdCloseServiceView(s, service);
    QdAddOne(s.closedServices, service);
    forall c | c in t.closedServices ensures !pendingForService(t, c) && !(c in t.busyServices) && c in t.retiredServices {
      assert pendingForService(t, c) == pendingForService(s, c);
    }
    QdFrameQueries(s, t);
    QdFrameStop(s, t);
    QdFrameClosedAdapters(s, t);
    QdFrameActive(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma unregister_ensures(s: Drain, agent: string, service: string)
  ensures (inv(s) ==> alwaysClosedServicesHaveNoQueries(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysStopReceiptDrainedItsSnapshot(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysActiveAdapterIsOpen(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysRunningServiceOwnsBusySlot(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysRunningServicesAreUnique(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysQueryKeysUnique(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysDirtyKeysUnique(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysCloseRequiresRetirement(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysStopSnapshotUsesIssuedKeys(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysReadyHasDispatch(unregister(s, agent, service)))
  ensures (inv(s) ==> alwaysClosedAdaptersHaveNoQueries(unregister(s, agent, service)))
  ensures (inv(s) ==> stepDispatchUsesCurrentRegistration(s, unregister(s, agent, service)))
  ensures (inv(s) ==> stepTakenClearsDirty(s, "unregister", unregister(s, agent, service)))
{
  if inv(s) {
    var t := unregister(s, agent, service);
    QdUnregisterView(s, agent, service);
    QdAddOne(s.retiredServices, service);
    QdDistinctOfDirty(s);
    QdFilterDistinct((dirty: string) => (dirty != agent), s.dirtyAgents);
    assert ProofLib.Distinct(t.dirtyAgents);
    QdDirtyOfDistinct(t);
    QdFrameQueries(s, t);
    QdFrameStop(s, t);
    QdFrameClosedServices(s, t);
    QdFrameClosedAdapters(s, t);
    QdFrameRetire(s, t);
    QdFrameActive(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma finishQuery_ensures(s: Drain, key: int, succeeded: bool, resultRows: seq<TaskResult>)
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysClosedServicesHaveNoQueries(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysActiveAdapterIsOpen(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysRunningServiceOwnsBusySlot(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysRunningServicesAreUnique(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysQueryKeysUnique(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysDirtyKeysUnique(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysCloseRequiresRetirement(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysReadyHasDispatch(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> alwaysClosedAdaptersHaveNoQueries(finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> stepDispatchUsesCurrentRegistration(s, finishQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canFinishQuery(s, key) ==> stepTakenClearsDirty(s, "finishQuery", finishQuery(s, key, succeeded, resultRows)))
{
  if inv(s) && canFinishQuery(s, key) {
    var t := finishQuery(s, key, succeeded, resultRows);
    QdQueryFor(s, key);
    var p := s.queries[key - 1];
    assert |t.queries| == |s.queries|;
    forall i | 0 <= i < |s.queries| && i != key - 1 ensures t.queries[i] == s.queries[i] {
    }
    var q := t.queries[key - 1];
    assert !q.phase.Querying? && !q.phase.Running?;
    assert q.phase.Ready? ==> |q.remaining| > 0;
    forall i | 0 <= i < |s.queries| && i != key - 1 && s.queries[i].phase.Running? ensures s.queries[i].running.registered.service in t.busyServices {
      assert s.queries[i] in s.queries;
    }
    QdFrameOne(s, t, key);
    QdDistinctOfDirty(s);
    QdRearmAny((agents: seq<string>, entry: Registration) => addDirty(agents, entry.agent), s.dirtyAgents);
    assert ProofLib.Distinct(t.dirtyAgents);
    QdDirtyOfDistinct(t);
    QdFrameRetire(s, t);
    QdFrameActive(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma finishRun_ensures(s: Drain, key: int)
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysClosedServicesHaveNoQueries(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysActiveAdapterIsOpen(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysRunningServiceOwnsBusySlot(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysRunningServicesAreUnique(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysQueryKeysUnique(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysDirtyKeysUnique(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysCloseRequiresRetirement(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysReadyHasDispatch(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> alwaysClosedAdaptersHaveNoQueries(finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> stepDispatchUsesCurrentRegistration(s, finishRun(s, key)))
  ensures (inv(s) ==> canFinishRun(s, key) ==> stepTakenClearsDirty(s, "finishRun", finishRun(s, key)))
{
  if inv(s) && canFinishRun(s, key) {
    var t := finishRun(s, key);
    QdQueryFor(s, key);
    var p := s.queries[key - 1];
    var own := p.running.registered;
    QdFinishRunView(s, key);
    forall c ensures c in t.busyServices <==> (c in s.busyServices && c != own.service) {
      ProofLib.FilterMember((set_x: string) => !((set_x in [queryFor(s, key).running.registered.service])), s.busyServices, c);
    }
    assert |t.queries| == |s.queries|;
    forall i | 0 <= i < |s.queries| && i != key - 1 ensures t.queries[i] == s.queries[i] {
    }
    var q := t.queries[key - 1];
    assert !q.phase.Querying? && !q.phase.Running?;
    assert q.phase.Ready? ==> |q.remaining| > 0;
    forall i | 0 <= i < |s.queries| && i != key - 1 && s.queries[i].phase.Running? ensures s.queries[i].running.registered.service in t.busyServices {
      var o := s.queries[i];
      assert o in s.queries;
      if o.running.registered.service == own.service {
        assert o.key == p.key;
        assert false;
      }
    }
    QdFrameOne(s, t, key);
    QdDistinctOfDirty(s);
    QdAddDirty(s.dirtyAgents, own.agent);
    assert ProofLib.Distinct(t.dirtyAgents);
    QdDirtyOfDistinct(t);
    QdFrameRetire(s, t);
    QdFrameActive(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma dispatchNext_ensures(s: Drain, key: int)
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysClosedServicesHaveNoQueries(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysActiveAdapterIsOpen(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysRunningServiceOwnsBusySlot(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysRunningServicesAreUnique(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysQueryKeysUnique(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysDirtyKeysUnique(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysCloseRequiresRetirement(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysReadyHasDispatch(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> alwaysClosedAdaptersHaveNoQueries(dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> stepDispatchUsesCurrentRegistration(s, dispatchNext(s, key)))
  ensures (inv(s) ==> canDispatchNext(s, key) ==> stepTakenClearsDirty(s, "dispatchNext", dispatchNext(s, key)))
{
  if inv(s) && canDispatchNext(s, key) {
    var t := dispatchNext(s, key);
    QdQueryFor(s, key);
    var p := s.queries[key - 1];
    var g := p.remaining[0];
    var e := g.registered;
    var accepted := currentRegistration(s, p.generation, e) && !(e.service in s.busyServices);
    QdDispatchBusy(s, key, e);
    QdAddOne(s.busyServices, e.service);
    assert forall c :: c in t.busyServices <==> (c in s.busyServices || (accepted && c == e.service));
    assert |t.queries| == |s.queries|;
    forall i | 0 <= i < |s.queries| && i != key - 1 ensures t.queries[i] == s.queries[i] {
    }
    var q := t.queries[key - 1];
    assert q == p.(remaining := p.remaining[1..], phase := (if accepted then QueryPhase.Running else (if (|p.remaining[1..]| > 0) then QueryPhase.Ready else QueryPhase.Done)), running := (if accepted then g else absentTaskGroup));
    assert q.phase.Running? ==> q.running.registered == e && accepted;
    forall i | 0 <= i < |s.queries| && i != key - 1 && s.queries[i].phase.Running? ensures s.queries[i].running.registered.service in s.busyServices {
      assert s.queries[i] in s.queries;
    }
    QdFrameOne(s, t, key);
    QdFrameRetire(s, t);
    QdFrameActive(s, t);
    if accepted {
      assert t.dispatches == s.dispatches + 1 && t.lastDispatched == e && t.lastDispatchGeneration == s.generation;
      assert registrationFor(s, e.agent) == e;
    } else {
      QdFrameDispatch(s, t);
    }
  }
}

lemma retireAdapter_ensures(s: Drain, adapter: string)
  ensures (inv(s) ==> alwaysClosedServicesHaveNoQueries(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysStopReceiptDrainedItsSnapshot(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysActiveAdapterIsOpen(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysRunningServiceOwnsBusySlot(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysRunningServicesAreUnique(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysQueryKeysUnique(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysDirtyKeysUnique(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysCloseRequiresRetirement(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysStopSnapshotUsesIssuedKeys(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysReadyHasDispatch(retireAdapter(s, adapter)))
  ensures (inv(s) ==> alwaysClosedAdaptersHaveNoQueries(retireAdapter(s, adapter)))
  ensures (inv(s) ==> stepDispatchUsesCurrentRegistration(s, retireAdapter(s, adapter)))
  ensures (inv(s) ==> stepTakenClearsDirty(s, "retireAdapter", retireAdapter(s, adapter)))
{
  if inv(s) {
    var t := retireAdapter(s, adapter);
    QdRetireAdapterView(s, adapter);
    QdAddOne(s.retiredAdapters, adapter);
    QdDistinctOfDirty(s);
    assert ProofLib.Distinct(t.dirtyAgents);
    QdDirtyOfDistinct(t);
    QdFrameQueries(s, t);
    QdFrameStop(s, t);
    QdFrameClosedServices(s, t);
    QdFrameClosedAdapters(s, t);
    QdFrameRetire(s, t);
    QdFrameDispatch(s, t);
    if t.activeAdapter != "" {
      assert t.activeAdapter == s.activeAdapter && s.activeAdapter != adapter;
      assert !(t.activeAdapter in t.retiredAdapters);
    }
  }
}

lemma closeAdapter_ensures(s: Drain, adapter: string)
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysClosedServicesHaveNoQueries(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysStopReceiptDrainedItsSnapshot(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysActiveAdapterIsOpen(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysRunningServiceOwnsBusySlot(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysRunningServicesAreUnique(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysQueryKeysUnique(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysDirtyKeysUnique(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysCloseRequiresRetirement(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysStopSnapshotUsesIssuedKeys(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysReadyHasDispatch(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> alwaysClosedAdaptersHaveNoQueries(closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> stepDispatchUsesCurrentRegistration(s, closeAdapter(s, adapter)))
  ensures (inv(s) ==> canCloseAdapter(s, adapter) ==> stepTakenClearsDirty(s, "closeAdapter", closeAdapter(s, adapter)))
{
  if inv(s) && canCloseAdapter(s, adapter) {
    var t := closeAdapter(s, adapter);
    QdCloseAdapterView(s, adapter);
    QdAddOne(s.closedAdapters, adapter);
    forall c | c in t.closedAdapters ensures !pendingForAdapter(t, c) && c in t.retiredAdapters {
      assert pendingForAdapter(t, c) == pendingForAdapter(s, c);
    }
    if t.activeAdapter != "" {
      assert t.activeAdapter == s.activeAdapter && s.activeAdapter != adapter;
      assert !(t.activeAdapter in t.closedAdapters);
    }
    QdFrameQueries(s, t);
    QdFrameStop(s, t);
    QdFrameClosedServices(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma stopScheduler_ensures(s: Drain)
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysClosedServicesHaveNoQueries(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysStopReceiptDrainedItsSnapshot(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysActiveAdapterIsOpen(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysRunningServiceOwnsBusySlot(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysRunningServicesAreUnique(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysQueryKeysUnique(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysDirtyKeysUnique(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysCloseRequiresRetirement(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysStopSnapshotUsesIssuedKeys(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysReadyHasDispatch(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> alwaysClosedAdaptersHaveNoQueries(stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> stepDispatchUsesCurrentRegistration(s, stopScheduler(s)))
  ensures (inv(s) ==> canStopScheduler(s) ==> stepTakenClearsDirty(s, "stopScheduler", stopScheduler(s)))
{
  if inv(s) && canStopScheduler(s) {
    var t := stopScheduler(s);
    QdStopView(s);
    var waiting := ProofLib.Filter((query: Query) => query.phase.Querying?, s.queries);
    forall k | k in t.stopWaiting ensures k > 0 && k < t.nextQuery {
      var i :| 0 <= i < |t.stopWaiting| && t.stopWaiting[i] == k;
      assert k == waiting[i].key;
      assert waiting[i] in waiting;
      ProofLib.FilterMember((query: Query) => query.phase.Querying?, s.queries, waiting[i]);
      assert waiting[i] in s.queries;
    }
    assert t.dirtyAgents == [];
    QdDirtyOfDistinct(t);
    QdFrameQueries(s, t);
    QdFrameClosedServices(s, t);
    QdFrameClosedAdapters(s, t);
    QdFrameRetire(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma returnStop_ensures(s: Drain)
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysClosedServicesHaveNoQueries(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysStopReceiptDrainedItsSnapshot(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysActiveAdapterIsOpen(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysRunningServiceOwnsBusySlot(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysRunningServicesAreUnique(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysQueryKeysUnique(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysDirtyKeysUnique(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysCloseRequiresRetirement(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysStopSnapshotUsesIssuedKeys(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysReadyHasDispatch(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysClosedAdaptersHaveNoQueries(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> stepDispatchUsesCurrentRegistration(s, returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> stepTakenClearsDirty(s, "returnStop", returnStop(s)))
{
  if inv(s) && canReturnStop(s) {
    var t := returnStop(s);
    QdFrameIssued(s, t);
    QdFrameQueries(s, t);
    QdFrameClosedServices(s, t);
    QdFrameClosedAdapters(s, t);
    QdFrameRetire(s, t);
    QdFrameActive(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma handoff_ensures(s: Drain, oldAdapter: string, replacementAdapter: string)
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysClosedServicesHaveNoQueries(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysStopReceiptDrainedItsSnapshot(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysActiveAdapterIsOpen(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysRunningServiceOwnsBusySlot(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysRunningServicesAreUnique(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysQueryKeysUnique(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysDirtyKeysUnique(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysCloseRequiresRetirement(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysStopSnapshotUsesIssuedKeys(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysReadyHasDispatch(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysClosedAdaptersHaveNoQueries(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> stepDispatchUsesCurrentRegistration(s, handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> stepTakenClearsDirty(s, "handoff", handoff(s, oldAdapter, replacementAdapter)))
{
  if inv(s) && canHandoff(s, oldAdapter, replacementAdapter) {
    var t := handoff(s, oldAdapter, replacementAdapter);
    QdHandoffView(s, oldAdapter, replacementAdapter);
    QdAddOne(s.retiredAdapters, oldAdapter);
    forall i | 0 <= i < |s.queries|
      ensures t.queries[i].key == s.queries[i].key && t.queries[i].phase == s.queries[i].phase && t.queries[i].captured == s.queries[i].captured && t.queries[i].running == s.queries[i].running && t.queries[i].remaining == s.queries[i].remaining
      ensures forall c :: c in t.queries[i].adapters ==> c in s.queries[i].adapters || c == replacementAdapter
    {
      QdAddOne(s.queries[i].adapters, replacementAdapter);
    }
    QdFrameAdapters(s, t, replacementAdapter);
    QdDistinctOfDirty(s);
    QdRearmRegistry(s);
    assert t.dirtyAgents == (if s.activeAdapter == oldAdapter then rearmRegistry(s) else s.dirtyAgents);
    QdDirtyOfDistinct(t);
    QdFrameRetire(s, t);
    QdFrameDispatch(s, t);
    if t.activeAdapter != "" {
      assert !(t.activeAdapter in t.closedAdapters);
      assert !(t.activeAdapter in s.retiredAdapters) && t.activeAdapter != oldAdapter;
      assert !(t.activeAdapter in t.retiredAdapters);
    }
  }
}

lemma closeRetiredServices_ensures(s: Drain)
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysClosedServicesHaveNoQueries(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysStopReceiptDrainedItsSnapshot(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysActiveAdapterIsOpen(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysRunningServiceOwnsBusySlot(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysRunningServicesAreUnique(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysQueryKeysUnique(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysDirtyKeysUnique(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysCloseRequiresRetirement(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysStopSnapshotUsesIssuedKeys(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysReadyHasDispatch(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> alwaysClosedAdaptersHaveNoQueries(closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> stepDispatchUsesCurrentRegistration(s, closeRetiredServices(s)))
  ensures (inv(s) ==> canCloseRetiredServices(s) ==> stepTakenClearsDirty(s, "closeRetiredServices", closeRetiredServices(s)))
{
  if inv(s) && canCloseRetiredServices(s) {
    var t := closeRetiredServices(s);
    QdCloseRetiredServicesView(s);
    var ready := ProofLib.Filter((service: string) => canCloseService(s, service), s.retiredServices);
    forall c | c in t.closedServices ensures c in s.closedServices || (c in s.retiredServices && canCloseService(s, c)) {
      if !(c in s.closedServices) {
        ProofLib.FilterMember((set_x: string) => !((set_x in s.closedServices)), ready, c);
        ProofLib.FilterMember((service: string) => canCloseService(s, service), s.retiredServices, c);
      }
    }
    forall c | c in t.closedServices ensures !pendingForService(t, c) && !(c in t.busyServices) && c in t.retiredServices {
      assert pendingForService(t, c) == pendingForService(s, c);
    }
    QdFrameQueries(s, t);
    QdFrameStop(s, t);
    QdFrameClosedAdapters(s, t);
    QdFrameActive(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma closeRetiredAdapters_ensures(s: Drain)
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysClosedServicesHaveNoQueries(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysStopReceiptDrainedItsSnapshot(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysActiveAdapterIsOpen(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysRunningServiceOwnsBusySlot(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysRunningServicesAreUnique(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysQueryKeysUnique(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysDirtyKeysUnique(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysCloseRequiresRetirement(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysStopSnapshotUsesIssuedKeys(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysReadyHasDispatch(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> alwaysClosedAdaptersHaveNoQueries(closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> stepDispatchUsesCurrentRegistration(s, closeRetiredAdapters(s)))
  ensures (inv(s) ==> canCloseRetiredAdapters(s) ==> stepTakenClearsDirty(s, "closeRetiredAdapters", closeRetiredAdapters(s)))
{
  if inv(s) && canCloseRetiredAdapters(s) {
    var t := closeRetiredAdapters(s);
    QdCloseRetiredAdaptersView(s);
    var ready := ProofLib.Filter((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters);
    forall c | c in t.closedAdapters ensures c in s.closedAdapters || (c in s.retiredAdapters && canCloseAdapter(s, c)) {
      if !(c in s.closedAdapters) {
        ProofLib.FilterMember((set_x: string) => !((set_x in s.closedAdapters)), ready, c);
        ProofLib.FilterMember((adapter: string) => canCloseAdapter(s, adapter), s.retiredAdapters, c);
      }
    }
    forall c | c in t.closedAdapters ensures !pendingForAdapter(t, c) && c in t.retiredAdapters {
      assert pendingForAdapter(t, c) == pendingForAdapter(s, c);
    }
    if t.activeAdapter != "" {
      assert t.activeAdapter == s.activeAdapter && !(s.activeAdapter in s.retiredAdapters) && !(s.activeAdapter in s.closedAdapters);
      assert !(t.activeAdapter in t.closedAdapters);
    }
    QdFrameQueries(s, t);
    QdFrameStop(s, t);
    QdFrameClosedServices(s, t);
    QdFrameDispatch(s, t);
  }
}

lemma advanceQuery_ensures(s: Drain, key: int, succeeded: bool, resultRows: seq<TaskResult>)
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysClosedServicesHaveNoQueries(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysStopReceiptDrainedItsSnapshot(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysActiveAdapterIsOpen(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysRunningServiceOwnsBusySlot(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysRunningServicesAreUnique(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysQueryKeysUnique(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysDirtyKeysUnique(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysCloseRequiresRetirement(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysStopSnapshotUsesIssuedKeys(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysReadyHasDispatch(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysClosedAdaptersHaveNoQueries(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> stepDispatchUsesCurrentRegistration(s, advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> stepTakenClearsDirty(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows)))
{
  if inv(s) && canAdvanceQuery(s, key) {
    if canFinishQuery(s, key) {
      finishQuery_ensures(s, key, succeeded, resultRows);
      assert advanceQuery(s, key, succeeded, resultRows) == finishQuery(s, key, succeeded, resultRows);
    } else if canDispatchNext(s, key) {
      dispatchNext_ensures(s, key);
      assert advanceQuery(s, key, succeeded, resultRows) == dispatchNext(s, key);
    } else {
      finishRun_ensures(s, key);
      assert advanceQuery(s, key, succeeded, resultRows) == finishRun(s, key);
    }
  }
}

lemma advancePending_ensures(s: Drain, succeeded: bool, resultRows: seq<TaskResult>)
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysClosedServicesHaveNoQueries(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysStopReceiptDrainedItsSnapshot(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysActiveAdapterIsOpen(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysRunningServiceOwnsBusySlot(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysRunningServicesAreUnique(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysQueryKeysUnique(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysDirtyKeysUnique(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysCloseRequiresRetirement(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysStopSnapshotUsesIssuedKeys(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysReadyHasDispatch(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> alwaysClosedAdaptersHaveNoQueries(advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> stepDispatchUsesCurrentRegistration(s, advancePending(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvancePending(s) ==> stepTakenClearsDirty(s, "advancePending", advancePending(s, succeeded, resultRows)))
{
  if inv(s) && canAdvancePending(s) {
    var q := nextPendingQuery(s);
    var pending := ProofLib.Filter((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries);
    QdNextPendingView(s);
    assert 0 < |pending| && q == pending[0];
    ProofLib.FilterMember((query: Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries, q);
    assert q in s.queries && (q.phase.Querying? || q.phase.Ready? || q.phase.Running?);
    QdKeysPositional(s);
    var i :| 0 <= i < |s.queries| && s.queries[i] == q;
    assert q.key == i + 1;
    assert queryFor(s, q.key) == q;
    assert canAdvanceQuery(s, q.key);
    advanceQuery_ensures(s, q.key, succeeded, resultRows);
    assert advancePending(s, succeeded, resultRows) == advanceQuery(s, q.key, succeeded, resultRows);
  }
}
