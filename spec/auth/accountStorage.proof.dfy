lemma CountAt(xs: seq<CredentialRecord>, r: CredentialRecord, i: int)
  requires 0 <= i < |xs| && xs[i] == r
  ensures |ProofLib.Filter((o: CredentialRecord) => (o.key == r.key), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].key != r.key
  ensures |ProofLib.Filter((o: CredentialRecord) => (o.generation == r.generation), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].generation != r.generation
{
  ProofLib.FilterCountOneIffUnique((o: CredentialRecord) => (o.key == r.key), xs, (c: CredentialRecord) => c.key, i);
  ProofLib.FilterCountOneIffUnique((o: CredentialRecord) => (o.generation == r.generation), xs, (c: CredentialRecord) => c.generation, i);
}

lemma CountForm(xs: seq<CredentialRecord>, n: int)
  ensures (forall r :: r in xs ==> (((r.generation < n) && (r.generation >= 0)) && (!((r.generation > 0)) || (|ProofLib.Filter((o: CredentialRecord) => (o.generation == r.generation), xs)| == 1))) && (|ProofLib.Filter((o: CredentialRecord) => (o.key == r.key), xs)| == 1)) <==> ((forall r :: r in xs ==> r.generation < n && r.generation >= 0) && ProofLib.DistinctBy(xs, (c: CredentialRecord) => c.key) && (forall x, y :: x in xs && y in xs && x.generation > 0 && x.generation == y.generation ==> x == y))
{
  if (forall r :: r in xs ==> (((r.generation < n) && (r.generation >= 0)) && (!((r.generation > 0)) || (|ProofLib.Filter((o: CredentialRecord) => (o.generation == r.generation), xs)| == 1))) && (|ProofLib.Filter((o: CredentialRecord) => (o.key == r.key), xs)| == 1)) {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].key != xs[j].key
    {
      assert xs[i] in xs;
      CountAt(xs, xs[i], i);
    }
    forall x, y | x in xs && y in xs && x.generation > 0 && x.generation == y.generation
      ensures x == y
    {
      var i :| 0 <= i < |xs| && xs[i] == x;
      var j :| 0 <= j < |xs| && xs[j] == y;
      CountAt(xs, x, i);
    }
  }
  if ((forall r :: r in xs ==> r.generation < n && r.generation >= 0) && ProofLib.DistinctBy(xs, (c: CredentialRecord) => c.key) && (forall x, y :: x in xs && y in xs && x.generation > 0 && x.generation == y.generation ==> x == y)) {
    forall r | r in xs
      ensures (!((r.generation > 0)) || (|ProofLib.Filter((o: CredentialRecord) => (o.generation == r.generation), xs)| == 1)) && (|ProofLib.Filter((o: CredentialRecord) => (o.key == r.key), xs)| == 1)
    {
      var i :| 0 <= i < |xs| && xs[i] == r;
      CountAt(xs, r, i);
      forall j | 0 <= j < |xs| && j != i && r.generation > 0
        ensures xs[j].generation != r.generation
      {
        if xs[j].generation == r.generation {
          assert xs[j] in xs;
        }
      }
    }
  }
}

lemma FreshFilter(s: AccountStorage)
  ensures alwaysGenerationsAreFresh(s) == ((s.nextGeneration >= 1) && (forall r :: r in (s.records + s.unlinked) ==> (((r.generation < s.nextGeneration) && (r.generation >= 0)) && (!((r.generation > 0)) || (|ProofLib.Filter((o: CredentialRecord) => (o.generation == r.generation), (s.records + s.unlinked))| == 1))) && (|ProofLib.Filter((o: CredentialRecord) => (o.key == r.key), (s.records + s.unlinked))| == 1)) && (forall r :: r in s.readers ==> r.generation < s.nextGeneration))
{
}

lemma Fresh(s: AccountStorage)
  ensures alwaysGenerationsAreFresh(s) <==> (s.nextGeneration >= 1 && ((forall r :: r in (s.records + s.unlinked) ==> r.generation < s.nextGeneration && r.generation >= 0) && ProofLib.DistinctBy((s.records + s.unlinked), (c: CredentialRecord) => c.key) && (forall x, y :: x in (s.records + s.unlinked) && y in (s.records + s.unlinked) && x.generation > 0 && x.generation == y.generation ==> x == y)) && (forall r :: r in s.readers ==> r.generation < s.nextGeneration))
{
  FreshFilter(s);
  CountForm((s.records + s.unlinked), s.nextGeneration);
}

