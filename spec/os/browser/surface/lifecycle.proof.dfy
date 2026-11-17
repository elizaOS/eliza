lemma SurfaceUniqueFilter(ids: seq<int>)
  ensures uniqueIds(ids) == (forall n :: n in ids ==> |ProofLib.Filter((m: int) => (m == n), ids)| == 1)
{}

lemma SurfaceUniqueDistinct(ids: seq<int>)
  ensures uniqueIds(ids) == ProofLib.Distinct(ids)
{
  SurfaceUniqueFilter(ids);
  if ProofLib.Distinct(ids) {
    forall n | n in ids ensures |ProofLib.Filter((m: int) => (m == n), ids)| == 1 {
      ProofLib.FilterDistinctCountOne((m: int) => (m == n), ids, n);
    }
  } else {
    var i, j :| 0 <= i < j < |ids| && ids[i] == ids[j];
    var n := ids[i];
    ProofLib.FilterTwo((m: int) => (m == n), ids, i, j);
    assert n in ids;
  }
}

lemma SurfaceIds(s: SurfaceHost)
  ensures alwaysSurfaceIdsUnique(s) == ProofLib.DistinctBy(s.surfaces, (x: NativeSurface) => x.id)
{
  var ids := (var s_map := s.surfaces; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; x.id));
  assert alwaysSurfaceIdsUnique(s) == uniqueIds(ids);
  SurfaceUniqueDistinct(ids);
  assert ProofLib.Distinct(ids) == ProofLib.DistinctBy(s.surfaces, (x: NativeSurface) => x.id) by {
    if ProofLib.Distinct(ids) {
      forall i, j | 0 <= i < |s.surfaces| && 0 <= j < |s.surfaces| && i != j ensures s.surfaces[i].id != s.surfaces[j].id {
        if i < j { assert ids[i] != ids[j]; } else { assert ids[j] != ids[i]; }
      }
    }
  }
}

lemma SurfacePresented(s: SurfaceHost)
  ensures alwaysAtMostOnePresented(s) == (|ProofLib.Filter((x: NativeSurface) => x.presented, s.surfaces)| <= 1)
{}

lemma SurfaceIdCount(s: SurfaceHost, id: int)
  requires alwaysSurfaceIdsUnique(s)
  ensures |ProofLib.Filter((x: NativeSurface) => (x.id == id), s.surfaces)| <= 1
{
  SurfaceIds(s);
  if i :| 0 <= i < |s.surfaces| && s.surfaces[i].id == id {
    ProofLib.FilterOne((x: NativeSurface) => (x.id == id), s.surfaces, i);
  } else {
    ProofLib.FilterNone((x: NativeSurface) => (x.id == id), s.surfaces);
  }
}

lemma SurfacesFiltered(s: SurfaceHost, u: SurfaceHost, p: NativeSurface -> bool)
  requires u.surfaces == ProofLib.Filter(p, s.surfaces)
  requires alwaysSurfaceIdsUnique(s) && alwaysAtMostOnePresented(s)
  ensures forall x :: x in u.surfaces ==> x in s.surfaces && p(x)
  ensures alwaysSurfaceIdsUnique(u) && alwaysAtMostOnePresented(u)
{
  forall x | x in u.surfaces ensures x in s.surfaces && p(x) { ProofLib.FilterMember(p, s.surfaces, x); }
  SurfaceIds(s); SurfaceIds(u);
  ProofLib.FilterKeepsDistinctBy(p, s.surfaces, (x: NativeSurface) => x.id);
  SurfacePresented(s); SurfacePresented(u);
  ProofLib.FilterOfFilterShorter(p, (x: NativeSurface) => x.presented, s.surfaces);
}

lemma SurfacesMapped(s: SurfaceHost, u: SurfaceHost)
  requires |u.surfaces| == |s.surfaces| && forall i :: 0 <= i < |s.surfaces| ==> u.surfaces[i].id == s.surfaces[i].id
  requires alwaysSurfaceIdsUnique(s)
  ensures alwaysSurfaceIdsUnique(u)
  ensures (forall i :: 0 <= i < |s.surfaces| ==> u.surfaces[i].presented == s.surfaces[i].presented) ==> alwaysAtMostOnePresented(s) ==> alwaysAtMostOnePresented(u)
{
  SurfaceIds(s); SurfaceIds(u);
  SurfacePresented(s); SurfacePresented(u);
  if forall i :: 0 <= i < |s.surfaces| ==> u.surfaces[i].presented == s.surfaces[i].presented {
    ProofLib.FilterLengthPointwise((x: NativeSurface) => x.presented, (x: NativeSurface) => x.presented, s.surfaces, u.surfaces);
  }
}

