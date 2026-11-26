lemma OneRecordBridge(s: SurfaceCommands)
  ensures alwaysEachSurfaceHasOneRecord(s) ==
    ((os__browser__surface__lifecycle_alwaysIssuedOnce(s.host) && !((exists c :: c in s.controls && !((exists x :: x in s.host.surfaces && (x.gen == c.gen)))))) && !((exists x :: x in s.host.surfaces && !(((|ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), s.host.surfaces)| == 1) && (|ProofLib.Filter((c: SurfaceControl) => (c.gen == x.gen), s.controls)| == 1))))))
{}

lemma StepCommandBridge(before: SurfaceCommands, via: string, after: SurfaceCommands)
  ensures stepACommandChangesOnlyTheSurfaceItNames(before, via, after) ==
    (!(hostCommand(via)) || (|ProofLib.Filter((x: os__browser__surface__lifecycle_NativeSurface) => (!((x in after.host.surfaces)) || (exists c :: c in before.controls && ((c.gen == x.gen) && !((c in after.controls))))), before.host.surfaces)| <= 1))
{}

lemma AfterHostChangeBridge(host: os__browser__surface__lifecycle_SurfaceHost, s: SurfaceCommands)
  ensures afterHostChange(host, s) ==
    s.(host := host, controls := (var s_map := ProofLib.Filter((c: SurfaceControl) => (exists x :: x in host.surfaces && (x.gen == c.gen)), s.controls); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; Std.Collections.Seq.FoldLeft((acc: SurfaceControl, x: os__browser__surface__lifecycle_NativeSurface) => (if (x.gen == c.gen) then keepValid(acc, x) else acc), c, host.surfaces))))
{}

lemma RecordOfBridge(s: SurfaceCommands, id: string)
  ensures recordOf(s, id) == ProofLib.Filter((c: SurfaceControl) => forId(s, id, c), s.controls)
{}

lemma ReadPageBridge(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures readPage(s, realm, id) ==
    CommandChange(s, (var s_map := ProofLib.Filter((x: os__browser__surface__lifecycle_NativeSurface) => (x.id == id), s.host.surfaces); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; PageRead(id, x.page.href))))
{}

lemma NavigateHistoryBridge(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, ref: int)
  ensures navigateHistory(s, realm, id, ref) ==
    (var local_3 := ProofLib.Filter((c: SurfaceControl) => forId(s, id, c), s.controls);
     if (exists c :: c in local_3 && c.dialogOpen) then
       CommandChange(s, [HistoryRefused(id, HistoryRefusal.DialogOpen)])
     else
       CommandChange(s.(controls := (var s_map := s.controls; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; (if forId(s, id, c) then c.(history := HistoryObservation.NotObserved) else c)))), [(if (exists c :: c in local_3 && (c.history == typed0_os__browser__surface__commands(ObservedAt(ref)))) then HistoryStepped(id, ref) else HistoryRefused(id, HistoryRefusal.StaleRef))]))
{}

lemma PageNavigatesBridge(s: SurfaceCommands, id: string, href: string, origin: string)
  ensures pageNavigates(s, id, href, origin) ==
    (if held(s, id, origin) then
       CommandChange(s, (var s_map := ProofLib.Filter((x: os__browser__surface__lifecycle_NativeSurface) => (x.id == id), s.host.surfaces); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; NavigationRequested(id, x.realm, href))))
     else
       CommandChange(afterHostChange(os__browser__surface__lifecycle_pageStarted(s.host, id, href), s.(controls := (var s_map := s.controls; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; (if forId(s, id, c) then c.(origin := origin, approval := Approval.NoApproval) else c))))), []))
{}

lemma LifecycleReconcileBridge(s: os__browser__surface__lifecycle_SurfaceHost, realm: os__browser__surface__lifecycle_Realm, desiredIds: seq<string>)
  ensures os__browser__surface__lifecycle_reconcileOwner(s, realm, desiredIds) ==
    s.(leases := (ProofLib.Filter((c: os__browser__surface__lifecycle_Realm) => (c.owner != realm.owner), s.leases) + [realm]), surfaces := (var s_map := ProofLib.Filter((x: os__browser__surface__lifecycle_NativeSurface) => ((x.realm.owner != realm.owner) || ((x.realm == realm) && (x.id in desiredIds))), s.surfaces); seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.realm.owner == realm.owner) then x.(presented := false) else x))))
{}

lemma LifecycleDestroyBridge(s: os__browser__surface__lifecycle_SurfaceHost, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures os__browser__surface__lifecycle_destroySurface(s, realm, id) ==
    s.(surfaces := ProofLib.Filter((x: os__browser__surface__lifecycle_NativeSurface) => (x.id != id), s.surfaces))
{}

lemma KeepValidAbsent(c: SurfaceControl, acc: SurfaceControl, surfaces: seq<os__browser__surface__lifecycle_NativeSurface>)
  requires forall x :: x in surfaces ==> x.gen != c.gen
  ensures Std.Collections.Seq.FoldLeft((a: SurfaceControl, x: os__browser__surface__lifecycle_NativeSurface) => (if (x.gen == c.gen) then keepValid(a, x) else a), acc, surfaces) == acc
  decreases |surfaces|
{
  reveal Std.Collections.Seq.FoldLeft();
  if |surfaces| > 0 {
    KeepValidAbsent(c, acc, surfaces[1..]);
  }
}

lemma KeepValidPresent(c: SurfaceControl, acc: SurfaceControl, surfaces: seq<os__browser__surface__lifecycle_NativeSurface>, target: os__browser__surface__lifecycle_NativeSurface)
  requires target in surfaces && target.gen == c.gen
  requires forall x :: x in surfaces && x.gen == c.gen ==> x == target
  ensures Std.Collections.Seq.FoldLeft((a: SurfaceControl, x: os__browser__surface__lifecycle_NativeSurface) => (if (x.gen == c.gen) then keepValid(a, x) else a), acc, surfaces) == keepValid(acc, target)
  decreases |surfaces|
{
  reveal Std.Collections.Seq.FoldLeft();
  assert surfaces == [surfaces[0]] + surfaces[1..];
  if surfaces[0] == target {
    if target in surfaces[1..] {
      KeepValidPresent(c, keepValid(acc, target), surfaces[1..], target);
      assert keepValid(keepValid(acc, target), target) == keepValid(acc, target);
    } else {
      KeepValidAbsent(c, keepValid(acc, target), surfaces[1..]);
    }
  } else {
    assert surfaces[0].gen != c.gen;
    KeepValidPresent(c, acc, surfaces[1..], target);
  }
}

lemma ControlByGenUnique(s: SurfaceCommands, c1: SurfaceControl, c2: SurfaceControl)
  requires alwaysEachSurfaceHasOneRecord(s)
  requires c1 in s.controls && c2 in s.controls && c1.gen == c2.gen
  ensures c1 == c2
{
  OneRecordBridge(s);
  var x :| x in s.host.surfaces && x.gen == c1.gen;
  var i :| 0 <= i < |s.controls| && s.controls[i] == c1;
  var j :| 0 <= j < |s.controls| && s.controls[j] == c2;
  ProofLib.FilterCountOneIffUnique((c: SurfaceControl) => (c.gen == x.gen), s.controls, (c: SurfaceControl) => c.gen, i);
  assert i == j;
}

lemma OriginUnchanged(before: SurfaceCommands, via: string, after: SurfaceCommands)
  requires alwaysEachSurfaceHasOneRecord(before)
  requires forall c :: c in after.controls ==> exists b0 :: b0 in before.controls && b0.gen == c.gen && c.origin == b0.origin
  ensures stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(before, via, after)
{
  hide *;
  reveal stepAnInterceptingPageLeavesItsOriginOnlyAsApproved;
  forall c, b | c in after.controls && b in before.controls && b.gen == c.gen
    ensures b.origin == c.origin
  {
    var b0 :| b0 in before.controls && b0.gen == c.gen && c.origin == b0.origin;
    ControlByGenUnique(before, b, b0);
  }
}

lemma MapControlsKeepsOneRecord(s: SurfaceCommands, nextControls: seq<SurfaceControl>, nextIssued: int)
  requires alwaysEachSurfaceHasOneRecord(s)
  requires |nextControls| == |s.controls|
  requires forall i :: 0 <= i < |s.controls| ==> nextControls[i].gen == s.controls[i].gen
  ensures alwaysEachSurfaceHasOneRecord(s.(issued := nextIssued, controls := nextControls))
{
  hide *;
  var after := s.(issued := nextIssued, controls := nextControls);
  OneRecordBridge(s);
  OneRecordBridge(after);
  forall c | c in nextControls
    ensures exists x :: x in s.host.surfaces && x.gen == c.gen
  {
    var i :| 0 <= i < |nextControls| && nextControls[i] == c;
    assert s.controls[i] in s.controls;
  }
  forall x | x in s.host.surfaces
    ensures |ProofLib.Filter((c: SurfaceControl) => (c.gen == x.gen), nextControls)| == 1
  {
    var eq := (c: SurfaceControl) => (c.gen == x.gen);
    ProofLib.FilterLengthPointwise(eq, eq, s.controls, nextControls);
  }
}

lemma SurfaceIdsPreservedMap(before: seq<os__browser__surface__lifecycle_NativeSurface>, after: seq<os__browser__surface__lifecycle_NativeSurface>)
  requires |before| == |after|
  requires forall i :: 0 <= i < |before| ==> before[i].id == after[i].id
  requires forall x :: x in before ==> |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), before)| == 1
  ensures forall x :: x in after ==> |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), after)| == 1
{
  forall x | x in after
    ensures |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), after)| == 1
  {
    var i :| 0 <= i < |after| && after[i] == x;
    assert before[i] in before && before[i].id == x.id;
    var eq := (y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id);
    ProofLib.FilterLengthPointwise(eq, eq, before, after);
  }
}

