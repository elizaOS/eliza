// Proofs for spec/core/sharedScheduler.md.
// The plan: the drain and the process scheduler keep the rules of their own
// units, because every transition moves each of them by a transition of that
// unit (whose proved _ensures lemmas are called here), except attach, which
// rearms the registry and is proved below. The links are positional: link i
// names query i + 1 and a tick below the serial that no other link names.
// With those facts, fire and advanceQuery keep the tick/query ownership rules.

// ---- Views of rules with ProofLib.Filter ------------------------------------

lemma SsLinksView(s: SharedScheduler)
  ensures alwaysLinksFollowQueries(s) == ((|s.links| == |s.drain.queries|) && !((exists link :: link in s.links && !(((((link.tick > 0) && (link.tick < s.process.serial)) && ((if ((0 <= (link.query - 1)) && ((link.query - 1) < |s.links|)) then s.links[(link.query - 1)] else noLink) == link)) && (|ProofLib.Filter((other: TickQueryLink) => (other.tick == link.tick), s.links)| == 1))))))
{
}

lemma SsTicksView(p: core__processScheduler_ProcessScheduler)
  ensures core__processScheduler_alwaysAllocatedIdentitiesFresh(p) == (((p.serial >= 1) && !((exists task :: task in p.tasks && !((((task.id > 0) && (task.id < p.serial)) && (|ProofLib.Filter((other: core__processScheduler_ProcessEntry) => (other.id == task.id), p.tasks)| == 1)))))) && !((exists tick :: tick in p.ticks && !((((tick.id > 0) && (tick.id < p.serial)) && (|ProofLib.Filter((other: core__processScheduler_TickEntry) => (other.id == tick.id), p.ticks)| == 1))))))
{
}

lemma SsKeysView(d: core__queryDrain_Drain)
  ensures core__queryDrain_alwaysQueryKeysUnique(d) == ((d.nextQuery == (|d.queries| + 1)) && !((exists query :: query in d.queries && !(((((query.key > 0) && (query.key < d.nextQuery)) && ((if ((0 <= (query.key - 1)) && ((query.key - 1) < |d.queries|)) then d.queries[(query.key - 1)] else core__queryDrain_absentQuery).key == query.key)) && (|ProofLib.Filter((other: core__queryDrain_Query) => (other.key == query.key), d.queries)| == 1))))))
{
}

lemma SsDirtyView(d: core__queryDrain_Drain)
  ensures core__queryDrain_alwaysDirtyKeysUnique(d) == !((exists agent :: agent in d.dirtyAgents && !((|ProofLib.Filter((other: string) => (other == agent), d.dirtyAgents)| == 1))))
{
}

lemma SsLinkAtView(s: SharedScheduler, tickId: int)
  ensures linkAt(s, tickId) == (if ((0 <= 0) && (0 < |ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links)|)) then ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links)[0] else noLink)
{
}

lemma SsAdvanceQueryView(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures advanceQuery(s, key, succeeded, resultRows) == s.(drain := core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows), process := settleLinkedTick(s.process, (if ((0 <= 0) && (0 < |ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)|)) then ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0] else noLink), core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows)))
{
}

lemma SsNextPendingView(d: core__queryDrain_Drain)
  ensures core__queryDrain_nextPendingQuery(d) == (if ((0 <= 0) && (0 < |ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), d.queries)|)) then ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), d.queries)[0] else core__queryDrain_absentQuery)
{
}

// ---- The component rules are the component units' inv -----------------------

lemma SsDrainInv(s: SharedScheduler)
  ensures (alwaysDrainKeepsItsRules(s) && alwaysRetiredStorageDrains(s)) == core__queryDrain_inv(s.drain)
{
}

lemma SsProcessInv(s: SharedScheduler)
  ensures alwaysProcessKeepsItsRules(s) == core__processScheduler_inv(s.process)
{
}

// ---- Positional keys, ticks and links -------------------------------------------

lemma SsKeys(d: core__queryDrain_Drain)
  requires core__queryDrain_alwaysQueryKeysUnique(d)
  ensures d.nextQuery == |d.queries| + 1
  ensures forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
{
  SsKeysView(d);
  forall i | 0 <= i < |d.queries| ensures d.queries[i].key == i + 1 {
    var query := d.queries[i];
    assert query in d.queries;
    var j := query.key - 1;
    assert 0 <= j < |d.queries| && d.queries[j].key == query.key;
    if j != i {
      ProofLib.FilterTwo((other: core__queryDrain_Query) => (other.key == query.key), d.queries, i, j);
    }
  }
}

lemma SsTicks(p: core__processScheduler_ProcessScheduler)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(p)
  ensures p.serial >= 1
  ensures forall i :: 0 <= i < |p.ticks| ==> 0 < p.ticks[i].id < p.serial
  ensures forall i, j :: 0 <= i < |p.ticks| && 0 <= j < |p.ticks| && i != j ==> p.ticks[i].id != p.ticks[j].id
{
  SsTicksView(p);
  forall i | 0 <= i < |p.ticks| ensures 0 < p.ticks[i].id < p.serial {
    assert p.ticks[i] in p.ticks;
  }
  forall i, j | 0 <= i < |p.ticks| && 0 <= j < |p.ticks| && i != j ensures p.ticks[i].id != p.ticks[j].id {
    if p.ticks[i].id == p.ticks[j].id {
      var tick := p.ticks[i];
      assert tick in p.ticks;
      ProofLib.FilterTwo((other: core__processScheduler_TickEntry) => (other.id == tick.id), p.ticks, i, j);
    }
  }
}

lemma SsLinksPositional(s: SharedScheduler)
  requires alwaysLinksFollowQueries(s)
  ensures |s.links| == |s.drain.queries|
  ensures forall i :: 0 <= i < |s.links| ==> s.links[i].query == i + 1 && 0 < s.links[i].tick < s.process.serial
  ensures forall i, j :: 0 <= i < |s.links| && 0 <= j < |s.links| && i != j ==> s.links[i].tick != s.links[j].tick
{
  SsLinksView(s);
  forall i, j | 0 <= i < |s.links| && 0 <= j < |s.links| && i != j ensures s.links[i].tick != s.links[j].tick {
    if s.links[i].tick == s.links[j].tick {
      var link := s.links[i];
      assert link in s.links;
      ProofLib.FilterTwo((other: TickQueryLink) => (other.tick == link.tick), s.links, i, j);
    }
  }
  forall i | 0 <= i < |s.links| ensures s.links[i].query == i + 1 && 0 < s.links[i].tick < s.process.serial {
    var link := s.links[i];
    assert link in s.links;
    var j := link.query - 1;
    if 0 <= j < |s.links| {
      assert s.links[j] == link;
      if j != i {
        assert s.links[j].tick == s.links[i].tick;
      }
    } else {
      assert noLink == link;
    }
  }
}

