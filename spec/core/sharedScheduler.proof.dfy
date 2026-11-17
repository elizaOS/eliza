lemma SharedForwardWitness(s: SharedScheduler, query: core__queryDrain_Query)
  requires alwaysCapturedQueryOwnsTick(s)
  requires query in s.drain.queries
  ensures exists linkIndex: int, tickIndex: int :: 0 <= linkIndex < |s.links| && 0 <= tickIndex < |s.process.ticks| && s.links[linkIndex].query == query.key && s.process.ticks[tickIndex].id == s.links[linkIndex].tick && s.process.ticks[tickIndex].generation == query.generation && s.process.ticks[tickIndex].completed == query.phase.Done?
{
  var link :| link in s.links && link.query == query.key && exists tick :: tick in s.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?;
  var tick :| tick in s.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?;
  var linkIndex :| 0 <= linkIndex < |s.links| && s.links[linkIndex] == link;
  var tickIndex :| 0 <= tickIndex < |s.process.ticks| && s.process.ticks[tickIndex] == tick;
  assert s.links[linkIndex].query == query.key && s.process.ticks[tickIndex].id == s.links[linkIndex].tick && s.process.ticks[tickIndex].generation == query.generation && s.process.ticks[tickIndex].completed == query.phase.Done?;
}

lemma SharedReverseWitness(s: SharedScheduler, link: TickQueryLink)
  requires alwaysLinksNameRetainedOwners(s)
  requires link in s.links
  ensures exists queryIndex: int, tickIndex: int :: 0 <= queryIndex < |s.drain.queries| && 0 <= tickIndex < |s.process.ticks| && s.drain.queries[queryIndex].key == link.query && s.process.ticks[tickIndex].id == link.tick && s.process.ticks[tickIndex].generation == s.drain.queries[queryIndex].generation && s.process.ticks[tickIndex].completed == s.drain.queries[queryIndex].phase.Done?
{
  var query :| query in s.drain.queries && query.key == link.query && exists tick :: tick in s.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?;
  var tick :| tick in s.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?;
  var queryIndex :| 0 <= queryIndex < |s.drain.queries| && s.drain.queries[queryIndex] == query;
  var tickIndex :| 0 <= tickIndex < |s.process.ticks| && s.process.ticks[tickIndex] == tick;
  assert s.drain.queries[queryIndex].key == link.query && s.process.ticks[tickIndex].id == link.tick && s.process.ticks[tickIndex].generation == s.drain.queries[queryIndex].generation && s.process.ticks[tickIndex].completed == s.drain.queries[queryIndex].phase.Done?;
}

lemma SharedSettleTickFrame(process: core__processScheduler_ProcessScheduler, link: TickQueryLink, drain: core__queryDrain_Drain, owned: core__processScheduler_TickEntry)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(process)
  requires owned in process.ticks && owned.id == link.tick && !owned.completed && link.tick > 0
  ensures |settleLinkedTick(process, link, drain).ticks| == |process.ticks|
  ensures forall i :: 0 <= i < |process.ticks| ==> settleLinkedTick(process, link, drain).ticks[i].id == process.ticks[i].id && settleLinkedTick(process, link, drain).ticks[i].generation == process.ticks[i].generation && settleLinkedTick(process, link, drain).ticks[i].completed == (if process.ticks[i].id == link.tick then core__queryDrain_queryFor(drain, link.query).phase.Done? else process.ticks[i].completed)
  ensures settleLinkedTick(process, link, drain).activeTick == (if core__queryDrain_queryFor(drain, link.query).phase.Done? && process.activeTick == link.tick then 0 else process.activeTick)
  ensures !core__queryDrain_queryFor(drain, link.query).phase.Done? ==> settleLinkedTick(process, link, drain) == process
  ensures core__queryDrain_queryFor(drain, link.query).phase.Done? ==> settleLinkedTick(process, link, drain) == core__processScheduler_finishTick(process, link.tick)
{
  SharedTickIdentity(process, owned);
  var done := core__queryDrain_queryFor(drain, link.query).phase.Done?;
  var after := settleLinkedTick(process, link, drain);
  assert core__processScheduler_canFinishTick(process, link.tick);
  if done {
    assert after == core__processScheduler_finishTick(process, link.tick);
  } else {
    assert after == process;
  }
  forall i | 0 <= i < |process.ticks|
    ensures after.ticks[i].id == process.ticks[i].id && after.ticks[i].generation == process.ticks[i].generation && after.ticks[i].completed == (if process.ticks[i].id == link.tick then done else process.ticks[i].completed)
  {
    if process.ticks[i].id == link.tick {
      assert process.ticks[i] == owned && !process.ticks[i].completed;
    }
  }
}

lemma SharedQueryKeysFilter(s: core__queryDrain_Drain)
  ensures core__queryDrain_alwaysQueryKeysUnique(s) == (s.nextQuery == |s.queries| + 1 && forall query :: query in s.queries ==> query.key > 0 && query.key < s.nextQuery && (if 0 <= query.key - 1 < |s.queries| then s.queries[query.key - 1] else core__queryDrain_absentQuery).key == query.key && |ProofLib.Filter((other: core__queryDrain_Query) => (other.key == query.key), s.queries)| == 1)
{
}

lemma SharedQueryKeyAt(s: core__queryDrain_Drain, i: int)
  requires core__queryDrain_alwaysQueryKeysUnique(s)
  requires 0 <= i < |s.queries|
  ensures s.queries[i].key == i + 1
{
  SharedQueryKeysFilter(s);
  var query := s.queries[i];
  var j := query.key - 1;
  assert 0 <= j < |s.queries| && s.queries[j].key == query.key;
  if i != j {
    ProofLib.FilterTwo((other: core__queryDrain_Query) => (other.key == query.key), s.queries, i, j);
  }
}

lemma SharedQueryKeysLayout(s: core__queryDrain_Drain)
  requires core__queryDrain_alwaysQueryKeysUnique(s)
  ensures s.nextQuery == |s.queries| + 1
  ensures forall i :: 0 <= i < |s.queries| ==> s.queries[i].key == i + 1
{
  forall i | 0 <= i < |s.queries|
    ensures s.queries[i].key == i + 1
  {
    SharedQueryKeyAt(s, i);
  }
}

lemma SharedQueryLookup(s: core__queryDrain_Drain, key: int)
  requires core__queryDrain_alwaysQueryKeysUnique(s)
  ensures 0 < key < s.nextQuery ==> core__queryDrain_queryFor(s, key) == s.queries[key - 1] && core__queryDrain_queryFor(s, key).key == key
  ensures !(0 < key < s.nextQuery) ==> core__queryDrain_queryFor(s, key) == core__queryDrain_absentQuery
  ensures forall query :: query in s.queries && query.key == key ==> core__queryDrain_queryFor(s, key) == query
{
  SharedQueryKeysLayout(s);
  forall query | query in s.queries && query.key == key
    ensures core__queryDrain_queryFor(s, key) == query
  {
    var i :| 0 <= i < |s.queries| && s.queries[i] == query;
    assert query.key == i + 1;
  }
}