lemma HostMapPreserves(before: os__browser__surface__lifecycle_SurfaceHost, after: os__browser__surface__lifecycle_SurfaceHost)
  requires os__browser__surface__lifecycle_alwaysIssuedOnce(before)
  requires after.issued == before.issued
  requires |after.surfaces| == |before.surfaces|
  requires forall i :: 0 <= i < |before.surfaces| ==> after.surfaces[i].id == before.surfaces[i].id && after.surfaces[i].gen == before.surfaces[i].gen
  requires forall x :: x in before.surfaces ==> |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), before.surfaces)| == 1
  ensures os__browser__surface__lifecycle_alwaysIssuedOnce(after)
  ensures forall x :: x in after.surfaces ==> |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), after.surfaces)| == 1
  ensures forall x :: x in after.surfaces ==> exists y :: y in before.surfaces && y.gen == x.gen
{
  hide *;
  reveal os__browser__surface__lifecycle_alwaysIssuedOnce;
  SurfaceIdsPreservedMap(before.surfaces, after.surfaces);
  forall a, b | a in after.surfaces && b in after.surfaces && (a.id == b.id || a.gen == b.gen)
    ensures a == b
  {
    var i :| 0 <= i < |after.surfaces| && after.surfaces[i] == a;
    var j :| 0 <= j < |after.surfaces| && after.surfaces[j] == b;
    assert before.surfaces[i] in before.surfaces && before.surfaces[j] in before.surfaces;
    assert before.surfaces[i] == before.surfaces[j];
    var eq := (y: os__browser__surface__lifecycle_NativeSurface) => (y.id == before.surfaces[i].id);
    ProofLib.FilterCountOneIffUnique(eq, before.surfaces, (y: os__browser__surface__lifecycle_NativeSurface) => y.id, i);
    assert i == j;
  }
  forall x | x in after.surfaces
    ensures exists y :: y in before.surfaces && y.gen == x.gen
  {
    var i :| 0 <= i < |after.surfaces| && after.surfaces[i] == x;
    assert before.surfaces[i] in before.surfaces && before.surfaces[i].gen == x.gen;
  }
}

lemma SingleChangedSurface(before: SurfaceCommands, via: string, after: SurfaceCommands, id: string)
  requires inv(before)
  requires hostCommand(via)
  requires exists x :: x in before.host.surfaces && x.id == id
  requires forall x :: x in before.host.surfaces && x.id != id ==> (x in after.host.surfaces) && (forall c :: c in before.controls && c.gen == x.gen ==> c in after.controls)
  ensures stepACommandChangesOnlyTheSurfaceItNames(before, via, after)
{
  hide *;
  reveal inv;
  StepCommandBridge(before, via, after);
  OneRecordBridge(before);
  var x0 :| x0 in before.host.surfaces && x0.id == id;
  var changed := (x: os__browser__surface__lifecycle_NativeSurface) => (!((x in after.host.surfaces)) || (exists c :: c in before.controls && ((c.gen == x.gen) && !((c in after.controls)))));
  var isId := (y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x0.id);
  ProofLib.FilterImpLength(changed, isId, before.host.surfaces);
}

lemma UnchangedOtherControls(s: SurfaceCommands, id: string, afterControls: seq<SurfaceControl>)
  requires alwaysEachSurfaceHasOneRecord(s)
  requires |afterControls| == |s.controls|
  requires forall i :: 0 <= i < |s.controls| ==> !forId(s, id, s.controls[i]) ==> afterControls[i] == s.controls[i]
  ensures forall x :: x in s.host.surfaces && x.id != id ==> forall c :: c in s.controls && c.gen == x.gen ==> c in afterControls
{
  hide *;
  reveal forId, os__browser__surface__lifecycle_alwaysIssuedOnce;
  OneRecordBridge(s);
  forall x | x in s.host.surfaces && x.id != id
    ensures forall c :: c in s.controls && c.gen == x.gen ==> c in afterControls
  {
    forall c | c in s.controls && c.gen == x.gen
      ensures c in afterControls
    {
      var i :| 0 <= i < |s.controls| && s.controls[i] == c;
      assert !forId(s, id, c);
      assert afterControls[i] == c;
    }
  }
}

