lemma lawStatementKeepsSignerPairs_ensures(signers: seq<SignerRelations>)
  ensures (lawStatementKeepsSignerPairs(signers) == true)
{
  forall pair | pair in associationStatement(signers)
    ensures exists x :: x in signers && ((x.signer == pair.signer) && ((pair.relation.HandleLinks? && x.handlesLinks) || (pair.relation.ShareCredentials? && x.sharesCredentials)))
  {
    ProofLib.FoldLeftConcatMember((acc: seq<AssociationPair>, x: SignerRelations) => (acc + pairsOf(x)), pairsOf, [], signers, pair);
    var i :| 0 <= i < |signers| && pair in pairsOf(signers[i]);
    assert signers[i] in signers;
  }
}

lemma Single<T>(p: T -> bool, xs: seq<T>, i: int)
  requires 0 <= i < |xs| && p(xs[i]) && forall j :: 0 <= j < |xs| && j != i ==> !p(xs[j])
  ensures ProofLib.Filter(p, xs) == [xs[i]]
{
  ProofLib.FilterOne(p, xs, i);
  ProofLib.FilterMember(p, xs, xs[i]);
}

lemma CountPointwise<T>(p: T -> bool, xs: seq<T>, ys: seq<T>, k: int)
  requires |xs| == |ys| && forall i :: 0 <= i < |xs| && i != k && p(xs[i]) ==> p(ys[i])
  ensures |ProofLib.Filter(p, xs)| <= |ProofLib.Filter(p, ys)| + (if 0 <= k < |xs| then 1 else 0)
  decreases |xs|
{
  if |xs| > 0 {
    ProofLib.FilterCons(p, xs); ProofLib.FilterCons(p, ys);
    CountPointwise(p, xs[1..], ys[1..], k - 1);
  }
}

lemma Filters(s: SignIn, id: int)
  ensures grantOf(s, id) == (if 0 < |ProofLib.Filter((x: Grant) => (x.id == id), s.grants)| then ProofLib.Filter((x: Grant) => (x.id == id), s.grants)[0] else noGrant)
  ensures keyOf(s, id) == (if 0 < |ProofLib.Filter((x: Key) => (x.id == id), s.keys)| then ProofLib.Filter((x: Key) => (x.id == id), s.keys)[0] else noKey)
  ensures alwaysEachCodeHasItsOwnNumber(s) == (forall g :: g in s.grants ==> g.id >= 1 && g.id <= |s.grants| && |ProofLib.Filter((o: Grant) => (o.id == g.id), s.grants)| == 1)
  ensures alwaysOneKeyPerGrant(s) == (forall k :: k in s.keys ==> |ProofLib.Filter((o: Key) => (o.id == k.id), s.keys)| == 1 && (exists g :: g in s.grants && (g.id == k.id)))
  ensures alwaysOneLiveSuccessor(s) == (forall k :: k in s.keys ==> |ProofLib.Filter((g: Grant) => ((g.from == k.id) && ((g.status.GrantPending? || g.status.GrantExchanged?) || g.status.GrantAcknowledged?)), s.grants)| <= 1)
{}

lemma GrantIds(s: SignIn)
  ensures alwaysEachCodeHasItsOwnNumber(s) == ((forall i :: 0 <= i < |s.grants| ==> 1 <= s.grants[i].id <= |s.grants|) && (forall i, j :: 0 <= i < |s.grants| && 0 <= j < |s.grants| && i != j ==> s.grants[i].id != s.grants[j].id))
{
  Filters(s, 0);
  forall a | 0 <= a < |s.grants|
    ensures |ProofLib.Filter((o: Grant) => (o.id == s.grants[a].id), s.grants)| == 1 <==> forall b :: 0 <= b < |s.grants| && b != a ==> s.grants[b].id != s.grants[a].id
  {
    ProofLib.FilterCountOneIffUnique((o: Grant) => (o.id == s.grants[a].id), s.grants, (x: Grant) => x.id, a);
  }
}

