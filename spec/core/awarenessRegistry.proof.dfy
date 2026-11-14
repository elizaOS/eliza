lemma ContributorIds(r: Registry)
  ensures alwaysUniqueContributorIds(r) == (forall entry :: entry in r.entries ==> |ProofLib.Filter((other: Entry) => (other.id == entry.id), r.entries)| == 1)
{}

lemma ContributorDistinct(entries: seq<Entry>)
  ensures alwaysUniqueContributorIds(Registry(entries)) <==> ProofLib.DistinctBy(entries, (entry: Entry) => entry.id)
{
  ContributorIds(Registry(entries));
  if alwaysUniqueContributorIds(Registry(entries)) {
    forall i, j | 0 <= i < |entries| && 0 <= j < |entries| && i != j
      ensures entries[i].id != entries[j].id
    {
      ProofLib.FilterCountOneIffUnique((other: Entry) => (other.id == entries[i].id), entries, (entry: Entry) => entry.id, i);
    }
  } else if ProofLib.DistinctBy(entries, (entry: Entry) => entry.id) {
    forall entry | entry in entries
      ensures |ProofLib.Filter((other: Entry) => (other.id == entry.id), entries)| == 1
    {
      var i :| 0 <= i < |entries| && entries[i] == entry;
      ProofLib.FilterOne((other: Entry) => (other.id == entry.id), entries, i);
    }
  }
}

lemma ContributorOrder(entries: seq<Entry>)
  ensures orderedContributors(entries) <==> (forall i, j :: 0 <= i < j < |entries| ==> entries[i].position <= entries[j].position)
  ensures Std.Collections.Seq.FoldLeft((checked: PositionCheck, entry: Entry) => PositionCheck(true, entry.position, (checked.ordered && (!(checked.seen) || (checked.previous <= entry.position)))), positionStart, entries).seen == (|entries| > 0)
  ensures |entries| > 0 ==> Std.Collections.Seq.FoldLeft((checked: PositionCheck, entry: Entry) => PositionCheck(true, entry.position, (checked.ordered && (!(checked.seen) || (checked.previous <= entry.position)))), positionStart, entries).previous == entries[|entries| - 1].position
  decreases |entries|
{
  if |entries| > 0 {
    var prefix := entries[..|entries| - 1];
    var last := entries[|entries| - 1];
    assert entries == prefix + [last];
    ContributorOrder(prefix);
    ProofLib.FoldLeftAppend((checked: PositionCheck, entry: Entry) => PositionCheck(true, entry.position, (checked.ordered && (!(checked.seen) || (checked.previous <= entry.position)))), positionStart, prefix, last);
    if orderedContributors(entries) {
      forall i, j | 0 <= i < j < |entries|
        ensures entries[i].position <= entries[j].position
      {
        if j == |entries| - 1 && i < |prefix| - 1 {
          assert prefix[i].position <= prefix[|prefix| - 1].position;
        }
      }
    }
  }
}

lemma ContributorFilterOrder(entries: seq<Entry>, p: Entry -> bool)
  requires orderedContributors(entries)
  ensures orderedContributors(ProofLib.Filter(p, entries))
  decreases |entries|
{
  ContributorOrder(entries);
  if |entries| > 0 {
    var prefix := entries[..|entries| - 1];
    var last := entries[|entries| - 1];
    assert entries == prefix + [last];
    ContributorOrder(prefix);
    ContributorFilterOrder(prefix, p);
    ProofLib.FilterAppend(p, prefix, last);
    var kept := ProofLib.Filter(p, prefix);
    ContributorOrder(kept);
    ContributorOrder(ProofLib.Filter(p, entries));
    if p(last) {
      forall i, j | 0 <= i < j < |kept + [last]|
        ensures (kept + [last])[i].position <= (kept + [last])[j].position
      {
        if j == |kept| {
          ProofLib.FilterMember(p, prefix, kept[i]);
          var k :| 0 <= k < |prefix| && prefix[k] == kept[i];
          assert entries[k].position <= last.position;
        }
      }
    }
  } else {
    ProofLib.FilterNil(p, entries);
  }
}