lemma AfterHostChangePreserves(host: os__browser__surface__lifecycle_SurfaceHost, s: SurfaceCommands, via: string)
  requires inv(s)
  requires os__browser__surface__lifecycle_alwaysIssuedOnce(host)
  requires forall x :: x in host.surfaces ==> |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), host.surfaces)| == 1
  requires forall x :: x in host.surfaces ==> exists y :: y in s.host.surfaces && y.gen == x.gen
  ensures var after := afterHostChange(host, s);
    alwaysEachSurfaceHasOneRecord(after) &&
    alwaysObservationsAreOnReadyPages(after) &&
    alwaysDialogsWaitOnShownRunningPages(after) &&
    stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, via, after) &&
    (forall c :: c in after.controls ==> exists b :: b in s.controls && b.gen == c.gen && c.origin == b.origin && c.approval == b.approval)
{
  AfterHostChangeBridge(host, s);
  var after := afterHostChange(host, s);
  OneRecordBridge(s);
  OneRecordBridge(after);
  var keepC := (c: SurfaceControl) => (exists x :: x in host.surfaces && (x.gen == c.gen));
  var s_map := ProofLib.Filter(keepC, s.controls);
  forall i | 0 <= i < |s_map|
    ensures s_map[i] in s.controls
    ensures exists x :: x in host.surfaces && x.gen == s_map[i].gen && after.controls[i] == keepValid(s_map[i], x)
  {
    var c := s_map[i];
    ProofLib.FilterMember(keepC, s.controls, c);
    var x :| x in host.surfaces && x.gen == c.gen;
    KeepValidPresent(c, c, host.surfaces, x);
  }
  forall x | x in host.surfaces
    ensures |ProofLib.Filter((c: SurfaceControl) => (c.gen == x.gen), after.controls)| == 1
  {
    var y :| y in s.host.surfaces && y.gen == x.gen;
    var eq := (c: SurfaceControl) => (c.gen == x.gen);
    if forall j :: 0 <= j < |s.controls| ==> !eq(s.controls[j]) {
      ProofLib.FilterNone(eq, s.controls);
      assert false;
    }
    var j :| 0 <= j < |s.controls| && eq(s.controls[j]);
    var c0 := s.controls[j];
    ProofLib.FilterMember(keepC, s.controls, c0);
    ProofLib.FilterOfFilterLength(keepC, eq, eq, s.controls);
    ProofLib.FilterMember(eq, s_map, c0);
    ProofLib.FilterLengthPointwise(eq, eq, s_map, after.controls);
  }
  OriginUnchanged(s, via, after);
}

lemma LoadPreserves(id: string, s: SurfaceCommands, via: string, approval: Approval, closesDialog: bool)
  requires inv(s)
  requires hostCommand(via) && via != "navigate" && via != "pageNavigates"
  requires exists x :: x in s.host.surfaces && x.id == id
  ensures var after := load(id, s, approval, closesDialog);
    alwaysEachSurfaceHasOneRecord(after) &&
    alwaysObservationsAreOnReadyPages(after) &&
    alwaysDialogsWaitOnShownRunningPages(after) &&
    stepACommandChangesOnlyTheSurfaceItNames(s, via, after) &&
    stepOnlyAShownLoadedPageIsReadOrDriven(s, via, after, []) &&
    stepAHistoryStepSpendsTheReferenceJustObserved(s, via, after, []) &&
    stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, via, after) &&
    stepAHeldNavigationIsReportedAndChangesNothing(s, via, after, [])
{
  hide *;
  reveal inv, load, refOf, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  var after := load(id, s, approval, closesDialog);
  MapControlsKeepsOneRecord(s, after.controls, s.issued);
  forall c | c in after.controls
    ensures exists b0 :: b0 in s.controls && b0.gen == c.gen && c.origin == b0.origin
  {
    var i :| 0 <= i < |s.controls| && after.controls[i] == c;
    assert s.controls[i] in s.controls;
  }
  OriginUnchanged(s, via, after);
  UnchangedOtherControls(s, id, after.controls);
  SingleChangedSurface(s, via, after, id);
}

lemma NavigateSingleChanged(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, href: string, origin: string)
  requires inv(s) && canNavigate(s, realm, id, href, origin)
  ensures stepACommandChangesOnlyTheSurfaceItNames(s, "navigate", navigate(s, realm, id, href, origin))
{
  hide *;
  reveal inv, canNavigate, navigate, load, forId, keepValid, ready, mayHoldDialog, hostCommand, os__browser__surface__lifecycle_owns, os__browser__surface__lifecycle_alwaysIssuedOnce, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages;
  OneRecordBridge(s);
  var local_0 := s.host.(surfaces := (var s_map := s.host.surfaces; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.id == id) then x.(page := os__browser__surface__lifecycle_Page(href, os__browser__surface__lifecycle_PageResult.PageLoading)) else x))));
  var local_1 := load(id, s, Approval.NoApproval, true);
  var mid := local_1.(controls := (var s_map := local_1.controls; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; (if forId(s, id, c) then c.(origin := origin) else c))));
  var after := navigate(s, realm, id, href, origin);
  AfterHostChangeBridge(local_0, mid);
  var keepC := (c: SurfaceControl) => (exists x :: x in local_0.surfaces && (x.gen == c.gen));
  var s_map := ProofLib.Filter(keepC, mid.controls);
  forall x | x in s.host.surfaces && x.id != id
    ensures x in after.host.surfaces
    ensures forall c :: c in s.controls && c.gen == x.gen ==> c in after.controls
  {
    var xi :| 0 <= xi < |s.host.surfaces| && s.host.surfaces[xi] == x;
    assert local_0.surfaces[xi] == x;
    forall c | c in s.controls && c.gen == x.gen
      ensures c in after.controls
    {
      var ci :| 0 <= ci < |s.controls| && s.controls[ci] == c;
      assert !forId(s, id, c);
      assert mid.controls[ci] == c;
      ProofLib.FilterMember(keepC, mid.controls, c);
      var ki :| 0 <= ki < |s_map| && s_map[ki] == c;
      forall y | y in local_0.surfaces && y.gen == c.gen
        ensures y == x
      {
        var yi :| 0 <= yi < |s.host.surfaces| && local_0.surfaces[yi] == y;
        assert s.host.surfaces[yi] in s.host.surfaces && s.host.surfaces[yi].gen == x.gen;
        assert s.host.surfaces[yi] == x;
      }
      KeepValidPresent(c, c, local_0.surfaces, x);
      assert keepValid(c, x) == c;
      assert after.controls[ki] == c;
    }
  }
  SingleChangedSurface(s, "navigate", after, id);
}

lemma navigate_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, href: string, origin: string)
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> alwaysEachSurfaceHasOneRecord(navigate(s, realm, id, href, origin)))
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> alwaysObservationsAreOnReadyPages(navigate(s, realm, id, href, origin)))
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> alwaysDialogsWaitOnShownRunningPages(navigate(s, realm, id, href, origin)))
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "navigate", navigate(s, realm, id, href, origin)))
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "navigate", navigate(s, realm, id, href, origin), []))
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "navigate", navigate(s, realm, id, href, origin), []))
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "navigate", navigate(s, realm, id, href, origin)))
  ensures (inv(s) ==> canNavigate(s, realm, id, href, origin) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "navigate", navigate(s, realm, id, href, origin), []))
{
  hide *;
  reveal inv, canNavigate, navigate, load, refOf, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAnInterceptingPageLeavesItsOriginOnlyAsApproved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canNavigate(s, realm, id, href, origin) {
    OneRecordBridge(s);
    var local_0 := s.host.(surfaces := (var s_map := s.host.surfaces; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var x := s_map[i_map]; (if (x.id == id) then x.(page := os__browser__surface__lifecycle_Page(href, os__browser__surface__lifecycle_PageResult.PageLoading)) else x))));
    var local_1 := load(id, s, Approval.NoApproval, true);
    var mid := local_1.(controls := (var s_map := local_1.controls; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; (if forId(s, id, c) then c.(origin := origin) else c))));
    MapControlsKeepsOneRecord(s, mid.controls, s.issued);
    HostMapPreserves(s.host, local_0);
    AfterHostChangePreserves(local_0, mid, "navigate");
    NavigateSingleChanged(s, realm, id, href, origin);
  }
}