lemma SsLinksOfPositional(t: SharedScheduler)
  requires |t.links| == |t.drain.queries|
  requires forall i :: 0 <= i < |t.links| ==> t.links[i].query == i + 1 && 0 < t.links[i].tick < t.process.serial
  requires forall i, j :: 0 <= i < |t.links| && 0 <= j < |t.links| && i != j ==> t.links[i].tick != t.links[j].tick
  ensures alwaysLinksFollowQueries(t)
{
  SsLinksView(t);
  forall link | link in t.links
    ensures (((link.tick > 0) && (link.tick < t.process.serial)) && ((if ((0 <= (link.query - 1)) && ((link.query - 1) < |t.links|)) then t.links[(link.query - 1)] else noLink) == link)) && (|ProofLib.Filter((other: TickQueryLink) => (other.tick == link.tick), t.links)| == 1)
  {
    var i :| 0 <= i < |t.links| && t.links[i] == link;
    ProofLib.FilterOne((other: TickQueryLink) => (other.tick == link.tick), t.links, i);
  }
}

lemma SsLinksFrame(s: SharedScheduler, t: SharedScheduler)
  requires alwaysLinksFollowQueries(s)
  requires t.links == s.links && |t.drain.queries| == |s.drain.queries| && t.process.serial >= s.process.serial
  ensures alwaysLinksFollowQueries(t)
{
  SsLinksPositional(s);
  SsLinksOfPositional(t);
}

lemma SsLinkAtMember(s: SharedScheduler, tickId: int)
  ensures linkAt(s, tickId) == noLink || (linkAt(s, tickId) in s.links && linkAt(s, tickId).tick == tickId)
{
  SsLinkAtView(s, tickId);
  var f := ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links);
  if 0 < |f| {
    assert f[0] in f;
    ProofLib.FilterMember((link: TickQueryLink) => (link.tick == tickId), s.links, f[0]);
  }
}

lemma SsLinkAt(s: SharedScheduler, i: int)
  requires alwaysLinksFollowQueries(s)
  requires 0 <= i < |s.links|
  ensures linkAt(s, s.links[i].tick) == s.links[i]
{
  SsLinksPositional(s);
  var tickId := s.links[i].tick;
  SsLinkAtView(s, tickId);
  var f := ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links);
  ProofLib.FilterMember((link: TickQueryLink) => (link.tick == tickId), s.links, s.links[i]);
  assert s.links[i] in f;
  assert f[0] in f;
  ProofLib.FilterMember((link: TickQueryLink) => (link.tick == tickId), s.links, f[0]);
  var j :| 0 <= j < |s.links| && s.links[j] == f[0];
}

lemma SsLinkForQuery(s: SharedScheduler, key: int)
  requires alwaysLinksFollowQueries(s)
  requires 1 <= key <= |s.links|
  ensures (if ((0 <= 0) && (0 < |ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)|)) then ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0] else noLink) == s.links[key - 1]
{
  SsLinksPositional(s);
  var f := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links);
  ProofLib.FilterMember((row: TickQueryLink) => (row.query == key), s.links, s.links[key - 1]);
  assert s.links[key - 1] in f;
  assert f[0] in f;
  ProofLib.FilterMember((row: TickQueryLink) => (row.query == key), s.links, f[0]);
  var j :| 0 <= j < |s.links| && s.links[j] == f[0];
}

// ---- Frames for the ownership rules ---------------------------------------------

lemma SsActiveSame(s: SharedScheduler, t: SharedScheduler)
  requires alwaysActiveTickOwnsSameGenerationQuery(s)
  requires t.process.activeTick == s.process.activeTick && t.process.generation == s.process.generation
  requires t.links == s.links && t.drain.queries == s.drain.queries
  ensures alwaysActiveTickOwnsSameGenerationQuery(t)
{
  assert activeLink(t) == activeLink(s);
}

lemma SsCapturedKeepTicks(s: SharedScheduler, t: SharedScheduler)
  requires alwaysCapturedQueryOwnsTick(s)
  requires t.links == s.links && t.drain.queries == s.drain.queries
  requires forall tick :: tick in s.process.ticks ==> tick in t.process.ticks
  ensures alwaysCapturedQueryOwnsTick(t)
{
  forall query | query in t.drain.queries
    ensures (exists link :: link in t.links && ((link.query == query.key) && (exists tick :: tick in t.process.ticks && (((tick.id == link.tick) && (tick.generation == query.generation)) && (tick.completed == query.phase.Done?)))))
  {
    assert query in s.drain.queries;
    var lk :| lk in s.links && lk.query == query.key && (exists tick :: tick in s.process.ticks && tick.id == lk.tick && tick.generation == query.generation && tick.completed == query.phase.Done?);
    var tk :| tk in s.process.ticks && tk.id == lk.tick && tk.generation == query.generation && tk.completed == query.phase.Done?;
    assert tk in t.process.ticks;
  }
}

lemma SsCapturedPointwise(s: SharedScheduler, t: SharedScheduler)
  requires alwaysCapturedQueryOwnsTick(s)
  requires t.links == s.links && t.process.ticks == s.process.ticks && |t.drain.queries| == |s.drain.queries|
  requires forall i :: 0 <= i < |s.drain.queries| ==> t.drain.queries[i].key == s.drain.queries[i].key && t.drain.queries[i].generation == s.drain.queries[i].generation && t.drain.queries[i].phase == s.drain.queries[i].phase
  ensures alwaysCapturedQueryOwnsTick(t)
{
  forall query | query in t.drain.queries
    ensures (exists link :: link in t.links && ((link.query == query.key) && (exists tick :: tick in t.process.ticks && (((tick.id == link.tick) && (tick.generation == query.generation)) && (tick.completed == query.phase.Done?)))))
  {
    var i :| 0 <= i < |t.drain.queries| && t.drain.queries[i] == query;
    var q0 := s.drain.queries[i];
    assert q0 in s.drain.queries;
    var lk :| lk in s.links && lk.query == q0.key && (exists tick :: tick in s.process.ticks && tick.id == lk.tick && tick.generation == q0.generation && tick.completed == q0.phase.Done?);
    var tk :| tk in s.process.ticks && tk.id == lk.tick && tk.generation == q0.generation && tk.completed == q0.phase.Done?;
    assert tk in t.process.ticks;
  }
}

lemma SsCapturedGrow(s: SharedScheduler, t: SharedScheduler, nq: core__queryDrain_Query, nl: TickQueryLink, nt: core__processScheduler_TickEntry)
  requires alwaysCapturedQueryOwnsTick(s)
  requires t.drain.queries == s.drain.queries + [nq] && t.links == s.links + [nl] && t.process.ticks == s.process.ticks + [nt]
  requires nl.query == nq.key && nt.id == nl.tick && nt.generation == nq.generation && nt.completed == nq.phase.Done?
  ensures alwaysCapturedQueryOwnsTick(t)
{
  forall query | query in t.drain.queries
    ensures (exists link :: link in t.links && ((link.query == query.key) && (exists tick :: tick in t.process.ticks && (((tick.id == link.tick) && (tick.generation == query.generation)) && (tick.completed == query.phase.Done?)))))
  {
    if query in s.drain.queries {
      var lk :| lk in s.links && lk.query == query.key && (exists tick :: tick in s.process.ticks && tick.id == lk.tick && tick.generation == query.generation && tick.completed == query.phase.Done?);
      var tk :| tk in s.process.ticks && tk.id == lk.tick && tk.generation == query.generation && tk.completed == query.phase.Done?;
      assert lk in t.links;
      assert tk in t.process.ticks;
    } else {
      assert query == nq;
      assert nl in t.links;
      assert nt in t.process.ticks;
    }
  }
}