lemma SplitDistinct(a: seq<CredentialRecord>, b: seq<CredentialRecord>)
  requires ProofLib.DistinctBy(a + b, (c: CredentialRecord) => c.key)
  ensures ProofLib.DistinctBy(a, (c: CredentialRecord) => c.key) && ProofLib.DistinctBy(b, (c: CredentialRecord) => c.key)
  ensures forall x, y :: x in a && y in b ==> x.key != y.key
{
  forall i, j | 0 <= i < |b| && 0 <= j < |b| && i != j
    ensures b[i].key != b[j].key
  {
    assert (a + b)[|a| + i] == b[i] && (a + b)[|a| + j] == b[j];
  }
  forall x, y | x in a && y in b
    ensures x.key != y.key
  {
    var i :| 0 <= i < |a| && a[i] == x;
    var j :| 0 <= j < |b| && b[j] == y;
    assert (a + b)[i] == x && (a + b)[|a| + j] == y;
  }
  forall i, j | 0 <= i < |a| && 0 <= j < |a| && i != j
    ensures a[i].key != a[j].key
  {
    assert (a + b)[i] == a[i] && (a + b)[j] == a[j];
  }
}

lemma KeyedUnique(xs: seq<CredentialRecord>, x: CredentialRecord, y: CredentialRecord)
  requires ProofLib.DistinctBy(xs, (c: CredentialRecord) => c.key)
  requires x in xs && y in xs && x.key == y.key
  ensures x == y
{
  var i :| 0 <= i < |xs| && xs[i] == x;
  var j :| 0 <= j < |xs| && xs[j] == y;
}

lemma FreshSubFilter(p: CredentialRecord -> bool, xs: seq<CredentialRecord>, n: int)
  requires ((forall r :: r in xs ==> r.generation < n && r.generation >= 0) && ProofLib.DistinctBy(xs, (c: CredentialRecord) => c.key) && (forall x, y :: x in xs && y in xs && x.generation > 0 && x.generation == y.generation ==> x == y))
  ensures ((forall r :: r in ProofLib.Filter(p, xs) ==> r.generation < n && r.generation >= 0) && ProofLib.DistinctBy(ProofLib.Filter(p, xs), (c: CredentialRecord) => c.key) && (forall x, y :: x in ProofLib.Filter(p, xs) && y in ProofLib.Filter(p, xs) && x.generation > 0 && x.generation == y.generation ==> x == y))
  ensures forall x :: x in ProofLib.Filter(p, xs) <==> x in xs && p(x)
{
  ProofLib.FilterKeepsDistinctBy(p, xs, (c: CredentialRecord) => c.key);
  forall x
    ensures x in ProofLib.Filter(p, xs) <==> x in xs && p(x)
  {
    ProofLib.FilterMember(p, xs, x);
  }
}

lemma ReplaceFresh(xs: seq<CredentialRecord>, ys: seq<CredentialRecord>, key: int, change: CredentialRecord, prior: CredentialRecord, n: int, n2: int)
  requires ((forall r :: r in xs ==> r.generation < n && r.generation >= 0) && ProofLib.DistinctBy(xs, (c: CredentialRecord) => c.key) && (forall x, y :: x in xs && y in xs && x.generation > 0 && x.generation == y.generation ==> x == y))
  requires |ys| == |xs| && forall i :: 0 <= i < |xs| ==> ys[i] == (if xs[i].key == key then change else xs[i])
  requires prior in xs && prior.key == key && change.key == key
  requires 0 <= change.generation < n2 && n <= n2
  requires change.generation == prior.generation || change.generation >= n
  ensures ((forall r :: r in ys ==> r.generation < n2 && r.generation >= 0) && ProofLib.DistinctBy(ys, (c: CredentialRecord) => c.key) && (forall x, y :: x in ys && y in ys && x.generation > 0 && x.generation == y.generation ==> x == y))
  ensures forall x :: x in ys ==> x == change || (x in xs && x.key != key)
  ensures change in ys
{
  forall x | x in ys
    ensures x == change || (x in xs && x.key != key)
  {
    var i :| 0 <= i < |ys| && ys[i] == x;
    assert xs[i] in xs;
  }
  var k :| 0 <= k < |xs| && xs[k] == prior;
  assert ys[k] == change;
  forall x, y | x in ys && y in ys && x.generation > 0 && x.generation == y.generation
    ensures x == y
  {
    if x == change && y != change {
      if change.generation == prior.generation {
        KeyedUnique(xs, y, prior);
      }
    } else if y == change && x != change {
      if change.generation == prior.generation {
        KeyedUnique(xs, x, prior);
      }
    }
  }
  forall i, j | 0 <= i < |ys| && 0 <= j < |ys| && i != j
    ensures ys[i].key != ys[j].key
  {
    assert xs[i].key != xs[j].key;
  }
}

lemma RecordOfFilter(s: AccountStorage, key: int)
  ensures recordOf(s, key) == (if ((0 <= 0) && (0 < |ProofLib.Filter((r: CredentialRecord) => (r.key == key), s.records)|)) then ProofLib.Filter((r: CredentialRecord) => (r.key == key), s.records)[0] else noRecord)
{
}

