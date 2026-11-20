// The schedule inspection (inspectLifeOpsSchedule in
// plugins/plugin-personal-assistant/src/lifeops/schedule-insight.ts) scores
// the stored activity signals with computeAwakeProbability
// (plugins/plugin-health/src/sleep/awake-probability.ts). When the newest
// signal is an active app_lifecycle report that is not a manual override, it
// may come from someone else on a shared device, so its weight is cut to a
// quarter unless the owner is interacting at the same time. A signal from the
// last five minutes is that evidence when it is an active mobile device, a
// manual override, or reports at most 60 seconds of idle time.
// The macOS activity collector reports HID idle time every 30 seconds, and
// ActivityTrackerService stores each sample as a desktop_interaction signal
// with its idle seconds. Such a sample shows the owner at the Mac only when
// it reports input in the last minute.
// One agent at 03:00 in America/Los_Angeles. A HID sample is stored or not;
// it reports 5, 60, 61, 1500 or 10800 idle seconds and is taken 20, 300 or
// 360 seconds before the inspection. A client app then resumes 10 seconds
// before the inspection, so the resume is the newest signal.
module HidIdleSharedDevice {
  pure val OwnerIdleLimit = 60
  pure val ConcurrentWindow = 300
  // Phases of the replay.
  pure val Start = 0
  pure val Sampled = 1
  pure val Resumed = 2
  pure val Inspected = 3

  // A HID sample is stored, its idle seconds and its age at the inspection.
  var hasSample: bool
  var idle: int
  var age: int
  var phase: int
  // The inspection kept the shared-device discount on the resume.
  var discounted: bool
  var reads: int

  // The stored HID sample shows the owner at the Mac at the inspection.
  pure def ownerAtMac(sampled: bool, idleSeconds: int, ageSeconds: int): bool =
    sampled and idleSeconds <= OwnerIdleLimit and ageSeconds <= ConcurrentWindow

  action init = {
    nondet sampled = Set(true, false).oneOf()
    nondet idleSeconds = Set(5, 60, 61, 1500, 10800).oneOf()
    nondet ageSeconds = Set(20, 300, 360).oneOf()
    all {
      hasSample' = sampled,
      idle' = idleSeconds,
      age' = ageSeconds,
      phase' = Start,
      discounted' = false,
      reads' = 0,
    }
  }
  // The next replay step runs: the collector reports the HID sample (nothing
  // is stored without one), the client resumes, then the schedule is
  // inspected.
  action advance = all {
    phase != Inspected,
    hasSample' = hasSample,
    idle' = idle,
    age' = age,
    phase' = phase + 1,
    discounted' =
      if (phase == Resumed) not(ownerAtMac(hasSample, idle, age))
      else discounted,
    reads' = if (phase == Resumed) reads + 1 else reads,
  }
  // The next step has not run yet.
  action stutter = all {
    hasSample' = hasSample,
    idle' = idle,
    age' = age,
    phase' = phase,
    discounted' = discounted,
    reads' = reads,
  }
  action step = any { advance, stutter }

  val ModelState = {
    hasSample: hasSample,
    idle: idle,
    age: age,
    phase: phase,
    discounted: discounted,
    reads: reads,
  }
  val Finished = phase == Inspected
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = advance.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  // A HID sample that reports more than a minute of idle time never lifts
  // the discount.
  val IdleSampleKeepsDiscount =
    phase != Inspected or not(hasSample) or idle <= OwnerIdleLimit or
      discounted
  // A sample older than five minutes never lifts the discount.
  val StaleSampleKeepsDiscount =
    phase != Inspected or not(hasSample) or age <= ConcurrentWindow or
      discounted
  // Without a HID sample the resume stays discounted.
  val NoSampleKeepsDiscount = phase != Inspected or hasSample or discounted
  // Recent input at the Mac lifts the discount.
  val RecentInputLiftsDiscount =
    phase != Inspected or not(ownerAtMac(hasSample, idle, age)) or
      not(discounted)
  val TypeOK = and {
    Set(5, 60, 61, 1500, 10800).contains(idle),
    Set(20, 300, 360).contains(age),
    phase.in(Start.to(Inspected)),
    reads.in(0.to(1)),
    (phase == Inspected) == (reads == 1),
    phase == Inspected or not(discounted),
  }
}
