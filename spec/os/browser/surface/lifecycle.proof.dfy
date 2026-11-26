lemma KeyboardNoticesBridge(out: seq<SurfaceNotice>)
  ensures keyboardNotices(out) == ProofLib.Filter((n: SurfaceNotice) => n.KeyboardChanged?, out)
{}

lemma ReconcileOwnerBridge(s: SurfaceHost, realm: Realm, desiredIds: seq<string>)
  ensures reconcileOwner(s, realm, desiredIds) ==
    s.(leases := (ProofLib.Filter((c: Realm) => (c.owner != realm.owner), s.leases) + [realm]), surfaces := (var s_map := ProofLib.Filter((x: NativeSurface) => ((x.realm.owner != realm.owner) || ((x.realm == realm) && (x.id in desiredIds))), s.surfaces); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.realm.owner == realm.owner) then x.(presented := false) else x))))
{}

lemma DestroySurfaceBridge(s: SurfaceHost, realm: Realm, id: string)
  ensures destroySurface(s, realm, id) ==
    s.(surfaces := ProofLib.Filter((x: NativeSurface) => (x.id != id), s.surfaces))
{}

lemma RendererGoneBridge(s: SurfaceHost, id: string)
  ensures rendererGone(s, id) ==
    SurfaceChange(s.(surfaces := ProofLib.Filter((x: NativeSurface) => (x.id != id), s.surfaces)), (var s_map := ProofLib.Filter((x: NativeSurface) => (x.id == id), s.surfaces); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; SurfaceCrashed(x.id, x.realm))))
{}

lemma CloseOnPurgeBridge(gone: seq<NativeSurface>, s: SurfaceHost)
  ensures closeOnPurge(gone, s) ==
    SurfaceChange(s.(surfaces := ProofLib.Filter((x: NativeSurface) => !((x in gone)), s.surfaces)), seq(|gone|, i_map requires 0 <= i_map < |gone| => var x := gone[i_map]; SurfaceClosed(x.id, x.realm)))
{}

lemma KeyedProfilePurgedBridge(s: SurfaceHost, owner: string, key: string)
  ensures keyedProfilePurged(s, owner, key) ==
    closeOnPurge(ProofLib.Filter((x: NativeSurface) => ((x.realm.owner == owner) && (x.policy.storage == typed0_os__browser__surface__lifecycle(KeyedProfile(key)))), s.surfaces), s)
{}

lemma AllProfilesPurgedBridge(s: SurfaceHost)
  ensures allProfilesPurged(s) ==
    closeOnPurge(ProofLib.Filter((x: NativeSurface) => (!x.policy.storage.HostStorage?), s.surfaces), s)
{}

lemma ReportedBridge(s: SurfaceHost, id: string)
  ensures reported(s, id) ==
    (var s_map := ProofLib.Filter((x: NativeSurface) => (x.id == id), s.surfaces); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; NavigationChanged(x.id, x.realm, x.page.href, x.page.result, x.presented, x.paused)))
{}

lemma NoKeyboardNotices(out: seq<SurfaceNotice>)
  requires forall n :: n in out ==> !n.KeyboardChanged?
  ensures keyboardNotices(out) == []
{
  KeyboardNoticesBridge(out);
  ProofLib.FilterNone((n: SurfaceNotice) => n.KeyboardChanged?, out);
}

lemma FilterPartitionLength<T>(p: T -> bool, q: T -> bool, xs: seq<T>)
  requires forall x :: x in xs ==> q(x) == !p(x)
  ensures |ProofLib.Filter(p, xs)| + |ProofLib.Filter(q, xs)| == |xs|
  decreases |xs|
{
  if |xs| == 0 {
    ProofLib.FilterNil(p, xs);
    ProofLib.FilterNil(q, xs);
  } else {
    ProofLib.FilterCons(p, xs);
    ProofLib.FilterCons(q, xs);
    assert forall x :: x in xs[1..] ==> x in xs;
    FilterPartitionLength(p, q, xs[1..]);
  }
}