lemma RecordOf(s: AccountStorage, key: int)
  ensures present(s, key) ==> recordOf(s, key) in s.records && recordOf(s, key).key == key
  ensures !present(s, key) ==> recordOf(s, key) == noRecord
{
  RecordOfFilter(s, key);
  var f := ProofLib.Filter((r: CredentialRecord) => (r.key == key), s.records);
  if |f| > 0 {
    assert f[0] in f;
    ProofLib.FilterMember((r: CredentialRecord) => (r.key == key), s.records, f[0]);
  }
  if present(s, key) {
    var w :| w in s.records && w.key == key;
    ProofLib.FilterMember((r: CredentialRecord) => (r.key == key), s.records, w);
  }
}

lemma ReaderOfFilter(s: AccountStorage, id: int)
  ensures readerOf(s, id) == (if ((0 <= 0) && (0 < |ProofLib.Filter((r: Reader) => (r.id == id), s.readers)|)) then ProofLib.Filter((r: Reader) => (r.id == id), s.readers)[0] else noReader)
{
}

lemma ReaderOf(s: AccountStorage, id: int, change: Reader)
  requires (exists r :: r in s.readers && r.id == id) ==> change.generation == readerOf(s, id).generation
  ensures (exists r :: r in s.readers && r.id == id) ==> readerOf(s, id) in s.readers
  ensures forall x :: x in withReader(id, change, s) ==> x in s.readers || (x == change && readerOf(s, id) in s.readers)
{
  ReaderOfFilter(s, id);
  var f := ProofLib.Filter((r: Reader) => (r.id == id), s.readers);
  if |f| > 0 {
    assert f[0] in f;
    ProofLib.FilterMember((r: Reader) => (r.id == id), s.readers, f[0]);
  }
  if exists r :: r in s.readers && r.id == id {
    var w :| w in s.readers && w.id == id;
    ProofLib.FilterMember((r: Reader) => (r.id == id), s.readers, w);
  }
  forall x | x in withReader(id, change, s)
    ensures x in s.readers || (x == change && readerOf(s, id) in s.readers)
  {
    var i :| 0 <= i < |withReader(id, change, s)| && withReader(id, change, s)[i] == x;
    assert s.readers[i] in s.readers;
  }
}

lemma RemoveFilter(s: AccountStorage, key: int)
  ensures remove(s, key).records == ProofLib.Filter((r: CredentialRecord) => (r.key != key), s.records)
  ensures unlinkPlanned(s, key).records == ProofLib.Filter((r: CredentialRecord) => (r.key != key), s.records)
{
}

lemma ProviderFilter(s: AccountStorage, provider: string)
  ensures |providerRecords(s, provider)| == |ProofLib.Filter((r: CredentialRecord) => (r.provider == provider), s.records)|
  ensures forall i :: 0 <= i < |providerRecords(s, provider)| ==> providerRecords(s, provider)[i] == PlannedRecord(ProofLib.Filter((r: CredentialRecord) => (r.provider == provider), s.records)[i].key, ProofLib.Filter((r: CredentialRecord) => (r.provider == provider), s.records)[i].generation)
{
}

lemma KeySetCard(xs: seq<CredentialRecord>)
  requires ProofLib.DistinctBy(xs, (c: CredentialRecord) => c.key)
  ensures |(set x | x in xs :: x.key)| == |xs|
  decreases |xs|
{
  if |xs| > 0 {
    assert ProofLib.DistinctBy(xs[1..], (c: CredentialRecord) => c.key) by {
      forall i, j | 0 <= i < |xs[1..]| && 0 <= j < |xs[1..]| && i != j
        ensures xs[1..][i].key != xs[1..][j].key
      {
        assert xs[1..][i] == xs[i + 1] && xs[1..][j] == xs[j + 1];
      }
    }
    KeySetCard(xs[1..]);
    assert (set x | x in xs :: x.key) == (set x | x in xs[1..] :: x.key) + {xs[0].key};
    if xs[0].key in (set x | x in xs[1..] :: x.key) {
      var x :| x in xs[1..] && x.key == xs[0].key;
      var i :| 0 <= i < |xs[1..]| && xs[1..][i] == x;
      assert xs[i + 1] == x;
    }
  }
}

lemma PlanKeyCard(plan: seq<PlannedRecord>)
  ensures |(set p | p in plan :: p.key)| <= |plan|
  decreases |plan|
{
  if |plan| > 0 {
    PlanKeyCard(plan[1..]);
    assert (set p | p in plan :: p.key) == (set p | p in plan[1..] :: p.key) + {plan[0].key};
  }
}

lemma SubsetFull(u: set<int>, p: set<int>)
  requires u <= p && |u| >= |p|
  ensures p <= u
{
  if exists x :: x in p && x !in u {
    var x :| x in p && x !in u;
    ProofLib.SubsetCard(u, p - {x});
  }
}