// ---- advanceQuery ---------------------------------------------------------------------

// Each of the three steps of advanceQuery rewrites only the query with the key.
lemma SsFinishQueryShape(d: core__queryDrain_Drain, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
  requires 1 <= key <= |d.queries|
  ensures core__queryDrain_finishQuery(d, key, succeeded, resultRows).generation == d.generation
  ensures core__queryDrain_finishQuery(d, key, succeeded, resultRows).activeAdapter == d.activeAdapter
  ensures |core__queryDrain_finishQuery(d, key, succeeded, resultRows).queries| == |d.queries|
  ensures forall i :: 0 <= i < |d.queries| && i != key - 1 ==> core__queryDrain_finishQuery(d, key, succeeded, resultRows).queries[i] == d.queries[i]
  ensures core__queryDrain_finishQuery(d, key, succeeded, resultRows).queries[key - 1].key == key
  ensures core__queryDrain_finishQuery(d, key, succeeded, resultRows).queries[key - 1].generation == d.queries[key - 1].generation
  ensures !core__queryDrain_finishQuery(d, key, succeeded, resultRows).queries[key - 1].phase.Missing?
{
  var e := core__queryDrain_finishQuery(d, key, succeeded, resultRows);
  assert |e.queries| == |d.queries|;
  forall i | 0 <= i < |d.queries| && i != key - 1 ensures e.queries[i] == d.queries[i] {
    assert d.queries[i].key != key;
  }
  assert d.queries[key - 1].key == key;
}

lemma SsDispatchNextShape(d: core__queryDrain_Drain, key: int)
  requires forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
  requires 1 <= key <= |d.queries|
  ensures core__queryDrain_dispatchNext(d, key).generation == d.generation
  ensures core__queryDrain_dispatchNext(d, key).activeAdapter == d.activeAdapter
  ensures |core__queryDrain_dispatchNext(d, key).queries| == |d.queries|
  ensures forall i :: 0 <= i < |d.queries| && i != key - 1 ==> core__queryDrain_dispatchNext(d, key).queries[i] == d.queries[i]
  ensures core__queryDrain_dispatchNext(d, key).queries[key - 1].key == key
  ensures core__queryDrain_dispatchNext(d, key).queries[key - 1].generation == d.queries[key - 1].generation
  ensures !core__queryDrain_dispatchNext(d, key).queries[key - 1].phase.Missing?
{
  var e := core__queryDrain_dispatchNext(d, key);
  assert |e.queries| == |d.queries|;
  forall i | 0 <= i < |d.queries| && i != key - 1 ensures e.queries[i] == d.queries[i] {
    assert d.queries[i].key != key;
  }
  assert d.queries[key - 1].key == key;
}

lemma SsFinishRunShape(d: core__queryDrain_Drain, key: int)
  requires forall i :: 0 <= i < |d.queries| ==> d.queries[i].key == i + 1
  requires 1 <= key <= |d.queries|
  ensures core__queryDrain_finishRun(d, key).generation == d.generation
  ensures core__queryDrain_finishRun(d, key).activeAdapter == d.activeAdapter
  ensures |core__queryDrain_finishRun(d, key).queries| == |d.queries|
  ensures forall i :: 0 <= i < |d.queries| && i != key - 1 ==> core__queryDrain_finishRun(d, key).queries[i] == d.queries[i]
  ensures core__queryDrain_finishRun(d, key).queries[key - 1].key == key
  ensures core__queryDrain_finishRun(d, key).queries[key - 1].generation == d.queries[key - 1].generation
  ensures !core__queryDrain_finishRun(d, key).queries[key - 1].phase.Missing?
{
  var e := core__queryDrain_finishRun(d, key);
  assert |e.queries| == |d.queries|;
  forall i | 0 <= i < |d.queries| && i != key - 1 ensures e.queries[i] == d.queries[i] {
    assert d.queries[i].key != key;
  }
  assert d.queries[key - 1].key == key;
}

lemma SsAdvanceShape(d: core__queryDrain_Drain, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires core__queryDrain_alwaysQueryKeysUnique(d)
  requires core__queryDrain_canAdvanceQuery(d, key)
  ensures 1 <= key <= |d.queries|
  ensures !d.queries[key - 1].phase.Done? && !d.queries[key - 1].phase.Missing?
  ensures core__queryDrain_advanceQuery(d, key, succeeded, resultRows).generation == d.generation
  ensures core__queryDrain_advanceQuery(d, key, succeeded, resultRows).activeAdapter == d.activeAdapter
  ensures |core__queryDrain_advanceQuery(d, key, succeeded, resultRows).queries| == |d.queries|
  ensures forall i :: 0 <= i < |d.queries| && i != key - 1 ==> core__queryDrain_advanceQuery(d, key, succeeded, resultRows).queries[i] == d.queries[i]
  ensures core__queryDrain_advanceQuery(d, key, succeeded, resultRows).queries[key - 1].key == key
  ensures core__queryDrain_advanceQuery(d, key, succeeded, resultRows).queries[key - 1].generation == d.queries[key - 1].generation
  ensures !core__queryDrain_advanceQuery(d, key, succeeded, resultRows).queries[key - 1].phase.Missing?
{
  SsKeys(d);
  var q := core__queryDrain_queryFor(d, key);
  assert q.phase.Querying? || q.phase.Ready? || q.phase.Running?;
  assert 0 <= key - 1 < |d.queries| && q == d.queries[key - 1];
  if core__queryDrain_canFinishQuery(d, key) {
    SsFinishQueryShape(d, key, succeeded, resultRows);
  } else if core__queryDrain_canDispatchNext(d, key) {
    SsDispatchNextShape(d, key);
  } else {
    SsFinishRunShape(d, key);
  }
}

// The tick linked to a query that has not finished is still open.
lemma SsSettleOpen(s: SharedScheduler, key: int)
  requires alwaysCapturedQueryOwnsTick(s) && alwaysLinksFollowQueries(s) && core__queryDrain_alwaysQueryKeysUnique(s.drain)
  requires 1 <= key <= |s.drain.queries|
  requires !s.drain.queries[key - 1].phase.Done?
  ensures core__processScheduler_canFinishTick(s.process, s.links[key - 1].tick)
{
  SsKeys(s.drain);
  SsLinksPositional(s);
  var q0 := s.drain.queries[key - 1];
  assert q0 in s.drain.queries;
  var lk :| lk in s.links && lk.query == q0.key && (exists tick :: tick in s.process.ticks && tick.id == lk.tick && tick.generation == q0.generation && tick.completed == q0.phase.Done?);
  var tk :| tk in s.process.ticks && tk.id == lk.tick && tk.generation == q0.generation && tk.completed == q0.phase.Done?;
  var j :| 0 <= j < |s.links| && s.links[j] == lk;
  assert j == key - 1;
}

lemma SsCapturedSettle(s: SharedScheduler, t: SharedScheduler, key: int)
  requires alwaysCapturedQueryOwnsTick(s) && alwaysLinksFollowQueries(s)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(s.process) && core__queryDrain_alwaysQueryKeysUnique(s.drain)
  requires 1 <= key <= |s.drain.queries|
  requires !s.drain.queries[key - 1].phase.Done?
  requires t.links == s.links && |t.drain.queries| == |s.drain.queries|
  requires forall i :: 0 <= i < |s.drain.queries| && i != key - 1 ==> t.drain.queries[i] == s.drain.queries[i]
  requires t.drain.queries[key - 1].key == key && t.drain.queries[key - 1].generation == s.drain.queries[key - 1].generation
  requires t.process.ticks == (if t.drain.queries[key - 1].phase.Done? then core__processScheduler_finishTick(s.process, s.links[key - 1].tick).ticks else s.process.ticks)
  ensures alwaysCapturedQueryOwnsTick(t)
{
  SsKeys(s.drain);
  SsLinksPositional(s);
  SsTicks(s.process);
  var T := s.links[key - 1].tick;
  forall query | query in t.drain.queries
    ensures (exists link :: link in t.links && ((link.query == query.key) && (exists tick :: tick in t.process.ticks && (((tick.id == link.tick) && (tick.generation == query.generation)) && (tick.completed == query.phase.Done?)))))
  {
    var i :| 0 <= i < |t.drain.queries| && t.drain.queries[i] == query;
    var q0 := s.drain.queries[i];
    assert q0 in s.drain.queries;
    var lk :| lk in s.links && lk.query == q0.key && (exists tick :: tick in s.process.ticks && tick.id == lk.tick && tick.generation == q0.generation && tick.completed == q0.phase.Done?);
    var tk :| tk in s.process.ticks && tk.id == lk.tick && tk.generation == q0.generation && tk.completed == q0.phase.Done?;
    var j :| 0 <= j < |s.links| && s.links[j] == lk;
    assert j == i;
    assert query.key == i + 1;
    var m :| 0 <= m < |s.process.ticks| && s.process.ticks[m] == tk;
    if t.drain.queries[key - 1].phase.Done? {
      var nt := core__processScheduler_finishTick(s.process, T).ticks;
      assert nt[m] == (if tk.id == T then tk.(completed := true) else tk);
      assert nt[m] in t.process.ticks;
      if i != key - 1 {
        assert lk.tick != T;
        assert nt[m] == tk;
      } else {
        assert nt[m] == tk.(completed := true);
      }
    } else {
      assert tk in t.process.ticks;
    }
  }
}

lemma SsActiveSettle(s: SharedScheduler, t: SharedScheduler, key: int)
  requires alwaysActiveTickOwnsSameGenerationQuery(s) && alwaysLinksFollowQueries(s) && core__queryDrain_alwaysQueryKeysUnique(s.drain)
  requires 1 <= key <= |s.drain.queries|
  requires t.links == s.links && |t.drain.queries| == |s.drain.queries|
  requires forall i :: 0 <= i < |s.drain.queries| && i != key - 1 ==> t.drain.queries[i] == s.drain.queries[i]
  requires t.drain.queries[key - 1].generation == s.drain.queries[key - 1].generation && !t.drain.queries[key - 1].phase.Missing?
  requires t.process == (if t.drain.queries[key - 1].phase.Done? then core__processScheduler_finishTick(s.process, s.links[key - 1].tick) else s.process)
  ensures alwaysActiveTickOwnsSameGenerationQuery(t)
  ensures stepOldTickCannotDetachReplacement(s, "advanceQuery", t)
  ensures stepOldTickCannotDetachReplacement(s, "advance", t)
{
  SsKeys(s.drain);
  SsLinksPositional(s);
  var A := s.process.activeTick;
  var T := s.links[key - 1].tick;
  var done := t.drain.queries[key - 1].phase.Done?;
  assert t.process.generation == s.process.generation;
  if A != 0 {
    var la := activeLink(s);
    SsLinkAtMember(s, A);
    assert la == linkAt(s, A);
    assert la.tick == A;
    var j :| 0 <= j < |s.links| && s.links[j] == la;
    assert la.query == j + 1;
    assert core__queryDrain_queryFor(s.drain, la.query) == s.drain.queries[j];
    assert core__queryDrain_queryFor(t.drain, la.query) == t.drain.queries[j];
    if done && A == T {
      assert j == key - 1;
      assert t.process.activeTick == 0;
    } else {
      assert t.process.activeTick == A;
      assert activeLink(t) == la;
      if j == key - 1 {
        assert T == A;
        assert !done;
      } else {
        assert t.drain.queries[j] == s.drain.queries[j];
      }
    }
  } else {
    assert t.process.activeTick == 0;
  }
}

lemma SsAdvanceAll(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires inv(s) && canAdvanceQuery(s, key)
  ensures alwaysLinksFollowQueries(advanceQuery(s, key, succeeded, resultRows))
  ensures alwaysDrainKeepsItsRules(advanceQuery(s, key, succeeded, resultRows))
  ensures alwaysProcessKeepsItsRules(advanceQuery(s, key, succeeded, resultRows))
  ensures alwaysCapturedQueryOwnsTick(advanceQuery(s, key, succeeded, resultRows))
  ensures alwaysRetiredStorageDrains(advanceQuery(s, key, succeeded, resultRows))
  ensures alwaysAdapterGenerationAgrees(advanceQuery(s, key, succeeded, resultRows))
  ensures alwaysActiveTickOwnsSameGenerationQuery(advanceQuery(s, key, succeeded, resultRows))
  ensures stepOldTickCannotDetachReplacement(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows))
  ensures stepOldTickCannotDetachReplacement(s, "advance", advanceQuery(s, key, succeeded, resultRows))
{
  var d := s.drain;
  var e := core__queryDrain_advanceQuery(d, key, succeeded, resultRows);
  SsDrainInv(s);
  SsAdvanceShape(d, key, succeeded, resultRows);
  SsLinksPositional(s);
  SsLinkForQuery(s, key);
  SsAdvanceQueryView(s, key, succeeded, resultRows);
  var L := s.links[key - 1];
  var t := advanceQuery(s, key, succeeded, resultRows);
  assert t == s.(drain := e, process := settleLinkedTick(s.process, L, e));
  core__queryDrain_advanceQuery_ensures(d, key, succeeded, resultRows);
  assert core__queryDrain_inv(e);
  SsSettleOpen(s, key);
  assert L.query == key && L.tick != 0;
  assert core__queryDrain_queryFor(e, key) == e.queries[key - 1];
  assert t.process == (if e.queries[key - 1].phase.Done? then core__processScheduler_finishTick(s.process, L.tick) else s.process);
  SsAdvanceSettled(s, t, key);
}

// What advanceQuery keeps, for any next state of its shape.
lemma SsAdvanceSettled(s: SharedScheduler, t: SharedScheduler, key: int)
  requires inv(s)
  requires 1 <= key <= |s.drain.queries| && !s.drain.queries[key - 1].phase.Done?
  requires core__processScheduler_canFinishTick(s.process, s.links[key - 1].tick)
  requires core__queryDrain_inv(t.drain)
  requires t.links == s.links
  requires t.drain.generation == s.drain.generation && t.drain.activeAdapter == s.drain.activeAdapter
  requires |t.drain.queries| == |s.drain.queries|
  requires forall i :: 0 <= i < |s.drain.queries| && i != key - 1 ==> t.drain.queries[i] == s.drain.queries[i]
  requires t.drain.queries[key - 1].key == key && t.drain.queries[key - 1].generation == s.drain.queries[key - 1].generation
  requires !t.drain.queries[key - 1].phase.Missing?
  requires t.process == (if t.drain.queries[key - 1].phase.Done? then core__processScheduler_finishTick(s.process, s.links[key - 1].tick) else s.process)
  ensures alwaysLinksFollowQueries(t)
  ensures alwaysDrainKeepsItsRules(t)
  ensures alwaysProcessKeepsItsRules(t)
  ensures alwaysCapturedQueryOwnsTick(t)
  ensures alwaysRetiredStorageDrains(t)
  ensures alwaysAdapterGenerationAgrees(t)
  ensures alwaysActiveTickOwnsSameGenerationQuery(t)
  ensures stepOldTickCannotDetachReplacement(s, "advanceQuery", t)
  ensures stepOldTickCannotDetachReplacement(s, "advance", t)
{
  SsDrainInv(s);
  SsProcessInv(s);
  SsDrainInv(t);
  if t.drain.queries[key - 1].phase.Done? {
    core__processScheduler_finishTick_ensures(s.process, s.links[key - 1].tick);
  }
  SsProcessInv(t);
  assert t.process.serial == s.process.serial;
  assert t.process.adapter == s.process.adapter && t.process.generation == s.process.generation;
  SsCapturedSettle(s, t, key);
  SsActiveSettle(s, t, key);
  SsLinksFrame(s, t);
}

lemma SsPendingCan(s: SharedScheduler)
  requires alwaysDrainKeepsItsRules(s) && canAdvance(s)
  ensures canAdvanceQuery(s, core__queryDrain_nextPendingQuery(s.drain).key)
{
  var d := s.drain;
  SsNextPendingView(d);
  SsKeys(d);
  var f := ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), d.queries);
  var n := core__queryDrain_nextPendingQuery(d);
  assert n.key != 0;
  assert 0 < |f|;
  assert n == f[0];
  assert f[0] in f;
  ProofLib.FilterMember((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), d.queries, n);
  var i :| 0 <= i < |d.queries| && d.queries[i] == n;
  assert core__queryDrain_queryFor(d, n.key) == n;
  assert n in d.queries;
}