lemma KeyIds(s: SignIn)
  ensures alwaysOneKeyPerGrant(s) == ((forall i, j :: 0 <= i < |s.keys| && 0 <= j < |s.keys| && i != j ==> s.keys[i].id != s.keys[j].id) && (forall i :: 0 <= i < |s.keys| ==> exists g :: g in s.grants && g.id == s.keys[i].id))
{
  Filters(s, 0);
  forall a | 0 <= a < |s.keys|
    ensures |ProofLib.Filter((o: Key) => (o.id == s.keys[a].id), s.keys)| == 1 <==> forall b :: 0 <= b < |s.keys| && b != a ==> s.keys[b].id != s.keys[a].id
  {
    ProofLib.FilterCountOneIffUnique((o: Key) => (o.id == s.keys[a].id), s.keys, (x: Key) => x.id, a);
  }
}

lemma GrantAt(s: SignIn, id: int)
  requires forall i, j :: 0 <= i < |s.grants| && 0 <= j < |s.grants| && i != j ==> s.grants[i].id != s.grants[j].id
  ensures forall i :: 0 <= i < |s.grants| && s.grants[i].id == id ==> grantOf(s, id) == s.grants[i]
  ensures (forall i :: 0 <= i < |s.grants| ==> s.grants[i].id != id) ==> grantOf(s, id) == noGrant
{
  Filters(s, id);
  if exists i :: 0 <= i < |s.grants| && s.grants[i].id == id {
    var i :| 0 <= i < |s.grants| && s.grants[i].id == id;
    Single((x: Grant) => (x.id == id), s.grants, i);
  } else {
    ProofLib.FilterNone((x: Grant) => (x.id == id), s.grants);
  }
}

lemma KeyAt(s: SignIn, id: int)
  requires forall i, j :: 0 <= i < |s.keys| && 0 <= j < |s.keys| && i != j ==> s.keys[i].id != s.keys[j].id
  ensures forall i :: 0 <= i < |s.keys| && s.keys[i].id == id ==> keyOf(s, id) == s.keys[i]
  ensures (forall i :: 0 <= i < |s.keys| ==> s.keys[i].id != id) ==> keyOf(s, id) == noKey
{
  Filters(s, id);
  if exists i :: 0 <= i < |s.keys| && s.keys[i].id == id {
    var i :| 0 <= i < |s.keys| && s.keys[i].id == id;
    Single((x: Key) => (x.id == id), s.keys, i);
  } else {
    ProofLib.FilterNone((x: Key) => (x.id == id), s.keys);
  }
}

lemma View(s: SignIn)
  requires alwaysEachCodeHasItsOwnNumber(s) && alwaysOneKeyPerGrant(s)
  ensures forall i :: 0 <= i < |s.grants| ==> 1 <= s.grants[i].id <= |s.grants|
  ensures forall i, j :: 0 <= i < |s.grants| && 0 <= j < |s.grants| && i != j ==> s.grants[i].id != s.grants[j].id
  ensures forall i, j :: 0 <= i < |s.keys| && 0 <= j < |s.keys| && i != j ==> s.keys[i].id != s.keys[j].id
  ensures forall i :: 0 <= i < |s.keys| ==> exists j :: 0 <= j < |s.grants| && s.grants[j].id == s.keys[i].id
  ensures forall i :: 0 <= i < |s.grants| ==> grantOf(s, s.grants[i].id) == s.grants[i]
  ensures forall i :: 0 <= i < |s.keys| ==> keyOf(s, s.keys[i].id) == s.keys[i]
{
  GrantIds(s); KeyIds(s);
  forall i | 0 <= i < |s.grants| ensures grantOf(s, s.grants[i].id) == s.grants[i] { GrantAt(s, s.grants[i].id); }
  forall i | 0 <= i < |s.keys| ensures keyOf(s, s.keys[i].id) == s.keys[i] { KeyAt(s, s.keys[i].id); }
  forall i | 0 <= i < |s.keys| ensures exists j :: 0 <= j < |s.grants| && s.grants[j].id == s.keys[i].id {
    assert exists g :: g in s.grants && g.id == s.keys[i].id;
    var g :| g in s.grants && g.id == s.keys[i].id;
    var j :| 0 <= j < |s.grants| && s.grants[j] == g;
  }
}

