// BrowserHelperEntry.kt and the corresponding BrowserSurfacePlugin methods.
// WindowManager attachment can follow addView in a later main-thread turn.
// Calls after plugin destruction are excluded by the host lifecycle contract.
// This models view custody and permission callbacks, with no browser navigation
// or task execution authority. Android window/IME failures need device tests.
module BrowserHelperEntry {
  type State = {
    permission: bool, destroyed: bool, watcher: bool,
    entry: str, full: str, parent: str,
    reconcilePending: bool, inputPending: bool, unsafeInputRestart: bool,
  }
  var s: State

  action init = s' = {
    permission: true, destroyed: false, watcher: true,
    entry: "none", full: "none", parent: "activity",
    reconcilePending: false, inputPending: false, unsafeInputRestart: false,
  }
  action showEntry = all {
    not(s.destroyed), s.permission, s.entry == "none",
    s' = { ...s, entry: "pending" },
  }
  action attachEntry = all {
    s.entry == "pending", s' = { ...s, entry: "visible" },
  }
  action removeEntry = all {
    s.entry != "none", s' = { ...s, entry: "none" },
  }
  action showFullScreen(accepted: bool): bool = all {
    not(s.destroyed), s.permission, s.entry != "none", s.full == "none",
    // addView failure restores the original parent before the call throws.
    s' = if (accepted) {
      ...s, entry: "none", full: "pending", parent: "overlay",
    } else s,
  }
  action attachFullScreen = all {
    s.full == "pending", s' = { ...s, full: "visible" },
  }
  action removeFullScreen = all {
    s.full != "none",
    s' = { ...s, full: "none", parent: "activity", inputPending: true },
  }
  action release = s' = {
    ...s, entry: "none", full: "none", parent: "activity",
    inputPending: s.inputPending or s.full != "none",
  }
  action changePermission(granted: bool): bool = all {
    not(s.destroyed), s.permission != granted,
    s' = { ...s, permission: granted, reconcilePending: s.watcher },
  }
  action reconcile = all {
    s.reconcilePending,
    s' = if (not(s.permission) and not(s.destroyed)) {
      ...s, entry: "none", full: "none", parent: "activity",
      inputPending: s.inputPending or s.full != "none", reconcilePending: false,
    } else { ...s, reconcilePending: false },
  }
  action restoreInput = all {
    s.inputPending,
    s' = {
      ...s, inputPending: false,
      unsafeInputRestart: s.unsafeInputRestart or
        (not(s.destroyed) and s.full == "none" and s.parent != "activity"),
    },
  }
  action destroy = all {
    not(s.destroyed),
    s' = {
      ...s, destroyed: true, watcher: false, entry: "none", full: "none",
      parent: "activity", inputPending: s.inputPending or s.full != "none",
    },
  }
  action step = any {
    showEntry, attachEntry, removeEntry,
    showFullScreen(true), showFullScreen(false), attachFullScreen,
    removeFullScreen, release, changePermission(true), changePermission(false),
    reconcile, restoreInput, destroy, s' = s,
  }
  val ViewCustody = (s.full != "none") == (s.parent == "overlay")
  val DestroyedReleases = not(s.destroyed) or
    (s.entry == "none" and s.full == "none" and not(s.watcher))
  val SafeInputRestore = not(s.unsafeInputRestart)
  val invariant = ViewCustody and DestroyedReleases and SafeInputRestore
  temporal PermissionReconciles = reconcile.weakFair(s).implies(
    not(s.permission).leadsTo(s.permission or (s.entry == "none" and s.full == "none")))

  run removeBeforeAttachmentTest = init
    .then(showEntry)
    .then(removeEntry)
    .expect(invariant and s.entry == "none")
  run failedWindowRestoresViewTest = init
    .then(showEntry)
    .then(showFullScreen(false))
    .expect(invariant and s.parent == "activity")
  run revocationReleasesViewTest = init
    .then(showEntry)
    .then(showFullScreen(true))
    .then(changePermission(false))
    .then(reconcile)
    .expect(invariant and s.parent == "activity")
  run destroyBeforeInputCallbackTest = init
    .then(showEntry)
    .then(showFullScreen(true))
    .then(removeFullScreen)
    .then(destroy)
    .then(restoreInput)
    .expect(invariant and not(s.inputPending))
}