lemma reloadSurface_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(reloadSurface(s, realm, id)))
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> alwaysObservationsAreOnReadyPages(reloadSurface(s, realm, id)))
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(reloadSurface(s, realm, id)))
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "reloadSurface", reloadSurface(s, realm, id)))
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "reloadSurface", reloadSurface(s, realm, id), []))
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "reloadSurface", reloadSurface(s, realm, id), []))
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "reloadSurface", reloadSurface(s, realm, id)))
  ensures (inv(s) ==> canReloadSurface(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "reloadSurface", reloadSurface(s, realm, id), []))
{
  if inv(s) && canReloadSurface(s, realm, id) {
    LoadPreserves(id, s, "reloadSurface", Approval.NoApproval, true);
  }
}

lemma goBack_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, origin: string)
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> alwaysEachSurfaceHasOneRecord(goBack(s, realm, id, origin)))
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> alwaysObservationsAreOnReadyPages(goBack(s, realm, id, origin)))
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> alwaysDialogsWaitOnShownRunningPages(goBack(s, realm, id, origin)))
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "goBack", goBack(s, realm, id, origin)))
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "goBack", goBack(s, realm, id, origin), []))
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "goBack", goBack(s, realm, id, origin), []))
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "goBack", goBack(s, realm, id, origin)))
  ensures (inv(s) ==> canGoBack(s, realm, id, origin) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "goBack", goBack(s, realm, id, origin), []))
{
  if inv(s) && canGoBack(s, realm, id, origin) {
    LoadPreserves(id, s, "goBack", ApprovedOrigin(origin), true);
  }
}

lemma goForward_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, origin: string)
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> alwaysEachSurfaceHasOneRecord(goForward(s, realm, id, origin)))
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> alwaysObservationsAreOnReadyPages(goForward(s, realm, id, origin)))
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> alwaysDialogsWaitOnShownRunningPages(goForward(s, realm, id, origin)))
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "goForward", goForward(s, realm, id, origin)))
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "goForward", goForward(s, realm, id, origin), []))
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "goForward", goForward(s, realm, id, origin), []))
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "goForward", goForward(s, realm, id, origin)))
  ensures (inv(s) ==> canGoForward(s, realm, id, origin) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "goForward", goForward(s, realm, id, origin), []))
{
  if inv(s) && canGoForward(s, realm, id, origin) {
    LoadPreserves(id, s, "goForward", ApprovedOrigin(origin), true);
  }
}

lemma stopLoading_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(stopLoading(s, realm, id)))
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> alwaysObservationsAreOnReadyPages(stopLoading(s, realm, id)))
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(stopLoading(s, realm, id)))
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "stopLoading", stopLoading(s, realm, id)))
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "stopLoading", stopLoading(s, realm, id), []))
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "stopLoading", stopLoading(s, realm, id), []))
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "stopLoading", stopLoading(s, realm, id)))
  ensures (inv(s) ==> canStopLoading(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "stopLoading", stopLoading(s, realm, id), []))
{
  if inv(s) && canStopLoading(s, realm, id) {
    LoadPreserves(id, s, "stopLoading", Approval.NoApproval, false);
  }
}

lemma learnSupport_ensures(s: SurfaceCommands, isolatedRenderer: bool, multiProfile: bool)
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysEachSurfaceHasOneRecord(learnSupport(s, isolatedRenderer, multiProfile)))
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysObservationsAreOnReadyPages(learnSupport(s, isolatedRenderer, multiProfile)))
  ensures (inv(s) ==> canLearnSupport(s) ==> alwaysDialogsWaitOnShownRunningPages(learnSupport(s, isolatedRenderer, multiProfile)))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile)))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile), []))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile), []))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile)))
  ensures (inv(s) ==> canLearnSupport(s) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "learnSupport", learnSupport(s, isolatedRenderer, multiProfile), []))
{
  hide *;
  reveal inv, canLearnSupport, learnSupport, os__browser__surface__lifecycle_learnSupport, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canLearnSupport(s) {
    OneRecordBridge(s);
    var host := os__browser__surface__lifecycle_learnSupport(s.host, isolatedRenderer, multiProfile);
    HostMapPreserves(s.host, host);
    AfterHostChangePreserves(host, s, "learnSupport");
  }
}

lemma reconcileOwner_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, desiredIds: seq<string>)
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysEachSurfaceHasOneRecord(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysObservationsAreOnReadyPages(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> alwaysDialogsWaitOnShownRunningPages(reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds), []))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds), []))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds)))
  ensures (inv(s) ==> canReconcileOwner(s, realm, desiredIds) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "reconcileOwner", reconcileOwner(s, realm, desiredIds), []))
{
  hide *;
  reveal inv, canReconcileOwner, reconcileOwner, os__browser__surface__lifecycle_alwaysIssuedOnce, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canReconcileOwner(s, realm, desiredIds) {
    OneRecordBridge(s);
    LifecycleReconcileBridge(s.host, realm, desiredIds);
    var host := os__browser__surface__lifecycle_reconcileOwner(s.host, realm, desiredIds);
    var keepS := (x: os__browser__surface__lifecycle_NativeSurface) => ((x.realm.owner != realm.owner) || ((x.realm == realm) && (x.id in desiredIds)));
    var keptS := ProofLib.Filter(keepS, s.host.surfaces);
    forall x | x in keptS
      ensures x in s.host.surfaces
      ensures |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), keptS)| == 1
    {
      ProofLib.FilterMember(keepS, s.host.surfaces, x);
      var eq := (y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id);
      ProofLib.FilterOfFilterLength(keepS, eq, eq, s.host.surfaces);
      ProofLib.FilterMember(eq, keptS, x);
    }
    HostMapPreserves(s.host.(surfaces := keptS), host);
    AfterHostChangePreserves(host, s, "reconcileOwner");
  }
}