lemma ContributorConcatOrder(left: seq<Entry>, right: seq<Entry>)
  requires orderedContributors(left) && orderedContributors(right)
  requires forall a, b :: a in left && b in right ==> a.position <= b.position
  ensures orderedContributors(left + right)
{
  ContributorOrder(left); ContributorOrder(right); ContributorOrder(left + right);
  forall i, j | 0 <= i < j < |left + right|
    ensures (left + right)[i].position <= (left + right)[j].position
  {
    if i < |left| && j >= |left| {
      assert left[i] in left && right[j - |left|] in right;
    }
  }
}

lemma ContributorMapPreserves(before: Registry, after: Registry)
  requires inv(before)
  requires |before.entries| == |after.entries|
  requires forall i :: 0 <= i < |before.entries| ==> before.entries[i].id == after.entries[i].id && before.entries[i].position == after.entries[i].position
  ensures alwaysUniqueContributorIds(after)
  ensures alwaysContributorsOrdered(after)
{
  ContributorIds(before); ContributorIds(after);
  forall entry | entry in after.entries
    ensures |ProofLib.Filter((other: Entry) => (other.id == entry.id), after.entries)| == 1
  {
    var i :| 0 <= i < |after.entries| && after.entries[i] == entry;
    ProofLib.FilterLengthPointwise((other: Entry) => (other.id == entry.id), (other: Entry) => (other.id == entry.id), before.entries, after.entries);
    assert before.entries[i].id == entry.id;
  }
  ProofLib.FoldLeftPointwise((checked: PositionCheck, entry: Entry) => PositionCheck(true, entry.position, (checked.ordered && (!(checked.seen) || (checked.previous <= entry.position)))), (checked: PositionCheck, entry: Entry) => PositionCheck(true, entry.position, (checked.ordered && (!(checked.seen) || (checked.previous <= entry.position)))), positionStart, before.entries, after.entries);
}

lemma ContributorLookup(r: Registry, id: string)
  ensures entryAt(r, id) == (if |ProofLib.Filter((entry: Entry) => (entry.id == id), r.entries)| > 0 then ProofLib.Filter((entry: Entry) => (entry.id == id), r.entries)[0] else noEntry)
{}

lemma ContributorLookupMatches(r: Registry, candidate: Entry)
  requires alwaysUniqueContributorIds(r)
  requires candidate in r.entries
  ensures entryAt(r, candidate.id) == candidate
{
  ContributorDistinct(r.entries);
  var id := candidate.id;
  ContributorLookup(r, id);
  var i :| 0 <= i < |r.entries| && r.entries[i] == candidate;
  ProofLib.FilterOne((entry: Entry) => (entry.id == id), r.entries, i);
  ProofLib.FilterMember((entry: Entry) => (entry.id == id), r.entries, candidate);
  assert ProofLib.Filter((entry: Entry) => (entry.id == id), r.entries) == [candidate];
}

lemma RegistrationParts(r: Registry, id: string, position: int, ttl: int, trusted: bool, events: seq<string>)
  ensures registerContributor(r, id, position, ttl, trusted, events).entries == ProofLib.Filter((existing: Entry) => (existing.position <= position), r.entries) + [Entry(id, position, ttl, trusted, events, core__awareness_initial)] + ProofLib.Filter((existing: Entry) => (existing.position > position), r.entries)
{}