lemma SharedQueryAdvanceFrame(s: core__queryDrain_Drain, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures |core__queryDrain_advanceQuery(s, key, succeeded, resultRows).queries| == |s.queries|
  ensures forall i :: 0 <= i < |s.queries| ==> core__queryDrain_advanceQuery(s, key, succeeded, resultRows).queries[i].key == s.queries[i].key && core__queryDrain_advanceQuery(s, key, succeeded, resultRows).queries[i].generation == s.queries[i].generation && (s.queries[i].key != key ==> core__queryDrain_advanceQuery(s, key, succeeded, resultRows).queries[i].phase == s.queries[i].phase)
  ensures forall i :: 0 <= i < |s.queries| && !s.queries[i].phase.Missing? ==> !core__queryDrain_advanceQuery(s, key, succeeded, resultRows).queries[i].phase.Missing?
{
  var after := core__queryDrain_advanceQuery(s, key, succeeded, resultRows);
  forall i | 0 <= i < |s.queries|
    ensures after.queries[i].key == s.queries[i].key && after.queries[i].generation == s.queries[i].generation && (s.queries[i].key != key ==> after.queries[i].phase == s.queries[i].phase)
    ensures !s.queries[i].phase.Missing? ==> !after.queries[i].phase.Missing?
  {
    if core__queryDrain_canFinishQuery(s, key) { }
    else if core__queryDrain_canDispatchNext(s, key) { }
  }
}

lemma SharedNextPendingQueryView(s: core__queryDrain_Drain)
  ensures core__queryDrain_nextPendingQuery(s) == (if ((0 <= 0) && (0 < |ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)|)) then
    ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.queries)[0]
  else
    core__queryDrain_absentQuery)
{
}

lemma SharedOwners(s: SharedScheduler)
  ensures alwaysCanonicalOwnersHold(s) == (core__processScheduler_inv(s.process) && core__queryDrain_inv(s.drain))
{}

lemma SharedTickKeys(s: core__processScheduler_ProcessScheduler)
  ensures core__processScheduler_alwaysAllocatedIdentitiesFresh(s) ==> forall tick :: tick in s.ticks ==> tick.id > 0 && tick.id < s.serial && |ProofLib.Filter((other: core__processScheduler_TickEntry) => (other.id == tick.id), s.ticks)| == 1
{}

lemma SharedTickIdentity(s: core__processScheduler_ProcessScheduler, tick: core__processScheduler_TickEntry)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(s) && tick in s.ticks
  ensures forall other :: other in s.ticks && other.id == tick.id ==> other == tick
{
  SharedTickKeys(s);
  var key := (other: core__processScheduler_TickEntry) => (other.id == tick.id);
  var selected := ProofLib.Filter(key, s.ticks);
  ProofLib.FilterMember(key, s.ticks, tick);
  forall other | other in s.ticks && other.id == tick.id ensures other == tick {
    ProofLib.FilterMember(key, s.ticks, other);
    assert |selected| == 1 && tick in selected && other in selected;
  }
}

lemma SharedLinkAtView(s: SharedScheduler, tickId: int)
  ensures linkAt(s, tickId) == (if |ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links)| > 0 then ProofLib.Filter((link: TickQueryLink) => (link.tick == tickId), s.links)[0] else noLink)
{}

lemma SharedLinkAtMember(s: SharedScheduler, tickId: int)
  requires alwaysLineagePartnersAgree(s)
  ensures linkAt(s, tickId).tick != 0 ==> linkAt(s, tickId) in s.links && linkAt(s, tickId).tick == tickId
  ensures forall link :: link in s.links && link.tick == tickId ==> linkAt(s, tickId) == link
{
  SharedLinkAtView(s, tickId);
  var key := (link: TickQueryLink) => (link.tick == tickId);
  var selected := ProofLib.Filter(key, s.links);
  if |selected| > 0 {
    ProofLib.FilterMember(key, s.links, selected[0]);
    forall link | link in s.links && link.tick == tickId ensures linkAt(s, tickId) == link {
      assert selected[0].query == link.query;
    }
  } else {
    ProofLib.FilterNone(key, s.links);
  }
}

lemma SharedPairState(s: SharedScheduler, link: TickQueryLink)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(s.process) && core__queryDrain_alwaysQueryKeysUnique(s.drain)
  requires alwaysLinksNameRetainedOwners(s) && link in s.links
  ensures 0 < link.query < s.drain.nextQuery && 0 < link.tick < s.process.serial
  ensures core__queryDrain_queryFor(s.drain, link.query) in s.drain.queries
  ensures exists tick :: tick in s.process.ticks && tick.id == link.tick && tick.generation == core__queryDrain_queryFor(s.drain, link.query).generation && tick.completed == core__queryDrain_queryFor(s.drain, link.query).phase.Done?
{
  var query :| query in s.drain.queries && query.key == link.query && exists tick :: tick in s.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?;
  SharedQueryLookup(s.drain, link.query);
  assert query == core__queryDrain_queryFor(s.drain, link.query);
  var tick :| tick in s.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?;
}

lemma SharedActiveOwned(s: SharedScheduler)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(s.process) && core__processScheduler_alwaysActiveTickIsOwned(s.process) && core__queryDrain_alwaysQueryKeysUnique(s.drain)
  requires alwaysLinksNameRetainedOwners(s) && alwaysLineagePartnersAgree(s)
  requires s.process.activeTick == 0 || activeLink(s).tick == s.process.activeTick
  requires s.process.activeTick == 0 || !core__queryDrain_queryFor(s.drain, activeLink(s).query).phase.Missing?
  ensures alwaysActiveTickOwnsSameGenerationQuery(s)
{
  if s.process.activeTick != 0 {
    var link := activeLink(s);
    SharedLinkAtMember(s, s.process.activeTick);
    SharedPairState(s, link);
    var owned :| owned in s.process.ticks && owned.id == s.process.activeTick && !owned.completed && owned.generation == s.process.generation;
    SharedTickIdentity(s.process, owned);
    var linked :| linked in s.process.ticks && linked.id == link.tick && linked.generation == core__queryDrain_queryFor(s.drain, link.query).generation && linked.completed == core__queryDrain_queryFor(s.drain, link.query).phase.Done?;
    assert linked == owned;
    assert core__queryDrain_queryFor(s.drain, link.query).phase != core__queryDrain_QueryPhase.Missing;
  }
}

lemma SharedLineageFrameQuery(before: SharedScheduler, after: SharedScheduler, query: core__queryDrain_Query)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && after.drain.queries[i].phase == before.drain.queries[i].phase
  requires |after.process.ticks| >= |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i] == before.process.ticks[i]
  requires query in after.drain.queries
  ensures exists link :: link in after.links && link.query == query.key && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
{
  var i :| 0 <= i < |after.drain.queries| && after.drain.queries[i] == query;
  var prior := before.drain.queries[i];
  assert prior in before.drain.queries;
  SharedForwardWitness(before, prior);
  var li, ti :| 0 <= li < |before.links| && 0 <= ti < |before.process.ticks| && before.links[li].query == prior.key && before.process.ticks[ti].id == before.links[li].tick && before.process.ticks[ti].generation == prior.generation && before.process.ticks[ti].completed == prior.phase.Done?;
  assert after.links[li] == before.links[li] && after.process.ticks[ti] == before.process.ticks[ti];
  assert after.links[li] in after.links && after.process.ticks[ti] in after.process.ticks;
  assert after.links[li].query == query.key && after.process.ticks[ti].id == after.links[li].tick && after.process.ticks[ti].generation == query.generation && after.process.ticks[ti].completed == query.phase.Done?;
}

