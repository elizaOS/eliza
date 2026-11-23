// runAppBlockHandler (plugins/plugin-personal-assistant/src/actions/app-block.ts)
// decides how long a BLOCK target=app request blocks Android apps and passes
// that durationMinutes to the native ElizaAppBlocker plugin. The Android
// plugin (plugins/plugin-native-appblocker/android/.../AppBlockerPlugin.kt,
// parseDurationMinutes) cuts the number to whole minutes and keeps the block
// with no end time when the value is missing or below one minute.
// path: 1 packageNames supplied by the action planner, 2 the app named by
// display name in the intent text, 3 packageNames answered by the app-block
// planning model.
// param: the action planner's durationMinutes: 0 omitted, 1 is 45, 2 is 0.4.
// phrase: what the message says about the length, read by
// extractHeuristicDurationMinutes (src/actions/website-block.ts):
// 0 nothing, 1 "for 2 hours", 2 "for 90 minutes", 3 "for 1.5 hours",
// 4 "until I unblock it".
// plan: the planning model's durationMinutes: 0 omitted, 1 is 60, 2 is 0.4.
// Only path 3 asks the planning model.
// minutes: the block length that the device keeps; 0 means no end time.
module AppBlockStatedDuration {
  pure val NoPath = 0
  pure val Explicit = 1
  pure val Intent = 2
  pure val Planner = 3
  pure val NoValue = 0
  pure val Whole = 1
  pure val SubMinute = 2
  pure val NoPhrase = 0
  pure val UntilUnblocked = 4
  pure val NoEnd = 0

  var path: int
  var param: int
  var phrase: int
  var plan: int
  var handled: bool
  var minutes: int

  // A positive value below one minute is sent as one minute.
  pure def paramMinutes(v: int): int =
    if (v == Whole) 45 else if (v == SubMinute) 1 else NoEnd
  pure def planMinutes(v: int): int =
    if (v == Whole) 60 else if (v == SubMinute) 1 else NoEnd
  pure def phraseMinutes(f: int): int =
    if (f == 1) 120 else if (f == 2) 90 else if (f == 3) 90 else NoEnd
  // The planner's durationMinutes wins. Otherwise a length written in the
  // message is used, on every path. Only then does the planning model's
  // answer count, and only path 3 asks it.
  pure def deviceMinutes(p: int, d: int, f: int, l: int): int =
    if (d != NoValue) paramMinutes(d)
    else if (f != NoPhrase) phraseMinutes(f)
    else if (p == Planner) planMinutes(l)
    else NoEnd
  // The request asks for a block that ends.
  pure def asksForEnd(p: int, d: int, f: int, l: int): bool =
    if (d != NoValue) true
    else if (f != NoPhrase) f != UntilUnblocked
    else p == Planner and l != NoValue
  // The planning model is asked only on path 3.
  pure def validRequest(p: int, l: int): bool = p == Planner or l == NoValue

  action init = all {
    path' = NoPath,
    param' = NoValue,
    phrase' = NoPhrase,
    plan' = NoValue,
    handled' = false,
    minutes' = NoEnd,
  }
  // The owner asks to block Instagram on one of the three paths.
  action request = {
    nondet p = Set(Explicit, Intent, Planner).oneOf()
    nondet d = 0.to(2).oneOf()
    nondet f = 0.to(4).oneOf()
    nondet l = 0.to(2).oneOf()
    all {
      path == NoPath,
      validRequest(p, l),
      path' = p,
      param' = d,
      phrase' = f,
      plan' = l,
      handled' = false,
      minutes' = NoEnd,
    }
  }
  // The handler starts the native block with the chosen length.
  action handle = all {
    path != NoPath,
    not(handled),
    path' = path,
    param' = param,
    phrase' = phrase,
    plan' = plan,
    handled' = true,
    minutes' = deviceMinutes(path, param, phrase, plan),
  }
  // The handler has not run yet.
  action stutter = all {
    path' = path,
    param' = param,
    phrase' = phrase,
    plan' = plan,
    handled' = handled,
    minutes' = minutes,
  }
  action step = any { request, handle, stutter }

  val ModelState = {
    path: path,
    param: param,
    phrase: phrase,
    plan: plan,
    handled: handled,
    minutes: minutes,
  }
  val Settled = path == NoPath or handled
  temporal SettlesWithoutFairness = not(Settled).leadsTo(Settled)
  temporal Settles = handle.weakFair(ModelState)
    .implies(SettlesWithoutFairness)

  // A length written in the message is kept when the planner sent none,
  // whichever path selected the app.
  val StatedLengthKept =
    not(handled) or param != NoValue or phrase == NoPhrase or
      minutes == phraseMinutes(phrase)
  // The planner's durationMinutes wins over the message and the planning
  // model.
  val PlannerDurationWins =
    not(handled) or param == NoValue or minutes == paramMinutes(param)
  // A request for a block that ends never becomes a block with no end.
  val TimedRequestEnds =
    not(handled) or asksForEnd(path, param, phrase, plan) == (minutes > 0)
  // When the planner and the message give no length, the planning model's
  // answer is used on path 3, and the other paths block with no end time.
  val SilentRequestUsesPlan =
    not(handled) or param != NoValue or phrase != NoPhrase or
      minutes == (if (path == Planner) planMinutes(plan) else NoEnd)
  val TypeOK = and {
    path.in(0.to(3)),
    param.in(0.to(2)),
    phrase.in(0.to(4)),
    plan.in(0.to(2)),
    validRequest(path, plan),
    handled or minutes == NoEnd,
    minutes.in(Set(NoEnd, 1, 45, 60, 90, 120)),
  }
}
