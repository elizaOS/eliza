lemma ProfilesIssuedView(s: ProfilePurge)
  ensures alwaysIssuedOnce(s) ==
    ((((s.lastProfile >= 0) && (s.lastSurface >= 0)) && !((exists p :: p in s.profiles && !((((p.name >= 1) && (p.name <= s.lastProfile)) && (|ProofLib.Filter((q: Profile) => (q.name == p.name), s.profiles)| == 1)))))) && !((exists a :: a in s.surfaces && !((((a.id >= 1) && (a.id <= s.lastSurface)) && (|ProofLib.Filter((b: Surface) => (b.id == a.id), s.surfaces)| == 1))))))
{}

lemma CreateSurfaceBridge(s: ProfilePurge, owner: string, key: string, now: int)
  ensures createSurface(s, owner, key, now) ==
    (var local_0 := (s.lastProfile + 1);
     var local_1 := ProofLib.Filter((p: Profile) => (((key != "") && (p.owner == owner)) && (p.key == key)), s.profiles);
     var local_2 := Std.Collections.Seq.FoldLeft((n: int, p: Profile) => p.name, local_0, local_1);
     var local_3 := (var s_map := s.profiles; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; (if (p.name == local_2) then p.(usedAt := now) else p)));
     s.(profiles := (if (local_2 == local_0) then (local_3 + [Profile(local_0, owner, key, now)]) else local_3), lastProfile := (if (local_2 == local_0) then local_0 else s.lastProfile), surfaces := (s.surfaces + [Surface((s.lastSurface + 1), local_2)]), lastSurface := (s.lastSurface + 1)))
{}

lemma CloseSurfaceBridge(s: ProfilePurge, id: int, now: int)
  ensures closeSurface(s, id, now) ==
    (var local_4 := Std.Collections.Seq.FoldLeft((n: int, x: Surface) => (if (x.id == id) then x.profile else n), 0, s.surfaces);
     s.(surfaces := ProofLib.Filter((x: Surface) => (x.id != id), s.surfaces), profiles := (var s_map := ProofLib.Filter((p: Profile) => ((p.name != local_4) || (p.key != "")), s.profiles); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; (if (p.name == local_4) then p.(usedAt := now) else p)))))
{}

lemma RemovingBridge(req: PurgeRequest, s: ProfilePurge, gone: seq<int>)
  ensures removing(req, s, gone) ==
    s.(request := req, purged := |gone|, cookieLeft := false, profiles := ProofLib.Filter((p: Profile) => !((p.name in gone)), s.profiles), surfaces := ProofLib.Filter((x: Surface) => !((x.profile in gone)), s.surfaces))
{}

lemma PurgeKeyBridge(s: ProfilePurge, owner: string, key: string)
  ensures purgeKey(s, owner, key) ==
    clearingFor(ByKey(owner, key), s, (var s_map := ProofLib.Filter((p: Profile) => ((p.key == key) && (p.owner == owner)), s.profiles); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; p.name)))
{}

lemma PurgeIdleBridge(s: ProfilePurge, idleMs: int, now: int)
  ensures purgeIdle(s, idleMs, now) ==
    (var local_5 := (var s_map := ProofLib.Filter((p: Profile) => (((p.key != "") && ((now - p.usedAt) >= idleMs)) && !(inUse(s, p.name))), s.profiles); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; p.name));
     removing(ByIdle(idleMs, now), s, local_5).(answer := Counted(|local_5|)))
{}

lemma KeyOfUnique(ps: seq<Profile>, target: Profile)
  requires target in ps
  requires |ProofLib.Filter((q: Profile) => (q.name == target.name), ps)| == 1
  ensures Std.Collections.Seq.FoldLeft((k: string, p: Profile) => (if (p.name == target.name) then p.key else k), "", ps) == target.key
  decreases |ps|
{
  var f := (k: string, p: Profile) => (if (p.name == target.name) then p.key else k);
  var pred := (q: Profile) => (q.name == target.name);
  var prefix := ps[..|ps| - 1];
  var last := ps[|ps| - 1];
  assert ps == prefix + [last];
  ProofLib.FilterAppend(pred, prefix, last);
  ProofLib.FoldLeftAppend(f, "", prefix, last);
  if last.name == target.name {
    ProofLib.FilterNone(pred, prefix);
    if target in prefix {
      var i :| 0 <= i < |prefix| && prefix[i] == target;
      assert pred(prefix[i]);
    }
    assert last == target;
  } else {
    assert target in prefix;
    KeyOfUnique(prefix, target);
  }
}