// ---- fire -----------------------------------------------------------------------------

lemma SsFireIdle(s: SharedScheduler)
  requires inv(s) && canFire(s) && !attachedTickMayCapture(s)
  ensures alwaysLinksFollowQueries(fire(s)) && alwaysDrainKeepsItsRules(fire(s)) && alwaysProcessKeepsItsRules(fire(s)) && alwaysCapturedQueryOwnsTick(fire(s)) && alwaysRetiredStorageDrains(fire(s)) && alwaysActiveTickOwnsSameGenerationQuery(fire(s))
{
  var p1 := core__processScheduler_tick(s.process);
  var t := fire(s);
  assert t == s.(process := p1);
  assert p1.activeTick == s.process.activeTick && p1.serial == s.process.serial && p1.ticks == s.process.ticks && p1.generation == s.process.generation;
  SsProcessInv(s);
  core__processScheduler_tick_ensures(s.process);
  SsProcessInv(t);
  SsDrainInv(s);
  SsDrainInv(t);
  SsLinksFrame(s, t);
  SsCapturedKeepTicks(s, t);
  SsActiveSame(s, t);
}

lemma SsFireEmpty(s: SharedScheduler)
  requires inv(s) && canFire(s) && attachedTickMayCapture(s) && !core__queryDrain_canBeginQuery(s.drain)
  ensures alwaysLinksFollowQueries(fire(s)) && alwaysDrainKeepsItsRules(fire(s)) && alwaysProcessKeepsItsRules(fire(s)) && alwaysCapturedQueryOwnsTick(fire(s)) && alwaysRetiredStorageDrains(fire(s)) && alwaysActiveTickOwnsSameGenerationQuery(fire(s))
{
  var p0 := s.process;
  var n := p0.serial;
  var p1 := core__processScheduler_tick(p0);
  assert p1.activeTick == n && p1.serial == n + 1;
  assert p1.ticks == p0.ticks + [core__processScheduler_TickEntry(n, p0.generation, false)];
  var p2 := core__processScheduler_finishTick(p1, n);
  var d2 := if core__queryDrain_canClearUnregisteredDirty(s.drain) then core__queryDrain_clearUnregisteredDirty(s.drain) else s.drain;
  var t := fire(s);
  assert t == s.(process := p2, drain := d2);
  SsProcessInv(s);
  core__processScheduler_tick_ensures(p0);
  assert p1.ticks[|p0.ticks|] == core__processScheduler_TickEntry(n, p0.generation, false);
  assert p1.ticks[|p0.ticks|] in p1.ticks;
  assert core__processScheduler_canFinishTick(p1, n);
  core__processScheduler_finishTick_ensures(p1, n);
  SsProcessInv(t);
  SsDrainInv(s);
  if core__queryDrain_canClearUnregisteredDirty(s.drain) {
    core__queryDrain_clearUnregisteredDirty_ensures(s.drain);
  }
  SsDrainInv(t);
  assert d2.queries == s.drain.queries;
  SsLinksFrame(s, t);
  SsTicks(p0);
  forall tick | tick in p0.ticks ensures tick in p2.ticks {
    var m :| 0 <= m < |p0.ticks| && p0.ticks[m] == tick;
    assert p1.ticks[m] == tick;
    assert p2.ticks[m] == tick;
  }
  SsCapturedKeepTicks(s, t);
  assert p2.activeTick == 0;
}

