lemma MemoFilters(m: Memo)
  ensures alwaysUniqueEntryKeys(m) == (forall entry :: entry in m.entries ==> |ProofLib.Filter((other: MemoEntry) => (other.key == entry.key), m.entries)| == 1)
  ensures alwaysUniqueObserverIds(m) == (forall observer :: observer in m.observers ==> |ProofLib.Filter((other: RejectionObserver) => (other.id == observer.id), m.observers)| == 1)
{}

lemma MemoEntryDistinct(entries: seq<MemoEntry>)
  ensures (forall entry :: entry in entries ==> |ProofLib.Filter((other: MemoEntry) => (other.key == entry.key), entries)| == 1) <==> ProofLib.DistinctBy(entries, (entry: MemoEntry) => entry.key)
{
  if forall entry :: entry in entries ==> |ProofLib.Filter((other: MemoEntry) => (other.key == entry.key), entries)| == 1 {
    forall i, j | 0 <= i < |entries| && 0 <= j < |entries| && i != j ensures entries[i].key != entries[j].key {
      ProofLib.FilterCountOneIffUnique((other: MemoEntry) => (other.key == entries[i].key), entries, (entry: MemoEntry) => entry.key, i);
    }
  } else if ProofLib.DistinctBy(entries, (entry: MemoEntry) => entry.key) {
    forall entry | entry in entries ensures |ProofLib.Filter((other: MemoEntry) => (other.key == entry.key), entries)| == 1 {
      var i :| 0 <= i < |entries| && entries[i] == entry;
      ProofLib.FilterOne((other: MemoEntry) => (other.key == entry.key), entries, i);
    }
  }
}

lemma MemoObserverDistinct(observers: seq<RejectionObserver>)
  ensures (forall observer :: observer in observers ==> |ProofLib.Filter((other: RejectionObserver) => (other.id == observer.id), observers)| == 1) <==> ProofLib.DistinctBy(observers, (observer: RejectionObserver) => observer.id)
{
  if forall observer :: observer in observers ==> |ProofLib.Filter((other: RejectionObserver) => (other.id == observer.id), observers)| == 1 {
    forall i, j | 0 <= i < |observers| && 0 <= j < |observers| && i != j ensures observers[i].id != observers[j].id {
      ProofLib.FilterCountOneIffUnique((other: RejectionObserver) => (other.id == observers[i].id), observers, (observer: RejectionObserver) => observer.id, i);
    }
  } else if ProofLib.DistinctBy(observers, (observer: RejectionObserver) => observer.id) {
    forall observer | observer in observers ensures |ProofLib.Filter((other: RejectionObserver) => (other.id == observer.id), observers)| == 1 {
      var i :| 0 <= i < |observers| && observers[i] == observer;
      ProofLib.FilterOne((other: RejectionObserver) => (other.id == observer.id), observers, i);
    }
  }
}

lemma MemoFilterEverything<T>(p: T -> bool, xs: seq<T>)
  requires forall x :: x in xs ==> p(x)
  ensures ProofLib.Filter(p, xs) == xs
  decreases |xs|
{
  if |xs| == 0 { ProofLib.FilterNil(p, xs); }
  else {
    ProofLib.FilterCons(p, xs);
    MemoFilterEverything(p, xs[1..]);
  }
}

lemma MemoFilterNested<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
  requires forall x :: x in xs && p(x) ==> q(x)
  ensures ProofLib.Filter(p, ProofLib.Filter(q, xs)) == ProofLib.Filter(p, xs)
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(q, xs);
    ProofLib.FilterNil(p, xs);
    ProofLib.FilterNil(p, ProofLib.Filter(q, xs));
  } else {
    var rest := ProofLib.Filter(q, xs[1..]);
    ProofLib.FilterCons(q, xs);
    ProofLib.FilterCons(p, xs);
    MemoFilterNested(p, q, xs[1..]);
    assert ProofLib.Filter(p, rest) == ProofLib.Filter(p, xs[1..]);
    if q(xs[0]) {
      assert ProofLib.Filter(q, xs) == [xs[0]] + rest;
      ProofLib.FilterCons(p, [xs[0]] + rest);
      assert ([xs[0]] + rest)[1..] == rest;
      assert ProofLib.Filter(p, ProofLib.Filter(q, xs)) == (if p(xs[0]) then [xs[0]] else []) + ProofLib.Filter(p, rest);
    } else {
      assert !p(xs[0]);
      assert ProofLib.Filter(q, xs) == rest;
      assert ProofLib.Filter(p, xs) == ProofLib.Filter(p, xs[1..]);
    }
  }
}