lemma SharedFoldPick(ps: seq<Profile>, nextName: int)
  ensures |ps| == 0 ==> Std.Collections.Seq.FoldLeft((n: int, p: Profile) => p.name, nextName, ps) == nextName
  ensures |ps| > 0 ==> Std.Collections.Seq.FoldLeft((n: int, p: Profile) => p.name, nextName, ps) == ps[|ps| - 1].name
  decreases |ps|
{
  var f := (n: int, p: Profile) => p.name;
  if |ps| == 0 {
    reveal Std.Collections.Seq.FoldLeft();
  } else {
    var prefix := ps[..|ps| - 1];
    var last := ps[|ps| - 1];
    assert ps == prefix + [last];
    ProofLib.FoldLeftAppend(f, nextName, prefix, last);
  }
}

lemma SurfaceFoldUnique(xs: seq<Surface>, target: Surface)
  requires target in xs
  requires |ProofLib.Filter((b: Surface) => (b.id == target.id), xs)| == 1
  ensures Std.Collections.Seq.FoldLeft((n: int, x: Surface) => (if (x.id == target.id) then x.profile else n), 0, xs) == target.profile
  decreases |xs|
{
  var f := (n: int, x: Surface) => (if (x.id == target.id) then x.profile else n);
  var pred := (b: Surface) => (b.id == target.id);
  var prefix := xs[..|xs| - 1];
  var last := xs[|xs| - 1];
  assert xs == prefix + [last];
  ProofLib.FilterAppend(pred, prefix, last);
  ProofLib.FoldLeftAppend(f, 0, prefix, last);
  if last.id == target.id {
    ProofLib.FilterNone(pred, prefix);
    if target in prefix {
      var i :| 0 <= i < |prefix| && prefix[i] == target;
      assert pred(prefix[i]);
    }
    assert last == target;
  } else {
    assert target in prefix;
    SurfaceFoldUnique(prefix, target);
  }
}

lemma ProfileByNameUnique(ps: seq<Profile>, p: Profile, q: Profile)
  requires p in ps && q in ps && p.name == q.name
  requires |ProofLib.Filter((r: Profile) => (r.name == p.name), ps)| == 1
  ensures p == q
{
  var i :| 0 <= i < |ps| && ps[i] == p;
  var j :| 0 <= j < |ps| && ps[j] == q;
  ProofLib.FilterCountOneIffUnique((r: Profile) => (r.name == p.name), ps, (r: Profile) => r.name, i);
  assert i == j;
}

lemma RemovingPreservesInv(req: PurgeRequest, s: ProfilePurge, gone: seq<int>)
  requires inv(s)
  ensures var after := removing(req, s, gone);
    alwaysOnlyKeyedProfilesAreShared(after) &&
    alwaysOneProfilePerOwnerAndKey(after) &&
    alwaysIssuedOnce(after) &&
    alwaysSurfacesUseLiveProfiles(after)
{
  RemovingBridge(req, s, gone);
  var after := removing(req, s, gone);
  ProfilesIssuedView(s);
  ProfilesIssuedView(after);
  var keepP := (p: Profile) => !((p.name in gone));
  var keepS := (x: Surface) => !((x.profile in gone));
  forall p | p in after.profiles
    ensures p in s.profiles && keepP(p)
    ensures |ProofLib.Filter((q: Profile) => (q.name == p.name), after.profiles)| == 1
  {
    ProofLib.FilterMember(keepP, s.profiles, p);
    var eq := (q: Profile) => (q.name == p.name);
    ProofLib.FilterOfFilterLength(keepP, eq, eq, s.profiles);
    ProofLib.FilterMember(eq, after.profiles, p);
  }
  forall a | a in after.surfaces
    ensures a in s.surfaces && keepS(a)
    ensures |ProofLib.Filter((b: Surface) => (b.id == a.id), after.surfaces)| == 1
    ensures exists p :: p in after.profiles && p.name == a.profile
  {
    ProofLib.FilterMember(keepS, s.surfaces, a);
    var eq := (b: Surface) => (b.id == a.id);
    ProofLib.FilterOfFilterLength(keepS, eq, eq, s.surfaces);
    ProofLib.FilterMember(eq, after.surfaces, a);
    var p :| p in s.profiles && p.name == a.profile;
    ProofLib.FilterMember(keepP, s.profiles, p);
  }
  forall a, b | a in after.surfaces && b in after.surfaces && a.id != b.id && a.profile == b.profile
    ensures keyOf(after, a.profile) != ""
  {
    var p :| p in after.profiles && p.name == a.profile;
    KeyOfUnique(s.profiles, p);
    KeyOfUnique(after.profiles, p);
  }
}