lemma UnlinkFresh(records: seq<CredentialRecord>, unlinked: seq<CredentialRecord>, key: int, moved: CredentialRecord, n: int)
  requires ((forall r :: r in (records + unlinked) ==> r.generation < n && r.generation >= 0) && ProofLib.DistinctBy((records + unlinked), (c: CredentialRecord) => c.key) && (forall x, y :: x in (records + unlinked) && y in (records + unlinked) && x.generation > 0 && x.generation == y.generation ==> x == y))
  requires moved in records && moved.key == key
  ensures ((forall r :: r in (ProofLib.Filter((r: CredentialRecord) => (r.key != key), records) + (unlinked + [moved])) ==> r.generation < n && r.generation >= 0) && ProofLib.DistinctBy((ProofLib.Filter((r: CredentialRecord) => (r.key != key), records) + (unlinked + [moved])), (c: CredentialRecord) => c.key) && (forall x, y :: x in (ProofLib.Filter((r: CredentialRecord) => (r.key != key), records) + (unlinked + [moved])) && y in (ProofLib.Filter((r: CredentialRecord) => (r.key != key), records) + (unlinked + [moved])) && x.generation > 0 && x.generation == y.generation ==> x == y))
  ensures forall x :: x in ProofLib.Filter((r: CredentialRecord) => (r.key != key), records) <==> x in records && x.key != key
{
  var kept := ProofLib.Filter((r: CredentialRecord) => (r.key != key), records);
  SplitDistinct(records, unlinked);
  forall x
    ensures x in kept <==> x in records && x.key != key
  {
    ProofLib.FilterMember((r: CredentialRecord) => (r.key != key), records, x);
  }
  ProofLib.FilterKeepsDistinctBy((r: CredentialRecord) => (r.key != key), records, (c: CredentialRecord) => c.key);
  ProofLib.DistinctByConcat(unlinked, [moved], (c: CredentialRecord) => c.key);
  ProofLib.DistinctByConcat(kept, unlinked + [moved], (c: CredentialRecord) => c.key);
  assert forall x :: x in kept + (unlinked + [moved]) ==> x in records + unlinked;
}