lemma MemoLookup(m: Memo, key: string)
  ensures entryAt(m, key) == (if |ProofLib.Filter((entry: MemoEntry) => (entry.key == key), m.entries)| > 0 then ProofLib.Filter((entry: MemoEntry) => (entry.key == key), m.entries)[0] else absentEntry)
{}

lemma MemoLookupKnown(m: Memo, entry: MemoEntry)
  requires alwaysUniqueEntryKeys(m)
  requires entry in m.entries
  ensures entryAt(m, entry.key) == entry
{
  MemoFilters(m); MemoLookup(m, entry.key);
  ProofLib.FilterMember((other: MemoEntry) => (other.key == entry.key), m.entries, entry);
  assert |ProofLib.Filter((other: MemoEntry) => (other.key == entry.key), m.entries)| == 1;
}

lemma MemoLookupSame(m: Memo, key: string, expected: MemoEntry)
  requires expected in m.entries && expected.key == key
  requires forall entry :: entry in m.entries && entry.key == key ==> entry == expected
  ensures entryAt(m, key) == expected
{
  MemoLookup(m, key);
  ProofLib.FilterMember((entry: MemoEntry) => (entry.key == key), m.entries, expected);
  var matches := ProofLib.Filter((entry: MemoEntry) => (entry.key == key), m.entries);
  assert |matches| > 0;
  ProofLib.FilterMember((entry: MemoEntry) => (entry.key == key), m.entries, matches[0]);
}

lemma MemoMutationParts(m: Memo, key: string, observerId: int)
  ensures invalidateKey(m, key).entries == ProofLib.Filter((entry: MemoEntry) => (entry.key != key), m.entries)
  ensures releaseObserver(m, observerId).observers == ProofLib.Filter((observer: RejectionObserver) => (observer.id != observerId), m.observers)
  ensures observeRejection(m, observerId).entries == ProofLib.Filter((entry: MemoEntry) => ((entry.key != observerAt(m, observerId).key) || (entry.promiseId != observerAt(m, observerId).promiseId)), m.entries)
  ensures observeRejection(m, observerId).observers == ProofLib.Filter((other: RejectionObserver) => (other.id != observerId), m.observers)
{}

lemma MemoTailDistinct(entries: seq<MemoEntry>)
  requires |entries| > 0 && ProofLib.DistinctBy(entries, (entry: MemoEntry) => entry.key)
  ensures ProofLib.DistinctBy(entries[1..], (entry: MemoEntry) => entry.key)
{
  forall i, j | 0 <= i < |entries[1..]| && 0 <= j < |entries[1..]| && i != j
    ensures entries[1..][i].key != entries[1..][j].key
  { assert entries[1..][i] == entries[i + 1] && entries[1..][j] == entries[j + 1]; }
}

lemma invalidateKey_ensures(m: Memo, key: string)
  ensures (inv(m) ==> alwaysUniqueEntryKeys(invalidateKey(m, key)))
  ensures (inv(m) ==> alwaysUniqueObserverIds(invalidateKey(m, key)))
  ensures (inv(m) ==> alwaysValidMemoIdentities(invalidateKey(m, key)))
  ensures (inv(m) ==> alwaysCapacityBound(invalidateKey(m, key)))
  ensures (inv(m) ==> stepInvalidationRetainsPendingObservers(m, "invalidateKey", invalidateKey(m, key)))
  ensures (inv(m) ==> stepConfigurationIsStable(m, invalidateKey(m, key)))
  ensures (inv(m) ==> stepElapsedTimeRetainsEntries(m, "invalidateKey", invalidateKey(m, key)))
{
  if inv(m) {
    var after := invalidateKey(m, key);
    MemoFilters(m); MemoFilters(after);
    MemoEntryDistinct(m.entries); MemoEntryDistinct(after.entries);
    MemoMutationParts(m, key, 0);
    ProofLib.FilterKeepsDistinctBy((entry: MemoEntry) => (entry.key != key), m.entries, (entry: MemoEntry) => entry.key);
    ProofLib.FilterSubset((entry: MemoEntry) => (entry.key != key), m.entries);
  }
}