lemma registerContributor_ensures(r: Registry, id: string, position: int, ttl: int, trusted: bool, events: seq<string>)
  ensures (inv(r) ==> canRegisterContributor(r, id, position, ttl, trusted, events) ==> alwaysUniqueContributorIds(registerContributor(r, id, position, ttl, trusted, events)))
  ensures (inv(r) ==> canRegisterContributor(r, id, position, ttl, trusted, events) ==> alwaysContributorCachesValid(registerContributor(r, id, position, ttl, trusted, events)))
  ensures (inv(r) ==> canRegisterContributor(r, id, position, ttl, trusted, events) ==> alwaysContributorsOrdered(registerContributor(r, id, position, ttl, trusted, events)))
{
  if inv(r) && canRegisterContributor(r, id, position, ttl, trusted, events) {
    RegistrationParts(r, id, position, ttl, trusted, events);
    var left := ProofLib.Filter((existing: Entry) => (existing.position <= position), r.entries);
    var right := ProofLib.Filter((existing: Entry) => (existing.position > position), r.entries);
    var added := Entry(id, position, ttl, trusted, events, core__awareness_initial);
    var after := registerContributor(r, id, position, ttl, trusted, events);
    ContributorDistinct(r.entries); ContributorDistinct(after.entries);
    ProofLib.FilterKeepsDistinctBy((existing: Entry) => (existing.position <= position), r.entries, (entry: Entry) => entry.id);
    ProofLib.FilterKeepsDistinctBy((existing: Entry) => (existing.position > position), r.entries, (entry: Entry) => entry.id);
    ProofLib.FilterSubset((existing: Entry) => (existing.position <= position), r.entries);
    ProofLib.FilterSubset((existing: Entry) => (existing.position > position), r.entries);
    ProofLib.DistinctByConcat(left, [added], (entry: Entry) => entry.id);
    forall a, b | a in left + [added] && b in right
      ensures a.id != b.id
    {
      ProofLib.FilterMember((existing: Entry) => (existing.position > position), r.entries, b);
      if a in left {
        ProofLib.FilterMember((existing: Entry) => (existing.position <= position), r.entries, a);
        if a.id == b.id {
          var i :| 0 <= i < |r.entries| && r.entries[i] == a;
          var j :| 0 <= j < |r.entries| && r.entries[j] == b;
          assert i != j;
        }
      }
    }
    ProofLib.DistinctByConcat(left + [added], right, (entry: Entry) => entry.id);
    ContributorFilterOrder(r.entries, (existing: Entry) => (existing.position <= position));
    ContributorFilterOrder(r.entries, (existing: Entry) => (existing.position > position));
    forall a, b | a in left && b in [added]
      ensures a.position <= b.position
    {
      ProofLib.FilterMember((existing: Entry) => (existing.position <= position), r.entries, a);
    }
    ContributorConcatOrder(left, [added]);
    forall a, b | a in left + [added] && b in right
      ensures a.position <= b.position
    {
      ProofLib.FilterMember((existing: Entry) => (existing.position > position), r.entries, b);
      if a in left { ProofLib.FilterMember((existing: Entry) => (existing.position <= position), r.entries, a); }
    }
    ContributorConcatOrder(left + [added], right);
    core__awareness_initialHolds_ensures();
    forall entry | entry in after.entries
      ensures core__awareness_inv(entry.cache)
    {
      if entry != added { assert entry in r.entries; }
    }
  }
}

lemma startSummary_ensures(r: Registry, id: string, requestId: string, runtimeId: string)
  ensures (inv(r) ==> canStartSummary(r, id, requestId, runtimeId) ==> alwaysUniqueContributorIds(startSummary(r, id, requestId, runtimeId)))
  ensures (inv(r) ==> canStartSummary(r, id, requestId, runtimeId) ==> alwaysContributorCachesValid(startSummary(r, id, requestId, runtimeId)))
  ensures (inv(r) ==> canStartSummary(r, id, requestId, runtimeId) ==> alwaysContributorsOrdered(startSummary(r, id, requestId, runtimeId)))
{
  if inv(r) && canStartSummary(r, id, requestId, runtimeId) {
    var after := startSummary(r, id, requestId, runtimeId);
    ContributorMapPreserves(r, after);
    forall i | 0 <= i < |r.entries|
      ensures core__awareness_inv(after.entries[i].cache)
    {
      var entry := r.entries[i];
      if entry.id == id {
        ContributorLookupMatches(r, entry);
        core__awareness_startSummary_ensures(entry.cache, requestId, runtimeId, entry.ttl);
      }
    }
  }
}

