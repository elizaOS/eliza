// The schedule inspection (inspectLifeOpsSchedule in
// plugins/plugin-personal-assistant/src/lifeops/schedule-insight.ts) resolves
// the sleep cycle and the day boundary (resolveLifeOpsSleepCycle and
// resolveLifeOpsDayBoundary in plugins/plugin-health/src/sleep/sleep-cycle.ts)
// and stores the insight under its effective day key.
// classifyLifeOpsSleepCycleType calls a sleep overnight once it lasts four
// hours and starts between 18:00 and 06:00 (or ends by 11:00), a nap while it
// is shorter, and unknown otherwise; a sleep in progress is measured up to now.
// The last completed sleep is the latest one that is overnight or at least
// four hours and not a nap; a nap counts only when no such sleep exists.
// The day boundary keeps the day open when the sleep cycle is overnight or a
// sleep in progress started in the overnight window: the day of the last
// completed sleep's wake, else the day the current sleep started. Otherwise
// the effective day is today.
// Times are minutes after 12:00 UTC on 2026-11-15; day 0 is 2026-11-15 and
// day 1 is 2026-11-16. An Oura reading of the night before (23:00 to 07:00,
// so the wake is minute -300) may be stored. Tonight's sleep starts at 14:00,
// 21:00, 23:00, 00:30 or 02:00 and lasts 2 or 8 hours; the ring reports it in
// progress while it lasts and finished after the wake. The schedule is
// inspected 30 minutes before the sleep, every hour from 30 minutes after it
// starts while it lasts, and 25 minutes after the wake.
module OpenNightDayKey {
  pure val PriorWake = -300
  pure val NapLimit = 240
  pure val NoDay = -1
  pure val NoTime = -1000
  // Phases of the latest inspection.
  pure val Start = 0
  pure val Before = 1
  pure val Asleep = 2
  pure val Woken = 3
  // Sleep cycle types.
  pure val Overnight = 0
  pure val Nap = 1
  pure val Unknown = 2

  // The earlier overnight sleep is stored.
  var prior: bool
  // Tonight's sleep: start and duration in minutes.
  var onset: int
  var duration: int
  // The latest inspection: its time, its phase and the day key it showed.
  var at: int
  var phase: int
  var shown: int
  // The day key the inspection before it showed.
  var previous: int
  // The day key shown before the sleep started.
  var onsetDay: int
  var reads: int

  pure def dayOf(m: int): int = (m + 720) / 1440
  pure def hourOf(m: int): int = ((m + 720) % 1440) / 60
  pure def overnightWindow(start: int): bool =
    hourOf(start) >= 18 or hourOf(start) < 6
  pure def classify(start: int, end: int): int =
    if (end - start >= NapLimit and (overnightWindow(start) or hourOf(end) <= 11))
      Overnight
    else if (end - start > 0 and end - start < NapLimit) Nap
    else Unknown

  // The day the last completed sleep opened after tonight's wake, or NoDay
  // when that sleep is not overnight.
  pure def dayAfterWake(hasPrior: bool, s: int, len: int): int = {
    val tonight = classify(s, s + len)
    val anchors = tonight == Overnight or (tonight != Nap and len >= NapLimit)
    val counted = anchors or not(hasPrior)
    val lastType = if (counted) tonight else Overnight
    val lastEnd = if (counted) s + len else PriorWake
    if (lastType == Overnight) dayOf(lastEnd) else NoDay
  }
  // The day kept open by the earlier night, else by the sleep's start.
  pure def openDay(hasPrior: bool, s: int): int =
    if (hasPrior) dayOf(PriorWake) else dayOf(s)
  // The effective day key the inspection shows at minute t in phase p.
  pure def dayKey(hasPrior: bool, s: int, len: int, t: int, p: int): int =
    if (p == Before) {
      // No sleep in progress: the sleep cycle is the earlier night's.
      if (hasPrior) dayOf(PriorWake) else dayOf(t)
    } else if (p == Asleep) {
      if (classify(s, t) == Overnight or overnightWindow(s)) openDay(hasPrior, s)
      else dayOf(t)
    } else {
      // After the wake the sleep cycle is the last completed sleep's.
      if (dayAfterWake(hasPrior, s, len) == NoDay) dayOf(t)
      else dayAfterWake(hasPrior, s, len)
    }

  action init = {
    nondet hasPrior = Set(true, false).oneOf()
    nondet s = Set(120, 540, 660, 750, 840).oneOf()
    nondet len = Set(120, 480).oneOf()
    all {
      prior' = hasPrior,
      onset' = s,
      duration' = len,
      at' = NoTime,
      phase' = Start,
      shown' = NoDay,
      previous' = NoDay,
      onsetDay' = NoDay,
      reads' = 0,
    }
  }
  // The next scheduled inspection runs (inspectSchedule). Before it, the ring
  // reports the sleep in progress (asleep) or finished (after the wake).
  action inspect = {
    val nextPhase =
      if (phase == Start) Before
      else if (phase == Before) Asleep
      else if (at + 60 < onset + duration) Asleep
      else Woken
    val nextAt =
      if (phase == Start) onset - 30
      else if (phase == Before) onset + 30
      else if (at + 60 < onset + duration) at + 60
      else onset + duration + 25
    val day = dayKey(prior, onset, duration, nextAt, nextPhase)
    all {
      phase != Woken,
      prior' = prior,
      onset' = onset,
      duration' = duration,
      at' = nextAt,
      phase' = nextPhase,
      shown' = day,
      previous' = shown,
      onsetDay' = if (nextPhase == Before) day else onsetDay,
      reads' = reads + 1,
    }
  }
  // The next inspection has not run yet.
  action stutter = all {
    prior' = prior,
    onset' = onset,
    duration' = duration,
    at' = at,
    phase' = phase,
    shown' = shown,
    previous' = previous,
    onsetDay' = onsetDay,
    reads' = reads,
  }
  action step = any { inspect, stutter }

  val ModelState = {
    prior: prior,
    onset: onset,
    duration: duration,
    at: at,
    phase: phase,
    shown: shown,
    previous: previous,
    onsetDay: onsetDay,
    reads: reads,
  }
  val Finished = phase == Woken
  temporal NightEndsWithoutFairness = eventually(Finished)
  temporal NightEnds = inspect.weakFair(ModelState)
    .implies(NightEndsWithoutFairness)

  // The day key never goes back to an earlier day.
  val NeverMovesBack = previous == NoDay or shown >= previous
  // While the owner sleeps, the day key is the one shown before the sleep.
  val HeldWhileAsleep = phase != Asleep or shown == onsetDay
  // The wake from an overnight sleep opens the wake's day.
  val WakeOpensDay =
    phase != Woken or classify(onset, onset + duration) != Overnight or
      shown == dayOf(onset + duration)
  // A nap after a stored overnight sleep leaves the day where it was.
  val NapKeepsDay =
    phase != Woken or not(prior) or duration >= NapLimit or shown == onsetDay
  val TypeOK = and {
    Set(120, 540, 660, 750, 840).contains(onset),
    Set(120, 480).contains(duration),
    phase.in(Start.to(Woken)),
    reads.in(0.to(10)),
    (phase == Start) == (reads == 0),
    phase == Start or shown.in(0.to(1)),
    reads < 2 or previous.in(0.to(1)),
    phase == Start or onsetDay.in(0.to(1)),
    phase != Asleep or (at > onset and at < onset + duration),
    phase != Woken or at == onset + duration + 25,
  }
}