lemma releaseObserver_ensures(m: Memo, observerId: int)
  ensures (inv(m) ==> canReleaseObserver(m, observerId) ==> alwaysUniqueEntryKeys(releaseObserver(m, observerId)))
  ensures (inv(m) ==> canReleaseObserver(m, observerId) ==> alwaysUniqueObserverIds(releaseObserver(m, observerId)))
  ensures (inv(m) ==> canReleaseObserver(m, observerId) ==> alwaysValidMemoIdentities(releaseObserver(m, observerId)))
  ensures (inv(m) ==> canReleaseObserver(m, observerId) ==> alwaysCapacityBound(releaseObserver(m, observerId)))
  ensures (inv(m) ==> canReleaseObserver(m, observerId) ==> stepInvalidationRetainsPendingObservers(m, "releaseObserver", releaseObserver(m, observerId)))
  ensures (inv(m) ==> canReleaseObserver(m, observerId) ==> stepConfigurationIsStable(m, releaseObserver(m, observerId)))
  ensures (inv(m) ==> canReleaseObserver(m, observerId) ==> stepElapsedTimeRetainsEntries(m, "releaseObserver", releaseObserver(m, observerId)))
{
  if inv(m) && canReleaseObserver(m, observerId) {
    var after := releaseObserver(m, observerId);
    MemoFilters(m); MemoFilters(after);
    MemoObserverDistinct(m.observers); MemoObserverDistinct(after.observers);
    MemoMutationParts(m, "", observerId);
    ProofLib.FilterKeepsDistinctBy((observer: RejectionObserver) => (observer.id != observerId), m.observers, (observer: RejectionObserver) => observer.id);
    ProofLib.FilterSubset((observer: RejectionObserver) => (observer.id != observerId), m.observers);
  }
}

lemma observeRejection_ensures(m: Memo, observerId: int)
  ensures (inv(m) ==> canObserveRejection(m, observerId) ==> alwaysUniqueEntryKeys(observeRejection(m, observerId)))
  ensures (inv(m) ==> canObserveRejection(m, observerId) ==> alwaysUniqueObserverIds(observeRejection(m, observerId)))
  ensures (inv(m) ==> canObserveRejection(m, observerId) ==> alwaysValidMemoIdentities(observeRejection(m, observerId)))
  ensures (inv(m) ==> canObserveRejection(m, observerId) ==> alwaysCapacityBound(observeRejection(m, observerId)))
  ensures (inv(m) ==> canObserveRejection(m, observerId) ==> stepInvalidationRetainsPendingObservers(m, "observeRejection", observeRejection(m, observerId)))
  ensures (inv(m) ==> canObserveRejection(m, observerId) ==> stepConfigurationIsStable(m, observeRejection(m, observerId)))
  ensures (inv(m) ==> canObserveRejection(m, observerId) ==> stepElapsedTimeRetainsEntries(m, "observeRejection", observeRejection(m, observerId)))
{
  if inv(m) && canObserveRejection(m, observerId) {
    var after := observeRejection(m, observerId);
    MemoFilters(m); MemoFilters(after);
    MemoEntryDistinct(m.entries); MemoEntryDistinct(after.entries);
    MemoObserverDistinct(m.observers); MemoObserverDistinct(after.observers);
    MemoMutationParts(m, "", observerId);
    ProofLib.FilterKeepsDistinctBy((entry: MemoEntry) => ((entry.key != observerAt(m, observerId).key) || (entry.promiseId != observerAt(m, observerId).promiseId)), m.entries, (entry: MemoEntry) => entry.key);
    ProofLib.FilterSubset((entry: MemoEntry) => ((entry.key != observerAt(m, observerId).key) || (entry.promiseId != observerAt(m, observerId).promiseId)), m.entries);
    ProofLib.FilterKeepsDistinctBy((other: RejectionObserver) => (other.id != observerId), m.observers, (observer: RejectionObserver) => observer.id);
    ProofLib.FilterSubset((other: RejectionObserver) => (other.id != observerId), m.observers);
  }
}

