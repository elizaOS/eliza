// runAppBlockHandler (plugins/plugin-personal-assistant/src/actions/app-block.ts)
// decides which Android packages a BLOCK target=app request selects and passes
// their package ids to the native ElizaAppBlocker plugin. The Android plugin
// (plugins/plugin-native-appblocker/android/.../AppBlockerPlugin.kt) stores
// the ids as given, and AppBlockerStateStore.isBlocked compares the foreground
// package id exactly, so an id blocks an app only when it has the case that
// the device reports. Android package ids are case-sensitive.
// Installed apps: Slack, whose id is "com.Slack", and Instagram, whose id is
// "com.instagram.android".
// Ids that a request can carry: 0 "com.Slack", 1 "com.slack",
// 2 "COM.SLACK", 3 "com.instagram.android", 4 "COM.INSTAGRAM.ANDROID",
// 5 "com.example.missing", which is not installed.
// path: 1 packageNames supplied by the action planner, 2 apps named by
// display name in the intent text (requested holds 0 for Slack and 3 for
// Instagram), 3 packageNames answered by the app-block planning model.
// stored: the ids the native plugin stores. started: the native block began.
module AppBlockPackageCase {
  pure val NoPath = 0
  pure val Explicit = 1
  pure val Intent = 2
  pure val Planner = 3
  pure val SlackId = 0
  pure val InstagramId = 3
  pure val MissingId = 5
  pure val MaxIds = 2
  pure val Slack = 0
  pure val Instagram = 1
  pure val NoApp = 2
  pure val Apps = Set(Slack, Instagram)
  pure val NoRequest: List[int] = []
  pure val Nothing: Set[int] = Set()

  var path: int
  var requested: List[int]
  var handled: bool
  var stored: Set[int]
  var started: bool

  // The installed app that an id names when its case is ignored.
  pure def appOf(id: int): int =
    if (id <= 2) Slack else if (id <= 4) Instagram else NoApp
  // The id that the device reports for an installed app.
  pure def installedId(app: int): int =
    if (app == Slack) SlackId else InstagramId
  pure def selectedApps(ids: List[int]): Set[int] =
    ids.foldl(Nothing, (s, id) =>
      if (appOf(id) == NoApp) s else s.union(Set(appOf(id))))
  // AppBlockerStateStore.isBlocked: an installed app is blocked when its
  // exact id is stored.
  pure def blockedApps(ids: Set[int]): Set[int] =
    Apps.filter(app => ids.contains(installedId(app)))
  pure def carries(ids: List[int], id: int): bool =
    ids.indices().exists(i => ids[i] == id)
  // The handler sends every id that names an installed app with the case of
  // that app. Only an explicit id that names no installed app is sent as
  // given; the planning model cannot add one.
  pure def sentIds(p: int, ids: List[int]): Set[int] =
    ids.foldl(Nothing, (s, id) =>
      if (appOf(id) != NoApp) s.union(Set(installedId(appOf(id))))
      else if (p == Explicit) s.union(Set(id))
      else s)
  // The intent text names one app, or two different apps, by display name.
  pure def validRequest(p: int, ids: List[int]): bool =
    p != Intent or and {
      ids.indices().forall(i => ids[i] == SlackId or ids[i] == InstagramId),
      ids.indices().map(i => ids[i]).size() == ids.length(),
    }

  action init = all {
    path' = NoPath,
    requested' = NoRequest,
    handled' = false,
    stored' = Nothing,
    started' = false,
  }
  // The owner asks to block one or two apps on one of the three paths.
  action request = {
    nondet p = Set(Explicit, Intent, Planner).oneOf()
    nondet n = 1.to(MaxIds).oneOf()
    nondet a = 0.to(5).oneOf()
    nondet b = 0.to(5).oneOf()
    val ids = if (n == 1) [a] else [a, b]
    all {
      path == NoPath,
      validRequest(p, ids),
      path' = p,
      requested' = ids,
      handled' = false,
      stored' = Nothing,
      started' = false,
    }
  }
  // The handler resolves the ids and starts the native block when an id is
  // left. A planning-model answer that names no installed app starts nothing.
  action handle = {
    val ids = sentIds(path, requested)
    all {
      path != NoPath,
      not(handled),
      path' = path,
      requested' = requested,
      handled' = true,
      stored' = ids,
      started' = (ids != Nothing),
    }
  }
  // The handler has not run yet.
  action stutter = all {
    path' = path,
    requested' = requested,
    handled' = handled,
    stored' = stored,
    started' = started,
  }
  action step = any { request, handle, stutter }

  val ModelState = {
    path: path,
    requested: requested,
    handled: handled,
    stored: stored,
    started: started,
  }
  val Settled = path == NoPath or handled
  temporal SettlesWithoutFairness = not(Settled).leadsTo(Settled)
  temporal Settles = handle.weakFair(ModelState)
    .implies(SettlesWithoutFairness)

  // Every installed app that the request selects is blocked on the device,
  // and no other installed app is.
  val SelectedAppsBlocked =
    not(handled) or blockedApps(stored) == selectedApps(requested)
  // A stored id that names an installed app has the case of that app, so the
  // app count in the reply is what the device blocks.
  val StoredIdsUseInstalledCase =
    stored.forall(id => appOf(id) == NoApp or id == installedId(appOf(id)))
  // The planning model's answer cannot add an app that is not installed.
  val PlannerIdsInstalled =
    path != Planner or stored.forall(id => appOf(id) != NoApp)
  // An explicit id that names no installed app is still passed on as given.
  val ExplicitUnknownIdKept = and {
    handled or stored == Nothing,
    not(handled) or path != Explicit or (
      carries(requested, MissingId) == stored.contains(MissingId)),
  }
  // The block starts unless no id is left to send.
  val StartsWhenAnIdIsLeft = and {
    handled or not(started),
    not(handled) or started == (stored != Nothing),
    not(handled) or stored != Nothing or (
      path == Planner and selectedApps(requested) == Nothing),
  }
  val TypeOK = and {
    path.in(0.to(3)),
    requested.length() <= MaxIds,
    requested.indices().forall(i => requested[i].in(0.to(5))),
    path == NoPath or requested.length() >= 1,
    stored.subseteq(0.to(5)),
    validRequest(path, requested),
  }
}
