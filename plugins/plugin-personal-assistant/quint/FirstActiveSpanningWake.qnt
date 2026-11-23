// The schedule inspection (inspectLifeOpsSchedule in
// plugins/plugin-personal-assistant/src/lifeops/schedule-insight.ts) reads the
// stored screen-time sessions, merges them into activity windows
// (mergeActivityWindows: sorted, and a window that starts within 5 minutes of
// the previous window's end extends it) and takes the wake from the sleep
// cycle. firstActiveAfterWake then reports the first active moment after the
// wake: the wake itself while a merged window spans it, otherwise the start of
// the first window that begins at or after the wake, and none when no window
// reaches past the wake.
// Times are minutes after 06:00 UTC. An Oura reading puts the wake at 07:00
// (minute 60). The evening before left one window, 18:00 to 22:30. The owner
// then records up to three phone sessions in time order and the schedule is
// inspected after each one. The first session starts at 06:40 or 07:00 and
// lasts 20 or 40 minutes; each later session starts 5 or 60 minutes after the
// previous one ended and lasts 30 minutes.
module FirstActiveSpanningWake {
  pure val Wake = 60
  pure val MergeGap = 5
  pure val LaterLength = 30
  pure val MaxSessions = 3
  pure val NoTime = -1
  pure val EveningStart = -720
  pure val EveningEnd = -450

  type Window = { start: int, end: int }

  // The merged activity windows of the stored sessions.
  var windows: Set[Window]
  // The newest stored session.
  var lastStart: int
  var lastEnd: int
  // A session was stored and the schedule has not been inspected since.
  var pending: bool
  // The first active moment the newest inspection reported.
  var shown: int
  // The first active moment the first inspection that reported one gave.
  var firstShown: int
  // Sessions stored so far.
  var recorded: int

  pure def spansWake(ws: Set[Window]): bool =
    ws.exists(w => w.start < Wake and w.end > Wake)
  pure def firstActive(ws: Set[Window]): int =
    if (spansWake(ws)) Wake
    else ws.fold(NoTime, (m, w) =>
      if (w.start >= Wake and (m == NoTime or w.start < m)) w.start else m)
  pure def later(a: int, b: int): int = if (a > b) a else b

  action init = all {
    windows' = Set({ start: EveningStart, end: EveningEnd }),
    lastStart' = EveningStart,
    lastEnd' = EveningEnd,
    pending' = false,
    shown' = NoTime,
    firstShown' = NoTime,
    recorded' = 0,
  }
  // The phone stores a finished session (recordScreenTimeEvent). The merge
  // either extends the newest window or adds the session as a new window.
  action record = {
    nondet firstStart = Set(40, 60).oneOf()
    nondet firstLength = Set(20, 40).oneOf()
    nondet gap = Set(MergeGap, 60).oneOf()
    val s = if (recorded == 0) firstStart else lastEnd + gap
    val e = if (recorded == 0) firstStart + firstLength else s + LaterLength
    val merged =
      if (s <= lastEnd + MergeGap)
        windows.map(w => if (w.end == lastEnd) { start: w.start, end: e } else w)
      else windows.union(Set({ start: s, end: e }))
    all {
      not(pending),
      recorded < MaxSessions,
      windows' = merged,
      lastStart' = s,
      lastEnd' = e,
      pending' = true,
      shown' = shown,
      firstShown' = firstShown,
      recorded' = recorded + 1,
    }
  }
  // The schedule is inspected 10 minutes after the newest session ended.
  action inspect = {
    val found = firstActive(windows)
    all {
      pending,
      windows' = windows,
      lastStart' = lastStart,
      lastEnd' = lastEnd,
      pending' = false,
      shown' = found,
      firstShown' = if (firstShown == NoTime) found else firstShown,
      recorded' = recorded,
    }
  }
  // The inspection has not run yet.
  action stutter = all {
    windows' = windows,
    lastStart' = lastStart,
    lastEnd' = lastEnd,
    pending' = pending,
    shown' = shown,
    firstShown' = firstShown,
    recorded' = recorded,
  }
  action step = any { record, inspect, stutter }

  val ModelState = {
    windows: windows,
    lastStart: lastStart,
    lastEnd: lastEnd,
    pending: pending,
    shown: shown,
    firstShown: firstShown,
    recorded: recorded,
  }
  val Inspected = recorded > 0 and not(pending)
  val Settled = not(pending)
  temporal SettlesWithoutFairness = not(Settled).leadsTo(Settled)
  temporal Settles = inspect.weakFair(ModelState)
    .implies(SettlesWithoutFairness)

  // The reported moment is never before the wake.
  val ShownNotBeforeWake =
    not(Inspected) or shown == NoTime or shown >= Wake
  // The owner was active at the reported moment.
  val ShownWhileActive =
    not(Inspected) or shown == NoTime or
      windows.exists(w => w.start <= shown and shown < w.end)
  // No window has an active moment after the wake that is earlier than the
  // reported one.
  val NoEarlierActiveMoment =
    not(Inspected) or shown == NoTime or
      windows.forall(w => w.end <= Wake or later(w.start, Wake) >= shown)
  // A moment is reported exactly when some window reaches past the wake.
  val ShownWheneverActiveAfterWake =
    not(Inspected) or
      (shown == NoTime) == windows.forall(w => w.end <= Wake)
  // Later sessions never move the first active moment once one is reported.
  val StaysOnceShown =
    not(Inspected) or firstShown == NoTime or shown == firstShown
  val TypeOK = and {
    recorded.in(0.to(MaxSessions)),
    windows.size() >= 1,
    windows.size() <= recorded + 1,
    windows.forall(w => w.start < w.end),
    lastStart < lastEnd,
    windows.exists(w => w.end == lastEnd),
    recorded > 0 or not(pending),
    shown == NoTime or shown.in(Wake.to(lastEnd)),
  }
}