lemma SameStart(s: SignIn, after: SignIn)
  requires forall i, j :: 0 <= i < |s.grants| && 0 <= j < |s.grants| && i != j ==> s.grants[i].id != s.grants[j].id
  requires forall i, j :: 0 <= i < |after.grants| && 0 <= j < |after.grants| && i != j ==> after.grants[i].id != after.grants[j].id
  requires |after.grants| >= |s.grants|
  requires forall i :: 0 <= i < |s.grants| ==> after.grants[i].id == s.grants[i].id && after.grants[i].start == s.grants[i].start
  requires forall i :: |s.grants| <= i < |after.grants| ==> after.grants[i].id != 1
  ensures signInStart(after) == signInStart(s)
{
  GrantAt(s, 1); GrantAt(after, 1);
  if exists i :: 0 <= i < |s.grants| && s.grants[i].id == 1 {
    var i :| 0 <= i < |s.grants| && s.grants[i].id == 1;
    assert after.grants[i].id == 1;
  }
}

lemma LiveKept(s: SignIn, after: SignIn)
  requires alwaysOneLiveSuccessor(s) && |after.grants| == |s.grants|
  requires forall j :: 0 <= j < |s.grants| ==> after.grants[j].from == s.grants[j].from && ((after.grants[j].status.GrantPending? || after.grants[j].status.GrantExchanged? || after.grants[j].status.GrantAcknowledged?) ==> (s.grants[j].status.GrantPending? || s.grants[j].status.GrantExchanged? || s.grants[j].status.GrantAcknowledged?))
  requires forall k :: k in after.keys ==> (exists k0 :: k0 in s.keys && k0.id == k.id) || (forall j :: 0 <= j < |s.grants| ==> s.grants[j].from != k.id)
  ensures alwaysOneLiveSuccessor(after)
{
  Filters(s, 0); Filters(after, 0);
  forall k | k in after.keys
    ensures |ProofLib.Filter((g: Grant) => ((g.from == k.id) && ((g.status.GrantPending? || g.status.GrantExchanged?) || g.status.GrantAcknowledged?)), after.grants)| <= 1
  {
    var live := (g: Grant) => ((g.from == k.id) && ((g.status.GrantPending? || g.status.GrantExchanged?) || g.status.GrantAcknowledged?));
    CountPointwise(live, after.grants, s.grants, -1);
    if exists k0 :: k0 in s.keys && k0.id == k.id {
      var k0 :| k0 in s.keys && k0.id == k.id;
      ProofLib.FilterSamePredicate(live, (g: Grant) => ((g.from == k0.id) && ((g.status.GrantPending? || g.status.GrantExchanged?) || g.status.GrantAcknowledged?)), s.grants);
    } else {
      ProofLib.FilterNone(live, s.grants);
    }
  }
}

lemma GrantsKept(s: SignIn, after: SignIn)
  requires |after.grants| == |s.grants| && |after.keys| == |s.keys|
  requires forall j :: 0 <= j < |s.grants| ==> after.grants[j].id == s.grants[j].id && after.grants[j].from == s.grants[j].from && after.grants[j].reveals_ == s.grants[j].reveals_ && (after.grants[j].status.GrantPending? ==> s.grants[j].status.GrantPending?) && (after.grants[j].status.GrantExchanged? ==> s.grants[j].status.GrantExchanged?)
  requires forall j :: 0 <= j < |s.keys| ==> after.keys[j].id == s.keys[j].id
  requires alwaysPendingGrantHasNoKey(s) && alwaysRevealedGrantHasItsKey(s) && alwaysSuccessorNamesAKey(s)
  ensures alwaysPendingGrantHasNoKey(after) && alwaysRevealedGrantHasItsKey(after) && alwaysSuccessorNamesAKey(after)
{
  assert forall j :: 0 <= j < |s.grants| ==> s.grants[j] in s.grants;
  forall x ensures hasKey(after, x) == hasKey(s, x) {
    if hasKey(s, x) { var y :| y in s.keys && y.id == x; var j :| 0 <= j < |s.keys| && s.keys[j] == y; assert after.keys[j] in after.keys; }
    if hasKey(after, x) { var y :| y in after.keys && y.id == x; var j :| 0 <= j < |after.keys| && after.keys[j] == y; assert s.keys[j] in s.keys; }
  }
}

lemma StartsKept(s: SignIn, after: SignIn)
  requires signInStart(after) == signInStart(s) && alwaysSignInTimeNeverMoves(s)
  requires |after.grants| >= |s.grants| && |after.keys| >= |s.keys|
  requires forall j :: 0 <= j < |after.grants| ==> after.grants[j].start == (if j < |s.grants| then s.grants[j].start else signInStart(s))
  requires forall j :: 0 <= j < |after.keys| ==> after.keys[j].start == (if j < |s.keys| then s.keys[j].start else signInStart(s))
  ensures alwaysSignInTimeNeverMoves(after)
{
  assert forall j :: 0 <= j < |s.grants| ==> s.grants[j] in s.grants;
  assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
}