lemma SurfacePartition(xs: seq<NativeSurface>, profileKey: string)
  ensures |ProofLib.Filter((x: NativeSurface) => (x.profileKey != profileKey), xs)| + |ProofLib.Filter((x: NativeSurface) => (x.profileKey == profileKey), xs)| == |xs|
{
  if |xs| > 0 {
    ProofLib.FilterCons((x: NativeSurface) => (x.profileKey != profileKey), xs);
    ProofLib.FilterCons((x: NativeSurface) => (x.profileKey == profileKey), xs);
    SurfacePartition(xs[1..], profileKey);
  }
}

lemma SurfaceIdPartition(xs: seq<NativeSurface>, id: int)
  ensures |ProofLib.Filter((x: NativeSurface) => (x.id != id), xs)| + |ProofLib.Filter((x: NativeSurface) => (x.id == id), xs)| == |xs|
{
  if |xs| > 0 {
    ProofLib.FilterCons((x: NativeSurface) => (x.id != id), xs);
    ProofLib.FilterCons((x: NativeSurface) => (x.id == id), xs);
    SurfaceIdPartition(xs[1..], id);
  }
}

lemma SurfaceCrashParts(s: SurfaceHost, id: int)
  ensures var gone := ProofLib.Filter((x: NativeSurface) => (x.id == id), s.surfaces); crashSurface(s, id).out == seq(|gone|, i_map requires 0 <= i_map < |gone| => var x := gone[i_map]; SurfaceCrashed(x.id, x.session, s.epoch))
  ensures crashSurface(s, id).state.surfaces == ProofLib.Filter((x: NativeSurface) => (x.id != id), s.surfaces)
  ensures var gone := ProofLib.Filter((x: NativeSurface) => (x.id == id), s.surfaces); crashSurface(s, id).state.crashReports == s.crashReports + ProofLib.Filter((g: int) => !((g in s.crashReports)), seq(|gone|, i_map requires 0 <= i_map < |gone| => var x := gone[i_map]; x.gen))
{}

lemma SurfacePurgeParts(s: SurfaceHost, profileKey: string)
  ensures purgeProfileSurfaces(s, profileKey).surfaces == ProofLib.Filter((x: NativeSurface) => (x.profileKey != profileKey), s.surfaces)
  ensures |purgeProfileSurfaces(s, profileKey).purgeClosed| == |s.purgeClosed| + |ProofLib.Filter((x: NativeSurface) => (x.profileKey == profileKey), s.surfaces)|
{}

lemma SurfaceBoundsStep(s: SurfaceHost, after: SurfaceHost)
  ensures stepBoundsTouchOneSurface(s, "setBounds", after) == (|ProofLib.Filter((x: NativeSurface) => !((x in s.surfaces)), after.surfaces)| <= 1)
{}