lemma remove_ensures(s: AccountStorage, key: int)
  ensures (inv(s) ==> canRemove(s, key) ==> alwaysGenerationsAreFresh(remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> alwaysRewrittenOnce(remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> alwaysDeletionResultMatchesPlan(remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> alwaysRollbackRestoresThePlan(remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> alwaysUnlinksStayInsidePlan(remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> stepStaleCommitChangesNothing(s, "remove", remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> stepRefreshKeepsLabelAndProvider(s, "remove", remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> stepEditKeepsCredentials(s, "remove", remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> stepMigrationKeepsContents(s, "remove", remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> stepOtherProvidersUntouched(s, "remove", remove(s, key)))
  ensures (inv(s) ==> canRemove(s, key) ==> stepRefusedPlanRemovesNothing(s, "remove", remove(s, key)))
{
  if inv(s) && canRemove(s, key) {
    var after := remove(s, key);
    Fresh(s);
    Fresh(after);
    RemoveFilter(s, key);
    assert s.records + s.unlinked == s.records;
    assert after.records + after.unlinked == after.records;
    FreshSubFilter((r: CredentialRecord) => (r.key != key), s.records, s.nextGeneration);
  }
}

lemma beginRead_ensures(s: AccountStorage, reader: int, key: int)
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> alwaysGenerationsAreFresh(beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> alwaysRewrittenOnce(beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> alwaysDeletionResultMatchesPlan(beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> alwaysRollbackRestoresThePlan(beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> alwaysUnlinksStayInsidePlan(beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> stepStaleCommitChangesNothing(s, "beginRead", beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> stepRefreshKeepsLabelAndProvider(s, "beginRead", beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> stepEditKeepsCredentials(s, "beginRead", beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> stepMigrationKeepsContents(s, "beginRead", beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> stepOtherProvidersUntouched(s, "beginRead", beginRead(s, reader, key)))
  ensures (inv(s) ==> canBeginRead(s, reader, key) ==> stepRefusedPlanRemovesNothing(s, "beginRead", beginRead(s, reader, key)))
{
  if inv(s) && canBeginRead(s, reader, key) {
    var after := beginRead(s, reader, key);
    Fresh(s);
    Fresh(after);
    RecordOf(s, key);
    var change := Reader(reader, key, recordOf(s, key).generation, ReaderStage.ReaderWaiting);
    forall x | x in after.readers
      ensures x.generation < s.nextGeneration
    {
      var i :| 0 <= i < |after.readers| && after.readers[i] == x;
      assert s.readers[i] in s.readers;
    }
  }
}

lemma save_ensures(s: AccountStorage, key: int, provider: string, credential: int, includesIdToken: bool)
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> alwaysGenerationsAreFresh(save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> alwaysRewrittenOnce(save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> alwaysDeletionResultMatchesPlan(save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> alwaysRollbackRestoresThePlan(save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> alwaysUnlinksStayInsidePlan(save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> stepStaleCommitChangesNothing(s, "save", save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> stepRefreshKeepsLabelAndProvider(s, "save", save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> stepEditKeepsCredentials(s, "save", save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> stepMigrationKeepsContents(s, "save", save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> stepOtherProvidersUntouched(s, "save", save(s, key, provider, credential, includesIdToken)))
  ensures (inv(s) ==> canSave(s, key, provider, credential, includesIdToken) ==> stepRefusedPlanRemovesNothing(s, "save", save(s, key, provider, credential, includesIdToken)))
{
  if inv(s) && canSave(s, key, provider, credential, includesIdToken) {
    var after := save(s, key, provider, credential, includesIdToken);
    var stored := CredentialRecord(key, provider, s.nextGeneration, credential, (if includesIdToken then credential else 0), key, RecordFormat.CurrentFormat, recordOf(s, key).rewrites);
    Fresh(s);
    Fresh(after);
    RecordOf(s, key);
    assert s.records + s.unlinked == s.records;
    assert after.records + after.unlinked == after.records;
    if present(s, key) {
      ReplaceFresh(s.records, after.records, key, stored, recordOf(s, key), s.nextGeneration, s.nextGeneration + 1);
    } else {
      ProofLib.DistinctByConcat(s.records, [stored], (c: CredentialRecord) => c.key);
      assert forall x :: x in after.records ==> x in s.records || x == stored;
    }
  }
}

lemma refreshCommit_ensures(s: AccountStorage, reader: int, credential: int, includesIdToken: bool)
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> alwaysGenerationsAreFresh(refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> alwaysRewrittenOnce(refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> alwaysDeletionResultMatchesPlan(refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> alwaysRollbackRestoresThePlan(refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> alwaysUnlinksStayInsidePlan(refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> stepStaleCommitChangesNothing(s, "refreshCommit", refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> stepRefreshKeepsLabelAndProvider(s, "refreshCommit", refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> stepEditKeepsCredentials(s, "refreshCommit", refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> stepMigrationKeepsContents(s, "refreshCommit", refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> stepOtherProvidersUntouched(s, "refreshCommit", refreshCommit(s, reader, credential, includesIdToken)))
  ensures (inv(s) ==> canRefreshCommit(s, reader, credential, includesIdToken) ==> stepRefusedPlanRemovesNothing(s, "refreshCommit", refreshCommit(s, reader, credential, includesIdToken)))
{
  if inv(s) && canRefreshCommit(s, reader, credential, includesIdToken) {
    var after := refreshCommit(s, reader, credential, includesIdToken);
    var held := readerOf(s, reader);
    Fresh(s);
    Fresh(after);
    ReaderOf(s, reader, held.(stage := ReaderStage.ReaderDone));
    RecordOf(s, held.key);
    assert s.records + s.unlinked == s.records;
    assert after.records + after.unlinked == after.records;
    forall x | x in after.readers
      ensures x.generation < after.nextGeneration
    {
    }
    if present(s, held.key) && recordOf(s, held.key).generation == held.generation {
      var record := recordOf(s, held.key);
      var change := record.(generation := s.nextGeneration, credential := credential, idToken := (if includesIdToken then credential else record.idToken));
      ReplaceFresh(s.records, after.records, held.key, change, record, s.nextGeneration, s.nextGeneration + 1);
      forall r | r in after.records
        ensures exists b :: b in s.records && (((b.key == r.key) && (b.label_ == r.label_)) && (b.provider == r.provider))
      {
        if r == change {
          assert record in s.records;
        }
      }
    } else {
      forall r | r in after.records
        ensures exists b :: b in s.records && (((b.key == r.key) && (b.label_ == r.label_)) && (b.provider == r.provider))
      {
        assert r in s.records;
      }
    }
  }
}

lemma editLabel_ensures(s: AccountStorage, key: int, label_: int)
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> alwaysGenerationsAreFresh(editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> alwaysRewrittenOnce(editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> alwaysDeletionResultMatchesPlan(editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> alwaysRollbackRestoresThePlan(editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> alwaysUnlinksStayInsidePlan(editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> stepStaleCommitChangesNothing(s, "editLabel", editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> stepRefreshKeepsLabelAndProvider(s, "editLabel", editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> stepEditKeepsCredentials(s, "editLabel", editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> stepMigrationKeepsContents(s, "editLabel", editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> stepOtherProvidersUntouched(s, "editLabel", editLabel(s, key, label_)))
  ensures (inv(s) ==> canEditLabel(s, key, label_) ==> stepRefusedPlanRemovesNothing(s, "editLabel", editLabel(s, key, label_)))
{
  if inv(s) && canEditLabel(s, key, label_) {
    var after := editLabel(s, key, label_);
    var record := recordOf(s, key);
    var change := record.(label_ := label_);
    Fresh(s);
    Fresh(after);
    RecordOf(s, key);
    assert s.records + s.unlinked == s.records;
    assert after.records + after.unlinked == after.records;
    ReplaceFresh(s.records, after.records, key, change, record, s.nextGeneration, s.nextGeneration);
    forall r | r in after.records
      ensures exists b :: b in s.records && ((((b.key == r.key) && (b.generation == r.generation)) && (b.credential == r.credential)) && (b.idToken == r.idToken))
    {
      if r == change {
        assert record in s.records;
      }
    }
  }
}

lemma editLabelIfCurrent_ensures(s: AccountStorage, reader: int, label_: int)
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> alwaysGenerationsAreFresh(editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> alwaysRewrittenOnce(editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> alwaysDeletionResultMatchesPlan(editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> alwaysRollbackRestoresThePlan(editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> alwaysUnlinksStayInsidePlan(editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> stepStaleCommitChangesNothing(s, "editLabelIfCurrent", editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> stepRefreshKeepsLabelAndProvider(s, "editLabelIfCurrent", editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> stepEditKeepsCredentials(s, "editLabelIfCurrent", editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> stepMigrationKeepsContents(s, "editLabelIfCurrent", editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> stepOtherProvidersUntouched(s, "editLabelIfCurrent", editLabelIfCurrent(s, reader, label_)))
  ensures (inv(s) ==> canEditLabelIfCurrent(s, reader, label_) ==> stepRefusedPlanRemovesNothing(s, "editLabelIfCurrent", editLabelIfCurrent(s, reader, label_)))
{
  if inv(s) && canEditLabelIfCurrent(s, reader, label_) {
    var after := editLabelIfCurrent(s, reader, label_);
    var held := readerOf(s, reader);
    Fresh(s);
    Fresh(after);
    ReaderOf(s, reader, held.(stage := ReaderStage.ReaderDone));
    RecordOf(s, held.key);
    assert s.records + s.unlinked == s.records;
    assert after.records + after.unlinked == after.records;
    forall x | x in after.readers
      ensures x.generation < after.nextGeneration
    {
    }
    if present(s, held.key) && recordOf(s, held.key).generation == held.generation {
      var record := recordOf(s, held.key);
      var change := record.(label_ := label_);
      ReplaceFresh(s.records, after.records, held.key, change, record, s.nextGeneration, s.nextGeneration);
      forall r | r in after.records
        ensures exists b :: b in s.records && ((((b.key == r.key) && (b.generation == r.generation)) && (b.credential == r.credential)) && (b.idToken == r.idToken))
      {
        if r == change {
          assert record in s.records;
        }
      }
    } else {
      forall r | r in after.records
        ensures exists b :: b in s.records && ((((b.key == r.key) && (b.generation == r.generation)) && (b.credential == r.credential)) && (b.idToken == r.idToken))
      {
        assert r in s.records;
      }
    }
  }
}

lemma migrate_ensures(s: AccountStorage, key: int, fault: MigrationFault)
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> alwaysGenerationsAreFresh(migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> alwaysRewrittenOnce(migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> alwaysDeletionResultMatchesPlan(migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> alwaysRollbackRestoresThePlan(migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> alwaysUnlinksStayInsidePlan(migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> stepStaleCommitChangesNothing(s, "migrate", migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> stepRefreshKeepsLabelAndProvider(s, "migrate", migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> stepEditKeepsCredentials(s, "migrate", migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> stepMigrationKeepsContents(s, "migrate", migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> stepOtherProvidersUntouched(s, "migrate", migrate(s, key, fault)))
  ensures (inv(s) ==> canMigrate(s, key, fault) ==> stepRefusedPlanRemovesNothing(s, "migrate", migrate(s, key, fault)))
{
  if inv(s) && canMigrate(s, key, fault) {
    var after := migrate(s, key, fault);
    var record := recordOf(s, key);
    Fresh(s);
    Fresh(after);
    RecordOf(s, key);
    assert s.records + s.unlinked == s.records;
    assert after.records + after.unlinked == after.records;
    assert record in s.records;
    if record.format.LegacyFormat? && !fault.FaultBeforeRename? {
      var change := record.(format := RecordFormat.CurrentFormat, generation := (if (record.generation == 0) then s.nextGeneration else record.generation), rewrites := (record.rewrites + 1));
      ReplaceFresh(s.records, after.records, key, change, record, s.nextGeneration, after.nextGeneration);
      forall r | r in after.records
        ensures exists b :: b in s.records && (((((b.key == r.key) && (b.credential == r.credential)) && (b.label_ == r.label_)) && (!((b.generation > 0)) || (b.generation == r.generation))) && (!(b.format.CorruptRecord?) || (b == r)))
      {
        if r != change {
          assert r in s.records;
        }
      }
    } else {
      forall r | r in after.records
        ensures exists b :: b in s.records && (((((b.key == r.key) && (b.credential == r.credential)) && (b.label_ == r.label_)) && (!((b.generation > 0)) || (b.generation == r.generation))) && (!(b.format.CorruptRecord?) || (b == r)))
      {
        assert r in s.records;
      }
    }
  }
}

lemma restoreUnlinked_ensures(s: AccountStorage)
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> alwaysGenerationsAreFresh(restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> alwaysRewrittenOnce(restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> alwaysDeletionResultMatchesPlan(restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> alwaysRollbackRestoresThePlan(restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> alwaysUnlinksStayInsidePlan(restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> stepStaleCommitChangesNothing(s, "restoreUnlinked", restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> stepRefreshKeepsLabelAndProvider(s, "restoreUnlinked", restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> stepEditKeepsCredentials(s, "restoreUnlinked", restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> stepMigrationKeepsContents(s, "restoreUnlinked", restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> stepOtherProvidersUntouched(s, "restoreUnlinked", restoreUnlinked(s)))
  ensures (inv(s) ==> canRestoreUnlinked(s) ==> stepRefusedPlanRemovesNothing(s, "restoreUnlinked", restoreUnlinked(s)))
{
  if inv(s) && canRestoreUnlinked(s) {
    var after := restoreUnlinked(s);
    Fresh(s);
    Fresh(after);
    assert after.records + after.unlinked == s.records + s.unlinked;
    forall p | p in s.plan
      ensures exists r :: r in after.records && ((r.key == p.key) && (r.generation == p.generation))
    {
      if exists r :: r in s.records && (((r.key == p.key) && (r.generation == p.generation)) && (r.provider == s.deletionProvider)) {
        var r :| r in s.records && (((r.key == p.key) && (r.generation == p.generation)) && (r.provider == s.deletionProvider));
        assert r in after.records;
      } else {
        var u :| u in s.unlinked && ((u.key == p.key) && (u.generation == p.generation));
        assert u in after.records;
      }
    }
  }
}

lemma confirmDeletion_ensures(s: AccountStorage)
  ensures (inv(s) ==> canConfirmDeletion(s) ==> alwaysGenerationsAreFresh(confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> alwaysRewrittenOnce(confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> alwaysDeletionResultMatchesPlan(confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> alwaysRollbackRestoresThePlan(confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> alwaysUnlinksStayInsidePlan(confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> stepStaleCommitChangesNothing(s, "confirmDeletion", confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> stepRefreshKeepsLabelAndProvider(s, "confirmDeletion", confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> stepEditKeepsCredentials(s, "confirmDeletion", confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> stepMigrationKeepsContents(s, "confirmDeletion", confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> stepOtherProvidersUntouched(s, "confirmDeletion", confirmDeletion(s)))
  ensures (inv(s) ==> canConfirmDeletion(s) ==> stepRefusedPlanRemovesNothing(s, "confirmDeletion", confirmDeletion(s)))
{
  if inv(s) && canConfirmDeletion(s) {
    var after := confirmDeletion(s);
    Fresh(s);
    Fresh(after);
    SplitDistinct(s.records, s.unlinked);
    assert after.records + after.unlinked == s.records;
    assert forall x :: x in s.records ==> x in s.records + s.unlinked;
    var unlinkedKeys := set u | u in s.unlinked :: u.key;
    var planKeys := set p | p in s.plan :: p.key;
    KeySetCard(s.unlinked);
    PlanKeyCard(s.plan);
    forall k | k in unlinkedKeys
      ensures k in planKeys
    {
      var u :| u in s.unlinked && u.key == k;
      var p :| p in s.plan && ((p.key == u.key) && (p.generation == u.generation));
    }
    SubsetFull(unlinkedKeys, planKeys);
    forall r | r in s.records && r.provider == s.deletionProvider
      ensures !(exists p :: p in s.plan && (p.key == r.key))
    {
      if exists p :: p in s.plan && (p.key == r.key) {
        var p :| p in s.plan && (p.key == r.key);
        assert p.key in planKeys;
        var u :| u in s.unlinked && u.key == p.key;
        assert present(s, u.key);
      }
    }
  }
}

lemma unlinkPlanned_ensures(s: AccountStorage, key: int)
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> alwaysGenerationsAreFresh(unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> alwaysRewrittenOnce(unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> alwaysDeletionResultMatchesPlan(unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> alwaysRollbackRestoresThePlan(unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> alwaysUnlinksStayInsidePlan(unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> stepStaleCommitChangesNothing(s, "unlinkPlanned", unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> stepRefreshKeepsLabelAndProvider(s, "unlinkPlanned", unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> stepEditKeepsCredentials(s, "unlinkPlanned", unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> stepMigrationKeepsContents(s, "unlinkPlanned", unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> stepOtherProvidersUntouched(s, "unlinkPlanned", unlinkPlanned(s, key)))
  ensures (inv(s) ==> canUnlinkPlanned(s, key) ==> stepRefusedPlanRemovesNothing(s, "unlinkPlanned", unlinkPlanned(s, key)))
{
  if inv(s) && canUnlinkPlanned(s, key) {
    var after := unlinkPlanned(s, key);
    var moved := recordOf(s, key);
    Fresh(s);
    Fresh(after);
    RecordOf(s, key);
    RemoveFilter(s, key);
    UnlinkFresh(s.records, s.unlinked, key, moved, s.nextGeneration);
    SplitDistinct(s.records, s.unlinked);
    assert after.records + after.unlinked == ProofLib.Filter((r: CredentialRecord) => (r.key != key), s.records) + (s.unlinked + [moved]);
    var p0 :| p0 in s.plan && p0.key == key;
    if exists u :: u in s.unlinked && ((u.key == p0.key) && (u.generation == p0.generation)) {
      var u :| u in s.unlinked && ((u.key == p0.key) && (u.generation == p0.generation));
    }
    var r0 :| r0 in s.records && (((r0.key == p0.key) && (r0.generation == p0.generation)) && (r0.provider == s.deletionProvider));
    KeyedUnique(s.records, r0, moved);
    forall u | u in after.unlinked
      ensures (exists p :: p in after.plan && ((p.key == u.key) && (p.generation == u.generation))) && !(present(after, u.key)) && (u.provider == after.deletionProvider)
    {
      if u != moved {
        assert u in s.unlinked;
        if present(after, u.key) {
          var w :| w in after.records && w.key == u.key;
        }
      }
    }
    forall p | p in after.plan
      ensures (exists r :: r in after.records && (((r.key == p.key) && (r.generation == p.generation)) && (r.provider == after.deletionProvider))) || (exists u :: u in after.unlinked && ((u.key == p.key) && (u.generation == p.generation)))
    {
      if exists r :: r in s.records && (((r.key == p.key) && (r.generation == p.generation)) && (r.provider == s.deletionProvider)) {
        var r :| r in s.records && (((r.key == p.key) && (r.generation == p.generation)) && (r.provider == s.deletionProvider));
        if r.key == key {
          KeyedUnique(s.records, r, moved);
          assert moved in after.unlinked;
        } else {
          assert r in after.records;
        }
      } else {
        var u :| u in s.unlinked && ((u.key == p.key) && (u.generation == p.generation));
        assert u in after.unlinked;
      }
    }
    forall b | b in s.records && b.provider != s.deletionProvider
      ensures b in after.records
    {
      if b.key == key {
        KeyedUnique(s.records, b, moved);
      }
    }
  }
}

lemma validateDeletion_ensures(s: AccountStorage)
  ensures (inv(s) ==> canValidateDeletion(s) ==> alwaysGenerationsAreFresh(validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> alwaysRewrittenOnce(validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> alwaysDeletionResultMatchesPlan(validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> alwaysRollbackRestoresThePlan(validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> alwaysUnlinksStayInsidePlan(validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> stepStaleCommitChangesNothing(s, "validateDeletion", validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> stepRefreshKeepsLabelAndProvider(s, "validateDeletion", validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> stepEditKeepsCredentials(s, "validateDeletion", validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> stepMigrationKeepsContents(s, "validateDeletion", validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> stepOtherProvidersUntouched(s, "validateDeletion", validateDeletion(s)))
  ensures (inv(s) ==> canValidateDeletion(s) ==> stepRefusedPlanRemovesNothing(s, "validateDeletion", validateDeletion(s)))
{
  if inv(s) && canValidateDeletion(s) {
    var after := validateDeletion(s);
    ProviderFilter(s, s.deletionProvider);
    if after.deletionPhase.Unlinking? {
      var listed := ProofLib.Filter((r: CredentialRecord) => (r.provider == s.deletionProvider), s.records);
      forall p | p in after.plan
        ensures exists r :: r in after.records && (((r.key == p.key) && (r.generation == p.generation)) && (r.provider == after.deletionProvider))
      {
        var i :| 0 <= i < |s.plan| && s.plan[i] == p;
        assert listed[i] in listed;
        ProofLib.FilterMember((r: CredentialRecord) => (r.provider == s.deletionProvider), s.records, listed[i]);
      }
    }
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  var s := initialHolds();
  Fresh(s);
  var xs := s.records + s.unlinked;
  assert xs == s.records;
  assert xs[0].key == 1 && xs[1].key == 2 && xs[2].key == 3 && |xs| == 3;
  forall x, y | x in xs && y in xs && x.generation > 0 && x.generation == y.generation
    ensures x == y
  {
  }
}
