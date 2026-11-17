lemma SessFamilyOf(s: Sessions, id: int)
  ensures familyOf(s, id) == (if |ProofLib.Filter((f: SessionFamily) => (f.id == id), s.families)| > 0 then ProofLib.Filter((f: SessionFamily) => (f.id == id), s.families)[0] else noFamily)
{}

lemma SessTokenOf(s: Sessions, id: int)
  ensures refreshTokenOf(s, id) == (if |ProofLib.Filter((t: RefreshToken) => (t.id == id), s.refreshTokens)| > 0 then ProofLib.Filter((t: RefreshToken) => (t.id == id), s.refreshTokens)[0] else noRefreshToken)
{}

lemma SessRules(s: Sessions)
  ensures alwaysOneUsableRefreshTokenPerFamily(s) == (forall f :: f in s.families ==> |ProofLib.Filter((t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), s.refreshTokens)| <= 1 && (f.revoked ==> forall t :: t in s.refreshTokens ==> !((t.family == f.id) && t.status.ActiveToken?)))
  ensures alwaysIdsComeFromOneCounter(s) == ((forall f :: f in s.families ==> |ProofLib.Filter((g: SessionFamily) => (g.id == f.id), s.families)| == 1) && (forall a :: a in s.accessTokens ==> a.id < s.nextId && |ProofLib.Filter((b: AccessToken) => (b.id == a.id), s.accessTokens)| == 1) && (forall t :: t in s.refreshTokens ==> t.family < s.nextId) && (forall r :: r in s.revocations ==> r.before <= s.nextId) && s.clientRefreshToken >= 0 && s.clientRefreshToken < s.nextId)
{}