lemma AckKeys(s: SignIn, after: SignIn, i0: int, m: int)
  requires 0 <= i0 < |s.grants| == |after.grants| && 0 <= m < |s.keys| == |after.keys|
  requires forall i, j :: 0 <= i < |s.grants| && 0 <= j < |s.grants| && i != j ==> s.grants[i].id != s.grants[j].id && after.grants[i].id != after.grants[j].id
  requires forall i, j :: 0 <= i < |s.keys| && 0 <= j < |s.keys| && i != j ==> s.keys[i].id != s.keys[j].id
  requires forall j :: 0 <= j < |s.grants| ==> after.grants[j].id == s.grants[j].id && (j != i0 ==> after.grants[j] == s.grants[j])
  requires forall j :: 0 <= j < |s.keys| && j != m ==> after.keys[j] == s.keys[j]
  requires after.grants[i0].status.GrantAcknowledged? && after.keys[m].id == s.keys[m].id == s.grants[i0].id
  requires forall i :: 0 <= i < |s.keys| ==> exists j :: 0 <= j < |s.grants| && s.grants[j].id == s.keys[i].id
  requires alwaysActiveKeyHasReceipt(s) && alwaysActivatedKeyWasAcknowledged(s)
  ensures alwaysActiveKeyHasReceipt(after) && alwaysActivatedKeyWasAcknowledged(after)
{
  forall i | 0 <= i < |after.keys|
    ensures (after.keys[i].status.KeyActive? ==> grantOf(after, after.keys[i].id).status.GrantAcknowledged?) && (after.keys[i].activated ==> (grantOf(after, after.keys[i].id).status.GrantAcknowledged? || grantOf(after, after.keys[i].id).status.GrantDeleted?))
  {
    GrantAt(after, after.keys[i].id);
    if i != m {
      assert s.keys[i] in s.keys;
      var j :| 0 <= j < |s.grants| && s.grants[j].id == s.keys[i].id;
      GrantAt(s, s.keys[i].id);
    }
  }
}