lemma createSurface_ensures(s: SurfaceHost, session: int, epoch: int, id: int, explicitPolicy: bool, layer: SurfaceLayer, profileKey: string)
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysSurfacesBelongToCurrentSession(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysSurfaceIdsUnique(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysDestroyedPluginHoldsNothing(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysLiveSessionIsNotRetired(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysAtMostOnePresented(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysCrashReportedOnce(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysGenerationNamesOneSurface(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysReportedCrashIsClosed(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysHelperViewCustody(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysDestroyedHelperReleased(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysInputRestoredSafely(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> alwaysHiddenKeyboardHasNoHeight(createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepEpochNeverGoesBack(s, createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepNoCommandWhileRendererGone(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepRetiredSessionNeverReturns(s, createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepBoundsTouchOneSurface(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepPresentingNeverResumes(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepOcclusionResolvesOnlyInEffect(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey), []))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepPurgeReportsEveryClosedSurface(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepUiOfferedBeforePage(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepReportOnlyOnChange(s, createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey)))
  ensures (inv(s) ==> canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "createSurface", createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey), []))
{
  if inv(s) && canCreateSurface(s, session, epoch, id, explicitPolicy, layer, profileKey) {
    var after := createSurface(s, session, epoch, id, explicitPolicy, layer, profileKey);
    var added := NativeSurface(id, session, (s.issued + 1), layer, profileKey, false, false, false, 0, 0, 0);
    assert after.surfaces == s.surfaces + [added];
    SurfaceIds(s); SurfaceIds(after);
    ProofLib.DistinctByConcat(s.surfaces, [added], (x: NativeSurface) => x.id);
    SurfacePresented(s); SurfacePresented(after);
    ProofLib.FilterAppend((x: NativeSurface) => x.presented, s.surfaces, added);
  }
}

lemma destroySurface_ensures(s: SurfaceHost, session: int, epoch: int, id: int)
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysSurfacesBelongToCurrentSession(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysSurfaceIdsUnique(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysDestroyedPluginHoldsNothing(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysLiveSessionIsNotRetired(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysAtMostOnePresented(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysCrashReportedOnce(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysGenerationNamesOneSurface(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysReportedCrashIsClosed(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysHelperViewCustody(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysDestroyedHelperReleased(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysInputRestoredSafely(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> alwaysHiddenKeyboardHasNoHeight(destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepEpochNeverGoesBack(s, destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepNoCommandWhileRendererGone(s, "destroySurface", destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepRetiredSessionNeverReturns(s, destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepBoundsTouchOneSurface(s, "destroySurface", destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepPresentingNeverResumes(s, "destroySurface", destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepOcclusionResolvesOnlyInEffect(s, "destroySurface", destroySurface(s, session, epoch, id), []))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepPurgeReportsEveryClosedSurface(s, "destroySurface", destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "destroySurface", destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepUiOfferedBeforePage(s, "destroySurface", destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepReportOnlyOnChange(s, destroySurface(s, session, epoch, id)))
  ensures (inv(s) ==> canDestroySurface(s, session, epoch, id) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "destroySurface", destroySurface(s, session, epoch, id), []))
{
  if inv(s) && canDestroySurface(s, session, epoch, id) {
    var after := destroySurface(s, session, epoch, id);
    assert after.surfaces == ProofLib.Filter((x: NativeSurface) => (x.id != id), s.surfaces);
    SurfacesFiltered(s, after, (x: NativeSurface) => (x.id != id));
  }
}

lemma reconcileOwner_ensures(s: SurfaceHost, session: int, epoch: int, desiredIds: seq<int>)
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysSurfacesBelongToCurrentSession(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysSurfaceIdsUnique(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysDestroyedPluginHoldsNothing(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysLiveSessionIsNotRetired(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysAtMostOnePresented(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysCrashReportedOnce(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysGenerationNamesOneSurface(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysReportedCrashIsClosed(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysHelperViewCustody(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysDestroyedHelperReleased(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysInputRestoredSafely(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> alwaysHiddenKeyboardHasNoHeight(reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepEpochNeverGoesBack(s, reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepNoCommandWhileRendererGone(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepRetiredSessionNeverReturns(s, reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepBoundsTouchOneSurface(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepPresentingNeverResumes(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepOcclusionResolvesOnlyInEffect(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds), []))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepPurgeReportsEveryClosedSurface(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepUiOfferedBeforePage(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepReportOnlyOnChange(s, reconcileOwner(s, session, epoch, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, session, epoch, desiredIds) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "reconcileOwner", reconcileOwner(s, session, epoch, desiredIds), []))
{
  if inv(s) && canReconcileOwner(s, session, epoch, desiredIds) {
    var after := reconcileOwner(s, session, epoch, desiredIds);
    assert after.surfaces == ProofLib.Filter((x: NativeSurface) => ((x.session == session) && (x.id in desiredIds)), s.surfaces);
    SurfacesFiltered(s, after, (x: NativeSurface) => ((x.session == session) && (x.id in desiredIds)));
    if session != s.session && s.session > 0 {
      assert after.retired == s.retired + ProofLib.Filter((set_x: int) => !((set_x in s.retired)), [s.session]);
      if session in after.retired { ProofLib.FilterMember((set_x: int) => !((set_x in s.retired)), [s.session], session); }
    }
  }
}

lemma pauseSurface_ensures(s: SurfaceHost, session: int, epoch: int, id: int)
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysSurfacesBelongToCurrentSession(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysSurfaceIdsUnique(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysDestroyedPluginHoldsNothing(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysLiveSessionIsNotRetired(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysAtMostOnePresented(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysCrashReportedOnce(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysGenerationNamesOneSurface(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysReportedCrashIsClosed(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysHelperViewCustody(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysDestroyedHelperReleased(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysInputRestoredSafely(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> alwaysHiddenKeyboardHasNoHeight(pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepEpochNeverGoesBack(s, pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepNoCommandWhileRendererGone(s, "pauseSurface", pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepRetiredSessionNeverReturns(s, pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepBoundsTouchOneSurface(s, "pauseSurface", pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepPresentingNeverResumes(s, "pauseSurface", pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepOcclusionResolvesOnlyInEffect(s, "pauseSurface", pauseSurface(s, session, epoch, id), []))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepPurgeReportsEveryClosedSurface(s, "pauseSurface", pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "pauseSurface", pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepUiOfferedBeforePage(s, "pauseSurface", pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepReportOnlyOnChange(s, pauseSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPauseSurface(s, session, epoch, id) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "pauseSurface", pauseSurface(s, session, epoch, id), []))
{
  if inv(s) && canPauseSurface(s, session, epoch, id) {
    SurfacesMapped(s, pauseSurface(s, session, epoch, id));
  }
}

lemma resumeSurface_ensures(s: SurfaceHost, session: int, epoch: int, id: int)
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysSurfacesBelongToCurrentSession(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysSurfaceIdsUnique(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysDestroyedPluginHoldsNothing(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysLiveSessionIsNotRetired(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysAtMostOnePresented(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysCrashReportedOnce(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysGenerationNamesOneSurface(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysReportedCrashIsClosed(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysHelperViewCustody(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysDestroyedHelperReleased(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysInputRestoredSafely(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> alwaysHiddenKeyboardHasNoHeight(resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepEpochNeverGoesBack(s, resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepNoCommandWhileRendererGone(s, "resumeSurface", resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepRetiredSessionNeverReturns(s, resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepBoundsTouchOneSurface(s, "resumeSurface", resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepPresentingNeverResumes(s, "resumeSurface", resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepOcclusionResolvesOnlyInEffect(s, "resumeSurface", resumeSurface(s, session, epoch, id), []))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepPurgeReportsEveryClosedSurface(s, "resumeSurface", resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "resumeSurface", resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepUiOfferedBeforePage(s, "resumeSurface", resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepReportOnlyOnChange(s, resumeSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canResumeSurface(s, session, epoch, id) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "resumeSurface", resumeSurface(s, session, epoch, id), []))
{
  if inv(s) && canResumeSurface(s, session, epoch, id) {
    SurfacesMapped(s, resumeSurface(s, session, epoch, id));
  }
}

lemma presentSurface_ensures(s: SurfaceHost, session: int, epoch: int, id: int)
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysSurfacesBelongToCurrentSession(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysSurfaceIdsUnique(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysDestroyedPluginHoldsNothing(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysLiveSessionIsNotRetired(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysAtMostOnePresented(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysCrashReportedOnce(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysGenerationNamesOneSurface(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysReportedCrashIsClosed(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysHelperViewCustody(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysDestroyedHelperReleased(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysInputRestoredSafely(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> alwaysHiddenKeyboardHasNoHeight(presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepEpochNeverGoesBack(s, presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepNoCommandWhileRendererGone(s, "presentSurface", presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepRetiredSessionNeverReturns(s, presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepBoundsTouchOneSurface(s, "presentSurface", presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepPresentingNeverResumes(s, "presentSurface", presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepOcclusionResolvesOnlyInEffect(s, "presentSurface", presentSurface(s, session, epoch, id), []))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepPurgeReportsEveryClosedSurface(s, "presentSurface", presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "presentSurface", presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepUiOfferedBeforePage(s, "presentSurface", presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepReportOnlyOnChange(s, presentSurface(s, session, epoch, id)))
  ensures (inv(s) ==> canPresentSurface(s, session, epoch, id) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "presentSurface", presentSurface(s, session, epoch, id), []))
{
  if inv(s) && canPresentSurface(s, session, epoch, id) {
    var after := presentSurface(s, session, epoch, id);
    SurfacesMapped(s, after);
    SurfacePresented(after);
    ProofLib.FilterLengthPointwise((x: NativeSurface) => x.presented, (x: NativeSurface) => (x.id == id), after.surfaces, s.surfaces);
    SurfaceIdCount(s, id);
  }
}

lemma setBounds_ensures(s: SurfaceHost, session: int, epoch: int, id: int, width: int, height: int)
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysSurfacesBelongToCurrentSession(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysSurfaceIdsUnique(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysDestroyedPluginHoldsNothing(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysLiveSessionIsNotRetired(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysAtMostOnePresented(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysCrashReportedOnce(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysGenerationNamesOneSurface(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysReportedCrashIsClosed(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysHelperViewCustody(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysDestroyedHelperReleased(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysInputRestoredSafely(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> alwaysHiddenKeyboardHasNoHeight(setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepEpochNeverGoesBack(s, setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepNoCommandWhileRendererGone(s, "setBounds", setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepRetiredSessionNeverReturns(s, setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepBoundsTouchOneSurface(s, "setBounds", setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepPresentingNeverResumes(s, "setBounds", setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepOcclusionResolvesOnlyInEffect(s, "setBounds", setBounds(s, session, epoch, id, width, height), []))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepPurgeReportsEveryClosedSurface(s, "setBounds", setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "setBounds", setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepUiOfferedBeforePage(s, "setBounds", setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepReportOnlyOnChange(s, setBounds(s, session, epoch, id, width, height)))
  ensures (inv(s) ==> canSetBounds(s, session, epoch, id, width, height) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "setBounds", setBounds(s, session, epoch, id, width, height), []))
{
  if inv(s) && canSetBounds(s, session, epoch, id, width, height) {
    var after := setBounds(s, session, epoch, id, width, height);
    SurfacesMapped(s, after);
    SurfaceBoundsStep(s, after);
    forall i | 0 <= i < |after.surfaces| && !(after.surfaces[i] in s.surfaces) ensures after.surfaces[i].id == id {
      if after.surfaces[i].id != id { assert after.surfaces[i] == s.surfaces[i]; }
    }
    ProofLib.FilterImpLength((x: NativeSurface) => !((x in s.surfaces)), (x: NativeSurface) => (x.id == id), after.surfaces);
    ProofLib.FilterLengthPointwise((x: NativeSurface) => (x.id == id), (x: NativeSurface) => (x.id == id), after.surfaces, s.surfaces);
    SurfaceIdCount(s, id);
  }
}

lemma setOcclusion_ensures(s: SurfaceHost, session: int, epoch: int, id: int, rects: int)
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysSurfacesBelongToCurrentSession(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysSurfaceIdsUnique(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysDestroyedPluginHoldsNothing(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysLiveSessionIsNotRetired(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysAtMostOnePresented(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysCrashReportedOnce(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysGenerationNamesOneSurface(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysReportedCrashIsClosed(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysHelperViewCustody(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysDestroyedHelperReleased(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysInputRestoredSafely(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> alwaysHiddenKeyboardHasNoHeight(setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepEpochNeverGoesBack(s, setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepNoCommandWhileRendererGone(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepRetiredSessionNeverReturns(s, setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepBoundsTouchOneSurface(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepPresentingNeverResumes(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepOcclusionResolvesOnlyInEffect(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state, setOcclusion(s, session, epoch, id, rects).out))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepPurgeReportsEveryClosedSurface(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepUiOfferedBeforePage(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepReportOnlyOnChange(s, setOcclusion(s, session, epoch, id, rects).state))
  ensures (inv(s) ==> canSetOcclusion(s, session, epoch, id, rects) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "setOcclusion", setOcclusion(s, session, epoch, id, rects).state, setOcclusion(s, session, epoch, id, rects).out))
{
  if inv(s) && canSetOcclusion(s, session, epoch, id, rects) {
    SurfacesMapped(s, setOcclusion(s, session, epoch, id, rects).state);
  }
}

lemma crashSurface_ensures(s: SurfaceHost, id: int)
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysSurfacesBelongToCurrentSession(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysSurfaceIdsUnique(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysDestroyedPluginHoldsNothing(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysLiveSessionIsNotRetired(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysAtMostOnePresented(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysCrashReportedOnce(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysGenerationNamesOneSurface(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysReportedCrashIsClosed(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysHelperViewCustody(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysDestroyedHelperReleased(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysInputRestoredSafely(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> alwaysHiddenKeyboardHasNoHeight(crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepEpochNeverGoesBack(s, crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepNoCommandWhileRendererGone(s, "crashSurface", crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepRetiredSessionNeverReturns(s, crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepBoundsTouchOneSurface(s, "crashSurface", crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepPresentingNeverResumes(s, "crashSurface", crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepOcclusionResolvesOnlyInEffect(s, "crashSurface", crashSurface(s, id).state, crashSurface(s, id).out))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepPurgeReportsEveryClosedSurface(s, "crashSurface", crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "crashSurface", crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepUiOfferedBeforePage(s, "crashSurface", crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepReportOnlyOnChange(s, crashSurface(s, id).state))
  ensures (inv(s) ==> canCrashSurface(s, id) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "crashSurface", crashSurface(s, id).state, crashSurface(s, id).out))
{
  if inv(s) && canCrashSurface(s, id) {
    var after := crashSurface(s, id).state;
    SurfaceCrashParts(s, id);
    SurfacesFiltered(s, after, (x: NativeSurface) => (x.id != id));
    var gone := ProofLib.Filter((x: NativeSurface) => (x.id == id), s.surfaces);
    SurfaceIdCount(s, id);
    var x0 :| x0 in s.surfaces && x0.id == id;
    ProofLib.FilterMember((x: NativeSurface) => (x.id == id), s.surfaces, x0);
    assert |gone| == 1;
    assert gone[0] in gone;
    ProofLib.FilterMember((x: NativeSurface) => (x.id == id), s.surfaces, gone[0]);
    var g := gone[0].gen;
    var gens := seq(|gone|, i_map requires 0 <= i_map < |gone| => var x := gone[i_map]; x.gen);
    assert gens == [g];
    ProofLib.FilterCons((g: int) => !((g in s.crashReports)), gens);
    ProofLib.FilterNil((g: int) => !((g in s.crashReports)), gens[1..]);
    assert after.crashReports == s.crashReports + (if g in s.crashReports then [] else [g]);
    SurfaceUniqueDistinct(s.crashReports); SurfaceUniqueDistinct(after.crashReports);
    SurfaceIdPartition(s.surfaces, id);
    var out := crashSurface(s, id).out;
    assert out == [SurfaceCrashed(gone[0].id, gone[0].session, s.epoch)];
    assert gone[0].session == s.session;
    assert eventServesTheLiveRealm(out[0], s);
  }
}

lemma purgeProfileSurfaces_ensures(s: SurfaceHost, profileKey: string)
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysSurfacesBelongToCurrentSession(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysSurfaceIdsUnique(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysDestroyedPluginHoldsNothing(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysLiveSessionIsNotRetired(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysAtMostOnePresented(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysCrashReportedOnce(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysGenerationNamesOneSurface(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysReportedCrashIsClosed(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysHelperViewCustody(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysDestroyedHelperReleased(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysInputRestoredSafely(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> alwaysHiddenKeyboardHasNoHeight(purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepEpochNeverGoesBack(s, purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepNoCommandWhileRendererGone(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepRetiredSessionNeverReturns(s, purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepBoundsTouchOneSurface(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepPresentingNeverResumes(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepOcclusionResolvesOnlyInEffect(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey), []))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepPurgeReportsEveryClosedSurface(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepActivityBackOnlyAfterUiAndPageDecline(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepUiOfferedBeforePage(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepReportOnlyOnChange(s, purgeProfileSurfaces(s, profileKey)))
  ensures (inv(s) ==> canPurgeProfileSurfaces(s, profileKey) ==> stepEveryClosedSurfaceIsHeardByItsRealmOnly(s, "purgeProfileSurfaces", purgeProfileSurfaces(s, profileKey), []))
{
  if inv(s) && canPurgeProfileSurfaces(s, profileKey) {
    var after := purgeProfileSurfaces(s, profileKey);
    SurfacePurgeParts(s, profileKey);
    SurfacesFiltered(s, after, (x: NativeSurface) => (x.profileKey != profileKey));
    SurfacePartition(s.surfaces, profileKey);
  }
}