lemma CreateSurfaceIssued(s: ProfilePurge, owner: string, key: string, now: int)
  requires inv(s) && canCreateSurface(s, owner)
  ensures var after := createSurface(s, owner, key, now);
    alwaysIssuedOnce(after) &&
    alwaysOneProfilePerOwnerAndKey(after) &&
    alwaysSurfacesUseLiveProfiles(after) &&
    stepOnlyPurgeRemovesKeyedProfiles(s, "createSurface", after)
{
  CreateSurfaceBridge(s, owner, key, now);
  var after := createSurface(s, owner, key, now);
  ProfilesIssuedView(s);
  ProfilesIssuedView(after);
  var nextName := s.lastProfile + 1;
  var matchPred := (p: Profile) => (((key != "") && (p.owner == owner)) && (p.key == key));
  var shared := ProofLib.Filter(matchPred, s.profiles);
  SharedFoldPick(shared, nextName);
  var name := Std.Collections.Seq.FoldLeft((n: int, p: Profile) => p.name, nextName, shared);
  var touched := (var s_map := s.profiles; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; (if (p.name == name) then p.(usedAt := now) else p)));
  if |shared| > 0 {
    ProofLib.FilterMember(matchPred, s.profiles, shared[|shared| - 1]);
    assert name != nextName;
  } else {
    ProofLib.FilterNone(matchPred, s.profiles);
    assert name == nextName;
  }
  forall p | p in touched
    ensures |ProofLib.Filter((q: Profile) => (q.name == p.name), touched)| == 1
  {
    var i :| 0 <= i < |touched| && touched[i] == p;
    assert s.profiles[i] in s.profiles && s.profiles[i].name == p.name;
    var eq := (q: Profile) => (q.name == p.name);
    ProofLib.FilterLengthPointwise(eq, eq, s.profiles, touched);
  }
  forall p | p in after.profiles
    ensures |ProofLib.Filter((q: Profile) => (q.name == p.name), after.profiles)| == 1
  {
    if name == nextName {
      var added := Profile(nextName, owner, key, now);
      var eq := (q: Profile) => (q.name == p.name);
      ProofLib.FilterAppend(eq, touched, added);
      if p == added {
        ProofLib.FilterNone(eq, touched);
      }
    }
  }
  forall a | a in after.surfaces
    ensures |ProofLib.Filter((b: Surface) => (b.id == a.id), after.surfaces)| == 1
    ensures exists p :: p in after.profiles && p.name == a.profile
  {
    var added := Surface(s.lastSurface + 1, name);
    var eq := (b: Surface) => (b.id == a.id);
    ProofLib.FilterAppend(eq, s.surfaces, added);
    if a == added {
      ProofLib.FilterNone(eq, s.surfaces);
      if name == nextName {
        assert Profile(nextName, owner, key, now) in after.profiles;
      } else {
        var orig := shared[|shared| - 1];
        var i :| 0 <= i < |s.profiles| && s.profiles[i] == orig;
        assert touched[i] in after.profiles && touched[i].name == name;
      }
    } else {
      var orig :| orig in s.profiles && orig.name == a.profile;
      var i :| 0 <= i < |s.profiles| && s.profiles[i] == orig;
      assert touched[i] in after.profiles && touched[i].name == a.profile;
    }
  }
  forall p | p in s.profiles && p.key != ""
    ensures exists q :: q in after.profiles && q.name == p.name
  {
    var i :| 0 <= i < |s.profiles| && s.profiles[i] == p;
    assert touched[i] in after.profiles && touched[i].name == p.name;
  }
}