lemma CreateSurfaceMidFacts(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, policy: os__browser__surface__lifecycle_SurfacePolicy, url: string)
  requires inv(s) && os__browser__surface__lifecycle_canCreateSurface(s.host, realm, id, policy, url)
  ensures var host := os__browser__surface__lifecycle_createSurface(s.host, realm, id, policy, url);
    var mid := afterHostChange(host, s);
    os__browser__surface__lifecycle_alwaysIssuedOnce(host) &&
    (forall x :: x in host.surfaces ==> |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), host.surfaces)| == 1) &&
    (forall c :: c in mid.controls ==> exists b :: b in s.controls && b.gen == c.gen && c.origin == b.origin && (exists x :: x in host.surfaces && x.gen == c.gen && c == keepValid(b, x))) &&
    (forall x :: x in s.host.surfaces ==> |ProofLib.Filter((c: SurfaceControl) => (c.gen == x.gen), mid.controls)| == 1)
{
  hide *;
  reveal inv, os__browser__surface__lifecycle_canCreateSurface, os__browser__surface__lifecycle_hasSurface, os__browser__surface__lifecycle_createSurface, os__browser__surface__lifecycle_alwaysIssuedOnce, keepValid;
  OneRecordBridge(s);
  var host := os__browser__surface__lifecycle_createSurface(s.host, realm, id, policy, url);
  var newSurf := os__browser__surface__lifecycle_NativeSurface(id, realm, (s.host.issued + 1), policy, false, false, false, os__browser__surface__lifecycle_HostRect(0, 0, 0, 0), os__browser__surface__lifecycle_OuterClip(0, 0, 0, 0, 0, 0, 0, 0), [], os__browser__surface__lifecycle_Page(url, os__browser__surface__lifecycle_PageResult.PageLoading));
  AfterHostChangeBridge(host, s);
  var mid := afterHostChange(host, s);
  var keepC := (c: SurfaceControl) => (exists x :: x in host.surfaces && (x.gen == c.gen));
  var s_map := ProofLib.Filter(keepC, s.controls);
  forall i | 0 <= i < |s_map|
    ensures s_map[i] in s.controls
    ensures exists x :: x in host.surfaces && x.gen == s_map[i].gen && mid.controls[i] == keepValid(s_map[i], x)
  {
    var c := s_map[i];
    ProofLib.FilterMember(keepC, s.controls, c);
    var x :| x in host.surfaces && x.gen == c.gen;
    KeepValidPresent(c, c, host.surfaces, x);
  }
  forall x | x in host.surfaces
    ensures |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), host.surfaces)| == 1
  {
    var eqS := (y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id);
    ProofLib.FilterAppend(eqS, s.host.surfaces, newSurf);
    if x == newSurf {
      ProofLib.FilterNone(eqS, s.host.surfaces);
    }
  }
  forall x | x in s.host.surfaces
    ensures |ProofLib.Filter((c: SurfaceControl) => (c.gen == x.gen), mid.controls)| == 1
  {
    var eqC := (c: SurfaceControl) => (c.gen == x.gen);
    if forall j :: 0 <= j < |s.controls| ==> !eqC(s.controls[j]) {
      ProofLib.FilterNone(eqC, s.controls);
      assert false;
    }
    var j :| 0 <= j < |s.controls| && eqC(s.controls[j]);
    var c0 := s.controls[j];
    ProofLib.FilterMember(keepC, s.controls, c0);
    ProofLib.FilterOfFilterLength(keepC, eqC, eqC, s.controls);
    ProofLib.FilterMember(eqC, s_map, c0);
    ProofLib.FilterLengthPointwise(eqC, eqC, s_map, mid.controls);
  }
}

lemma createSurface_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, policy: os__browser__surface__lifecycle_SurfacePolicy, url: string, origin: string)
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> alwaysEachSurfaceHasOneRecord(createSurface(s, realm, id, policy, url, origin)))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> alwaysObservationsAreOnReadyPages(createSurface(s, realm, id, policy, url, origin)))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> alwaysDialogsWaitOnShownRunningPages(createSurface(s, realm, id, policy, url, origin)))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "createSurface", createSurface(s, realm, id, policy, url, origin)))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "createSurface", createSurface(s, realm, id, policy, url, origin), []))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "createSurface", createSurface(s, realm, id, policy, url, origin), []))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "createSurface", createSurface(s, realm, id, policy, url, origin)))
  ensures (inv(s) ==> canCreateSurface(s, realm, id, policy, url, origin) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "createSurface", createSurface(s, realm, id, policy, url, origin), []))
{
  hide *;
  reveal inv, canCreateSurface, createSurface, os__browser__surface__lifecycle_createSurface, os__browser__surface__lifecycle_alwaysIssuedOnce, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages, keepValid, ready, mayHoldDialog, refOf, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAnInterceptingPageLeavesItsOriginOnlyAsApproved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canCreateSurface(s, realm, id, policy, url, origin) {
    CreateSurfaceMidFacts(s, realm, id, policy, url);
    OneRecordBridge(s);
    var host := os__browser__surface__lifecycle_createSurface(s.host, realm, id, policy, url);
    var mid := afterHostChange(host, s);
    var after := createSurface(s, realm, id, policy, url, origin);
    var newSurf := os__browser__surface__lifecycle_NativeSurface(id, realm, (s.host.issued + 1), policy, false, false, false, os__browser__surface__lifecycle_HostRect(0, 0, 0, 0), os__browser__surface__lifecycle_OuterClip(0, 0, 0, 0, 0, 0, 0, 0), [], os__browser__surface__lifecycle_Page(url, os__browser__surface__lifecycle_PageResult.PageLoading));
    var newCtrl := SurfaceControl((s.host.issued + 1), origin, Approval.NoApproval, HistoryObservation.NotObserved, false);
    assert after.host == host && after.issued == s.issued && after.controls == mid.controls + [newCtrl] by {
      reveal afterHostChange;
    }
    OneRecordBridge(after);
    forall x | x in host.surfaces
      ensures |ProofLib.Filter((c: SurfaceControl) => (c.gen == x.gen), after.controls)| == 1
    {
      var eqC := (c: SurfaceControl) => (c.gen == x.gen);
      ProofLib.FilterAppend(eqC, mid.controls, newCtrl);
      if x == newSurf {
        ProofLib.FilterNone(eqC, mid.controls);
      }
    }
    forall c, b | c in after.controls && b in s.controls && b.gen == c.gen
      ensures b.origin == c.origin
    {
      assert c in mid.controls;
      var b0 :| b0 in s.controls && b0.gen == c.gen && c.origin == b0.origin;
      ControlByGenUnique(s, b, b0);
    }
  }
}

lemma presentSurface_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(presentSurface(s, realm, id)))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysObservationsAreOnReadyPages(presentSurface(s, realm, id)))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(presentSurface(s, realm, id)))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "presentSurface", presentSurface(s, realm, id)))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "presentSurface", presentSurface(s, realm, id), []))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "presentSurface", presentSurface(s, realm, id), []))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "presentSurface", presentSurface(s, realm, id)))
  ensures (inv(s) ==> canPresentSurface(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "presentSurface", presentSurface(s, realm, id), []))
{
  hide *;
  reveal inv, canPresentSurface, presentSurface, os__browser__surface__lifecycle_presentSurface, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canPresentSurface(s, realm, id) {
    OneRecordBridge(s);
    var host := os__browser__surface__lifecycle_presentSurface(s.host, realm, id);
    HostMapPreserves(s.host, host);
    AfterHostChangePreserves(host, s, "presentSurface");
  }
}

lemma pauseSurface_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(pauseSurface(s, realm, id)))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysObservationsAreOnReadyPages(pauseSurface(s, realm, id)))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(pauseSurface(s, realm, id)))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "pauseSurface", pauseSurface(s, realm, id)))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "pauseSurface", pauseSurface(s, realm, id), []))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "pauseSurface", pauseSurface(s, realm, id), []))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "pauseSurface", pauseSurface(s, realm, id)))
  ensures (inv(s) ==> canPauseSurface(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "pauseSurface", pauseSurface(s, realm, id), []))
{
  hide *;
  reveal inv, canPauseSurface, pauseSurface, os__browser__surface__lifecycle_pauseSurface, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canPauseSurface(s, realm, id) {
    OneRecordBridge(s);
    var host := os__browser__surface__lifecycle_pauseSurface(s.host, realm, id);
    HostMapPreserves(s.host, host);
    AfterHostChangePreserves(host, s, "pauseSurface");
  }
}