lemma SsFireCapture(s: SharedScheduler)
  requires inv(s) && canFire(s) && attachedTickMayCapture(s) && core__queryDrain_canBeginQuery(s.drain)
  ensures alwaysLinksFollowQueries(fire(s)) && alwaysDrainKeepsItsRules(fire(s)) && alwaysProcessKeepsItsRules(fire(s)) && alwaysCapturedQueryOwnsTick(fire(s)) && alwaysRetiredStorageDrains(fire(s)) && alwaysActiveTickOwnsSameGenerationQuery(fire(s))
{
  var p0 := s.process;
  var d0 := s.drain;
  var n := p0.serial;
  var p1 := core__processScheduler_tick(p0);
  var nt := core__processScheduler_TickEntry(n, p0.generation, false);
  assert p1.activeTick == n && p1.serial == n + 1 && p1.generation == p0.generation;
  assert p1.ticks == p0.ticks + [nt];
  var d1 := core__queryDrain_beginQuery(d0);
  var nq := core__queryDrain_Query(d0.nextQuery, d0.generation, core__queryDrain_queryRegistrations(d0), [d0.activeAdapter], core__queryDrain_QueryPhase.Querying, [], core__queryDrain_absentTaskGroup);
  assert d1.queries == d0.queries + [nq];
  var nl := TickQueryLink(n, d0.nextQuery);
  var t := fire(s);
  assert t == s.(process := p1, drain := d1, links := s.links + [nl]);
  SsProcessInv(s);
  core__processScheduler_tick_ensures(p0);
  SsProcessInv(t);
  SsDrainInv(s);
  core__queryDrain_beginQuery_ensures(d0);
  SsDrainInv(t);
  SsKeys(d0);
  SsLinksPositional(s);
  SsTicks(p0);
  var k := |d0.queries|;
  assert |s.links| == k;
  assert |t.links| == |t.drain.queries|;
  forall i | 0 <= i < |t.links| ensures t.links[i].query == i + 1 && 0 < t.links[i].tick < t.process.serial {
    if i < k {
      assert t.links[i] == s.links[i];
    } else {
      assert t.links[i] == nl;
    }
  }
  forall i, j | 0 <= i < |t.links| && 0 <= j < |t.links| && i != j ensures t.links[i].tick != t.links[j].tick {
    if i < k {
      assert t.links[i] == s.links[i];
    }
    if j < k {
      assert t.links[j] == s.links[j];
    }
  }
  SsLinksOfPositional(t);
  assert p0.generation == d0.generation;
  SsCapturedGrow(s, t, nq, nl, nt);
  SsLinkAt(t, k);
  assert t.links[k] == nl;
  assert activeLink(t) == nl;
  assert core__queryDrain_queryFor(t.drain, d0.nextQuery) == nq;
}