lemma CreateSurfaceShared(s: ProfilePurge, owner: string, key: string, now: int)
  requires inv(s) && canCreateSurface(s, owner)
  requires alwaysIssuedOnce(createSurface(s, owner, key, now))
  requires alwaysSurfacesUseLiveProfiles(createSurface(s, owner, key, now))
  ensures alwaysOnlyKeyedProfilesAreShared(createSurface(s, owner, key, now))
{
  CreateSurfaceBridge(s, owner, key, now);
  var after := createSurface(s, owner, key, now);
  ProfilesIssuedView(s);
  ProfilesIssuedView(after);
  var nextName := s.lastProfile + 1;
  var matchPred := (p: Profile) => (((key != "") && (p.owner == owner)) && (p.key == key));
  var shared := ProofLib.Filter(matchPred, s.profiles);
  SharedFoldPick(shared, nextName);
  var name := Std.Collections.Seq.FoldLeft((n: int, p: Profile) => p.name, nextName, shared);
  var touched := (var s_map := s.profiles; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; (if (p.name == name) then p.(usedAt := now) else p)));
  if |shared| > 0 {
    ProofLib.FilterMember(matchPred, s.profiles, shared[|shared| - 1]);
  }
  forall a, b | a in after.surfaces && b in after.surfaces && a.id != b.id && a.profile == b.profile
    ensures keyOf(after, a.profile) != ""
  {
    var addedSurf := Surface(s.lastSurface + 1, name);
    if !(a in s.surfaces) {
      assert a == addedSurf && b in s.surfaces;
    }
    var p :| p in after.profiles && p.name == a.profile;
    KeyOfUnique(after.profiles, p);
    if a in s.surfaces && b in s.surfaces {
      var orig :| orig in s.profiles && orig.name == a.profile;
      KeyOfUnique(s.profiles, orig);
      var idx :| 0 <= idx < |s.profiles| && s.profiles[idx] == orig;
      assert touched[idx] in after.profiles && touched[idx].name == orig.name && touched[idx].key == orig.key;
      ProfileByNameUnique(after.profiles, p, touched[idx]);
    } else {
      assert a.profile == name;
      assert |shared| > 0;
      var orig := shared[|shared| - 1];
      var idx :| 0 <= idx < |s.profiles| && s.profiles[idx] == orig;
      assert touched[idx] in after.profiles && touched[idx].name == orig.name && touched[idx].key == key;
      ProfileByNameUnique(after.profiles, p, touched[idx]);
    }
  }
}

lemma createSurface_ensures(s: ProfilePurge, owner: string, key: string, now: int)
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> alwaysOnlyKeyedProfilesAreShared(createSurface(s, owner, key, now)))
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> alwaysOneProfilePerOwnerAndKey(createSurface(s, owner, key, now)))
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> alwaysIssuedOnce(createSurface(s, owner, key, now)))
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> alwaysSurfacesUseLiveProfiles(createSurface(s, owner, key, now)))
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> alwaysAnswerFollowsCookieRemoval(createSurface(s, owner, key, now)))
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> stepOnlyPurgeRemovesKeyedProfiles(s, "createSurface", createSurface(s, owner, key, now)))
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> stepPurgeRemovesExactlySelected(s, "createSurface", createSurface(s, owner, key, now)))
  ensures (inv(s) ==> canCreateSurface(s, owner) ==> stepIdlePurgeNeedsAnHour(s, "createSurface", createSurface(s, owner, key, now)))
{
  if inv(s) && canCreateSurface(s, owner) {
    CreateSurfaceIssued(s, owner, key, now);
    CreateSurfaceShared(s, owner, key, now);
  }
}

