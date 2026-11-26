lemma FilterLenLe<T>(p: T -> bool, xs: seq<T>)
  ensures |ProofLib.Filter(p, xs)| <= |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    FilterLenLe(p, xs[1..]);
  }
}

lemma DistinctTokenIdsIffDistinctBy(table: seq<OneShotToken>)
  ensures distinctTokenIds(table) <==> ProofLib.DistinctBy(table, (t: OneShotToken) => t.id)
{
  assert distinctTokenIds(table) ==
    (forall t :: t in table ==> |ProofLib.Filter((other: OneShotToken) => (other.id == t.id), table)| == 1);
  if distinctTokenIds(table) {
    forall i, j | 0 <= i < |table| && 0 <= j < |table| && i != j
      ensures table[i].id != table[j].id
    {
      ProofLib.FilterCountOneIffUnique((other: OneShotToken) => (other.id == table[i].id), table, (t: OneShotToken) => t.id, i);
    }
  }
  if ProofLib.DistinctBy(table, (t: OneShotToken) => t.id) {
    forall t | t in table
      ensures |ProofLib.Filter((other: OneShotToken) => (other.id == t.id), table)| == 1
    {
      var i :| 0 <= i < |table| && table[i] == t;
      ProofLib.FilterOne((other: OneShotToken) => (other.id == t.id), table, i);
    }
  }
}

lemma lawIssuedTokenLivesThroughItsDeadline_ensures(table: seq<OneShotToken>, tokenId: int, at: int, ttl: int, capacity: int)
  ensures (lawIssuedTokenLivesThroughItsDeadline(table, tokenId, at, ttl, capacity) == true)
{
  if freshTokenId(table, tokenId) && ttl >= 0 && capacity >= 1 {
    var local_0 := ProofLib.Filter((t: OneShotToken) => (at <= t.until), table);
    var local_1 := if |local_0| >= capacity then (if 0 < |local_0| then local_0[0..0] + local_0[1..] else local_0) else local_0;
    var added := OneShotToken(tokenId, at + ttl);
    var res := local_1 + [added];
    assert res == issueToken(table, at, capacity, tokenId, ttl);
    assert added in res;
    forall t | t in res && t.id == tokenId
      ensures t == added
    {
      if t in local_1 {
        assert t in local_0;
        ProofLib.FilterMember((x: OneShotToken) => (at <= x.until), table, t);
        assert t in table;
      }
    }
  }
}

lemma lawIssueKeepsBoundedLiveDistinctTable_ensures(table: seq<OneShotToken>, tokenId: int, at: int, ttl: int, capacity: int)
  ensures (lawIssueKeepsBoundedLiveDistinctTable(table, tokenId, at, ttl, capacity) == true)
{
  if |table| <= capacity && distinctTokenIds(table) && freshTokenId(table, tokenId) && ttl >= 0 && capacity >= 1 {
    var local_0 := ProofLib.Filter((t: OneShotToken) => (at <= t.until), table);
    var local_1 := if |local_0| >= capacity then (if 0 < |local_0| then local_0[0..0] + local_0[1..] else local_0) else local_0;
    var added := OneShotToken(tokenId, at + ttl);
    var res := local_1 + [added];
    assert res == issueToken(table, at, capacity, tokenId, ttl);
    FilterLenLe((t: OneShotToken) => (at <= t.until), table);
    assert |local_0| <= |table|;
    assert |res| <= capacity;
    forall t | t in local_0
      ensures at <= t.until && t in table
    {
      ProofLib.FilterMember((x: OneShotToken) => (at <= x.until), table, t);
    }
    assert forall t :: t in local_1 ==> t in local_0;
    DistinctTokenIdsIffDistinctBy(table);
    ProofLib.FilterKeepsDistinctBy((t: OneShotToken) => (at <= t.until), table, (t: OneShotToken) => t.id);
    assert ProofLib.DistinctBy(local_0, (t: OneShotToken) => t.id);
    assert ProofLib.DistinctBy(local_1, (t: OneShotToken) => t.id) by {
      if |local_0| >= capacity && 0 < |local_0| {
        assert local_1 == local_0[1..];
        forall i, j | 0 <= i < |local_1| && 0 <= j < |local_1| && i != j
          ensures local_1[i].id != local_1[j].id
        {
          assert local_1[i] == local_0[i + 1] && local_1[j] == local_0[j + 1];
        }
      }
    }
    assert ProofLib.DistinctBy([added], (t: OneShotToken) => t.id);
    ProofLib.DistinctByConcat(local_1, [added], (t: OneShotToken) => t.id);
    DistinctTokenIdsIffDistinctBy(res);
  }
}