lemma CloseOnPurgePreserves(s: SurfaceHost, gonePred: NativeSurface -> bool, via: string)
  requires inv(s)
  requires via == "keyedProfilePurged" || via == "allProfilesPurged"
  ensures var gone := ProofLib.Filter(gonePred, s.surfaces);
    var res := closeOnPurge(gone, s);
    alwaysOneLeasePerOwner(res.state) &&
    alwaysSurfacesBelongToTheirOwnersLease(res.state) &&
    alwaysIsolationIsHonoured(res.state) &&
    alwaysIssuedOnce(res.state) &&
    alwaysOnePresentedPerOwner(res.state) &&
    alwaysHiddenKeyboardHasNoHeight(res.state) &&
    stepLeaseMovesOnlyToANewerEpoch(s, res.state) &&
    stepPresentingNeverResumes(s, via, res.state) &&
    stepClosedSurfaceIsReportedOnceAfterItCloses(s, via, res.state, res.out) &&
    stepNavigationReportsTheStateAsSent(s, via, res.state, res.out) &&
    stepSecurityBlockEndsOnlyAtANewAddress(s, via, res.state) &&
    stepKeyboardReportedOncePerChange(s, via, res.state, res.out)
{
  var gone := ProofLib.Filter(gonePred, s.surfaces);
  CloseOnPurgeBridge(gone, s);
  var res := closeOnPurge(gone, s);
  var keep := (x: NativeSurface) => !((x in gone));
  forall x | x in s.surfaces
    ensures (x in gone) == gonePred(x)
    ensures keep(x) == !gonePred(x)
  {
    ProofLib.FilterMember(gonePred, s.surfaces, x);
  }
  FilterPartitionLength(gonePred, keep, s.surfaces);
  forall x
    ensures x in res.state.surfaces <==> x in s.surfaces && !(x in gone)
  {
    ProofLib.FilterMember(keep, s.surfaces, x);
  }
  forall x | x in gone
    ensures x in s.surfaces && !(hasSurface(res.state, x.id))
  {
    ProofLib.FilterMember(gonePred, s.surfaces, x);
    forall y | y in res.state.surfaces
      ensures y.id != x.id
    {
      if y.id == x.id {
        assert y == x;
      }
    }
  }
  NoKeyboardNotices(res.out);
}