lemma closeSurface_ensures(s: ProfilePurge, id: int, now: int)
  ensures (inv(s) ==> canCloseSurface(s, id) ==> alwaysOnlyKeyedProfilesAreShared(closeSurface(s, id, now)))
  ensures (inv(s) ==> canCloseSurface(s, id) ==> alwaysOneProfilePerOwnerAndKey(closeSurface(s, id, now)))
  ensures (inv(s) ==> canCloseSurface(s, id) ==> alwaysIssuedOnce(closeSurface(s, id, now)))
  ensures (inv(s) ==> canCloseSurface(s, id) ==> alwaysSurfacesUseLiveProfiles(closeSurface(s, id, now)))
  ensures (inv(s) ==> canCloseSurface(s, id) ==> alwaysAnswerFollowsCookieRemoval(closeSurface(s, id, now)))
  ensures (inv(s) ==> canCloseSurface(s, id) ==> stepOnlyPurgeRemovesKeyedProfiles(s, "closeSurface", closeSurface(s, id, now)))
  ensures (inv(s) ==> canCloseSurface(s, id) ==> stepPurgeRemovesExactlySelected(s, "closeSurface", closeSurface(s, id, now)))
  ensures (inv(s) ==> canCloseSurface(s, id) ==> stepIdlePurgeNeedsAnHour(s, "closeSurface", closeSurface(s, id, now)))
{
  if inv(s) && canCloseSurface(s, id) {
    CloseSurfaceBridge(s, id, now);
    var after := closeSurface(s, id, now);
    ProfilesIssuedView(s);
    ProfilesIssuedView(after);
    var closed :| closed in s.surfaces && closed.id == id;
    SurfaceFoldUnique(s.surfaces, closed);
    var name := closed.profile;
    var keepS := (x: Surface) => (x.id != id);
    var keepP := (p: Profile) => ((p.name != name) || (p.key != ""));
    var keptP := ProofLib.Filter(keepP, s.profiles);
    forall p | p in keptP
      ensures p in s.profiles && keepP(p)
      ensures |ProofLib.Filter((q: Profile) => (q.name == p.name), keptP)| == 1
    {
      ProofLib.FilterMember(keepP, s.profiles, p);
      var eq := (q: Profile) => (q.name == p.name);
      ProofLib.FilterOfFilterLength(keepP, eq, eq, s.profiles);
      ProofLib.FilterMember(eq, keptP, p);
    }
    forall p | p in after.profiles
      ensures |ProofLib.Filter((q: Profile) => (q.name == p.name), after.profiles)| == 1
    {
      var i :| 0 <= i < |after.profiles| && after.profiles[i] == p;
      assert keptP[i] in keptP && keptP[i].name == p.name;
      var eq := (q: Profile) => (q.name == p.name);
      ProofLib.FilterLengthPointwise(eq, eq, keptP, after.profiles);
    }
    forall a | a in after.surfaces
      ensures a in s.surfaces && a.id != id
      ensures |ProofLib.Filter((b: Surface) => (b.id == a.id), after.surfaces)| == 1
      ensures exists p :: p in after.profiles && p.name == a.profile
    {
      ProofLib.FilterMember(keepS, s.surfaces, a);
      var eq := (b: Surface) => (b.id == a.id);
      ProofLib.FilterOfFilterLength(keepS, eq, eq, s.surfaces);
      ProofLib.FilterMember(eq, after.surfaces, a);
      var orig :| orig in s.profiles && orig.name == a.profile;
      if a.profile == name {
        KeyOfUnique(s.profiles, orig);
        assert orig.key != "";
      }
      ProofLib.FilterMember(keepP, s.profiles, orig);
      var idx :| 0 <= idx < |keptP| && keptP[idx] == orig;
      assert after.profiles[idx] in after.profiles && after.profiles[idx].name == orig.name;
    }
    forall a, b | a in after.surfaces && b in after.surfaces && a.id != b.id && a.profile == b.profile
      ensures keyOf(after, a.profile) != ""
    {
      var orig :| orig in s.profiles && orig.name == a.profile;
      KeyOfUnique(s.profiles, orig);
      assert orig.key != "";
      ProofLib.FilterMember(keepP, s.profiles, orig);
      var idx :| 0 <= idx < |keptP| && keptP[idx] == orig;
      assert after.profiles[idx] in after.profiles && after.profiles[idx].name == a.profile && after.profiles[idx].key == orig.key;
      KeyOfUnique(after.profiles, after.profiles[idx]);
    }
    forall p | p in s.profiles && p.key != ""
      ensures exists q :: q in after.profiles && q.name == p.name
    {
      ProofLib.FilterMember(keepP, s.profiles, p);
      var idx :| 0 <= idx < |keptP| && keptP[idx] == p;
      assert after.profiles[idx] in after.profiles && after.profiles[idx].name == p.name;
    }
  }
}