lemma SessFamiliesDistinct(xs: seq<SessionFamily>)
  ensures (forall f :: f in xs ==> |ProofLib.Filter((g: SessionFamily) => (g.id == f.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (f: SessionFamily) => f.id)
{
  if forall f :: f in xs ==> |ProofLib.Filter((g: SessionFamily) => (g.id == f.id), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].id != xs[j].id
    {
      ProofLib.FilterCountOneIffUnique((g: SessionFamily) => (g.id == xs[i].id), xs, (f: SessionFamily) => f.id, i);
    }
  } else if ProofLib.DistinctBy(xs, (f: SessionFamily) => f.id) {
    forall f | f in xs
      ensures |ProofLib.Filter((g: SessionFamily) => (g.id == f.id), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == f;
      ProofLib.FilterOne((g: SessionFamily) => (g.id == f.id), xs, i);
    }
  }
}

lemma SessAccessDistinct(xs: seq<AccessToken>)
  ensures (forall a :: a in xs ==> |ProofLib.Filter((b: AccessToken) => (b.id == a.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (a: AccessToken) => a.id)
{
  if forall a :: a in xs ==> |ProofLib.Filter((b: AccessToken) => (b.id == a.id), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].id != xs[j].id
    {
      ProofLib.FilterCountOneIffUnique((b: AccessToken) => (b.id == xs[i].id), xs, (a: AccessToken) => a.id, i);
    }
  } else if ProofLib.DistinctBy(xs, (a: AccessToken) => a.id) {
    forall a | a in xs
      ensures |ProofLib.Filter((b: AccessToken) => (b.id == a.id), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == a;
      ProofLib.FilterOne((b: AccessToken) => (b.id == a.id), xs, i);
    }
  }
}

lemma SessFacts(s: Sessions)
  requires inv(s)
  ensures ProofLib.DistinctBy(s.families, (f: SessionFamily) => f.id)
  ensures ProofLib.DistinctBy(s.accessTokens, (a: AccessToken) => a.id)
  ensures forall a :: a in s.accessTokens ==> a.id < s.nextId
  ensures forall t :: t in s.refreshTokens ==> t.family < s.nextId
  ensures forall r :: r in s.revocations ==> r.before <= s.nextId
  ensures forall f :: f in s.families ==> f.id < s.nextId
  ensures 0 <= s.clientRefreshToken < s.nextId
{
  SessRules(s);
  SessFamiliesDistinct(s.families);
  SessAccessDistinct(s.accessTokens);
}

lemma SessIds(s: Sessions)
  requires ProofLib.DistinctBy(s.families, (f: SessionFamily) => f.id)
  requires ProofLib.DistinctBy(s.accessTokens, (a: AccessToken) => a.id)
  requires forall a :: a in s.accessTokens ==> a.id < s.nextId
  requires forall t :: t in s.refreshTokens ==> t.family < s.nextId
  requires forall r :: r in s.revocations ==> r.before <= s.nextId
  requires 0 <= s.clientRefreshToken < s.nextId
  ensures alwaysIdsComeFromOneCounter(s)
{
  SessRules(s);
  SessFamiliesDistinct(s.families);
  SessAccessDistinct(s.accessTokens);
}

lemma SessFamilyFound(s: Sessions, id: int, e: SessionFamily)
  requires ProofLib.DistinctBy(s.families, (f: SessionFamily) => f.id)
  requires e in s.families && e.id == id
  ensures familyOf(s, id) == e
{
  SessFamilyOf(s, id);
  var i :| 0 <= i < |s.families| && s.families[i] == e;
  ProofLib.FilterOne((f: SessionFamily) => (f.id == id), s.families, i);
  var x := ProofLib.Filter((f: SessionFamily) => (f.id == id), s.families)[0];
  ProofLib.FilterMember((f: SessionFamily) => (f.id == id), s.families, x);
  var j :| 0 <= j < |s.families| && s.families[j] == x;
}

lemma SessFamilyLive(s: Sessions, id: int)
  requires ProofLib.DistinctBy(s.families, (f: SessionFamily) => f.id)
  requires !familyOf(s, id).revoked
  ensures familyOf(s, id) in s.families && familyOf(s, id).id == id
{
  if forall f :: f in s.families ==> f.id != id {
    SessFamilyOf(s, id);
    ProofLib.FilterNone((f: SessionFamily) => (f.id == id), s.families);
  } else {
    var e :| e in s.families && e.id == id;
    SessFamilyFound(s, id, e);
  }
}

lemma SessTokenFound(s: Sessions, id: int)
  requires !refreshTokenOf(s, id).status.RevokedToken?
  ensures refreshTokenOf(s, id) in s.refreshTokens && refreshTokenOf(s, id).id == id
{
  SessTokenOf(s, id);
  ProofLib.FilterMember((t: RefreshToken) => (t.id == id), s.refreshTokens, refreshTokenOf(s, id));
}

lemma SessMark(xs: seq<Revocation>, user: int, mark: int, bound: int)
  requires mark <= bound
  requires forall r :: r in xs ==> r.before <= bound
  ensures Std.Collections.Seq.FoldLeft((mark: int, r: Revocation) => (if (r.user == user) then r.before else mark), mark, xs) <= bound
  decreases |xs|
{
  if |xs| > 0 {
    assert xs[0] in xs;
    assert forall r :: r in xs[1..] ==> r in xs;
    SessMark(xs[1..], user, if (xs[0].user == user) then xs[0].before else mark, bound);
  }
}

lemma SessVisible(before: Sessions, via: string, s: Sessions)
  requires ProofLib.DistinctBy(s.families, (f: SessionFamily) => f.id)
  requires ProofLib.DistinctBy(s.accessTokens, (a: AccessToken) => a.id)
  ensures stepRevocationVisibleOnReturn(before, via, s)
{
  forall a | a in s.accessTokens && familyOf(s, a.family).revoked
    ensures !accepts(s, a.id)
  {
    if accepts(s, a.id) {
      var b :| b in s.accessTokens && b.id == a.id && s.now < b.expiresAt && exists f :: f in s.families && f.id == b.family && !f.revoked;
      var i :| 0 <= i < |s.accessTokens| && s.accessTokens[i] == a;
      var j :| 0 <= j < |s.accessTokens| && s.accessTokens[j] == b;
      assert i == j;
      var e :| e in s.families && e.id == b.family && !e.revoked;
      SessFamilyFound(s, a.family, e);
    }
  }
}

lemma SessSame(s: Sessions, after: Sessions)
  requires inv(s)
  requires after.families == s.families && after.refreshTokens == s.refreshTokens && after.accessTokens == s.accessTokens
  requires after.reuseDetected == s.reuseDetected && after.revocations == s.revocations && after.nextId == s.nextId
  requires 0 <= after.clientRefreshToken < after.nextId
  ensures alwaysAccessWithinLifetimes(after) && alwaysOneUsableRefreshTokenPerFamily(after) && alwaysReuseRevokesTheFamily(after)
  ensures alwaysRevokeAllCoversEarlierSessions(after) && alwaysIdsComeFromOneCounter(after)
  ensures ProofLib.DistinctBy(after.families, (f: SessionFamily) => f.id) && ProofLib.DistinctBy(after.accessTokens, (a: AccessToken) => a.id)
{
  SessFacts(s);
  SessIds(after);
  assert forall x :: familyOf(after, x) == familyOf(s, x);
  assert forall u :: revokedBefore(after, u) == revokedBefore(s, u);
}

lemma SessSignedIn(s: Sessions, user: int)
  requires inv(s)
  ensures alwaysAccessWithinLifetimes(signIn(s, user).state) && alwaysOneUsableRefreshTokenPerFamily(signIn(s, user).state)
  ensures alwaysReuseRevokesTheFamily(signIn(s, user).state) && alwaysRevokeAllCoversEarlierSessions(signIn(s, user).state)
  ensures alwaysIdsComeFromOneCounter(signIn(s, user).state)
{
  var after := signIn(s, user).state;
  var g := SessionFamily(s.nextId, user, s.now, false);
  var rt := RefreshToken(s.nextId + 1, s.nextId, TokenStatus.ActiveToken);
  var at := AccessToken(s.nextId + 2, s.nextId, s.now, accessExpiry(s.now, s.now));
  assert after.families == s.families + [g];
  assert after.refreshTokens == s.refreshTokens + [rt];
  assert after.accessTokens == s.accessTokens + [at];
  SessFacts(s);
  ProofLib.DistinctByConcat(s.families, [g], (f: SessionFamily) => f.id);
  ProofLib.DistinctByConcat(s.accessTokens, [at], (a: AccessToken) => a.id);
  SessIds(after);
  forall a | a in after.accessTokens
    ensures a.expiresAt <= a.issuedAt + accessLifetime && a.expiresAt <= familyOf(after, a.family).startedAt + sessionMaximum && exists f :: f in after.families && f.id == a.family
  {
    if a == at {
      SessFamilyFound(after, s.nextId, g);
    } else {
      var e :| e in s.families && e.id == a.family;
      SessFamilyFound(s, a.family, e);
      SessFamilyFound(after, a.family, e);
    }
  }
  SessRules(s);
  SessRules(after);
  forall f | f in after.families
    ensures |ProofLib.Filter((t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), after.refreshTokens)| <= 1 && (f.revoked ==> forall t :: t in after.refreshTokens ==> !((t.family == f.id) && t.status.ActiveToken?))
  {
    ProofLib.FilterAppend((t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), s.refreshTokens, rt);
    if f == g {
      ProofLib.FilterNone((t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), s.refreshTokens);
    }
  }
  forall id | id in after.reuseDetected
    ensures familyOf(after, id).revoked && exists f :: f in after.families && f.id == id
  {
    var e :| e in s.families && e.id == id;
    SessFamilyFound(s, id, e);
    SessFamilyFound(after, id, e);
  }
  SessMark(s.revocations, user, 0, s.nextId);
  assert forall u :: revokedBefore(after, u) == revokedBefore(s, u);
}

lemma SessRevoked(s: Sessions, doomed: seq<int>, after: Sessions)
  requires inv(s)
  requires after.families == revokedFamilies(s, doomed) && after.refreshTokens == revokeFamilies(s, doomed)
  requires after.accessTokens == s.accessTokens && after.nextId == s.nextId
  requires forall r :: r in after.revocations ==> r.before <= after.nextId
  requires 0 <= after.clientRefreshToken < after.nextId
  requires forall id :: id in after.reuseDetected ==> id in s.reuseDetected || (id in doomed && exists f :: f in s.families && f.id == id)
  ensures alwaysAccessWithinLifetimes(after) && alwaysOneUsableRefreshTokenPerFamily(after) && alwaysReuseRevokesTheFamily(after)
  ensures alwaysIdsComeFromOneCounter(after)
  ensures after.revocations == s.revocations ==> alwaysRevokeAllCoversEarlierSessions(after)
  ensures ProofLib.DistinctBy(after.families, (f: SessionFamily) => f.id) && ProofLib.DistinctBy(after.accessTokens, (a: AccessToken) => a.id)
  ensures |after.families| == |s.families|
  ensures forall i :: 0 <= i < |s.families| ==> after.families[i].id == s.families[i].id && after.families[i].user == s.families[i].user && after.families[i].revoked == (s.families[i].revoked || s.families[i].id in doomed)
{
  SessFacts(s);
  var F := s.families;
  var F2 := after.families;
  var R := s.refreshTokens;
  var R2 := after.refreshTokens;
  assert |F2| == |F| && forall i :: 0 <= i < |F| ==> F2[i] == (if F[i].id in doomed then F[i].(revoked := true) else F[i]);
  assert |R2| == |R| && forall k :: 0 <= k < |R| ==> R2[k] == (if R[k].family in doomed then R[k].(status := TokenStatus.RevokedToken) else R[k]);
  assert ProofLib.DistinctBy(F2, (f: SessionFamily) => f.id);
  assert forall t :: t in R2 ==> t.family < after.nextId by {
    forall t | t in R2 ensures t.family < after.nextId {
      var k :| 0 <= k < |R2| && R2[k] == t;
      assert R[k] in R;
    }
  }
  SessIds(after);
  forall a | a in after.accessTokens
    ensures a.expiresAt <= a.issuedAt + accessLifetime && a.expiresAt <= familyOf(after, a.family).startedAt + sessionMaximum && exists f :: f in F2 && f.id == a.family
  {
    var e :| e in F && e.id == a.family;
    var i :| 0 <= i < |F| && F[i] == e;
    SessFamilyFound(s, a.family, e);
    SessFamilyFound(after, a.family, F2[i]);
  }
  SessRules(s);
  SessRules(after);
  forall f | f in F2
    ensures |ProofLib.Filter((t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), R2)| <= 1 && (f.revoked ==> forall t :: t in R2 ==> !((t.family == f.id) && t.status.ActiveToken?))
  {
    var i :| 0 <= i < |F2| && F2[i] == f;
    var e := F[i];
    assert e in F;
    ProofLib.FilterLengthPointwise((t: RefreshToken) => ((t.family == f.id) && !(t.family in doomed) && t.status.ActiveToken?), (t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), R, R2);
    ProofLib.FilterImpLength((t: RefreshToken) => ((t.family == f.id) && !(t.family in doomed) && t.status.ActiveToken?), (t: RefreshToken) => ((t.family == e.id) && t.status.ActiveToken?), R);
    if f.revoked {
      forall t | t in R2 ensures !((t.family == f.id) && t.status.ActiveToken?) {
        var k :| 0 <= k < |R2| && R2[k] == t;
        assert R[k] in R;
      }
    }
  }
  forall id | id in after.reuseDetected
    ensures familyOf(after, id).revoked && exists f :: f in F2 && f.id == id
  {
    var e :| e in F && e.id == id;
    var i :| 0 <= i < |F| && F[i] == e;
    SessFamilyFound(after, id, F2[i]);
    if id in s.reuseDetected {
      SessFamilyFound(s, id, e);
    }
  }
  if after.revocations == s.revocations {
    forall f | f in F2
      ensures (f.id < revokedBefore(after, f.user) ==> f.revoked) && f.id < after.nextId
    {
      var i :| 0 <= i < |F2| && F2[i] == f;
      assert F[i] in F;
      assert revokedBefore(after, f.user) == revokedBefore(s, f.user);
    }
  }
}

lemma SessRotated(s: Sessions, id: int, after: Sessions)
  requires inv(s) && rotates(s, id)
  requires after.families == s.families && after.refreshTokens == refreshed(id, s).refreshTokens && after.accessTokens == refreshed(id, s).accessTokens
  requires after.nextId == s.nextId + 2 && after.revocations == s.revocations && after.reuseDetected == s.reuseDetected
  requires 0 <= after.clientRefreshToken < after.nextId
  ensures alwaysAccessWithinLifetimes(after) && alwaysOneUsableRefreshTokenPerFamily(after) && alwaysReuseRevokesTheFamily(after)
  ensures alwaysRevokeAllCoversEarlierSessions(after) && alwaysIdsComeFromOneCounter(after)
  ensures ProofLib.DistinctBy(after.families, (f: SessionFamily) => f.id) && ProofLib.DistinctBy(after.accessTokens, (a: AccessToken) => a.id)
{
  SessFacts(s);
  var tok := refreshTokenOf(s, id);
  var fam := familyOf(s, tok.family);
  SessTokenFound(s, id);
  SessFamilyLive(s, tok.family);
  var R := s.refreshTokens;
  var nt := RefreshToken(s.nextId, tok.family, TokenStatus.ActiveToken);
  var at := AccessToken(s.nextId + 1, tok.family, s.now, accessExpiry(s.now, fam.startedAt));
  var M := after.refreshTokens[..|R|];
  assert after.refreshTokens == M + [nt];
  assert |M| == |R| && forall k :: 0 <= k < |R| ==> M[k] == (if R[k].id == id then R[k].(status := TokenStatus.RotatedToken) else R[k]);
  assert after.accessTokens == s.accessTokens + [at];
  ProofLib.DistinctByConcat(s.accessTokens, [at], (a: AccessToken) => a.id);
  assert forall r :: r in after.refreshTokens ==> r.family < after.nextId by {
    forall r | r in after.refreshTokens ensures r.family < after.nextId {
      if r != nt {
        var k :| 0 <= k < |M| && M[k] == r;
        assert R[k] in R;
      }
    }
  }
  SessIds(after);
  assert forall x :: familyOf(after, x) == familyOf(s, x);
  forall a | a in after.accessTokens
    ensures a.expiresAt <= a.issuedAt + accessLifetime && a.expiresAt <= familyOf(after, a.family).startedAt + sessionMaximum && exists f :: f in after.families && f.id == a.family
  {
  }
  SessRules(s);
  SessRules(after);
  var k0 :| 0 <= k0 < |R| && R[k0] == tok;
  forall f | f in after.families
    ensures |ProofLib.Filter((t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), after.refreshTokens)| <= 1 && (f.revoked ==> forall r :: r in after.refreshTokens ==> !((r.family == f.id) && r.status.ActiveToken?))
  {
    ProofLib.FilterAppend((t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), M, nt);
    ProofLib.FilterLengthPointwise((r: RefreshToken) => ((r.family == f.id) && r.id != id && r.status.ActiveToken?), (t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), R, M);
    ProofLib.FilterImpLength((r: RefreshToken) => ((r.family == f.id) && r.id != id && r.status.ActiveToken?), (t: RefreshToken) => ((t.family == f.id) && t.status.ActiveToken?), R);
    if f.id == tok.family {
      assert R[k0].family == f.id && R[k0].status.ActiveToken? && R[k0].id == id;
      SessFamilyFound(s, tok.family, f);
    }
    if f.revoked {
      forall r | r in after.refreshTokens ensures !((r.family == f.id) && r.status.ActiveToken?) {
        if r != nt {
          var k :| 0 <= k < |M| && M[k] == r;
          assert R[k] in R;
        }
      }
    }
  }
  assert forall u :: revokedBefore(after, u) == revokedBefore(s, u);
}

lemma SessRefreshed(s: Sessions, id: int, after: Sessions)
  requires inv(s)
  requires after.families == refreshed(id, s).families && after.refreshTokens == refreshed(id, s).refreshTokens && after.accessTokens == refreshed(id, s).accessTokens
  requires after.nextId == refreshed(id, s).nextId && after.reuseDetected == refreshed(id, s).reuseDetected && after.revocations == s.revocations
  requires 0 <= after.clientRefreshToken < after.nextId
  ensures alwaysAccessWithinLifetimes(after) && alwaysOneUsableRefreshTokenPerFamily(after) && alwaysReuseRevokesTheFamily(after)
  ensures alwaysRevokeAllCoversEarlierSessions(after) && alwaysIdsComeFromOneCounter(after)
  ensures ProofLib.DistinctBy(after.families, (f: SessionFamily) => f.id) && ProofLib.DistinctBy(after.accessTokens, (a: AccessToken) => a.id)
{
  SessFacts(s);
  var t := refreshTokenOf(s, id);
  if rotates(s, id) {
    SessRotated(s, id, after);
  } else if t.status.RotatedToken? && !familyOf(s, t.family).revoked {
    SessFamilyLive(s, t.family);
    SessRevoked(s, [t.family], after);
  } else {
    SessSame(s, after);
  }
}

lemma SessRevokeAllState(s: Sessions, user: int)
  ensures revokeAll(s, user).state.families == revokedFamilies(s, (var s_map := ProofLib.Filter((f: SessionFamily) => (f.user == user), s.families); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var f := s_map[i_map]; f.id)))
  ensures revokeAll(s, user).state.refreshTokens == revokeFamilies(s, (var s_map := ProofLib.Filter((f: SessionFamily) => (f.user == user), s.families); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var f := s_map[i_map]; f.id)))
{}