lemma SharedLineageFrameLink(before: SharedScheduler, after: SharedScheduler, link: TickQueryLink)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && after.drain.queries[i].phase == before.drain.queries[i].phase
  requires |after.process.ticks| >= |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i] == before.process.ticks[i]
  requires link in after.links
  ensures exists query :: query in after.drain.queries && query.key == link.query && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
{

    var prior :| prior in before.drain.queries && prior.key == link.query && exists tick :: tick in before.process.ticks && tick.id == link.tick && tick.generation == prior.generation && tick.completed == prior.phase.Done?;
    var i :| 0 <= i < |before.drain.queries| && before.drain.queries[i] == prior;
    var tick :| tick in before.process.ticks && tick.id == link.tick && tick.generation == prior.generation && tick.completed == prior.phase.Done?;
    var j :| 0 <= j < |before.process.ticks| && before.process.ticks[j] == tick;
    assert after.process.ticks[j] == tick && tick in after.process.ticks;
    assert after.drain.queries[i] in after.drain.queries;

}

lemma SharedLineageFrame(before: SharedScheduler, after: SharedScheduler)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && after.drain.queries[i].phase == before.drain.queries[i].phase
  requires |after.process.ticks| >= |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i] == before.process.ticks[i]
  ensures alwaysCapturedQueryOwnsTick(after) && alwaysLinksNameRetainedOwners(after) && alwaysLineagePartnersAgree(after)
{
  forall query | query in after.drain.queries
    ensures exists link :: link in after.links && link.query == query.key && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
  {
    SharedLineageFrameQuery(before, after, query);
  }
  forall link | link in after.links
    ensures exists query :: query in after.drain.queries && query.key == link.query && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
  {
    SharedLineageFrameLink(before, after, link);
  }
}

lemma SharedStaticFrame(before: SharedScheduler, after: SharedScheduler)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires alwaysActiveTickOwnsSameGenerationQuery(before)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(before.process) && core__queryDrain_alwaysQueryKeysUnique(before.drain)
  requires core__processScheduler_inv(after.process) && core__queryDrain_inv(after.drain)
  requires alwaysAdapterGenerationAgrees(after)
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && after.drain.queries[i].phase == before.drain.queries[i].phase
  requires |after.process.ticks| >= |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i] == before.process.ticks[i]
  requires after.process.activeTick == 0 || after.process.activeTick == before.process.activeTick
  ensures inv(after)
{
  SharedOwners(after);
  SharedLineageFrame(before, after);
  if after.process.activeTick != 0 {
    assert activeLink(after) == activeLink(before);
    SharedLinkAtMember(before, before.process.activeTick);
    SharedPairState(before, activeLink(before));
    SharedQueryLookup(before.drain, activeLink(before).query);
    SharedQueryLookup(after.drain, activeLink(before).query);
    assert core__queryDrain_queryFor(after.drain, activeLink(before).query).phase == core__queryDrain_queryFor(before.drain, activeLink(before).query).phase;
  }
  SharedActiveOwned(after);
}

lemma SharedAttachQueryOwner(s: core__queryDrain_Drain, hadTimer: bool, adapter: string)
  requires core__queryDrain_inv(s) && core__queryDrain_canStartAdapter(s, adapter)
  ensures core__queryDrain_inv(core__queryDrain_attachAfterTimerState(hadTimer, s, adapter))
{
  core__queryDrain_startAdapter_ensures(s, adapter);
  var after := core__queryDrain_attachAfterTimerState(hadTimer, s, adapter);
  SharedQueryDirtyView(s); SharedQueryDirtyView(after);
  if hadTimer { SharedQueryDirtyFold(s.registry, s.dirtyAgents, core__queryDrain_rearmRegistry(s)); }
}

lemma SharedSettleOwner(process: core__processScheduler_ProcessScheduler, link: TickQueryLink, drain: core__queryDrain_Drain)
  requires core__processScheduler_inv(process)
  ensures core__processScheduler_inv(settleLinkedTick(process, link, drain))
{
  if link.tick != 0 && core__queryDrain_queryFor(drain, link.query).phase.Done? && core__processScheduler_canFinishTick(process, link.tick) {
    core__processScheduler_finishTick_ensures(process, link.tick);
  }
}

lemma SharedAdvanceView(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures advanceQuery(s, key, succeeded, resultRows).links == s.links
  ensures advanceQuery(s, key, succeeded, resultRows).drain.generation == s.drain.generation && advanceQuery(s, key, succeeded, resultRows).drain.activeAdapter == s.drain.activeAdapter
  ensures advanceQuery(s, key, succeeded, resultRows).process.generation == s.process.generation && advanceQuery(s, key, succeeded, resultRows).process.adapter == s.process.adapter
  ensures advanceQuery(s, key, succeeded, resultRows).drain == core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows)
  ensures advanceQuery(s, key, succeeded, resultRows).process == settleLinkedTick(s.process, (if |ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)| > 0 then ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0] else noLink), core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows))
{}

lemma SharedQueryLinkChoice(s: SharedScheduler, key: int)
  requires inv(s) && 0 < key < s.drain.nextQuery
  ensures |ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)| > 0
  ensures ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0] in s.links
  ensures ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0].query == key
{
  SharedOwners(s); SharedQueryLookup(s.drain, key);
  var query := core__queryDrain_queryFor(s.drain, key);
  assert query in s.drain.queries;
  var link :| link in s.links && link.query == query.key && exists tick :: tick in s.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?;
  var selected := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links);
  ProofLib.FilterMember((row: TickQueryLink) => (row.query == key), s.links, link);
  assert link in selected && |selected| > 0;
  ProofLib.FilterMember((row: TickQueryLink) => (row.query == key), s.links, selected[0]);
}

lemma SharedSettleLineageQuery(before: SharedScheduler, after: SharedScheduler, selected: TickQueryLink, query: core__queryDrain_Query)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires core__queryDrain_alwaysQueryKeysUnique(before.drain)
  requires selected in before.links
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && (before.drain.queries[i].key != selected.query ==> after.drain.queries[i].phase == before.drain.queries[i].phase)
  requires |after.process.ticks| == |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i].id == before.process.ticks[i].id && after.process.ticks[i].generation == before.process.ticks[i].generation && after.process.ticks[i].completed == (if before.process.ticks[i].id == selected.tick then core__queryDrain_queryFor(after.drain, selected.query).phase.Done? else before.process.ticks[i].completed)
  requires core__queryDrain_alwaysQueryKeysUnique(after.drain)
  requires query in after.drain.queries
  ensures exists link :: link in after.links && link.query == query.key && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
{
  var i :| 0 <= i < |after.drain.queries| && after.drain.queries[i] == query;
  var prior := before.drain.queries[i];
  assert prior in before.drain.queries;
  SharedForwardWitness(before, prior);
  var li, ti :| 0 <= li < |before.links| && 0 <= ti < |before.process.ticks| && before.links[li].query == prior.key && before.process.ticks[ti].id == before.links[li].tick && before.process.ticks[ti].generation == prior.generation && before.process.ticks[ti].completed == prior.phase.Done?;
  var link := before.links[li];
  SharedQueryLookup(after.drain, selected.query);
  if prior.key == selected.query {
    assert link.tick == selected.tick;
    assert core__queryDrain_queryFor(after.drain, selected.query) == query;
  } else { assert link.tick != selected.tick; }
  assert after.links[li] == link && after.links[li] in after.links && after.process.ticks[ti] in after.process.ticks;
  assert after.links[li].query == query.key && after.process.ticks[ti].id == after.links[li].tick && after.process.ticks[ti].generation == query.generation && after.process.ticks[ti].completed == query.phase.Done?;
}