lemma finishSummary_ensures(r: Registry, id: string, requestId: string, text: string)
  ensures (inv(r) ==> canFinishSummary(r, id, requestId, text) ==> alwaysUniqueContributorIds(finishSummary(r, id, requestId, text)))
  ensures (inv(r) ==> canFinishSummary(r, id, requestId, text) ==> alwaysContributorCachesValid(finishSummary(r, id, requestId, text)))
  ensures (inv(r) ==> canFinishSummary(r, id, requestId, text) ==> alwaysContributorsOrdered(finishSummary(r, id, requestId, text)))
{
  if inv(r) && canFinishSummary(r, id, requestId, text) {
    var after := finishSummary(r, id, requestId, text);
    ContributorMapPreserves(r, after);
    forall i | 0 <= i < |r.entries|
      ensures core__awareness_inv(after.entries[i].cache)
    {
      var entry := r.entries[i];
      if entry.id == id {
        ContributorLookupMatches(r, entry);
        core__awareness_finishSummary_ensures(entry.cache, requestId, text);
      }
    }
  }
}

lemma failSummary_ensures(r: Registry, id: string, requestId: string)
  ensures (inv(r) ==> canFailSummary(r, id, requestId) ==> alwaysUniqueContributorIds(failSummary(r, id, requestId)))
  ensures (inv(r) ==> canFailSummary(r, id, requestId) ==> alwaysContributorCachesValid(failSummary(r, id, requestId)))
  ensures (inv(r) ==> canFailSummary(r, id, requestId) ==> alwaysContributorsOrdered(failSummary(r, id, requestId)))
{
  if inv(r) && canFailSummary(r, id, requestId) {
    var after := failSummary(r, id, requestId);
    ContributorMapPreserves(r, after);
    forall i | 0 <= i < |r.entries|
      ensures core__awareness_inv(after.entries[i].cache)
    {
      var entry := r.entries[i];
      if entry.id == id {
        ContributorLookupMatches(r, entry);
        core__awareness_failSummary_ensures(entry.cache, requestId);
      }
    }
  }
}

lemma setClock_ensures(r: Registry, now: int)
  ensures (inv(r) ==> canSetClock(r, now) ==> alwaysUniqueContributorIds(setClock(r, now)))
  ensures (inv(r) ==> canSetClock(r, now) ==> alwaysContributorCachesValid(setClock(r, now)))
  ensures (inv(r) ==> canSetClock(r, now) ==> alwaysContributorsOrdered(setClock(r, now)))
{
  if inv(r) && canSetClock(r, now) {
    var after := setClock(r, now);
    ContributorMapPreserves(r, after);
    forall i | 0 <= i < |r.entries|
      ensures core__awareness_inv(after.entries[i].cache)
    {
      core__awareness_setClock_ensures(r.entries[i].cache, now);
    }
  }
}

lemma invalidateEvent_ensures(r: Registry, invalidationEvent: string)
  ensures (inv(r) ==> alwaysUniqueContributorIds(invalidateEvent(r, invalidationEvent)))
  ensures (inv(r) ==> alwaysContributorCachesValid(invalidateEvent(r, invalidationEvent)))
  ensures (inv(r) ==> alwaysContributorsOrdered(invalidateEvent(r, invalidationEvent)))
{
  if inv(r) {
    var after := invalidateEvent(r, invalidationEvent);
    ContributorMapPreserves(r, after);
    forall i | 0 <= i < |r.entries|
      ensures core__awareness_inv(after.entries[i].cache)
    {
      if invalidationEvent in r.entries[i].events {
        core__awareness_invalidateSummary_ensures(r.entries[i].cache);
      }
    }
  }
}
