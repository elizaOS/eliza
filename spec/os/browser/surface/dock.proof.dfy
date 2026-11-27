lemma CountOfBridge(out: seq<DockNotice>, n: DockNotice)
  ensures countOf(out, n) == |ProofLib.Filter((x: DockNotice) => (x == n), out)|
{}

lemma DockCount2(a: DockNotice, b: DockNotice, target: DockNotice)
  ensures countOf([a, b], target) == (if a == target then 1 else 0) + (if b == target then 1 else 0)
{
  CountOfBridge([a, b], target);
  var p := (x: DockNotice) => (x == target);
  ProofLib.FilterCons(p, [a, b]);
  assert [a, b][1..] == [b];
  ProofLib.FilterCons(p, [b]);
  assert [b][1..] == [];
  ProofLib.FilterNil(p, []);
}

lemma openDockedBrowser_ensures(s: BrowserDock, address: os__browser__address_WebAddress, panelWidthDp: int, windowWidthDp: int, splitAvailable: bool)
  ensures (inv(s) ==> canOpenDockedBrowser(s, address) ==> alwaysRequestedPaneFits(openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).state))
  ensures (inv(s) ==> canOpenDockedBrowser(s, address) ==> alwaysHelperWindowOnlyWithPermission(openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).state))
  ensures (inv(s) ==> canOpenDockedBrowser(s, address) ==> stepRefusedOpeningChangesNothing(s, "openDockedBrowser", openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).state, openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).out))
  ensures (inv(s) ==> canOpenDockedBrowser(s, address) ==> stepDispatchIsNotASplit(s, "openDockedBrowser", openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).state))
  ensures (inv(s) ==> canOpenDockedBrowser(s, address) ==> stepDockControlsChangeOnlyTheHelper(s, "openDockedBrowser", openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).state))
  ensures (inv(s) ==> canOpenDockedBrowser(s, address) ==> stepHelperEventsFireOncePerChange(s, "openDockedBrowser", openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).state, openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable).out))
{
  if inv(s) && canOpenDockedBrowser(s, address) {
    reveal Std.Collections.Seq.Filter();
    var after := openDockedBrowser(s, address, panelWidthDp, windowWidthDp, splitAvailable);
    if |after.out| == 1 {
      assert after.out[1..] == [];
    } else if |after.out| == 2 {
      var a := after.out[0];
      var b := after.out[1];
      assert after.out == [a, b];
      DockCount2(a, b, DockNotice.HelperReturned);
      DockCount2(a, b, HelperWindowClosed(WindowClosedReason.WebsiteOpened));
      DockCount2(a, b, Dispatched(panelWidthOf(after.state.split)));
      DockCount2(a, b, HelperWindowClosed(WindowClosedReason.PermissionRevoked));
    }
  }
}

lemma overlayPermissionChanged_ensures(s: BrowserDock, granted: bool)
  ensures (inv(s) ==> canOverlayPermissionChanged(s, granted) ==> alwaysRequestedPaneFits(overlayPermissionChanged(s, granted).state))
  ensures (inv(s) ==> canOverlayPermissionChanged(s, granted) ==> alwaysHelperWindowOnlyWithPermission(overlayPermissionChanged(s, granted).state))
  ensures (inv(s) ==> canOverlayPermissionChanged(s, granted) ==> stepRefusedOpeningChangesNothing(s, "overlayPermissionChanged", overlayPermissionChanged(s, granted).state, overlayPermissionChanged(s, granted).out))
  ensures (inv(s) ==> canOverlayPermissionChanged(s, granted) ==> stepDispatchIsNotASplit(s, "overlayPermissionChanged", overlayPermissionChanged(s, granted).state))
  ensures (inv(s) ==> canOverlayPermissionChanged(s, granted) ==> stepDockControlsChangeOnlyTheHelper(s, "overlayPermissionChanged", overlayPermissionChanged(s, granted).state))
  ensures (inv(s) ==> canOverlayPermissionChanged(s, granted) ==> stepHelperEventsFireOncePerChange(s, "overlayPermissionChanged", overlayPermissionChanged(s, granted).state, overlayPermissionChanged(s, granted).out))
{
  if inv(s) && canOverlayPermissionChanged(s, granted) {
    reveal Std.Collections.Seq.Filter();
    var after := overlayPermissionChanged(s, granted);
    if |after.out| == 1 {
      assert after.out[1..] == [];
    }
  }
}

lemma badgeTapped_ensures(s: BrowserDock)
  ensures (inv(s) ==> canBadgeTapped(s) ==> alwaysRequestedPaneFits(badgeTapped(s).state))
  ensures (inv(s) ==> canBadgeTapped(s) ==> alwaysHelperWindowOnlyWithPermission(badgeTapped(s).state))
  ensures (inv(s) ==> canBadgeTapped(s) ==> stepRefusedOpeningChangesNothing(s, "badgeTapped", badgeTapped(s).state, badgeTapped(s).out))
  ensures (inv(s) ==> canBadgeTapped(s) ==> stepDispatchIsNotASplit(s, "badgeTapped", badgeTapped(s).state))
  ensures (inv(s) ==> canBadgeTapped(s) ==> stepDockControlsChangeOnlyTheHelper(s, "badgeTapped", badgeTapped(s).state))
  ensures (inv(s) ==> canBadgeTapped(s) ==> stepHelperEventsFireOncePerChange(s, "badgeTapped", badgeTapped(s).state, badgeTapped(s).out))
{
  if inv(s) && canBadgeTapped(s) {
    reveal Std.Collections.Seq.Filter();
    var after := badgeTapped(s);
    assert after.out[1..] == [];
  }
}