lemma SharedSettleLineageLink(before: SharedScheduler, after: SharedScheduler, selected: TickQueryLink, link: TickQueryLink)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires core__queryDrain_alwaysQueryKeysUnique(before.drain)
  requires selected in before.links
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && (before.drain.queries[i].key != selected.query ==> after.drain.queries[i].phase == before.drain.queries[i].phase)
  requires |after.process.ticks| == |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i].id == before.process.ticks[i].id && after.process.ticks[i].generation == before.process.ticks[i].generation && after.process.ticks[i].completed == (if before.process.ticks[i].id == selected.tick then core__queryDrain_queryFor(after.drain, selected.query).phase.Done? else before.process.ticks[i].completed)
  requires core__queryDrain_alwaysQueryKeysUnique(after.drain)
  requires link in after.links
  ensures exists query :: query in after.drain.queries && query.key == link.query && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
{
  SharedReverseWitness(before, link);
  var qi, ti :| 0 <= qi < |before.drain.queries| && 0 <= ti < |before.process.ticks| && before.drain.queries[qi].key == link.query && before.process.ticks[ti].id == link.tick && before.process.ticks[ti].generation == before.drain.queries[qi].generation && before.process.ticks[ti].completed == before.drain.queries[qi].phase.Done?;
  var prior := before.drain.queries[qi];
  SharedQueryLookup(after.drain, selected.query);
  if prior.key == selected.query {
    assert link.tick == selected.tick;
    assert core__queryDrain_queryFor(after.drain, selected.query) == after.drain.queries[qi];
  } else { assert link.tick != selected.tick; }
  assert after.drain.queries[qi] in after.drain.queries && after.process.ticks[ti] in after.process.ticks;
  assert after.drain.queries[qi].key == link.query && after.process.ticks[ti].id == link.tick && after.process.ticks[ti].generation == after.drain.queries[qi].generation && after.process.ticks[ti].completed == after.drain.queries[qi].phase.Done?;
}

lemma SharedSettleLineage(before: SharedScheduler, after: SharedScheduler, selected: TickQueryLink)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires core__queryDrain_alwaysQueryKeysUnique(before.drain)
  requires selected in before.links
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && (before.drain.queries[i].key != selected.query ==> after.drain.queries[i].phase == before.drain.queries[i].phase)
  requires |after.process.ticks| == |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i].id == before.process.ticks[i].id && after.process.ticks[i].generation == before.process.ticks[i].generation && after.process.ticks[i].completed == (if before.process.ticks[i].id == selected.tick then core__queryDrain_queryFor(after.drain, selected.query).phase.Done? else before.process.ticks[i].completed)
  requires core__queryDrain_alwaysQueryKeysUnique(after.drain)
  ensures alwaysCapturedQueryOwnsTick(after) && alwaysLinksNameRetainedOwners(after) && alwaysLineagePartnersAgree(after)
{
  forall query | query in after.drain.queries
    ensures exists link :: link in after.links && link.query == query.key && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
  {
    SharedSettleLineageQuery(before, after, selected, query);
  }
  forall link | link in after.links
    ensures exists query :: query in after.drain.queries && query.key == link.query && exists tick :: tick in after.process.ticks && tick.id == link.tick && tick.generation == query.generation && tick.completed == query.phase.Done?
  {
    SharedSettleLineageLink(before, after, selected, link);
  }
}

lemma SharedFreshQuery(before: SharedScheduler, after: SharedScheduler, pair: TickQueryLink, query: core__queryDrain_Query, tick: core__processScheduler_TickEntry)
  requires alwaysCapturedQueryOwnsTick(before)
  requires after.links == before.links + [pair]
  requires after.drain.queries == before.drain.queries + [query]
  requires after.process.ticks == before.process.ticks + [tick]
  requires query.key == pair.query && tick.id == pair.tick && query.generation == tick.generation && tick.completed == query.phase.Done?
  ensures alwaysCapturedQueryOwnsTick(after)
{
  forall q | q in after.drain.queries
    ensures exists link :: link in after.links && link.query == q.key && exists t :: t in after.process.ticks && t.id == link.tick && t.generation == q.generation && t.completed == q.phase.Done?
  {
    var i :| 0 <= i < |after.drain.queries| && after.drain.queries[i] == q;
    if i < |before.drain.queries| {
      assert q == before.drain.queries[i] && q in before.drain.queries;
      SharedForwardWitness(before, q);
      var li, ti :| 0 <= li < |before.links| && 0 <= ti < |before.process.ticks| && before.links[li].query == q.key && before.process.ticks[ti].id == before.links[li].tick && before.process.ticks[ti].generation == q.generation && before.process.ticks[ti].completed == q.phase.Done?;
      assert after.links[li] == before.links[li] && after.process.ticks[ti] == before.process.ticks[ti];
      assert after.links[li] in after.links && after.process.ticks[ti] in after.process.ticks;
    } else {
      assert i == |before.drain.queries| && q == query;
      assert pair in after.links && tick in after.process.ticks;
    }
  }
}

lemma SharedFreshLink(before: SharedScheduler, after: SharedScheduler, pair: TickQueryLink, query: core__queryDrain_Query, tick: core__processScheduler_TickEntry)
  requires alwaysLinksNameRetainedOwners(before)
  requires after.links == before.links + [pair]
  requires after.drain.queries == before.drain.queries + [query]
  requires after.process.ticks == before.process.ticks + [tick]
  requires query.key == pair.query && tick.id == pair.tick && query.generation == tick.generation && tick.completed == query.phase.Done?
  ensures alwaysLinksNameRetainedOwners(after)
{
  forall link | link in after.links
    ensures exists q :: q in after.drain.queries && q.key == link.query && exists t :: t in after.process.ticks && t.id == link.tick && t.generation == q.generation && t.completed == q.phase.Done?
  {
    var i :| 0 <= i < |after.links| && after.links[i] == link;
    if i < |before.links| {
      assert link == before.links[i] && link in before.links;
      SharedReverseWitness(before, link);
      var qi, ti :| 0 <= qi < |before.drain.queries| && 0 <= ti < |before.process.ticks| && before.drain.queries[qi].key == link.query && before.process.ticks[ti].id == link.tick && before.process.ticks[ti].generation == before.drain.queries[qi].generation && before.process.ticks[ti].completed == before.drain.queries[qi].phase.Done?;
      assert after.drain.queries[qi] == before.drain.queries[qi] && after.process.ticks[ti] == before.process.ticks[ti];
      assert after.drain.queries[qi] in after.drain.queries && after.process.ticks[ti] in after.process.ticks;
    } else {
      assert i == |before.links| && link == pair;
      assert query in after.drain.queries && tick in after.process.ticks;
    }
  }
}

lemma SharedFreshPartners(before: SharedScheduler, after: SharedScheduler, pair: TickQueryLink)
  requires alwaysLineagePartnersAgree(before)
  requires after.links == before.links + [pair]
  requires forall prior :: prior in before.links ==> prior.tick != pair.tick && prior.query != pair.query
  ensures alwaysLineagePartnersAgree(after)
{
  forall a, b | a in after.links && b in after.links
    ensures (a.tick == b.tick ==> a.query == b.query) && (a.query == b.query ==> a.tick == b.tick)
  {
    if a != pair && b != pair { assert a in before.links && b in before.links; }
    else if a != pair { assert a in before.links && a.tick != pair.tick && a.query != pair.query; }
    else if b != pair { assert b in before.links && b.tick != pair.tick && b.query != pair.query; }
  }
}