lemma storeEntry_ensures(m: Memo, key: string, promiseId: int, meta: string)
  ensures (inv(m) ==> canStoreEntry(m, key, promiseId, meta) ==> alwaysUniqueEntryKeys(storeEntry(m, key, promiseId, meta)))
  ensures (inv(m) ==> canStoreEntry(m, key, promiseId, meta) ==> alwaysUniqueObserverIds(storeEntry(m, key, promiseId, meta)))
  ensures (inv(m) ==> canStoreEntry(m, key, promiseId, meta) ==> alwaysValidMemoIdentities(storeEntry(m, key, promiseId, meta)))
  ensures (inv(m) ==> canStoreEntry(m, key, promiseId, meta) ==> alwaysCapacityBound(storeEntry(m, key, promiseId, meta)))
  ensures (inv(m) ==> canStoreEntry(m, key, promiseId, meta) ==> stepInvalidationRetainsPendingObservers(m, "storeEntry", storeEntry(m, key, promiseId, meta)))
  ensures (inv(m) ==> canStoreEntry(m, key, promiseId, meta) ==> stepConfigurationIsStable(m, storeEntry(m, key, promiseId, meta)))
  ensures (inv(m) ==> canStoreEntry(m, key, promiseId, meta) ==> stepElapsedTimeRetainsEntries(m, "storeEntry", storeEntry(m, key, promiseId, meta)))
{
  if inv(m) && canStoreEntry(m, key, promiseId, meta) {
    var after := storeEntry(m, key, promiseId, meta);
    var supplied := MemoEntry(key, promiseId, meta, m.now);
    MemoFilters(m); MemoFilters(after);
    MemoEntryDistinct(m.entries); MemoEntryDistinct(after.entries);
    MemoObserverDistinct(m.observers); MemoObserverDistinct(after.observers);
    ProofLib.DistinctByConcat(m.observers, [RejectionObserver(m.nextObserver, key, promiseId)], (observer: RejectionObserver) => observer.id);
    if hasEntry(m, key) {
      assert |after.entries| == |m.entries|;
      forall i | 0 <= i < |m.entries| ensures after.entries[i].key == m.entries[i].key {}
      forall entry | entry in after.entries ensures |ProofLib.Filter((other: MemoEntry) => (other.key == entry.key), after.entries)| == 1 {
        var i :| 0 <= i < |after.entries| && after.entries[i] == entry;
        assert m.entries[i].key == entry.key;
        ProofLib.FilterLengthPointwise((other: MemoEntry) => (other.key == entry.key), (other: MemoEntry) => (other.key == entry.key), m.entries, after.entries);
      }
    } else {
      var retainedEntries := if |m.entries| >= m.capacity && |m.entries| > 0 then m.entries[1..] else m.entries;
      if |m.entries| >= m.capacity && |m.entries| > 0 { MemoTailDistinct(m.entries); }
      assert after.entries == retainedEntries + [supplied];
      ProofLib.DistinctByConcat(retainedEntries, [supplied], (entry: MemoEntry) => entry.key);
    }
  }
}

lemma lawRejectionPreservesOtherKeys_ensures(m: Memo, observerId: int, key: string)
  ensures (lawRejectionPreservesOtherKeys(m, observerId, key) == true)
{
  if observerAt(m, observerId).key != key {
    var after := observeRejection(m, observerId);
    MemoMutationParts(m, key, observerId);
    MemoLookup(m, key); MemoLookup(after, key);
    MemoFilterNested((entry: MemoEntry) => (entry.key == key), (entry: MemoEntry) => ((entry.key != observerAt(m, observerId).key) || (entry.promiseId != observerAt(m, observerId).promiseId)), m.entries);
  }
}

lemma lawRejectionPreservesReplacement_ensures(m: Memo, observerId: int)
  ensures (lawRejectionPreservesReplacement(m, observerId) == true)
{
  if alwaysUniqueEntryKeys(m) && entryAt(m, observerAt(m, observerId).key).promiseId != observerAt(m, observerId).promiseId {
    MemoMutationParts(m, "", observerId);
    forall entry | entry in m.entries
      ensures entry.key != observerAt(m, observerId).key || entry.promiseId != observerAt(m, observerId).promiseId
    {
      if entry.key == observerAt(m, observerId).key { MemoLookupKnown(m, entry); }
    }
    MemoFilterEverything((entry: MemoEntry) => ((entry.key != observerAt(m, observerId).key) || (entry.promiseId != observerAt(m, observerId).promiseId)), m.entries);
  }
}

lemma lawPutRetainsExactPromiseAndMetadata_ensures(m: Memo, key: string, promiseId: int, meta: string)
  ensures (lawPutRetainsExactPromiseAndMetadata(m, key, promiseId, meta) == true)
{
  var after := storeEntry(m, key, promiseId, meta);
  var supplied := MemoEntry(key, promiseId, meta, m.now);
  if hasEntry(m, key) {
    var previous :| previous in m.entries && previous.key == key;
    var i :| 0 <= i < |m.entries| && m.entries[i] == previous;
    assert after.entries[i] == supplied;
  } else { assert after.entries[|after.entries| - 1] == supplied; }
  assert supplied in after.entries;
  forall entry | entry in after.entries && entry.key == key ensures entry == supplied {}
  MemoLookupSame(after, key, supplied);
}