lemma purgeKey_ensures(s: ProfilePurge, owner: string, key: string)
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> alwaysOnlyKeyedProfilesAreShared(purgeKey(s, owner, key)))
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> alwaysOneProfilePerOwnerAndKey(purgeKey(s, owner, key)))
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> alwaysIssuedOnce(purgeKey(s, owner, key)))
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> alwaysSurfacesUseLiveProfiles(purgeKey(s, owner, key)))
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> alwaysAnswerFollowsCookieRemoval(purgeKey(s, owner, key)))
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> stepOnlyPurgeRemovesKeyedProfiles(s, "purgeKey", purgeKey(s, owner, key)))
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> stepPurgeRemovesExactlySelected(s, "purgeKey", purgeKey(s, owner, key)))
  ensures (inv(s) ==> canPurgeKey(s, owner, key) ==> stepIdlePurgeNeedsAnHour(s, "purgeKey", purgeKey(s, owner, key)))
{
  if inv(s) && canPurgeKey(s, owner, key) {
    PurgeKeyBridge(s, owner, key);
    var selPred := (p: Profile) => ((p.key == key) && (p.owner == owner));
    var sel := ProofLib.Filter(selPred, s.profiles);
    var after := purgeKey(s, owner, key);
    var gone := after.clearing;
    assert |gone| == |sel| && forall i :: 0 <= i < |sel| ==> gone[i] == sel[i].name;
    RemovingPreservesInv(ByKey(owner, key), s, gone);
    RemovingBridge(ByKey(owner, key), s, gone);
    ProfilesIssuedView(s);
    var keepP := (p: Profile) => !((p.name in gone));
    forall p | p in s.profiles
      ensures (p in after.profiles) == !(selected(after.request, s, p))
    {
      ProofLib.FilterMember(keepP, s.profiles, p);
      ProofLib.FilterMember(selPred, s.profiles, p);
      if p.name in gone {
        var i :| 0 <= i < |sel| && sel[i].name == p.name;
        ProofLib.FilterMember(selPred, s.profiles, sel[i]);
        ProfileByNameUnique(s.profiles, p, sel[i]);
      }
      if selPred(p) {
        var i :| 0 <= i < |sel| && sel[i] == p;
        assert gone[i] == p.name && p.name in gone;
      }
    }
    forall p | p in after.profiles
      ensures p in s.profiles
    {
      ProofLib.FilterMember(keepP, s.profiles, p);
    }
  }
}