lemma SharedFreshPair(before: SharedScheduler, after: SharedScheduler, pair: TickQueryLink, query: core__queryDrain_Query, tick: core__processScheduler_TickEntry)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires after.links == before.links + [pair]
  requires after.drain.queries == before.drain.queries + [query]
  requires after.process.ticks == before.process.ticks + [tick]
  requires query.key == pair.query && tick.id == pair.tick && query.generation == tick.generation && tick.completed == query.phase.Done?
  requires forall prior :: prior in before.links ==> prior.tick != pair.tick && prior.query != pair.query
  ensures alwaysCapturedQueryOwnsTick(after) && alwaysLinksNameRetainedOwners(after) && alwaysLineagePartnersAgree(after)
{
  SharedFreshQuery(before, after, pair, query, tick);
  SharedFreshLink(before, after, pair, query, tick);
  SharedFreshPartners(before, after, pair);
}

lemma SharedCaptureLineage(before: SharedScheduler, after: SharedScheduler)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(before.process) && core__queryDrain_alwaysQueryKeysUnique(before.drain)
  requires alwaysAdapterGenerationAgrees(before)
  requires after.drain == core__queryDrain_beginQuery(before.drain)
  requires after.process == core__processScheduler_tick(before.process)
  requires attachedTickMayCapture(before)
  requires after.links == before.links + [TickQueryLink(after.process.activeTick, before.drain.nextQuery)]
  ensures alwaysCapturedQueryOwnsTick(after) && alwaysLinksNameRetainedOwners(after) && alwaysLineagePartnersAgree(after)
  ensures activeLink(after) == TickQueryLink(after.process.activeTick, before.drain.nextQuery)
{
  SharedQueryKeysLayout(before.drain); SharedTickKeys(before.process);
  var pair := TickQueryLink(after.process.activeTick, before.drain.nextQuery);
  var query := after.drain.queries[|before.drain.queries|];
  var tick := after.process.ticks[|before.process.ticks|];
  assert pair.tick == before.process.serial && pair.query == before.drain.nextQuery;
  assert query.key == pair.query && tick.id == pair.tick && query.generation == tick.generation && !tick.completed && query.phase.Querying?;
  forall prior | prior in before.links ensures prior.tick != pair.tick && prior.query != pair.query {
    SharedPairState(before, prior);
  }
  SharedFreshPair(before, after, pair, query, tick);
  SharedLinkAtView(after, pair.tick);
  ProofLib.FilterAppend((link: TickQueryLink) => (link.tick == pair.tick), before.links, pair);
  ProofLib.FilterNone((link: TickQueryLink) => (link.tick == pair.tick), before.links);
}

lemma SharedQueryDirtyView(s: core__queryDrain_Drain)
  ensures core__queryDrain_alwaysDirtyKeysUnique(s) == (forall agent :: agent in s.dirtyAgents ==> |ProofLib.Filter((other: string) => (other == agent), s.dirtyAgents)| == 1)
{
}

lemma SharedQueryDirtyAdd(xs: seq<string>, agent: string)
  requires forall item :: item in xs ==> |ProofLib.Filter((other: string) => (other == item), xs)| == 1
  ensures forall item :: item in core__queryDrain_addDirty(xs, agent) ==> |ProofLib.Filter((other: string) => (other == item), core__queryDrain_addDirty(xs, agent))| == 1
{
  if agent !in xs {
    forall item | item in core__queryDrain_addDirty(xs, agent)
      ensures |ProofLib.Filter((other: string) => (other == item), core__queryDrain_addDirty(xs, agent))| == 1
    {
      ProofLib.FilterAppend((other: string) => (other == item), xs, agent);
      if item == agent { ProofLib.FilterNone((other: string) => (other == item), xs); }
    }
  }
}

lemma SharedQueryDirtyFold(xs: seq<core__queryDrain_Registration>, dirty: seq<string>, result: seq<string>)
  requires result == Std.Collections.Seq.FoldLeft((dirty: seq<string>, entry: core__queryDrain_Registration) => core__queryDrain_addDirty(dirty, entry.agent), dirty, xs)
  requires forall item :: item in dirty ==> |ProofLib.Filter((other: string) => (other == item), dirty)| == 1
  ensures forall item :: item in result ==> |ProofLib.Filter((other: string) => (other == item), result)| == 1
  decreases |xs|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |xs| > 0 {
    SharedQueryDirtyAdd(dirty, xs[0].agent);
    SharedQueryDirtyFold(xs[1..], core__queryDrain_addDirty(dirty, xs[0].agent), result);
  }
}