// ---- attach: the drain rearms the registry when the timer already exists ---------------

lemma SsDistinctOfCounts(xs: seq<string>)
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

lemma SsCountsOfDistinct(xs: seq<string>)
  requires ProofLib.Distinct(xs)
  ensures !((exists agent :: agent in xs && !((|ProofLib.Filter((other: string) => (other == agent), xs)| == 1))))
{
  forall agent | agent in xs ensures |ProofLib.Filter((other: string) => (other == agent), xs)| == 1 {
    ProofLib.FilterDistinctCountOne((other: string) => (other == agent), xs, agent);
  }
}

lemma SsAddDirty(dirty: seq<string>, agent: string)
  requires ProofLib.Distinct(dirty)
  ensures ProofLib.Distinct(core__queryDrain_addDirty(dirty, agent))
{
  if agent !in dirty {
    var r := dirty + [agent];
    assert core__queryDrain_addDirty(dirty, agent) == r;
    forall i, j | 0 <= i < j < |r| ensures r[i] != r[j] {
      assert r[i] == dirty[i];
      assert dirty[i] in dirty;
      if j < |dirty| {
        assert r[j] == dirty[j];
      }
    }
  }
}

lemma SsRearm(f: (seq<string>, core__queryDrain_Registration) -> seq<string>, acc: seq<string>, xs: seq<core__queryDrain_Registration>)
  requires forall a, e :: f(a, e) == core__queryDrain_addDirty(a, e.agent)
  requires ProofLib.Distinct(acc)
  ensures ProofLib.Distinct(Std.Collections.Seq.FoldLeft(f, acc, xs))
  decreases |xs|
{
  if |xs| > 0 {
    SsAddDirty(acc, xs[0].agent);
    SsRearm(f, f(acc, xs[0]), xs[1..]);
  }
}

lemma SsAttachDrain(s: SharedScheduler, adapter: string)
  requires inv(s) && canAttach(s, adapter)
  ensures core__queryDrain_inv(attach(s, adapter).drain)
{
  var d := s.drain;
  SsDrainInv(s);
  SsProcessInv(s);
  core__queryDrain_startAdapter_ensures(d, adapter);
  var e0 := core__queryDrain_startAdapter(d, adapter);
  assert core__queryDrain_inv(e0);
  var e := core__queryDrain_attachAfterTimerState(s.process.timer, d, adapter);
  assert attach(s, adapter).drain == e;
  if s.process.timer != (d.activeAdapter != "") {
    assert s.process.timer && d.activeAdapter == "";
    assert e == e0.(dirtyAgents := core__queryDrain_rearmRegistry(d));
    SsDirtyView(d);
    SsDistinctOfCounts(d.dirtyAgents);
    SsRearm((dirty: seq<string>, entry: core__queryDrain_Registration) => core__queryDrain_addDirty(dirty, entry.agent), d.dirtyAgents, d.registry);
    SsDirtyView(e);
    SsCountsOfDistinct(e.dirtyAgents);
    assert core__queryDrain_alwaysDirtyKeysUnique(e);
    assert core__queryDrain_alwaysClosedServicesHaveNoQueries(e) == core__queryDrain_alwaysClosedServicesHaveNoQueries(e0);
    assert core__queryDrain_alwaysClosedAdaptersHaveNoQueries(e) == core__queryDrain_alwaysClosedAdaptersHaveNoQueries(e0);
    assert core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(e) == core__queryDrain_alwaysStopReceiptDrainedItsSnapshot(e0);
    assert core__queryDrain_alwaysQueryKeysUnique(e) == core__queryDrain_alwaysQueryKeysUnique(e0);
  } else {
    assert e == e0;
  }
}

// A disposal step changes only the process tasks.
lemma SsDisposalFrame(p: core__processScheduler_ProcessScheduler, succeeded: bool)
  ensures core__processScheduler_advanceDisposal(p, succeeded).ticks == p.ticks
  ensures core__processScheduler_advanceDisposal(p, succeeded).activeTick == p.activeTick
  ensures core__processScheduler_advanceDisposal(p, succeeded).generation == p.generation
  ensures core__processScheduler_advanceDisposal(p, succeeded).serial == p.serial
  ensures core__processScheduler_advanceDisposal(p, succeeded).adapter == p.adapter
{
  var n := core__processScheduler_nextDisposingTask(p);
  if n.phase.ProcessQueued? {
    assert core__processScheduler_advanceDisposal(p, succeeded) == core__processScheduler_enterProcess(p, n.id);
  } else if n.phase.ProcessRunning? {
    assert core__processScheduler_advanceDisposal(p, succeeded) == core__processScheduler_finishProcess(p, n.id, succeeded);
  } else {
    assert core__processScheduler_advanceDisposal(p, succeeded) == core__processScheduler_returnDispose(p, n.id);
  }
}