lemma purgeEverything_ensures(s: ProfilePurge)
  ensures (inv(s) ==> canPurgeEverything(s) ==> alwaysOnlyKeyedProfilesAreShared(purgeEverything(s)))
  ensures (inv(s) ==> canPurgeEverything(s) ==> alwaysOneProfilePerOwnerAndKey(purgeEverything(s)))
  ensures (inv(s) ==> canPurgeEverything(s) ==> alwaysIssuedOnce(purgeEverything(s)))
  ensures (inv(s) ==> canPurgeEverything(s) ==> alwaysSurfacesUseLiveProfiles(purgeEverything(s)))
  ensures (inv(s) ==> canPurgeEverything(s) ==> alwaysAnswerFollowsCookieRemoval(purgeEverything(s)))
  ensures (inv(s) ==> canPurgeEverything(s) ==> stepOnlyPurgeRemovesKeyedProfiles(s, "purgeEverything", purgeEverything(s)))
  ensures (inv(s) ==> canPurgeEverything(s) ==> stepPurgeRemovesExactlySelected(s, "purgeEverything", purgeEverything(s)))
  ensures (inv(s) ==> canPurgeEverything(s) ==> stepIdlePurgeNeedsAnHour(s, "purgeEverything", purgeEverything(s)))
{
  if inv(s) && canPurgeEverything(s) {
    var after := purgeEverything(s);
    var gone := after.clearing;
    assert |gone| == |s.profiles| && forall i :: 0 <= i < |s.profiles| ==> gone[i] == s.profiles[i].name;
    RemovingPreservesInv(PurgeRequest.Everything, s, gone);
    RemovingBridge(PurgeRequest.Everything, s, gone);
    var keepP := (p: Profile) => !((p.name in gone));
    forall p | p in s.profiles
      ensures !(p in after.profiles)
    {
      var i :| 0 <= i < |s.profiles| && s.profiles[i] == p;
      assert gone[i] == p.name && p.name in gone;
      ProofLib.FilterMember(keepP, s.profiles, p);
    }
    forall p | p in after.profiles
      ensures p in s.profiles
    {
      ProofLib.FilterMember(keepP, s.profiles, p);
    }
  }
}

lemma purgeIdle_ensures(s: ProfilePurge, idleMs: int, now: int)
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> alwaysOnlyKeyedProfilesAreShared(purgeIdle(s, idleMs, now)))
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> alwaysOneProfilePerOwnerAndKey(purgeIdle(s, idleMs, now)))
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> alwaysIssuedOnce(purgeIdle(s, idleMs, now)))
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> alwaysSurfacesUseLiveProfiles(purgeIdle(s, idleMs, now)))
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> alwaysAnswerFollowsCookieRemoval(purgeIdle(s, idleMs, now)))
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> stepOnlyPurgeRemovesKeyedProfiles(s, "purgeIdle", purgeIdle(s, idleMs, now)))
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> stepPurgeRemovesExactlySelected(s, "purgeIdle", purgeIdle(s, idleMs, now)))
  ensures (inv(s) ==> canPurgeIdle(s, idleMs) ==> stepIdlePurgeNeedsAnHour(s, "purgeIdle", purgeIdle(s, idleMs, now)))
{
  if inv(s) && canPurgeIdle(s, idleMs) {
    PurgeIdleBridge(s, idleMs, now);
    var selPred := (p: Profile) => (((p.key != "") && ((now - p.usedAt) >= idleMs)) && !(inUse(s, p.name)));
    var sel := ProofLib.Filter(selPred, s.profiles);
    var gone := (var s_map := sel; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var p := s_map[i_map]; p.name));
    RemovingPreservesInv(ByIdle(idleMs, now), s, gone);
    RemovingBridge(ByIdle(idleMs, now), s, gone);
    var after := purgeIdle(s, idleMs, now);
    assert after == removing(ByIdle(idleMs, now), s, gone).(answer := Counted(|gone|));
    ProfilesIssuedView(s);
    var keepP := (p: Profile) => !((p.name in gone));
    forall p | p in s.profiles
      ensures (p in after.profiles) == !(selected(after.request, s, p))
    {
      ProofLib.FilterMember(keepP, s.profiles, p);
      ProofLib.FilterMember(selPred, s.profiles, p);
      if p.name in gone {
        var i :| 0 <= i < |sel| && sel[i].name == p.name;
        ProofLib.FilterMember(selPred, s.profiles, sel[i]);
        ProfileByNameUnique(s.profiles, p, sel[i]);
      }
      if selPred(p) {
        var i :| 0 <= i < |sel| && sel[i] == p;
        assert gone[i] == p.name && p.name in gone;
      }
    }
    forall p | p in after.profiles
      ensures p in s.profiles
    {
      ProofLib.FilterMember(keepP, s.profiles, p);
    }
  }
}
