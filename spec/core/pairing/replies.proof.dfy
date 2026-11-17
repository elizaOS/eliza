lemma ReplyClaimsDistinct(s: PairingReplies)
  requires alwaysUniqueReplyScopes(s)
  ensures ProofLib.DistinctBy(s.retained, (entry: ReplyClaim) => entry.scope)
{
  var rows := s.retained;
  var k := (entry: ReplyClaim) => entry.scope;
  reveal alwaysUniqueReplyScopes(), ProofLib.Filter(), ProofLib.DistinctBy();
  forall i | 0 <= i < |rows|
    ensures forall j :: 0 <= j < |rows| && j != i ==> k(rows[j]) != k(rows[i])
  {
    var p := (entry: ReplyClaim) => entry.scope == rows[i].scope;
    assert rows[i] in rows;
    assert |ProofLib.Filter(p, rows)| == 1;
    ProofLib.FilterCountOneIffUnique(p, rows, k, i);
  }
}

lemma ReplyScopesFromDistinct(s: PairingReplies)
  requires ProofLib.DistinctBy(s.retained, (entry: ReplyClaim) => entry.scope)
  ensures alwaysUniqueReplyScopes(s)
{
  var rows := s.retained;
  var k := (entry: ReplyClaim) => entry.scope;
  reveal alwaysUniqueReplyScopes(), ProofLib.Filter(), ProofLib.DistinctBy();
  forall entry | entry in rows
    ensures |ProofLib.Filter((other: ReplyClaim) => other.scope == entry.scope, rows)| == 1
  {
    var i :| 0 <= i < |rows| && rows[i] == entry;
    ProofLib.FilterCountOneIffUnique((other: ReplyClaim) => other.scope == entry.scope, rows, k, i);
  }
}

lemma ReplyRefreshDistinct(entries: seq<ReplyClaim>, scope: ReplyScope, now: int)
  requires ProofLib.DistinctBy(entries, (entry: ReplyClaim) => entry.scope)
  ensures ProofLib.DistinctBy(refreshedClaims(entries, scope, now), (entry: ReplyClaim) => entry.scope)
  ensures |refreshedClaims(entries, scope, now)| <= |entries| + 1
{
  var k := (entry: ReplyClaim) => entry.scope;
  var refreshed := refreshedClaims(entries, scope, now);
  reveal refreshedClaims(), ProofLib.DistinctBy();
  if exists entry :: entry in entries && entry.scope == scope {
    forall i | 0 <= i < |entries| ensures refreshed[i].scope == entries[i].scope {
      assert refreshed[i] == (if entries[i].scope == scope then ReplyClaim(scope, now) else entries[i]);
    }
  } else {
    ProofLib.DistinctByConcat(entries, [ReplyClaim(scope, now)], k);
  }
}

lemma ReplyFilterLength(p: ReplyClaim -> bool, rows: seq<ReplyClaim>)
  ensures |ProofLib.Filter(p, rows)| <= |rows|
  decreases |rows|
{
  if |rows| == 0 {
    ProofLib.FilterNil(p, rows);
  } else {
    ProofLib.FilterCons(p, rows);
    ReplyFilterLength(p, rows[1..]);
  }
}

lemma ReplyCollect(s: PairingReplies, now: int)
  requires alwaysReplyCacheBound(s)
  requires ProofLib.DistinctBy(s.retained, (entry: ReplyClaim) => entry.scope)
  ensures ProofLib.DistinctBy(boundedClaims(if |s.retained| >= s.capacity then liveClaims(s, now) else s.retained, s.capacity), (entry: ReplyClaim) => entry.scope)
  ensures |boundedClaims(if |s.retained| >= s.capacity then liveClaims(s, now) else s.retained, s.capacity)| < s.capacity
{
  var k := (entry: ReplyClaim) => entry.scope;
  var swept := if |s.retained| >= s.capacity then liveClaims(s, now) else s.retained;
  reveal liveClaims(), ProofLib.Filter(), boundedClaims(), ProofLib.DistinctBy();
  if |s.retained| >= s.capacity {
    var p := (entry: ReplyClaim) => now - entry.claimedAt < s.ttl;
    assert swept == ProofLib.Filter(p, s.retained);
    ProofLib.FilterKeepsDistinctBy(p, s.retained, k);
    ReplyFilterLength(p, s.retained);
  }
  if |swept| >= s.capacity {
    var retained := boundedClaims(swept, s.capacity);
    assert retained == swept[1..];
    forall i, j | 0 <= i < |retained| && 0 <= j < |retained| && i != j
      ensures k(retained[i]) != k(retained[j])
    {
      assert retained[i] == swept[i + 1] && retained[j] == swept[j + 1];
    }
  }
}

lemma claim_ensures(s: PairingReplies, scope: ReplyScope, now: int)
  ensures (inv(s) ==> canClaim(s) ==> alwaysReplyCacheBound(claim(s, scope, now)))
  ensures (inv(s) ==> canClaim(s) ==> alwaysUnconfiguredIsEmpty(claim(s, scope, now)))
  ensures (inv(s) ==> canClaim(s) ==> alwaysUniqueReplyScopes(claim(s, scope, now)))
  ensures (inv(s) ==> canClaim(s) ==> alwaysLiveClaimSuppresses(claim(s, scope, now)))
{
  if inv(s) && canClaim(s) {
    if !(exists entry :: entry in s.retained && entry.scope == scope && now - entry.claimedAt < s.ttl) {
      ReplyClaimsDistinct(s);
      ReplyCollect(s, now);
      var swept := if |s.retained| >= s.capacity then liveClaims(s, now) else s.retained;
      ReplyRefreshDistinct(boundedClaims(swept, s.capacity), scope, now);
      ReplyScopesFromDistinct(claim(s, scope, now));
    }
  }
}