lemma approveInBrowser_ensures(s: SignIn)
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysOneKeyPerGrant(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysRevealedGrantHasItsKey(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysUnapprovedSignInIsEmpty(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysEachCodeHasItsOwnNumber(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysPendingGrantHasNoKey(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysReceiptErasesStoredCopy(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysNoKeyOutlivesCap(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysActiveKeyHasReceipt(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysActivatedKeyWasAcknowledged(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysNoCodeAfterCap(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysOneLiveSuccessor(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysSuccessorNamesAKey(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysSignInTimeNeverMoves(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysEndedSignInHasNoKey(approveInBrowser(s)))
  ensures (inv(s) ==> canApproveInBrowser(s) ==> alwaysCleanupKeepsLiveKeys(approveInBrowser(s)))
{
  if inv(s) && canApproveInBrowser(s) {
    var after := approveInBrowser(s);
    GrantIds(after); GrantAt(after, 1);
  }
}

lemma exchange_ensures(s: SignIn, g: int)
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysOneKeyPerGrant(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysRevealedGrantHasItsKey(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysUnapprovedSignInIsEmpty(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysEachCodeHasItsOwnNumber(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysPendingGrantHasNoKey(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysReceiptErasesStoredCopy(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysNoKeyOutlivesCap(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysActiveKeyHasReceipt(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysActivatedKeyWasAcknowledged(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysNoCodeAfterCap(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysOneLiveSuccessor(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysSuccessorNamesAKey(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysSignInTimeNeverMoves(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysEndedSignInHasNoKey(exchange(s, g)))
  ensures (inv(s) ==> canExchange(s, g) ==> alwaysCleanupKeepsLiveKeys(exchange(s, g)))
{
  if inv(s) && canExchange(s, g) {
    var after := exchange(s, g);
    View(s);
    var grant := grantOf(s, g);
    GrantAt(s, g);
    var i0 :| 0 <= i0 < |s.grants| && s.grants[i0].id == g;
    assert grant == s.grants[i0];
    assert forall j :: 0 <= j < |s.grants| ==> s.grants[j] in s.grants;
    assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
    assert |after.grants| == |s.grants| && forall j :: 0 <= j < |s.grants| ==> after.grants[j] == (if j == i0 then after.grants[i0] else s.grants[j]);
    assert after.grants[i0].id == g && after.grants[i0].from == grant.from && after.grants[i0].start == grant.start && after.grants[i0].issuedAt == grant.issuedAt;
    if grant.status.GrantPending? {
      assert !hasKey(s, g);
      assert after.keys == s.keys + [Key(g, KeyStatus.KeyMinted, (grant.issuedAt + codeTtl), grant.start, false)];
    } else {
      assert after.keys == s.keys;
    }
    GrantIds(after); KeyIds(after); View(after);
    SameStart(s, after);
    LiveKept(s, after);
  }
}

lemma acknowledge_ensures(s: SignIn, g: int)
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysOneKeyPerGrant(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysRevealedGrantHasItsKey(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysUnapprovedSignInIsEmpty(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysEachCodeHasItsOwnNumber(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysPendingGrantHasNoKey(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysReceiptErasesStoredCopy(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysNoKeyOutlivesCap(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysActiveKeyHasReceipt(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysActivatedKeyWasAcknowledged(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysNoCodeAfterCap(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysOneLiveSuccessor(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysSuccessorNamesAKey(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysSignInTimeNeverMoves(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysEndedSignInHasNoKey(acknowledge(s, g)))
  ensures (inv(s) ==> canAcknowledge(s, g) ==> alwaysCleanupKeepsLiveKeys(acknowledge(s, g)))
{
  if inv(s) && canAcknowledge(s, g) {
    var after := acknowledge(s, g);
    View(s);
    var grant := grantOf(s, g);
    GrantAt(s, g);
    var i0 :| 0 <= i0 < |s.grants| && s.grants[i0].id == g;
    assert grant == s.grants[i0] && grant in s.grants;
    assert hasKey(s, g);
    var m :| 0 <= m < |s.keys| && s.keys[m].id == g;
    KeyAt(s, g);
    assert keyOf(s, g) == s.keys[m] && s.keys[m] in s.keys;
    assert forall j :: 0 <= j < |s.grants| ==> s.grants[j] in s.grants;
    assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
    assert |after.grants| == |s.grants| && forall j :: 0 <= j < |s.grants| ==> after.grants[j] == (if j == i0 then after.grants[i0] else s.grants[j]);
    assert |after.keys| == |s.keys| && forall j :: 0 <= j < |s.keys| ==> after.keys[j] == (if j == m then after.keys[m] else s.keys[j]);
    assert after.keys[m].id == g && after.keys[m].start == s.keys[m].start && after.keys[m].start == grant.start;
    GrantIds(after); KeyIds(after); View(after);
    SameStart(s, after);
    LiveKept(s, after);
    AckKeys(s, after, i0, m);
    GrantsKept(s, after);
  }
}

lemma requestRenewal_ensures(s: SignIn, k: int)
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysOneKeyPerGrant(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysRevealedGrantHasItsKey(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysUnapprovedSignInIsEmpty(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysEachCodeHasItsOwnNumber(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysPendingGrantHasNoKey(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysReceiptErasesStoredCopy(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysNoKeyOutlivesCap(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysActiveKeyHasReceipt(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysActivatedKeyWasAcknowledged(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysNoCodeAfterCap(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysOneLiveSuccessor(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysSuccessorNamesAKey(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysSignInTimeNeverMoves(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysEndedSignInHasNoKey(requestRenewal(s, k)))
  ensures (inv(s) ==> canRequestRenewal(s, k) ==> alwaysCleanupKeepsLiveKeys(requestRenewal(s, k)))
{
  if inv(s) && canRequestRenewal(s, k) {
    var after := requestRenewal(s, k);
    View(s);
    KeyAt(s, k);
    var m :| 0 <= m < |s.keys| && s.keys[m].id == k;
    assert keyOf(s, k) == s.keys[m] && s.keys[m] in s.keys;
    assert forall j :: 0 <= j < |s.grants| ==> s.grants[j] in s.grants;
    assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
    if renewed(s, k) {
      assert after.grants == s.grants && |after.keys| == |s.keys|;
      assert forall j :: 0 <= j < |s.keys| ==> after.keys[j] == s.keys[j] || after.keys[j] == s.keys[j].(status := KeyStatus.KeyRevoked);
      assert forall j :: 0 <= j < |after.keys| ==> !after.keys[j].status.KeyActive?;
      KeysOnlyRevoked(s, after);
      GrantsKept(s, after);
      GrantIds(after); KeyIds(after); View(after);
      SameStart(s, after);
      StartsKept(s, after);
      LiveKept(s, after);
    } else {
      var n := |s.grants|;
      assert n >= 1;
      assert after.keys == s.keys && after.ended == s.ended && after.clock == s.clock;
      assert |after.grants| == n + 1 && after.grants[n] == Grant((n + 1), GrantStatus.GrantPending, k, s.clock, s.keys[m].start, false, 0, 0);
      assert forall j :: 0 <= j < n ==> after.grants[j] == (if s.grants[j].from == k && (s.grants[j].status.GrantPending? || s.grants[j].status.GrantExchanged?) then s.grants[j].(status := GrantStatus.GrantVoid, cipher := false) else s.grants[j]);
      assert !hasKey(s, n + 1);
      GrantIds(after); KeyIds(after); View(after);
      SameStart(s, after);
      StartsKept(s, after);
      GrantsLocal(s, after);
      KeyReceipts(s, after);
      RenewalLive(s, after, k);
    }
  }
}

lemma KeysOnlyRevoked(s: SignIn, after: SignIn)
  requires after.grants == s.grants && after.clock == s.clock && |after.keys| == |s.keys|
  requires forall j :: 0 <= j < |s.keys| ==> after.keys[j] == s.keys[j] || after.keys[j] == s.keys[j].(status := KeyStatus.KeyRevoked)
  requires alwaysActiveKeyHasReceipt(s) && alwaysActivatedKeyWasAcknowledged(s) && alwaysCleanupKeepsLiveKeys(s) && alwaysNoKeyOutlivesCap(s) && alwaysEndedSignInHasNoKey(s)
  requires after.ended ==> (s.ended || forall j :: 0 <= j < |after.keys| ==> !after.keys[j].status.KeyActive?)
  ensures alwaysActiveKeyHasReceipt(after) && alwaysActivatedKeyWasAcknowledged(after) && alwaysCleanupKeepsLiveKeys(after) && alwaysNoKeyOutlivesCap(after) && alwaysEndedSignInHasNoKey(after)
{
  forall x ensures grantOf(after, x) == grantOf(s, x) { Filters(s, x); Filters(after, x); }
  assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
}

lemma GrantsLocal(s: SignIn, after: SignIn)
  requires after.keys == s.keys && |after.grants| == |s.grants| + 1
  requires forall j :: 0 <= j < |s.grants| ==> after.grants[j] == s.grants[j] || after.grants[j] == s.grants[j].(status := GrantStatus.GrantVoid, cipher := false)
  requires var x := after.grants[|s.grants|]; x.status.GrantPending? && x.reveals_ == 0 && !x.cipher && !hasKey(s, x.id) && (x.from == 0 || hasKey(s, x.from))
  requires alwaysPendingGrantHasNoKey(s) && alwaysRevealedGrantHasItsKey(s) && alwaysSuccessorNamesAKey(s) && alwaysReceiptErasesStoredCopy(s)
  ensures alwaysPendingGrantHasNoKey(after) && alwaysRevealedGrantHasItsKey(after) && alwaysSuccessorNamesAKey(after) && alwaysReceiptErasesStoredCopy(after)
{
  assert forall j :: 0 <= j < |s.grants| ==> s.grants[j] in s.grants;
}

lemma KeyReceipts(s: SignIn, after: SignIn)
  requires after.keys == s.keys && |after.grants| >= |s.grants|
  requires forall i, j :: 0 <= i < |s.grants| && 0 <= j < |s.grants| && i != j ==> s.grants[i].id != s.grants[j].id
  requires forall i, j :: 0 <= i < |after.grants| && 0 <= j < |after.grants| && i != j ==> after.grants[i].id != after.grants[j].id
  requires forall j :: 0 <= j < |s.grants| ==> after.grants[j].id == s.grants[j].id && ((s.grants[j].status.GrantAcknowledged? || s.grants[j].status.GrantDeleted?) ==> after.grants[j] == s.grants[j])
  requires forall i :: 0 <= i < |s.keys| ==> exists j :: 0 <= j < |s.grants| && s.grants[j].id == s.keys[i].id
  requires alwaysActiveKeyHasReceipt(s) && alwaysActivatedKeyWasAcknowledged(s)
  ensures alwaysActiveKeyHasReceipt(after) && alwaysActivatedKeyWasAcknowledged(after)
{
  forall i | 0 <= i < |s.keys|
    ensures (s.keys[i].status.KeyActive? ==> grantOf(after, s.keys[i].id).status.GrantAcknowledged?) && (s.keys[i].activated ==> (grantOf(after, s.keys[i].id).status.GrantAcknowledged? || grantOf(after, s.keys[i].id).status.GrantDeleted?))
  {
    assert s.keys[i] in s.keys;
    var j :| 0 <= j < |s.grants| && s.grants[j].id == s.keys[i].id;
    GrantAt(s, s.keys[i].id); GrantAt(after, s.keys[i].id);
  }
}

lemma RenewalLive(s: SignIn, after: SignIn, k: int)
  requires alwaysOneLiveSuccessor(s) && after.keys == s.keys && |after.grants| == |s.grants| + 1
  requires !renewed(s, k)
  requires forall j :: 0 <= j < |s.grants| ==> after.grants[j] == (if s.grants[j].from == k && (s.grants[j].status.GrantPending? || s.grants[j].status.GrantExchanged?) then s.grants[j].(status := GrantStatus.GrantVoid, cipher := false) else s.grants[j])
  requires after.grants[|s.grants|].from == k
  ensures alwaysOneLiveSuccessor(after)
{
  Filters(s, 0); Filters(after, 0);
  var n := |s.grants|;
  forall key | key in after.keys
    ensures |ProofLib.Filter((g: Grant) => ((g.from == key.id) && ((g.status.GrantPending? || g.status.GrantExchanged?) || g.status.GrantAcknowledged?)), after.grants)| <= 1
  {
    var live := (g: Grant) => ((g.from == key.id) && ((g.status.GrantPending? || g.status.GrantExchanged?) || g.status.GrantAcknowledged?));
    assert after.grants == after.grants[..n] + [after.grants[n]];
    ProofLib.FilterAppend(live, after.grants[..n], after.grants[n]);
    if key.id == k {
      forall j | 0 <= j < n ensures !live(after.grants[..n][j]) { assert s.grants[j] in s.grants; }
      ProofLib.FilterNone(live, after.grants[..n]);
    } else {
      CountPointwise(live, after.grants[..n], s.grants, -1);
    }
  }
}

lemma selfRevoke_ensures(s: SignIn, k: int, names: int)
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysOneKeyPerGrant(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysRevealedGrantHasItsKey(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysUnapprovedSignInIsEmpty(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysEachCodeHasItsOwnNumber(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysPendingGrantHasNoKey(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysReceiptErasesStoredCopy(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysNoKeyOutlivesCap(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysActiveKeyHasReceipt(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysActivatedKeyWasAcknowledged(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysNoCodeAfterCap(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysOneLiveSuccessor(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysSuccessorNamesAKey(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysSignInTimeNeverMoves(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysEndedSignInHasNoKey(selfRevoke(s, k, names)))
  ensures (inv(s) ==> canSelfRevoke(s, k, names) ==> alwaysCleanupKeepsLiveKeys(selfRevoke(s, k, names)))
{
  if inv(s) && canSelfRevoke(s, k, names) {
    var after := selfRevoke(s, k, names);
    View(s);
    KeyAt(s, k);
    var m :| 0 <= m < |s.keys| && s.keys[m].id == k;
    assert keyOf(s, k) == s.keys[m];
    assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
    assert after.grants == s.grants && |after.keys| == |s.keys| && after.clock == s.clock;
    assert forall j :: 0 <= j < |s.keys| ==> after.keys[j] == s.keys[j] || after.keys[j] == s.keys[j].(status := KeyStatus.KeyRevoked);
    assert after.ended ==> (s.ended || forall j :: 0 <= j < |after.keys| ==> !after.keys[j].status.KeyActive?);
    KeysOnlyRevoked(s, after);
    GrantsKept(s, after);
    GrantIds(after); KeyIds(after); View(after);
    SameStart(s, after);
    StartsKept(s, after);
    LiveKept(s, after);
  }
}

lemma ownerRevoke_ensures(s: SignIn)
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysOneKeyPerGrant(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysRevealedGrantHasItsKey(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysUnapprovedSignInIsEmpty(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysEachCodeHasItsOwnNumber(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysPendingGrantHasNoKey(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysReceiptErasesStoredCopy(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysNoKeyOutlivesCap(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysActiveKeyHasReceipt(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysActivatedKeyWasAcknowledged(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysNoCodeAfterCap(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysOneLiveSuccessor(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysSuccessorNamesAKey(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysSignInTimeNeverMoves(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysEndedSignInHasNoKey(ownerRevoke(s)))
  ensures (inv(s) ==> canOwnerRevoke(s) ==> alwaysCleanupKeepsLiveKeys(ownerRevoke(s)))
{
  if inv(s) && canOwnerRevoke(s) {
    var after := ownerRevoke(s);
    View(s);
    assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
    assert after.grants == s.grants && |after.keys| == |s.keys|;
    assert forall j :: 0 <= j < |s.keys| ==> after.keys[j].id == s.keys[j].id;
    GrantIds(after); KeyIds(after); View(after);
    LiveKept(s, after);
  }
}

lemma reap_ensures(s: SignIn, g: int)
  ensures (inv(s) ==> canReap(s, g) ==> alwaysOneKeyPerGrant(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysRevealedGrantHasItsKey(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysUnapprovedSignInIsEmpty(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysEachCodeHasItsOwnNumber(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysPendingGrantHasNoKey(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysReceiptErasesStoredCopy(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysNoKeyOutlivesCap(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysActiveKeyHasReceipt(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysActivatedKeyWasAcknowledged(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysNoCodeAfterCap(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysOneLiveSuccessor(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysSuccessorNamesAKey(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysSignInTimeNeverMoves(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysEndedSignInHasNoKey(reap(s, g)))
  ensures (inv(s) ==> canReap(s, g) ==> alwaysCleanupKeepsLiveKeys(reap(s, g)))
{
  if inv(s) && canReap(s, g) {
    var after := reap(s, g);
    View(s);
    GrantAt(s, g); KeyAt(s, g);
    assert forall j :: 0 <= j < |s.grants| ==> s.grants[j] in s.grants;
    assert forall j :: 0 <= j < |s.keys| ==> s.keys[j] in s.keys;
    assert |after.grants| == |s.grants| && forall j :: 0 <= j < |s.grants| ==> after.grants[j] == (if s.grants[j].id == g then grantOf(s, g).(status := GrantStatus.GrantDeleted, cipher := false) else s.grants[j]);
    assert |after.keys| == |s.keys| && forall j :: 0 <= j < |s.keys| ==> after.keys[j] == (if s.keys[j].id == g then keyOf(s, g).(status := KeyStatus.KeyDeleted) else s.keys[j]);
    GrantIds(after); KeyIds(after); View(after);
    SameStart(s, after);
    LiveKept(s, after);
  }
}

lemma signInNatively_ensures(s: SignIn, identityVerified: bool, challengeFresh: bool)
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysOneKeyPerGrant(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysRevealedGrantHasItsKey(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysUnapprovedSignInIsEmpty(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysEachCodeHasItsOwnNumber(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysPendingGrantHasNoKey(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysReceiptErasesStoredCopy(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysNoKeyOutlivesCap(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysActiveKeyHasReceipt(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysActivatedKeyWasAcknowledged(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysNoCodeAfterCap(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysOneLiveSuccessor(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysSuccessorNamesAKey(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysSignInTimeNeverMoves(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysEndedSignInHasNoKey(signInNatively(s, identityVerified, challengeFresh)))
  ensures (inv(s) ==> canSignInNatively(s, identityVerified, challengeFresh) ==> alwaysCleanupKeepsLiveKeys(signInNatively(s, identityVerified, challengeFresh)))
{
  if inv(s) && canSignInNatively(s, identityVerified, challengeFresh) {
    var after := signInNatively(s, identityVerified, challengeFresh);
    assert |after.grants| == 1 && |after.keys| == 1;
    GrantIds(after); KeyIds(after); GrantAt(after, 1); KeyAt(after, 1);
    assert after.grants[0] in after.grants;
    assert signInStart(after) == s.clock;
  }
}