// ---- Transitions ----------------------------------------------------------------------

lemma advanceQuery_ensures(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysLinksFollowQueries(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysDrainKeepsItsRules(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysProcessKeepsItsRules(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysCapturedQueryOwnsTick(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysRetiredStorageDrains(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysAdapterGenerationAgrees(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysActiveTickOwnsSameGenerationQuery(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> stepOldTickCannotDetachReplacement(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows)))
{
  if inv(s) && canAdvanceQuery(s, key) {
    SsAdvanceAll(s, key, succeeded, resultRows);
  }
}

lemma advance_ensures(s: SharedScheduler, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures (inv(s) ==> canAdvance(s) ==> alwaysLinksFollowQueries(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysDrainKeepsItsRules(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysProcessKeepsItsRules(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysCapturedQueryOwnsTick(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysRetiredStorageDrains(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysAdapterGenerationAgrees(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysActiveTickOwnsSameGenerationQuery(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> stepOldTickCannotDetachReplacement(s, "advance", advance(s, succeeded, resultRows)))
{
  if inv(s) && canAdvance(s) {
    var k := core__queryDrain_nextPendingQuery(s.drain).key;
    SsPendingCan(s);
    assert advance(s, succeeded, resultRows) == advanceQuery(s, k, succeeded, resultRows);
    SsAdvanceAll(s, k, succeeded, resultRows);
  }
}

lemma fire_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canFire(s) ==> alwaysLinksFollowQueries(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysDrainKeepsItsRules(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysProcessKeepsItsRules(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysCapturedQueryOwnsTick(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysRetiredStorageDrains(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysAdapterGenerationAgrees(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysActiveTickOwnsSameGenerationQuery(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> stepOldTickCannotDetachReplacement(s, "fire", fire(s)))
{
  if inv(s) && canFire(s) {
    if attachedTickMayCapture(s) && core__queryDrain_canBeginQuery(s.drain) {
      SsFireCapture(s);
    } else if attachedTickMayCapture(s) {
      SsFireEmpty(s);
    } else {
      SsFireIdle(s);
    }
  }
}

lemma registerRuntime_ensures(s: SharedScheduler, agent: string, service: string)
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysLinksFollowQueries(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysDrainKeepsItsRules(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysProcessKeepsItsRules(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysCapturedQueryOwnsTick(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysRetiredStorageDrains(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysAdapterGenerationAgrees(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysActiveTickOwnsSameGenerationQuery(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> stepOldTickCannotDetachReplacement(s, "registerRuntime", registerRuntime(s, agent, service)))
{
  if inv(s) && canRegisterRuntime(s, agent, service) {
    var t := registerRuntime(s, agent, service);
    SsDrainInv(s);
    core__queryDrain_register_ensures(s.drain, agent, service);
    SsDrainInv(t);
    assert t.drain.queries == s.drain.queries;
    SsActiveSame(s, t);
  }
}

lemma unregisterRuntime_ensures(s: SharedScheduler, agent: string, service: string)
  ensures (inv(s) ==> alwaysLinksFollowQueries(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysDrainKeepsItsRules(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysProcessKeepsItsRules(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysCapturedQueryOwnsTick(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysRetiredStorageDrains(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysAdapterGenerationAgrees(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysActiveTickOwnsSameGenerationQuery(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> stepOldTickCannotDetachReplacement(s, "unregisterRuntime", unregisterRuntime(s, agent, service)))
{
  if inv(s) {
    var t := unregisterRuntime(s, agent, service);
    SsDrainInv(s);
    core__queryDrain_unregister_ensures(s.drain, agent, service);
    SsDrainInv(t);
    assert t.drain.queries == s.drain.queries;
    SsActiveSame(s, t);
  }
}

lemma markDirty_ensures(s: SharedScheduler, agent: string)
  ensures (inv(s) ==> alwaysLinksFollowQueries(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysDrainKeepsItsRules(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysProcessKeepsItsRules(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysCapturedQueryOwnsTick(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysRetiredStorageDrains(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysAdapterGenerationAgrees(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysActiveTickOwnsSameGenerationQuery(markDirty(s, agent)))
  ensures (inv(s) ==> stepOldTickCannotDetachReplacement(s, "markDirty", markDirty(s, agent)))
{
  if inv(s) {
    var t := markDirty(s, agent);
    SsDrainInv(s);
    if core__queryDrain_canMarkDirty(s.drain, agent) {
      core__queryDrain_markDirty_ensures(s.drain, agent);
    } else {
      assert t.drain == s.drain;
    }
    SsDrainInv(t);
  }
}

lemma registerProcess_ensures(s: SharedScheduler, name: string)
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysLinksFollowQueries(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysDrainKeepsItsRules(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysProcessKeepsItsRules(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysCapturedQueryOwnsTick(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysRetiredStorageDrains(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysAdapterGenerationAgrees(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysActiveTickOwnsSameGenerationQuery(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> stepOldTickCannotDetachReplacement(s, "registerProcess", registerProcess(s, name)))
{
  if inv(s) && canRegisterProcess(s, name) {
    SsProcessInv(s);
    core__processScheduler_register_ensures(s.process, name);
    SsProcessInv(registerProcess(s, name));
  }
}

lemma disposeProcess_ensures(s: SharedScheduler, id: int)
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysLinksFollowQueries(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysDrainKeepsItsRules(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysProcessKeepsItsRules(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysCapturedQueryOwnsTick(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysRetiredStorageDrains(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysAdapterGenerationAgrees(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> stepOldTickCannotDetachReplacement(s, "disposeProcess", disposeProcess(s, id)))
{
  if inv(s) && canDisposeProcess(s, id) {
    SsProcessInv(s);
    core__processScheduler_dispose_ensures(s.process, id);
    SsProcessInv(disposeProcess(s, id));
  }
}

lemma enterCallback_ensures(s: SharedScheduler, id: int)
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysLinksFollowQueries(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysDrainKeepsItsRules(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysProcessKeepsItsRules(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysCapturedQueryOwnsTick(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysRetiredStorageDrains(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysAdapterGenerationAgrees(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> stepOldTickCannotDetachReplacement(s, "enterCallback", enterCallback(s, id)))
{
  if inv(s) && canEnterCallback(s, id) {
    SsProcessInv(s);
    core__processScheduler_enterProcess_ensures(s.process, id);
    SsProcessInv(enterCallback(s, id));
  }
}

lemma returnCallback_ensures(s: SharedScheduler, id: int, succeeded: bool)
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysLinksFollowQueries(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysDrainKeepsItsRules(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysProcessKeepsItsRules(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysCapturedQueryOwnsTick(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysRetiredStorageDrains(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysAdapterGenerationAgrees(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> stepOldTickCannotDetachReplacement(s, "returnCallback", returnCallback(s, id, succeeded)))
{
  if inv(s) && canReturnCallback(s, id) {
    SsProcessInv(s);
    core__processScheduler_finishProcess_ensures(s.process, id, succeeded);
    SsProcessInv(returnCallback(s, id, succeeded));
  }
}

lemma advanceDisposal_ensures(s: SharedScheduler, succeeded: bool)
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysLinksFollowQueries(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysDrainKeepsItsRules(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysProcessKeepsItsRules(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysCapturedQueryOwnsTick(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysRetiredStorageDrains(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysAdapterGenerationAgrees(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysActiveTickOwnsSameGenerationQuery(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> stepOldTickCannotDetachReplacement(s, "advanceDisposal", advanceDisposal(s, succeeded)))
{
  if inv(s) && canAdvanceDisposal(s) {
    var t := advanceDisposal(s, succeeded);
    SsProcessInv(s);
    core__processScheduler_advanceDisposal_ensures(s.process, succeeded);
    SsProcessInv(t);
    SsDisposalFrame(s.process, succeeded);
    SsLinksFrame(s, t);
    SsCapturedKeepTicks(s, t);
    SsActiveSame(s, t);
  }
}

lemma attach_ensures(s: SharedScheduler, adapter: string)
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysLinksFollowQueries(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysDrainKeepsItsRules(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysProcessKeepsItsRules(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysCapturedQueryOwnsTick(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysRetiredStorageDrains(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysAdapterGenerationAgrees(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysActiveTickOwnsSameGenerationQuery(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> stepOldTickCannotDetachReplacement(s, "attach", attach(s, adapter)))
{
  if inv(s) && canAttach(s, adapter) {
    SsAttachDrain(s, adapter);
    SsDrainInv(attach(s, adapter));
    SsProcessInv(s);
    core__processScheduler_startAdapter_ensures(s.process, adapter);
    SsProcessInv(attach(s, adapter));
  }
}

lemma handoff_ensures(s: SharedScheduler, oldAdapter: string, replacementAdapter: string)
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysLinksFollowQueries(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysDrainKeepsItsRules(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysProcessKeepsItsRules(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysCapturedQueryOwnsTick(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysRetiredStorageDrains(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysAdapterGenerationAgrees(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysActiveTickOwnsSameGenerationQuery(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> stepOldTickCannotDetachReplacement(s, "handoff", handoff(s, oldAdapter, replacementAdapter)))
{
  if inv(s) && canHandoff(s, oldAdapter, replacementAdapter) {
    var t := handoff(s, oldAdapter, replacementAdapter);
    SsDrainInv(s);
    core__queryDrain_handoff_ensures(s.drain, oldAdapter, replacementAdapter);
    SsDrainInv(t);
    SsProcessInv(s);
    if s.process.adapter == oldAdapter {
      core__processScheduler_startAdapter_ensures(s.process, replacementAdapter);
    }
    SsProcessInv(t);
    assert |t.drain.queries| == |s.drain.queries|;
    forall i | 0 <= i < |s.drain.queries|
      ensures t.drain.queries[i].key == s.drain.queries[i].key && t.drain.queries[i].generation == s.drain.queries[i].generation && t.drain.queries[i].phase == s.drain.queries[i].phase
    {
    }
    assert t.process.ticks == s.process.ticks;
    SsCapturedPointwise(s, t);
  }
}

lemma retireAdapter_ensures(s: SharedScheduler, adapter: string)
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysLinksFollowQueries(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysDrainKeepsItsRules(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysProcessKeepsItsRules(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysCapturedQueryOwnsTick(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysRetiredStorageDrains(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysAdapterGenerationAgrees(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysActiveTickOwnsSameGenerationQuery(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> stepOldTickCannotDetachReplacement(s, "retireAdapter", retireAdapter(s, adapter)))
{
  if inv(s) && canRetireAdapter(s, adapter) {
    var t := retireAdapter(s, adapter);
    SsDrainInv(s);
    core__queryDrain_retireAdapter_ensures(s.drain, adapter);
    SsDrainInv(t);
    SsProcessInv(s);
    if s.process.adapter == adapter {
      core__processScheduler_detachAdapter_ensures(s.process);
    }
    SsProcessInv(t);
  }
}

lemma stop_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canStop(s) ==> alwaysLinksFollowQueries(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysDrainKeepsItsRules(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysProcessKeepsItsRules(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysCapturedQueryOwnsTick(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysRetiredStorageDrains(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysAdapterGenerationAgrees(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysActiveTickOwnsSameGenerationQuery(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepOldTickCannotDetachReplacement(s, "stop", stop(s)))
{
  if inv(s) && canStop(s) {
    var t := stop(s);
    SsDrainInv(s);
    core__queryDrain_stopScheduler_ensures(s.drain);
    SsDrainInv(t);
    SsProcessInv(s);
    core__processScheduler_detachAdapter_ensures(s.process);
    SsProcessInv(t);
  }
}

lemma returnStop_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysLinksFollowQueries(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysDrainKeepsItsRules(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysProcessKeepsItsRules(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysCapturedQueryOwnsTick(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysRetiredStorageDrains(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysAdapterGenerationAgrees(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysActiveTickOwnsSameGenerationQuery(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> stepOldTickCannotDetachReplacement(s, "returnStop", returnStop(s)))
{
  if inv(s) && canReturnStop(s) {
    SsDrainInv(s);
    core__queryDrain_returnStop_ensures(s.drain);
    SsDrainInv(returnStop(s));
  }
}

lemma closeAdapters_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysLinksFollowQueries(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysDrainKeepsItsRules(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysProcessKeepsItsRules(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysCapturedQueryOwnsTick(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysRetiredStorageDrains(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysAdapterGenerationAgrees(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysActiveTickOwnsSameGenerationQuery(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> stepOldTickCannotDetachReplacement(s, "closeAdapters", closeAdapters(s)))
{
  if inv(s) && canCloseAdapters(s) {
    var t := closeAdapters(s);
    SsDrainInv(s);
    core__queryDrain_closeRetiredAdapters_ensures(s.drain);
    SsDrainInv(t);
    assert t.drain.queries == s.drain.queries;
    SsActiveSame(s, t);
  }
}

lemma closeServices_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysLinksFollowQueries(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysDrainKeepsItsRules(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysProcessKeepsItsRules(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysCapturedQueryOwnsTick(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysRetiredStorageDrains(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysAdapterGenerationAgrees(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysActiveTickOwnsSameGenerationQuery(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> stepOldTickCannotDetachReplacement(s, "closeServices", closeServices(s)))
{
  if inv(s) && canCloseServices(s) {
    var t := closeServices(s);
    SsDrainInv(s);
    core__queryDrain_closeRetiredServices_ensures(s.drain);
    SsDrainInv(t);
    assert t.drain.queries == s.drain.queries;
    SsActiveSame(s, t);
  }
}