lemma registerRuntime_ensures(s: SharedScheduler, agent: string, service: string)
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysAdapterGenerationAgrees(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysCapturedQueryOwnsTick(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysRetiredStorageDrains(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysActiveTickOwnsSameGenerationQuery(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysCanonicalOwnersHold(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysLinksNameRetainedOwners(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> alwaysLineagePartnersAgree(registerRuntime(s, agent, service)))
  ensures (inv(s) ==> canRegisterRuntime(s, agent, service) ==> stepOldTickCannotDetachReplacement(s, "registerRuntime", registerRuntime(s, agent, service)))
{
  if inv(s) && canRegisterRuntime(s, agent, service) {
    SharedOwners(s);
    core__queryDrain_register_ensures(s.drain, agent, service);
    var after := registerRuntime(s, agent, service);
    SharedStaticFrame(s, after);
  }
}

lemma unregisterRuntime_ensures(s: SharedScheduler, agent: string, service: string)
  ensures (inv(s) ==> alwaysAdapterGenerationAgrees(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysCapturedQueryOwnsTick(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysRetiredStorageDrains(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysActiveTickOwnsSameGenerationQuery(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysCanonicalOwnersHold(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysLinksNameRetainedOwners(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> alwaysLineagePartnersAgree(unregisterRuntime(s, agent, service)))
  ensures (inv(s) ==> stepOldTickCannotDetachReplacement(s, "unregisterRuntime", unregisterRuntime(s, agent, service)))
{
  if inv(s) {
    SharedOwners(s);
    core__queryDrain_unregister_ensures(s.drain, agent, service);
    var after := unregisterRuntime(s, agent, service);
    SharedStaticFrame(s, after);
  }
}

lemma markDirty_ensures(s: SharedScheduler, agent: string)
  ensures (inv(s) ==> alwaysAdapterGenerationAgrees(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysCapturedQueryOwnsTick(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysRetiredStorageDrains(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysActiveTickOwnsSameGenerationQuery(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysCanonicalOwnersHold(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysLinksNameRetainedOwners(markDirty(s, agent)))
  ensures (inv(s) ==> alwaysLineagePartnersAgree(markDirty(s, agent)))
  ensures (inv(s) ==> stepOldTickCannotDetachReplacement(s, "markDirty", markDirty(s, agent)))
{
  if inv(s) {
    SharedOwners(s);
    core__queryDrain_markDirty_ensures(s.drain, agent);
    var after := markDirty(s, agent);
    SharedStaticFrame(s, after);
  }
}

lemma registerProcess_ensures(s: SharedScheduler, name: string)
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysAdapterGenerationAgrees(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysCapturedQueryOwnsTick(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysRetiredStorageDrains(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysActiveTickOwnsSameGenerationQuery(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysCanonicalOwnersHold(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysLinksNameRetainedOwners(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> alwaysLineagePartnersAgree(registerProcess(s, name)))
  ensures (inv(s) ==> canRegisterProcess(s, name) ==> stepOldTickCannotDetachReplacement(s, "registerProcess", registerProcess(s, name)))
{
  if inv(s) && canRegisterProcess(s, name) {
    SharedOwners(s);
    core__processScheduler_register_ensures(s.process, name);
    var after := registerProcess(s, name);
    SharedStaticFrame(s, after);
  }
}

lemma disposeProcess_ensures(s: SharedScheduler, id: int)
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysAdapterGenerationAgrees(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysCapturedQueryOwnsTick(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysRetiredStorageDrains(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysCanonicalOwnersHold(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysLinksNameRetainedOwners(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> alwaysLineagePartnersAgree(disposeProcess(s, id)))
  ensures (inv(s) ==> canDisposeProcess(s, id) ==> stepOldTickCannotDetachReplacement(s, "disposeProcess", disposeProcess(s, id)))
{
  if inv(s) && canDisposeProcess(s, id) {
    SharedOwners(s);
    core__processScheduler_dispose_ensures(s.process, id);
    var after := disposeProcess(s, id);
    SharedStaticFrame(s, after);
  }
}

lemma enterCallback_ensures(s: SharedScheduler, id: int)
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysAdapterGenerationAgrees(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysCapturedQueryOwnsTick(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysRetiredStorageDrains(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysCanonicalOwnersHold(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysLinksNameRetainedOwners(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> alwaysLineagePartnersAgree(enterCallback(s, id)))
  ensures (inv(s) ==> canEnterCallback(s, id) ==> stepOldTickCannotDetachReplacement(s, "enterCallback", enterCallback(s, id)))
{
  if inv(s) && canEnterCallback(s, id) {
    SharedOwners(s);
    core__processScheduler_enterProcess_ensures(s.process, id);
    var after := enterCallback(s, id);
    SharedStaticFrame(s, after);
  }
}

lemma returnCallback_ensures(s: SharedScheduler, id: int, succeeded: bool)
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysAdapterGenerationAgrees(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysCapturedQueryOwnsTick(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysRetiredStorageDrains(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysActiveTickOwnsSameGenerationQuery(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysCanonicalOwnersHold(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysLinksNameRetainedOwners(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> alwaysLineagePartnersAgree(returnCallback(s, id, succeeded)))
  ensures (inv(s) ==> canReturnCallback(s, id) ==> stepOldTickCannotDetachReplacement(s, "returnCallback", returnCallback(s, id, succeeded)))
{
  if inv(s) && canReturnCallback(s, id) {
    SharedOwners(s);
    core__processScheduler_finishProcess_ensures(s.process, id, succeeded);
    var after := returnCallback(s, id, succeeded);
    SharedStaticFrame(s, after);
  }
}

lemma advanceDisposal_ensures(s: SharedScheduler, succeeded: bool)
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysAdapterGenerationAgrees(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysCapturedQueryOwnsTick(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysRetiredStorageDrains(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysActiveTickOwnsSameGenerationQuery(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysCanonicalOwnersHold(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysLinksNameRetainedOwners(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> alwaysLineagePartnersAgree(advanceDisposal(s, succeeded)))
  ensures (inv(s) ==> canAdvanceDisposal(s) ==> stepOldTickCannotDetachReplacement(s, "advanceDisposal", advanceDisposal(s, succeeded)))
{
  if inv(s) && canAdvanceDisposal(s) {
    SharedOwners(s);
    core__processScheduler_advanceDisposal_ensures(s.process, succeeded);
    var after := advanceDisposal(s, succeeded);
    SharedStaticFrame(s, after);
  }
}

lemma attach_ensures(s: SharedScheduler, adapter: string)
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysAdapterGenerationAgrees(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysCapturedQueryOwnsTick(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysRetiredStorageDrains(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysActiveTickOwnsSameGenerationQuery(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysCanonicalOwnersHold(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysLinksNameRetainedOwners(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> alwaysLineagePartnersAgree(attach(s, adapter)))
  ensures (inv(s) ==> canAttach(s, adapter) ==> stepOldTickCannotDetachReplacement(s, "attach", attach(s, adapter)))
{
  if inv(s) && canAttach(s, adapter) {
    SharedOwners(s);
    core__processScheduler_startAdapter_ensures(s.process, adapter);
    SharedAttachQueryOwner(s.drain, s.process.timer, adapter);
    var after := attach(s, adapter);
    SharedStaticFrame(s, after);
  }
}

lemma handoff_ensures(s: SharedScheduler, oldAdapter: string, replacementAdapter: string)
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysAdapterGenerationAgrees(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysCapturedQueryOwnsTick(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysRetiredStorageDrains(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysActiveTickOwnsSameGenerationQuery(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysCanonicalOwnersHold(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysLinksNameRetainedOwners(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> alwaysLineagePartnersAgree(handoff(s, oldAdapter, replacementAdapter)))
  ensures (inv(s) ==> canHandoff(s, oldAdapter, replacementAdapter) ==> stepOldTickCannotDetachReplacement(s, "handoff", handoff(s, oldAdapter, replacementAdapter)))
{
  if inv(s) && canHandoff(s, oldAdapter, replacementAdapter) {
    SharedOwners(s);
    core__queryDrain_handoff_ensures(s.drain, oldAdapter, replacementAdapter);
    if s.process.adapter == oldAdapter { core__processScheduler_startAdapter_ensures(s.process, replacementAdapter); }
    var after := handoff(s, oldAdapter, replacementAdapter);
    SharedStaticFrame(s, after);
  }
}

lemma retireAdapter_ensures(s: SharedScheduler, adapter: string)
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysAdapterGenerationAgrees(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysCapturedQueryOwnsTick(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysRetiredStorageDrains(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysActiveTickOwnsSameGenerationQuery(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysCanonicalOwnersHold(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysLinksNameRetainedOwners(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> alwaysLineagePartnersAgree(retireAdapter(s, adapter)))
  ensures (inv(s) ==> canRetireAdapter(s, adapter) ==> stepOldTickCannotDetachReplacement(s, "retireAdapter", retireAdapter(s, adapter)))
{
  if inv(s) && canRetireAdapter(s, adapter) {
    SharedOwners(s);
    core__queryDrain_retireAdapter_ensures(s.drain, adapter);
    if s.process.adapter == adapter { core__processScheduler_detachAdapter_ensures(s.process); }
    var after := retireAdapter(s, adapter);
    SharedStaticFrame(s, after);
  }
}

lemma stop_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canStop(s) ==> alwaysAdapterGenerationAgrees(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysCapturedQueryOwnsTick(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysRetiredStorageDrains(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysActiveTickOwnsSameGenerationQuery(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysCanonicalOwnersHold(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysLinksNameRetainedOwners(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> alwaysLineagePartnersAgree(stop(s)))
  ensures (inv(s) ==> canStop(s) ==> stepOldTickCannotDetachReplacement(s, "stop", stop(s)))
{
  if inv(s) && canStop(s) {
    SharedOwners(s);
    core__processScheduler_detachAdapter_ensures(s.process);
    core__queryDrain_stopScheduler_ensures(s.drain);
    var after := stop(s);
    SharedStaticFrame(s, after);
  }
}

lemma returnStop_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysAdapterGenerationAgrees(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysCapturedQueryOwnsTick(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysRetiredStorageDrains(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysActiveTickOwnsSameGenerationQuery(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysCanonicalOwnersHold(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysLinksNameRetainedOwners(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> alwaysLineagePartnersAgree(returnStop(s)))
  ensures (inv(s) ==> canReturnStop(s) ==> stepOldTickCannotDetachReplacement(s, "returnStop", returnStop(s)))
{
  if inv(s) && canReturnStop(s) {
    SharedOwners(s);
    core__queryDrain_returnStop_ensures(s.drain);
    var after := returnStop(s);
    SharedStaticFrame(s, after);
  }
}

lemma closeAdapters_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysAdapterGenerationAgrees(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysCapturedQueryOwnsTick(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysRetiredStorageDrains(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysActiveTickOwnsSameGenerationQuery(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysCanonicalOwnersHold(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysLinksNameRetainedOwners(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> alwaysLineagePartnersAgree(closeAdapters(s)))
  ensures (inv(s) ==> canCloseAdapters(s) ==> stepOldTickCannotDetachReplacement(s, "closeAdapters", closeAdapters(s)))
{
  if inv(s) && canCloseAdapters(s) {
    SharedOwners(s);
    core__queryDrain_closeRetiredAdapters_ensures(s.drain);
    var after := closeAdapters(s);
    SharedStaticFrame(s, after);
  }
}

lemma closeServices_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysAdapterGenerationAgrees(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysCapturedQueryOwnsTick(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysRetiredStorageDrains(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysActiveTickOwnsSameGenerationQuery(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysCanonicalOwnersHold(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysLinksNameRetainedOwners(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> alwaysLineagePartnersAgree(closeServices(s)))
  ensures (inv(s) ==> canCloseServices(s) ==> stepOldTickCannotDetachReplacement(s, "closeServices", closeServices(s)))
{
  if inv(s) && canCloseServices(s) {
    SharedOwners(s);
    core__queryDrain_closeRetiredServices_ensures(s.drain);
    var after := closeServices(s);
    SharedStaticFrame(s, after);
  }
}

lemma fire_ensures(s: SharedScheduler)
  ensures (inv(s) ==> canFire(s) ==> alwaysAdapterGenerationAgrees(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysCapturedQueryOwnsTick(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysRetiredStorageDrains(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysActiveTickOwnsSameGenerationQuery(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysCanonicalOwnersHold(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysLinksNameRetainedOwners(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> alwaysLineagePartnersAgree(fire(s)))
  ensures (inv(s) ==> canFire(s) ==> stepOldTickCannotDetachReplacement(s, "fire", fire(s)))
{
  if inv(s) && canFire(s) {
    SharedOwners(s);
    core__processScheduler_tick_ensures(s.process);
    var process := core__processScheduler_tick(s.process);
    var after := fire(s);
    if attachedTickMayCapture(s) && core__queryDrain_canBeginQuery(s.drain) {
      core__queryDrain_beginQuery_ensures(s.drain);
      SharedOwners(after);
      SharedCaptureLineage(s, after);
      SharedQueryLookup(after.drain, s.drain.nextQuery);
      assert core__queryDrain_queryFor(after.drain, activeLink(after).query).phase.Querying?;
      SharedActiveOwned(after);
    } else {
      if attachedTickMayCapture(s) {
        assert core__processScheduler_canFinishTick(process, process.activeTick);
        core__processScheduler_finishTick_ensures(process, process.activeTick);
        if core__queryDrain_canClearUnregisteredDirty(s.drain) { core__queryDrain_clearUnregisteredDirty_ensures(s.drain); }
      }
      SharedStaticFrame(s, after);
    }
  }
}

lemma SharedAdvanceOwners(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  requires core__processScheduler_inv(s.process) && core__queryDrain_inv(s.drain) && canAdvanceQuery(s, key)
  ensures core__processScheduler_inv(advanceQuery(s, key, succeeded, resultRows).process) && core__queryDrain_inv(advanceQuery(s, key, succeeded, resultRows).drain)
  ensures alwaysAdapterGenerationAgrees(s) ==> alwaysAdapterGenerationAgrees(advanceQuery(s, key, succeeded, resultRows))
{
  core__queryDrain_advanceQuery_ensures(s.drain, key, succeeded, resultRows);
  SharedAdvanceView(s, key, succeeded, resultRows);
  var links := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links);
  var link := if |links| > 0 then links[0] else noLink;
  SharedSettleOwner(s.process, link, core__queryDrain_advanceQuery(s.drain, key, succeeded, resultRows));
}

lemma SharedAdvanceMapFrame(s: SharedScheduler, after: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>, selected: TickQueryLink)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(s.process) && core__queryDrain_alwaysQueryKeysUnique(s.drain)
  requires alwaysLinksNameRetainedOwners(s)
  requires 0 < key < s.drain.nextQuery && !core__queryDrain_queryFor(s.drain, key).phase.Done?
  requires |ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)| > 0
  requires selected == ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0] && selected in s.links && selected.query == key
  requires after == advanceQuery(s, key, succeeded, resultRows)
  ensures after.links == s.links
  ensures |after.drain.queries| == |s.drain.queries|
  ensures forall i :: 0 <= i < |s.drain.queries| ==> after.drain.queries[i].key == s.drain.queries[i].key && after.drain.queries[i].generation == s.drain.queries[i].generation && (s.drain.queries[i].key != key ==> after.drain.queries[i].phase == s.drain.queries[i].phase)
  ensures forall i :: 0 <= i < |s.drain.queries| && !s.drain.queries[i].phase.Missing? ==> !after.drain.queries[i].phase.Missing?
  ensures |after.process.ticks| == |s.process.ticks|
  ensures forall i :: 0 <= i < |s.process.ticks| ==> after.process.ticks[i].id == s.process.ticks[i].id && after.process.ticks[i].generation == s.process.ticks[i].generation && after.process.ticks[i].completed == (if s.process.ticks[i].id == selected.tick then core__queryDrain_queryFor(after.drain, selected.query).phase.Done? else s.process.ticks[i].completed)
  ensures after.process.activeTick == (if core__queryDrain_queryFor(after.drain, selected.query).phase.Done? && s.process.activeTick == selected.tick then 0 else s.process.activeTick)
{
  SharedPairState(s, selected);
  SharedQueryLookup(s.drain, key);
  SharedReverseWitness(s, selected);
  var qi, ti :| 0 <= qi < |s.drain.queries| && 0 <= ti < |s.process.ticks| && s.drain.queries[qi].key == selected.query && s.process.ticks[ti].id == selected.tick && s.process.ticks[ti].generation == s.drain.queries[qi].generation && s.process.ticks[ti].completed == s.drain.queries[qi].phase.Done?;
  var prior := core__queryDrain_queryFor(s.drain, key);
  assert s.drain.queries[qi] == prior;
  var owned := s.process.ticks[ti];
  assert !owned.completed && owned.id == selected.tick && selected.tick > 0;
  SharedAdvanceView(s, key, succeeded, resultRows);
  SharedQueryAdvanceFrame(s.drain, key, succeeded, resultRows);
  SharedSettleTickFrame(s.process, selected, after.drain, owned);
}

lemma SharedActivePhaseFrame(before: SharedScheduler, after: SharedScheduler)
  requires core__queryDrain_alwaysQueryKeysUnique(before.drain)
  requires alwaysActiveTickOwnsSameGenerationQuery(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before)
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(after.process) && core__processScheduler_alwaysActiveTickIsOwned(after.process) && core__queryDrain_alwaysQueryKeysUnique(after.drain)
  requires alwaysLinksNameRetainedOwners(after) && alwaysLineagePartnersAgree(after)
  requires after.links == before.links
  requires after.process.activeTick == 0 || after.process.activeTick == before.process.activeTick
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key
  requires forall i :: 0 <= i < |before.drain.queries| && !before.drain.queries[i].phase.Missing? ==> !after.drain.queries[i].phase.Missing?
  ensures alwaysActiveTickOwnsSameGenerationQuery(after)
{
  if after.process.activeTick != 0 {
    assert before.process.activeTick == after.process.activeTick;
    SharedLinkAtMember(before, before.process.activeTick);
    var link := activeLink(before);
    assert link in before.links;
    SharedReverseWitness(before, link);
    var qi, ti :| 0 <= qi < |before.drain.queries| && 0 <= ti < |before.process.ticks| && before.drain.queries[qi].key == link.query && before.process.ticks[ti].id == link.tick && before.process.ticks[ti].generation == before.drain.queries[qi].generation && before.process.ticks[ti].completed == before.drain.queries[qi].phase.Done?;
    SharedQueryLookup(before.drain, link.query); SharedQueryLookup(after.drain, link.query);
    assert core__queryDrain_queryFor(before.drain, link.query) == before.drain.queries[qi];
    assert !before.drain.queries[qi].phase.Missing?;
    assert after.drain.queries[qi].key == link.query && after.drain.queries[qi] in after.drain.queries;
    assert core__queryDrain_queryFor(after.drain, link.query) == after.drain.queries[qi] && !after.drain.queries[qi].phase.Missing?;
    assert activeLink(after) == link;
  }
  SharedActiveOwned(after);
}

lemma SharedOldPointerFrame(before: SharedScheduler, after: SharedScheduler, selected: TickQueryLink)
  requires alwaysLineagePartnersAgree(before) && selected in before.links
  requires before.process.activeTick == 0 || activeLink(before).tick == before.process.activeTick
  requires after.process.activeTick == (if core__queryDrain_queryFor(after.drain, selected.query).phase.Done? && before.process.activeTick == selected.tick then 0 else before.process.activeTick)
  ensures before.process.activeTick != 0 && !core__queryDrain_queryFor(after.drain, activeLink(before).query).phase.Done? ==> after.process.activeTick == before.process.activeTick
{
  if before.process.activeTick != 0 && !core__queryDrain_queryFor(after.drain, activeLink(before).query).phase.Done? {
    SharedLinkAtMember(before, before.process.activeTick);
    if selected.tick == before.process.activeTick {
      assert activeLink(before) in before.links && selected.query == activeLink(before).query;
    }
  }
}

lemma SharedAdvanceRelations(before: SharedScheduler, after: SharedScheduler, selected: TickQueryLink)
  requires core__queryDrain_alwaysQueryKeysUnique(before.drain)
  requires alwaysCapturedQueryOwnsTick(before) && alwaysLinksNameRetainedOwners(before) && alwaysLineagePartnersAgree(before) && alwaysActiveTickOwnsSameGenerationQuery(before)
  requires selected in before.links
  requires core__processScheduler_alwaysAllocatedIdentitiesFresh(after.process) && core__processScheduler_alwaysActiveTickIsOwned(after.process) && core__queryDrain_alwaysQueryKeysUnique(after.drain)
  requires after.links == before.links
  requires |after.drain.queries| == |before.drain.queries|
  requires forall i :: 0 <= i < |before.drain.queries| ==> after.drain.queries[i].key == before.drain.queries[i].key && after.drain.queries[i].generation == before.drain.queries[i].generation && (before.drain.queries[i].key != selected.query ==> after.drain.queries[i].phase == before.drain.queries[i].phase)
  requires forall i :: 0 <= i < |before.drain.queries| && !before.drain.queries[i].phase.Missing? ==> !after.drain.queries[i].phase.Missing?
  requires |after.process.ticks| == |before.process.ticks|
  requires forall i :: 0 <= i < |before.process.ticks| ==> after.process.ticks[i].id == before.process.ticks[i].id && after.process.ticks[i].generation == before.process.ticks[i].generation && after.process.ticks[i].completed == (if before.process.ticks[i].id == selected.tick then core__queryDrain_queryFor(after.drain, selected.query).phase.Done? else before.process.ticks[i].completed)
  requires after.process.activeTick == (if core__queryDrain_queryFor(after.drain, selected.query).phase.Done? && before.process.activeTick == selected.tick then 0 else before.process.activeTick)
  ensures alwaysCapturedQueryOwnsTick(after) && alwaysLinksNameRetainedOwners(after) && alwaysLineagePartnersAgree(after) && alwaysActiveTickOwnsSameGenerationQuery(after)
  ensures before.process.activeTick != 0 && !core__queryDrain_queryFor(after.drain, activeLink(before).query).phase.Done? ==> after.process.activeTick == before.process.activeTick
{
  assert before.process.activeTick != 0 && !core__queryDrain_queryFor(after.drain, activeLink(before).query).phase.Done? ==> after.process.activeTick == before.process.activeTick by { SharedOldPointerFrame(before, after, selected); }
  assert alwaysCapturedQueryOwnsTick(after) && alwaysLinksNameRetainedOwners(after) && alwaysLineagePartnersAgree(after) by { SharedSettleLineage(before, after, selected); }
  assert alwaysActiveTickOwnsSameGenerationQuery(after) by { SharedActivePhaseFrame(before, after); }
}

lemma advanceQuery_ensures(s: SharedScheduler, key: int, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysAdapterGenerationAgrees(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysCapturedQueryOwnsTick(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysRetiredStorageDrains(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysActiveTickOwnsSameGenerationQuery(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysCanonicalOwnersHold(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysLinksNameRetainedOwners(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> alwaysLineagePartnersAgree(advanceQuery(s, key, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvanceQuery(s, key) ==> stepOldTickCannotDetachReplacement(s, "advanceQuery", advanceQuery(s, key, succeeded, resultRows)))
{
  if inv(s) && canAdvanceQuery(s, key) {
    SharedOwners(s);
    SharedQueryLookup(s.drain, key);
    assert 0 < key < s.drain.nextQuery && !core__queryDrain_queryFor(s.drain, key).phase.Done?;
    SharedQueryLinkChoice(s, key);
    var selected := ProofLib.Filter((row: TickQueryLink) => (row.query == key), s.links)[0];
    SharedAdvanceOwners(s, key, succeeded, resultRows);
    var after := advanceQuery(s, key, succeeded, resultRows);
    SharedOwners(after);
    SharedAdvanceMapFrame(s, after, key, succeeded, resultRows, selected);
    SharedAdvanceRelations(s, after, selected);
  }
}

lemma advance_ensures(s: SharedScheduler, succeeded: bool, resultRows: seq<core__queryDrain_TaskResult>)
  ensures (inv(s) ==> canAdvance(s) ==> alwaysAdapterGenerationAgrees(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysCapturedQueryOwnsTick(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysRetiredStorageDrains(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysActiveTickOwnsSameGenerationQuery(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysCanonicalOwnersHold(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysLinksNameRetainedOwners(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> alwaysLineagePartnersAgree(advance(s, succeeded, resultRows)))
  ensures (inv(s) ==> canAdvance(s) ==> stepOldTickCannotDetachReplacement(s, "advance", advance(s, succeeded, resultRows)))
{
  if inv(s) && canAdvance(s) {
    SharedOwners(s);
    SharedNextPendingQueryView(s.drain);
    var pending := ProofLib.Filter((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.drain.queries);
    assert core__queryDrain_nextPendingQuery(s.drain) == (if |pending| > 0 then pending[0] else core__queryDrain_absentQuery);
    var query := core__queryDrain_nextPendingQuery(s.drain);
    assert |pending| > 0 && query == pending[0];
    ProofLib.FilterMember((query: core__queryDrain_Query) => ((query.phase.Querying? || query.phase.Ready?) || query.phase.Running?), s.drain.queries, query);
    SharedQueryLookup(s.drain, query.key);
    assert canAdvanceQuery(s, query.key);
    advanceQuery_ensures(s, query.key, succeeded, resultRows);
  }
}