lemma reconcileOwner_ensures(s: SurfaceHost, realm: Realm, desiredIds: seq<string>)
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysOneLeasePerOwner(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysSurfacesBelongToTheirOwnersLease(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysIsolationIsHonoured(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysIssuedOnce(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysOnePresentedPerOwner(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysHiddenKeyboardHasNoHeight(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepLeaseMovesOnlyToANewerEpoch(s, reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepPresentingNeverResumes(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds), []))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepNavigationReportsTheStateAsSent(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds), []))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepKeyboardReportedOncePerChange(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds), []))
{
  if inv(s) && canReconcileOwner(s, realm, desiredIds) {
    ReconcileOwnerBridge(s, realm, desiredIds);
    var after := reconcileOwner(s, realm, desiredIds);
    var keepL := (c: Realm) => (c.owner != realm.owner);
    var keepS := (x: NativeSurface) => ((x.realm.owner != realm.owner) || ((x.realm == realm) && (x.id in desiredIds)));
    var keptL := ProofLib.Filter(keepL, s.leases);
    var keptS := ProofLib.Filter(keepS, s.surfaces);
    forall c
      ensures c in keptL <==> c in s.leases && c.owner != realm.owner
    {
      ProofLib.FilterMember(keepL, s.leases, c);
    }
    forall x
      ensures x in keptS <==> x in s.surfaces && keepS(x)
    {
      ProofLib.FilterMember(keepS, s.surfaces, x);
    }
    NoKeyboardNotices([]);
  }
}

lemma destroySurface_ensures(s: SurfaceHost, realm: Realm, id: string)
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysOneLeasePerOwner(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysSurfacesBelongToTheirOwnersLease(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysIsolationIsHonoured(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysIssuedOnce(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysOnePresentedPerOwner(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysHiddenKeyboardHasNoHeight(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepLeaseMovesOnlyToANewerEpoch(s, destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepPresentingNeverResumes(s, "destroySurface", destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "destroySurface", destroySurface(s, realm, id), []))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepNavigationReportsTheStateAsSent(s, "destroySurface", destroySurface(s, realm, id), []))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "destroySurface", destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepKeyboardReportedOncePerChange(s, "destroySurface", destroySurface(s, realm, id), []))
{
  if inv(s) && canDestroySurface(s, realm, id) {
    DestroySurfaceBridge(s, realm, id);
    var after := destroySurface(s, realm, id);
    var keep := (x: NativeSurface) => (x.id != id);
    forall x
      ensures x in after.surfaces <==> x in s.surfaces && x.id != id
    {
      ProofLib.FilterMember(keep, s.surfaces, x);
    }
    NoKeyboardNotices([]);
  }
}

lemma rendererGone_ensures(s: SurfaceHost, id: string)
  ensures (inv(s) ==> alwaysOneLeasePerOwner(rendererGone(s, id).state))
  ensures (inv(s) ==> alwaysSurfacesBelongToTheirOwnersLease(rendererGone(s, id).state))
  ensures (inv(s) ==> alwaysIsolationIsHonoured(rendererGone(s, id).state))
  ensures (inv(s) ==> alwaysIssuedOnce(rendererGone(s, id).state))
  ensures (inv(s) ==> alwaysOnePresentedPerOwner(rendererGone(s, id).state))
  ensures (inv(s) ==> alwaysHiddenKeyboardHasNoHeight(rendererGone(s, id).state))
  ensures (inv(s) ==> stepLeaseMovesOnlyToANewerEpoch(s, rendererGone(s, id).state))
  ensures (inv(s) ==> stepPresentingNeverResumes(s, "rendererGone", rendererGone(s, id).state))
  ensures (inv(s) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "rendererGone", rendererGone(s, id).state, rendererGone(s, id).out))
  ensures (inv(s) ==> stepNavigationReportsTheStateAsSent(s, "rendererGone", rendererGone(s, id).state, rendererGone(s, id).out))
  ensures (inv(s) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "rendererGone", rendererGone(s, id).state))
  ensures (inv(s) ==> stepKeyboardReportedOncePerChange(s, "rendererGone", rendererGone(s, id).state, rendererGone(s, id).out))
{
  if inv(s) {
    RendererGoneBridge(s, id);
    var after := rendererGone(s, id);
    var keep := (x: NativeSurface) => (x.id != id);
    var drop := (x: NativeSurface) => (x.id == id);
    FilterPartitionLength(keep, drop, s.surfaces);
    forall x
      ensures x in after.state.surfaces <==> x in s.surfaces && x.id != id
      ensures x in ProofLib.Filter(drop, s.surfaces) <==> x in s.surfaces && x.id == id
    {
      ProofLib.FilterMember(keep, s.surfaces, x);
      ProofLib.FilterMember(drop, s.surfaces, x);
    }
    NoKeyboardNotices(after.out);
  }
}

lemma keyedProfilePurged_ensures(s: SurfaceHost, owner: string, key: string)
  ensures (inv(s) ==> alwaysOneLeasePerOwner(keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> alwaysSurfacesBelongToTheirOwnersLease(keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> alwaysIsolationIsHonoured(keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> alwaysIssuedOnce(keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> alwaysOnePresentedPerOwner(keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> alwaysHiddenKeyboardHasNoHeight(keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> stepLeaseMovesOnlyToANewerEpoch(s, keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> stepPresentingNeverResumes(s, "keyedProfilePurged", keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "keyedProfilePurged", keyedProfilePurged(s, owner, key).state, keyedProfilePurged(s, owner, key).out))
  ensures (inv(s) ==> stepNavigationReportsTheStateAsSent(s, "keyedProfilePurged", keyedProfilePurged(s, owner, key).state, keyedProfilePurged(s, owner, key).out))
  ensures (inv(s) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "keyedProfilePurged", keyedProfilePurged(s, owner, key).state))
  ensures (inv(s) ==> stepKeyboardReportedOncePerChange(s, "keyedProfilePurged", keyedProfilePurged(s, owner, key).state, keyedProfilePurged(s, owner, key).out))
{
  if inv(s) {
    KeyedProfilePurgedBridge(s, owner, key);
    CloseOnPurgePreserves(s, (x: NativeSurface) => ((x.realm.owner == owner) && (x.policy.storage == typed0_os__browser__surface__lifecycle(KeyedProfile(key)))), "keyedProfilePurged");
  }
}

lemma allProfilesPurged_ensures(s: SurfaceHost)
  ensures (inv(s) ==> alwaysOneLeasePerOwner(allProfilesPurged(s).state))
  ensures (inv(s) ==> alwaysSurfacesBelongToTheirOwnersLease(allProfilesPurged(s).state))
  ensures (inv(s) ==> alwaysIsolationIsHonoured(allProfilesPurged(s).state))
  ensures (inv(s) ==> alwaysIssuedOnce(allProfilesPurged(s).state))
  ensures (inv(s) ==> alwaysOnePresentedPerOwner(allProfilesPurged(s).state))
  ensures (inv(s) ==> alwaysHiddenKeyboardHasNoHeight(allProfilesPurged(s).state))
  ensures (inv(s) ==> stepLeaseMovesOnlyToANewerEpoch(s, allProfilesPurged(s).state))
  ensures (inv(s) ==> stepPresentingNeverResumes(s, "allProfilesPurged", allProfilesPurged(s).state))
  ensures (inv(s) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "allProfilesPurged", allProfilesPurged(s).state, allProfilesPurged(s).out))
  ensures (inv(s) ==> stepNavigationReportsTheStateAsSent(s, "allProfilesPurged", allProfilesPurged(s).state, allProfilesPurged(s).out))
  ensures (inv(s) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "allProfilesPurged", allProfilesPurged(s).state))
  ensures (inv(s) ==> stepKeyboardReportedOncePerChange(s, "allProfilesPurged", allProfilesPurged(s).state, allProfilesPurged(s).out))
{
  if inv(s) {
    AllProfilesPurgedBridge(s);
    CloseOnPurgePreserves(s, (x: NativeSurface) => (!x.policy.storage.HostStorage?), "allProfilesPurged");
  }
}

lemma certificateRefused_ensures(s: SurfaceHost, id: string, address: os__browser__address_WebAddress)
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> alwaysOneLeasePerOwner(certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> alwaysSurfacesBelongToTheirOwnersLease(certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> alwaysIsolationIsHonoured(certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> alwaysIssuedOnce(certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> alwaysOnePresentedPerOwner(certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> alwaysHiddenKeyboardHasNoHeight(certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> stepLeaseMovesOnlyToANewerEpoch(s, certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> stepPresentingNeverResumes(s, "certificateRefused", certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "certificateRefused", certificateRefused(s, id, address).state, certificateRefused(s, id, address).out))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> stepNavigationReportsTheStateAsSent(s, "certificateRefused", certificateRefused(s, id, address).state, certificateRefused(s, id, address).out))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "certificateRefused", certificateRefused(s, id, address).state))
  ensures (inv(s) ==> canCertificateRefused(s, id, address) ==> stepKeyboardReportedOncePerChange(s, "certificateRefused", certificateRefused(s, id, address).state, certificateRefused(s, id, address).out))
{
  if inv(s) && canCertificateRefused(s, id, address) {
    var after := certificateRefused(s, id, address);
    ReportedBridge(after.state, id);
    var p := (x: NativeSurface) => (x.id == id);
    forall x | x in ProofLib.Filter(p, after.state.surfaces)
      ensures x in after.state.surfaces
    {
      ProofLib.FilterMember(p, after.state.surfaces, x);
    }
    NoKeyboardNotices(after.out);
  }
}

lemma pageFinished_ensures(s: SurfaceHost, id: string)
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysOneLeasePerOwner(pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysSurfacesBelongToTheirOwnersLease(pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysIsolationIsHonoured(pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysIssuedOnce(pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysOnePresentedPerOwner(pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysHiddenKeyboardHasNoHeight(pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepLeaseMovesOnlyToANewerEpoch(s, pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepPresentingNeverResumes(s, "pageFinished", pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "pageFinished", pageFinished(s, id).state, pageFinished(s, id).out))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepNavigationReportsTheStateAsSent(s, "pageFinished", pageFinished(s, id).state, pageFinished(s, id).out))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "pageFinished", pageFinished(s, id).state))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepKeyboardReportedOncePerChange(s, "pageFinished", pageFinished(s, id).state, pageFinished(s, id).out))
{
  if inv(s) && canPageFinished(s, id) {
    var after := pageFinished(s, id);
    ReportedBridge(after.state, id);
    var p := (x: NativeSurface) => (x.id == id);
    forall x | x in ProofLib.Filter(p, after.state.surfaces)
      ensures x in after.state.surfaces
    {
      ProofLib.FilterMember(p, after.state.surfaces, x);
    }
    NoKeyboardNotices(after.out);
  }
}

lemma imeChanged_ensures(s: SurfaceHost, visible: bool, height: int)
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> alwaysOneLeasePerOwner(imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> alwaysSurfacesBelongToTheirOwnersLease(imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> alwaysIsolationIsHonoured(imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> alwaysIssuedOnce(imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> alwaysOnePresentedPerOwner(imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> alwaysHiddenKeyboardHasNoHeight(imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> stepLeaseMovesOnlyToANewerEpoch(s, imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> stepPresentingNeverResumes(s, "imeChanged", imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> stepClosedSurfaceIsReportedOnceAfterItCloses(s, "imeChanged", imeChanged(s, visible, height).state, imeChanged(s, visible, height).out))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> stepNavigationReportsTheStateAsSent(s, "imeChanged", imeChanged(s, visible, height).state, imeChanged(s, visible, height).out))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> stepSecurityBlockEndsOnlyAtANewAddress(s, "imeChanged", imeChanged(s, visible, height).state))
  ensures (inv(s) ==> canImeChanged(s, visible, height) ==> stepKeyboardReportedOncePerChange(s, "imeChanged", imeChanged(s, visible, height).state, imeChanged(s, visible, height).out))
{
  if inv(s) && canImeChanged(s, visible, height) {
    var after := imeChanged(s, visible, height);
    KeyboardNoticesBridge(after.out);
    var p := (n: SurfaceNotice) => n.KeyboardChanged?;
    if visible == s.keyboard.visible {
      ProofLib.FilterNil(p, after.out);
    } else {
      ProofLib.FilterCons(p, after.out);
      assert after.out[1..] == [];
      ProofLib.FilterNil(p, []);
    }
  }
}