lemma resumeSurface_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(resumeSurface(s, realm, id)))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysObservationsAreOnReadyPages(resumeSurface(s, realm, id)))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(resumeSurface(s, realm, id)))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "resumeSurface", resumeSurface(s, realm, id)))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "resumeSurface", resumeSurface(s, realm, id), []))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "resumeSurface", resumeSurface(s, realm, id), []))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "resumeSurface", resumeSurface(s, realm, id)))
  ensures (inv(s) ==> canResumeSurface(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "resumeSurface", resumeSurface(s, realm, id), []))
{
  hide *;
  reveal inv, canResumeSurface, resumeSurface, os__browser__surface__lifecycle_resumeSurface, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canResumeSurface(s, realm, id) {
    OneRecordBridge(s);
    var host := os__browser__surface__lifecycle_resumeSurface(s.host, realm, id);
    HostMapPreserves(s.host, host);
    AfterHostChangePreserves(host, s, "resumeSurface");
  }
}

lemma destroySurface_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysObservationsAreOnReadyPages(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "destroySurface", destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "destroySurface", destroySurface(s, realm, id), []))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "destroySurface", destroySurface(s, realm, id), []))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "destroySurface", destroySurface(s, realm, id)))
  ensures (inv(s) ==> canDestroySurface(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "destroySurface", destroySurface(s, realm, id), []))
{
  hide *;
  reveal inv, canDestroySurface, destroySurface, os__browser__surface__lifecycle_alwaysIssuedOnce, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canDestroySurface(s, realm, id) {
    OneRecordBridge(s);
    LifecycleDestroyBridge(s.host, realm, id);
    var host := os__browser__surface__lifecycle_destroySurface(s.host, realm, id);
    var keepS := (x: os__browser__surface__lifecycle_NativeSurface) => (x.id != id);
    forall x | x in host.surfaces
      ensures x in s.host.surfaces
      ensures |ProofLib.Filter((y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id), host.surfaces)| == 1
    {
      ProofLib.FilterMember(keepS, s.host.surfaces, x);
      var eq := (y: os__browser__surface__lifecycle_NativeSurface) => (y.id == x.id);
      ProofLib.FilterOfFilterLength(keepS, eq, eq, s.host.surfaces);
      ProofLib.FilterMember(eq, host.surfaces, x);
    }
    AfterHostChangePreserves(host, s, "destroySurface");
  }
}

lemma pageFinished_ensures(s: SurfaceCommands, id: string)
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysEachSurfaceHasOneRecord(pageFinished(s, id)))
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysObservationsAreOnReadyPages(pageFinished(s, id)))
  ensures (inv(s) ==> canPageFinished(s, id) ==> alwaysDialogsWaitOnShownRunningPages(pageFinished(s, id)))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "pageFinished", pageFinished(s, id)))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "pageFinished", pageFinished(s, id), []))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "pageFinished", pageFinished(s, id), []))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "pageFinished", pageFinished(s, id)))
  ensures (inv(s) ==> canPageFinished(s, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "pageFinished", pageFinished(s, id), []))
{
  hide *;
  reveal inv, canPageFinished, pageFinished, os__browser__surface__lifecycle_pageFinished, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canPageFinished(s, id) {
    OneRecordBridge(s);
    var host := os__browser__surface__lifecycle_pageFinished(s.host, id).state;
    HostMapPreserves(s.host, host);
    AfterHostChangePreserves(host, s, "pageFinished");
  }
}

lemma dialogOpened_ensures(s: SurfaceCommands, id: string)
  ensures (inv(s) ==> canDialogOpened(s, id) ==> alwaysEachSurfaceHasOneRecord(dialogOpened(s, id)))
  ensures (inv(s) ==> canDialogOpened(s, id) ==> alwaysObservationsAreOnReadyPages(dialogOpened(s, id)))
  ensures (inv(s) ==> canDialogOpened(s, id) ==> alwaysDialogsWaitOnShownRunningPages(dialogOpened(s, id)))
  ensures (inv(s) ==> canDialogOpened(s, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "dialogOpened", dialogOpened(s, id)))
  ensures (inv(s) ==> canDialogOpened(s, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "dialogOpened", dialogOpened(s, id), []))
  ensures (inv(s) ==> canDialogOpened(s, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "dialogOpened", dialogOpened(s, id), []))
  ensures (inv(s) ==> canDialogOpened(s, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "dialogOpened", dialogOpened(s, id)))
  ensures (inv(s) ==> canDialogOpened(s, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "dialogOpened", dialogOpened(s, id), []))
{
  hide *;
  reveal inv, canDialogOpened, dialogOpened, forId, os__browser__surface__lifecycle_alwaysIssuedOnce, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canDialogOpened(s, id) {
    OneRecordBridge(s);
    var after := dialogOpened(s, id);
    MapControlsKeepsOneRecord(s, after.controls, s.issued);
    forall c | c in after.controls
      ensures exists b0 :: b0 in s.controls && b0.gen == c.gen && c.origin == b0.origin
    {
      var i :| 0 <= i < |s.controls| && after.controls[i] == c;
      assert s.controls[i] in s.controls;
    }
    OriginUnchanged(s, "dialogOpened", after);
  }
}

lemma dialogClosed_ensures(s: SurfaceCommands, id: string)
  ensures (inv(s) ==> canDialogClosed(s, id) ==> alwaysEachSurfaceHasOneRecord(dialogClosed(s, id)))
  ensures (inv(s) ==> canDialogClosed(s, id) ==> alwaysObservationsAreOnReadyPages(dialogClosed(s, id)))
  ensures (inv(s) ==> canDialogClosed(s, id) ==> alwaysDialogsWaitOnShownRunningPages(dialogClosed(s, id)))
  ensures (inv(s) ==> canDialogClosed(s, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "dialogClosed", dialogClosed(s, id)))
  ensures (inv(s) ==> canDialogClosed(s, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "dialogClosed", dialogClosed(s, id), []))
  ensures (inv(s) ==> canDialogClosed(s, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "dialogClosed", dialogClosed(s, id), []))
  ensures (inv(s) ==> canDialogClosed(s, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "dialogClosed", dialogClosed(s, id)))
  ensures (inv(s) ==> canDialogClosed(s, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "dialogClosed", dialogClosed(s, id), []))
{
  hide *;
  reveal inv, dialogClosed, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  if inv(s) && canDialogClosed(s, id) {
    var after := dialogClosed(s, id);
    MapControlsKeepsOneRecord(s, after.controls, s.issued);
    forall c | c in after.controls
      ensures exists b0 :: b0 in s.controls && b0.gen == c.gen && c.origin == b0.origin
    {
      var i :| 0 <= i < |s.controls| && after.controls[i] == c;
      assert s.controls[i] in s.controls;
    }
    OriginUnchanged(s, "dialogClosed", after);
  }
}

lemma readPage_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(readPage(s, realm, id).state))
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> alwaysObservationsAreOnReadyPages(readPage(s, realm, id).state))
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(readPage(s, realm, id).state))
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "readPage", readPage(s, realm, id).state))
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "readPage", readPage(s, realm, id).state, readPage(s, realm, id).out))
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "readPage", readPage(s, realm, id).state, readPage(s, realm, id).out))
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "readPage", readPage(s, realm, id).state))
  ensures (inv(s) ==> canReadPage(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "readPage", readPage(s, realm, id).state, readPage(s, realm, id).out))
{
  if inv(s) && canReadPage(s, realm, id) {
    ReadPageBridge(s, realm, id);
    SingleChangedSurface(s, "readPage", s, id);
    OriginUnchanged(s, "readPage", s);
  }
}