lemma SessRevokedAll(s: Sessions, user: int)
  requires inv(s)
  ensures alwaysAccessWithinLifetimes(revokeAll(s, user).state) && alwaysOneUsableRefreshTokenPerFamily(revokeAll(s, user).state)
  ensures alwaysReuseRevokesTheFamily(revokeAll(s, user).state) && alwaysRevokeAllCoversEarlierSessions(revokeAll(s, user).state)
  ensures alwaysIdsComeFromOneCounter(revokeAll(s, user).state)
  ensures ProofLib.DistinctBy(revokeAll(s, user).state.families, (f: SessionFamily) => f.id) && ProofLib.DistinctBy(revokeAll(s, user).state.accessTokens, (a: AccessToken) => a.id)
{
  SessFacts(s);
  var after := revokeAll(s, user).state;
  var fs := ProofLib.Filter((f: SessionFamily) => (f.user == user), s.families);
  var doomed := (var s_map := ProofLib.Filter((f: SessionFamily) => (f.user == user), s.families); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var f := s_map[i_map]; f.id));
  SessRevokeAllState(s, user);
  assert after.revocations == s.revocations + [Revocation(user, s.nextId)];
  SessRevoked(s, doomed, after);
  var F := s.families;
  var F2 := after.families;
  forall f | f in F2
    ensures (f.id < revokedBefore(after, f.user) ==> f.revoked) && f.id < after.nextId
  {
    var i :| 0 <= i < |F2| && F2[i] == f;
    assert F[i] in F;
    ProofLib.FoldLeftAppend((mark: int, r: Revocation) => (if (r.user == f.user) then r.before else mark), 0, s.revocations, Revocation(user, s.nextId));
    if f.user == user {
      ProofLib.FilterMember((f: SessionFamily) => (f.user == user), s.families, F[i]);
      var k :| 0 <= k < |fs| && fs[k] == F[i];
      assert doomed[k] == F[i].id;
    }
  }
}