lemma controlPage_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(controlPage(s, realm, id).state))
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> alwaysObservationsAreOnReadyPages(controlPage(s, realm, id).state))
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(controlPage(s, realm, id).state))
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "controlPage", controlPage(s, realm, id).state))
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "controlPage", controlPage(s, realm, id).state, controlPage(s, realm, id).out))
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "controlPage", controlPage(s, realm, id).state, controlPage(s, realm, id).out))
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "controlPage", controlPage(s, realm, id).state))
  ensures (inv(s) ==> canControlPage(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "controlPage", controlPage(s, realm, id).state, controlPage(s, realm, id).out))
{
  if inv(s) && canControlPage(s, realm, id) {
    SingleChangedSurface(s, "controlPage", s, id);
    OriginUnchanged(s, "controlPage", s);
  }
}

lemma ObserveHistoryCore(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  requires inv(s) && canObserveHistory(s, realm, id)
  ensures var after := observeHistory(s, realm, id);
    alwaysObservationsAreOnReadyPages(after.state) &&
    alwaysDialogsWaitOnShownRunningPages(after.state) &&
    stepOnlyAShownLoadedPageIsReadOrDriven(s, "observeHistory", after.state, after.out) &&
    stepAHistoryStepSpendsTheReferenceJustObserved(s, "observeHistory", after.state, after.out) &&
    stepAHeldNavigationIsReportedAndChangesNothing(s, "observeHistory", after.state, after.out)
{
  hide *;
  reveal inv, canObserveHistory, canControlPage, observeHistory, os__browser__surface__lifecycle_owns, os__browser__surface__lifecycle_alwaysIssuedOnce, forId, ready, refOf, shownAndLoaded, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  OneRecordBridge(s);
}

lemma observeHistory_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string)
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> alwaysEachSurfaceHasOneRecord(observeHistory(s, realm, id).state))
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> alwaysObservationsAreOnReadyPages(observeHistory(s, realm, id).state))
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> alwaysDialogsWaitOnShownRunningPages(observeHistory(s, realm, id).state))
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "observeHistory", observeHistory(s, realm, id).state))
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "observeHistory", observeHistory(s, realm, id).state, observeHistory(s, realm, id).out))
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "observeHistory", observeHistory(s, realm, id).state, observeHistory(s, realm, id).out))
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "observeHistory", observeHistory(s, realm, id).state))
  ensures (inv(s) ==> canObserveHistory(s, realm, id) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "observeHistory", observeHistory(s, realm, id).state, observeHistory(s, realm, id).out))
{
  hide *;
  reveal inv, canObserveHistory, canControlPage, observeHistory, os__browser__surface__lifecycle_owns, hostCommand;
  if inv(s) && canObserveHistory(s, realm, id) {
    ObserveHistoryCore(s, realm, id);
    var after := observeHistory(s, realm, id);
    MapControlsKeepsOneRecord(s, after.state.controls, s.issued + 1);
    forall c | c in after.state.controls
      ensures exists b0 :: b0 in s.controls && b0.gen == c.gen && c.origin == b0.origin
    {
      var i :| 0 <= i < |s.controls| && after.state.controls[i] == c;
      assert s.controls[i] in s.controls;
    }
    OriginUnchanged(s, "observeHistory", after.state);
    UnchangedOtherControls(s, id, after.state.controls);
    SingleChangedSurface(s, "observeHistory", after.state, id);
  }
}

lemma NavigateHistoryStepRule(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, ref: int)
  requires inv(s) && canNavigateHistory(s, realm, id, ref)
  ensures stepOnlyAShownLoadedPageIsReadOrDriven(s, "navigateHistory", navigateHistory(s, realm, id, ref).state, navigateHistory(s, realm, id, ref).out)
  ensures stepAHistoryStepSpendsTheReferenceJustObserved(s, "navigateHistory", navigateHistory(s, realm, id, ref).state, navigateHistory(s, realm, id, ref).out)
  ensures stepAHeldNavigationIsReportedAndChangesNothing(s, "navigateHistory", navigateHistory(s, realm, id, ref).state, navigateHistory(s, realm, id, ref).out)
{
  hide *;
  reveal inv, canNavigateHistory, os__browser__surface__lifecycle_owns, os__browser__surface__lifecycle_alwaysIssuedOnce, forId, ready, shownAndLoaded, typed0_os__browser__surface__commands, alwaysObservationsAreOnReadyPages, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  OneRecordBridge(s);
  NavigateHistoryBridge(s, realm, id, ref);
  var after := navigateHistory(s, realm, id, ref);
  RecordOfBridge(s, id);
  RecordOfBridge(after.state, id);
  var predBefore := (c: SurfaceControl) => forId(s, id, c);
  var predAfter := (c: SurfaceControl) => forId(after.state, id, c);
  forall c
    ensures c in recordOf(s, id) <==> c in s.controls && forId(s, id, c)
    ensures c in recordOf(after.state, id) <==> c in after.state.controls && forId(after.state, id, c)
  {
    ProofLib.FilterMember(predBefore, s.controls, c);
    ProofLib.FilterMember(predAfter, after.state.controls, c);
  }
}

lemma navigateHistory_ensures(s: SurfaceCommands, realm: os__browser__surface__lifecycle_Realm, id: string, ref: int)
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> alwaysEachSurfaceHasOneRecord(navigateHistory(s, realm, id, ref).state))
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> alwaysObservationsAreOnReadyPages(navigateHistory(s, realm, id, ref).state))
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> alwaysDialogsWaitOnShownRunningPages(navigateHistory(s, realm, id, ref).state))
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "navigateHistory", navigateHistory(s, realm, id, ref).state))
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "navigateHistory", navigateHistory(s, realm, id, ref).state, navigateHistory(s, realm, id, ref).out))
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "navigateHistory", navigateHistory(s, realm, id, ref).state, navigateHistory(s, realm, id, ref).out))
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "navigateHistory", navigateHistory(s, realm, id, ref).state))
  ensures (inv(s) ==> canNavigateHistory(s, realm, id, ref) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "navigateHistory", navigateHistory(s, realm, id, ref).state, navigateHistory(s, realm, id, ref).out))
{
  hide *;
  reveal inv, canNavigateHistory, os__browser__surface__lifecycle_owns, refOf, hostCommand, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages;
  if inv(s) && canNavigateHistory(s, realm, id, ref) {
    NavigateHistoryStepRule(s, realm, id, ref);
    NavigateHistoryBridge(s, realm, id, ref);
    var after := navigateHistory(s, realm, id, ref);
    var local_3 := ProofLib.Filter((c: SurfaceControl) => forId(s, id, c), s.controls);
    if exists c :: c in local_3 && c.dialogOpen {
      SingleChangedSurface(s, "navigateHistory", s, id);
      OriginUnchanged(s, "navigateHistory", s);
    } else {
      MapControlsKeepsOneRecord(s, after.state.controls, s.issued);
      forall c | c in after.state.controls
        ensures exists b0 :: b0 in s.controls && b0.gen == c.gen && c.origin == b0.origin
      {
        var i :| 0 <= i < |s.controls| && after.state.controls[i] == c;
        assert s.controls[i] in s.controls;
      }
      OriginUnchanged(s, "navigateHistory", after.state);
      UnchangedOtherControls(s, id, after.state.controls);
      SingleChangedSurface(s, "navigateHistory", after.state, id);
    }
  }
}