lemma signIn_ensures(s: Sessions, user: int)
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysAccessWithinLifetimes(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysOneUsableRefreshTokenPerFamily(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysReuseRevokesTheFamily(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysRevokeAllCoversEarlierSessions(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysIdsComeFromOneCounter(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysOneClientRefreshInFlight(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysSignOutStaysFinal(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> alwaysTransientFailureKeepsCredential(signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> stepRevocationVisibleOnReturn(s, "signIn", signIn(s, user).state))
  ensures (inv(s) ==> canSignIn(s, user) ==> stepSessionChangeIsAudited(s, signIn(s, user).state, signIn(s, user).out))
{
  if inv(s) && canSignIn(s, user) {
    SessSignedIn(s, user);
  }
}

lemma refresh_ensures(s: Sessions, token: int)
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysAccessWithinLifetimes(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysOneUsableRefreshTokenPerFamily(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysReuseRevokesTheFamily(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysRevokeAllCoversEarlierSessions(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysIdsComeFromOneCounter(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysOneClientRefreshInFlight(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysSignOutStaysFinal(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> alwaysTransientFailureKeepsCredential(refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> stepRevocationVisibleOnReturn(s, "refresh", refresh(s, token).state))
  ensures (inv(s) ==> canRefresh(s, token) ==> stepSessionChangeIsAudited(s, refresh(s, token).state, refresh(s, token).out))
{
  if inv(s) && canRefresh(s, token) {
    SessFacts(s);
    SessRefreshed(s, token, refresh(s, token).state);
    SessVisible(s, "refresh", refresh(s, token).state);
  }
}

lemma revokeAll_ensures(s: Sessions, user: int)
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysAccessWithinLifetimes(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysOneUsableRefreshTokenPerFamily(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysReuseRevokesTheFamily(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysRevokeAllCoversEarlierSessions(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysIdsComeFromOneCounter(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysOneClientRefreshInFlight(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysSignOutStaysFinal(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> alwaysTransientFailureKeepsCredential(revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> stepRevocationVisibleOnReturn(s, "revokeAll", revokeAll(s, user).state))
  ensures (inv(s) ==> canRevokeAll(s, user) ==> stepSessionChangeIsAudited(s, revokeAll(s, user).state, revokeAll(s, user).out))
{
  if inv(s) && canRevokeAll(s, user) {
    SessRevokedAll(s, user);
    SessVisible(s, "revokeAll", revokeAll(s, user).state);
  }
}

lemma logout_ensures(s: Sessions, token: int)
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysAccessWithinLifetimes(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysOneUsableRefreshTokenPerFamily(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysReuseRevokesTheFamily(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysRevokeAllCoversEarlierSessions(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysIdsComeFromOneCounter(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysOneClientRefreshInFlight(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysSignOutStaysFinal(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> alwaysTransientFailureKeepsCredential(logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> stepRevocationVisibleOnReturn(s, "logout", logout(s, token).state))
  ensures (inv(s) ==> canLogout(s, token) ==> stepSessionChangeIsAudited(s, logout(s, token).state, logout(s, token).out))
{
  if inv(s) && canLogout(s, token) {
    SessFacts(s);
    SessRevoked(s, [refreshTokenOf(s, token).family], logout(s, token).state);
    SessVisible(s, "logout", logout(s, token).state);
  }
}

lemma clientSignOut_ensures(s: Sessions)
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysAccessWithinLifetimes(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysOneUsableRefreshTokenPerFamily(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysReuseRevokesTheFamily(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysRevokeAllCoversEarlierSessions(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysIdsComeFromOneCounter(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysOneClientRefreshInFlight(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysSignOutStaysFinal(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> alwaysTransientFailureKeepsCredential(clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> stepRevocationVisibleOnReturn(s, "clientSignOut", clientSignOut(s).state))
  ensures (inv(s) ==> canClientSignOut(s) ==> stepSessionChangeIsAudited(s, clientSignOut(s).state, clientSignOut(s).out))
{
  if inv(s) && canClientSignOut(s) {
    SessFacts(s);
    SessRevoked(s, [refreshTokenOf(s, s.clientRefreshToken).family], clientSignOut(s).state);
  }
}

lemma clientRefreshSettles_ensures(s: Sessions, transient: bool)
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysAccessWithinLifetimes(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysOneUsableRefreshTokenPerFamily(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysReuseRevokesTheFamily(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysRevokeAllCoversEarlierSessions(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysIdsComeFromOneCounter(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysOneClientRefreshInFlight(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysSignOutStaysFinal(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> alwaysTransientFailureKeepsCredential(clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> stepRevocationVisibleOnReturn(s, "clientRefreshSettles", clientRefreshSettles(s, transient).state))
  ensures (inv(s) ==> canClientRefreshSettles(s, transient) ==> stepSessionChangeIsAudited(s, clientRefreshSettles(s, transient).state, clientRefreshSettles(s, transient).out))
{
  if inv(s) && canClientRefreshSettles(s, transient) {
    SessFacts(s);
    if s.clientRefreshToken == 0 || transient {
      SessSame(s, clientRefreshSettles(s, transient).state);
    } else {
      SessRefreshed(s, s.clientRefreshToken, clientRefreshSettles(s, transient).state);
    }
  }
}