lemma PageNavigatesHeld(s: SurfaceCommands, id: string, href: string, origin: string)
  requires inv(s) && canPageNavigates(s, id, href, origin) && held(s, id, origin)
  ensures var after := pageNavigates(s, id, href, origin);
    alwaysEachSurfaceHasOneRecord(after.state) &&
    alwaysObservationsAreOnReadyPages(after.state) &&
    alwaysDialogsWaitOnShownRunningPages(after.state) &&
    stepACommandChangesOnlyTheSurfaceItNames(s, "pageNavigates", after.state) &&
    stepOnlyAShownLoadedPageIsReadOrDriven(s, "pageNavigates", after.state, after.out) &&
    stepAHistoryStepSpendsTheReferenceJustObserved(s, "pageNavigates", after.state, after.out) &&
    stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "pageNavigates", after.state) &&
    stepAHeldNavigationIsReportedAndChangesNothing(s, "pageNavigates", after.state, after.out)
{
  hide *;
  reveal inv, held, forId, interceptsAt, os__browser__surface__lifecycle_alwaysIssuedOnce, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  PageNavigatesBridge(s, id, href, origin);
  RecordOfBridge(s, id);
  OneRecordBridge(s);
  var predRec := (c: SurfaceControl) => forId(s, id, c);
  forall c
    ensures c in recordOf(s, id) <==> c in s.controls && forId(s, id, c)
  {
    ProofLib.FilterMember(predRec, s.controls, c);
  }
  var predId := (x: os__browser__surface__lifecycle_NativeSurface) => (x.id == id);
  forall x | x in ProofLib.Filter(predId, s.host.surfaces)
    ensures x in s.host.surfaces && x.id == id && x.policy.interceptsNavigation
  {
    ProofLib.FilterMember(predId, s.host.surfaces, x);
    var c :| c in recordOf(s, id) && interceptsAt(s.host, c.gen);
    var y :| y in s.host.surfaces && y.id == id && y.gen == c.gen;
    var z :| z in s.host.surfaces && z.gen == c.gen && z.policy.interceptsNavigation;
    assert x == y && y == z;
  }
  OriginUnchanged(s, "pageNavigates", s);
}

lemma PageNavigatesUnheldOrigin(s: SurfaceCommands, id: string, href: string, origin: string, mid: SurfaceCommands, after: SurfaceCommands)
  requires alwaysEachSurfaceHasOneRecord(s) && !held(s, id, origin)
  requires mid == s.(controls := (var s_map := s.controls; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; (if forId(s, id, c) then c.(origin := origin, approval := Approval.NoApproval) else c))))
  requires forall c :: c in after.controls ==> exists m :: m in mid.controls && m.gen == c.gen && c.origin == m.origin
  ensures stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "pageNavigates", after)
{
  hide *;
  reveal held, stepAnInterceptingPageLeavesItsOriginOnlyAsApproved;
  RecordOfBridge(s, id);
  var predRec := (c: SurfaceControl) => forId(s, id, c);
  forall c, b | c in after.controls && b in s.controls && b.gen == c.gen && b.origin != c.origin && interceptsAt(s.host, b.gen)
    ensures b.approval == typed1_os__browser__surface__commands(ApprovedOrigin(c.origin))
  {
    var m :| m in mid.controls && m.gen == c.gen && c.origin == m.origin;
    var mi :| 0 <= mi < |s.controls| && mid.controls[mi] == m;
    ControlByGenUnique(s, b, s.controls[mi]);
    assert forId(s, id, b);
    ProofLib.FilterMember(predRec, s.controls, b);
  }
}

lemma PageNavigatesUnheld(s: SurfaceCommands, id: string, href: string, origin: string)
  requires inv(s) && canPageNavigates(s, id, href, origin) && !held(s, id, origin)
  ensures var after := pageNavigates(s, id, href, origin);
    alwaysEachSurfaceHasOneRecord(after.state) &&
    alwaysObservationsAreOnReadyPages(after.state) &&
    alwaysDialogsWaitOnShownRunningPages(after.state) &&
    stepACommandChangesOnlyTheSurfaceItNames(s, "pageNavigates", after.state) &&
    stepOnlyAShownLoadedPageIsReadOrDriven(s, "pageNavigates", after.state, after.out) &&
    stepAHistoryStepSpendsTheReferenceJustObserved(s, "pageNavigates", after.state, after.out) &&
    stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "pageNavigates", after.state) &&
    stepAHeldNavigationIsReportedAndChangesNothing(s, "pageNavigates", after.state, after.out)
{
  hide *;
  reveal inv, os__browser__surface__lifecycle_pageStarted, alwaysObservationsAreOnReadyPages, alwaysDialogsWaitOnShownRunningPages, stepACommandChangesOnlyTheSurfaceItNames, hostCommand, stepOnlyAShownLoadedPageIsReadOrDriven, stepAHistoryStepSpendsTheReferenceJustObserved, stepAHeldNavigationIsReportedAndChangesNothing;
  PageNavigatesBridge(s, id, href, origin);
  OneRecordBridge(s);
  var host := os__browser__surface__lifecycle_pageStarted(s.host, id, href);
  var mid := s.(controls := (var s_map := s.controls; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var c := s_map[i_map]; (if forId(s, id, c) then c.(origin := origin, approval := Approval.NoApproval) else c))));
  MapControlsKeepsOneRecord(s, mid.controls, s.issued);
  HostMapPreserves(s.host, host);
  AfterHostChangePreserves(host, mid, "pageNavigates");
  PageNavigatesUnheldOrigin(s, id, href, origin, mid, pageNavigates(s, id, href, origin).state);
}

lemma pageNavigates_ensures(s: SurfaceCommands, id: string, href: string, origin: string)
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> alwaysEachSurfaceHasOneRecord(pageNavigates(s, id, href, origin).state))
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> alwaysObservationsAreOnReadyPages(pageNavigates(s, id, href, origin).state))
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> alwaysDialogsWaitOnShownRunningPages(pageNavigates(s, id, href, origin).state))
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> stepACommandChangesOnlyTheSurfaceItNames(s, "pageNavigates", pageNavigates(s, id, href, origin).state))
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> stepOnlyAShownLoadedPageIsReadOrDriven(s, "pageNavigates", pageNavigates(s, id, href, origin).state, pageNavigates(s, id, href, origin).out))
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> stepAHistoryStepSpendsTheReferenceJustObserved(s, "pageNavigates", pageNavigates(s, id, href, origin).state, pageNavigates(s, id, href, origin).out))
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> stepAnInterceptingPageLeavesItsOriginOnlyAsApproved(s, "pageNavigates", pageNavigates(s, id, href, origin).state))
  ensures (inv(s) ==> canPageNavigates(s, id, href, origin) ==> stepAHeldNavigationIsReportedAndChangesNothing(s, "pageNavigates", pageNavigates(s, id, href, origin).state, pageNavigates(s, id, href, origin).out))
{
  hide *;
  if inv(s) && canPageNavigates(s, id, href, origin) {
    if held(s, id, origin) {
      PageNavigatesHeld(s, id, href, origin);
    } else {
      PageNavigatesUnheld(s, id, href, origin);
    }
  }
}
