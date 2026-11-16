// The schedule inspection (inspectLifeOpsSchedule in
// plugins/plugin-personal-assistant/src/lifeops/schedule-insight.ts) scores
// the stored activity signals, newest first, with scoreCircadianRules
// (plugins/plugin-health/src/sleep/circadian-rules.ts). Two of its rules
// describe the current state of one source:
//   - hid.idleGt20m: the Mac's HID input has been idle for at least 20
//     minutes. The macOS activity collector reports the idle time every 30
//     seconds, and ActivityTrackerService stores each sample as a
//     desktop_interaction signal.
//   - continuity.iphoneDisconnected (overnight only): the paired iPhone is
//     away. probeContinuityDevices stores each connection change as a
//     mobile_device signal, "active" when connected and "background" when
//     not.
// Each rule reads the newest report of its source, so an older idle sample or
// disconnect no longer counts once a newer report shows input or a reconnect.
// One agent at 23:45 in America/Los_Angeles. One source per case: up to two
// HID samples (idle 5, 1199 or 1200 seconds, taken 600 and 30 seconds before
// the inspection) or up to two iPhone reports (connected or disconnected, 40
// and 15 minutes before the inspection).
module CircadianNewestSample {
  pure val IdleLimit = 1200
  // A HID report is its idle seconds, or NoSample.
  pure val NoSample = -1
  // An iPhone report.
  pure val Absent = 0
  pure val Connected = 1
  pure val Disconnected = 2
  // Phases of the replay.
  pure val Start = 0
  pure val OlderStored = 1
  pure val NewerStored = 2
  pure val Inspected = 3

  // The case replays HID samples (otherwise iPhone reports), and the older
  // and newer report of that source.
  var hid: bool
  var older: int
  var newer: int
  var phase: int
  // The source's rule fired at the inspection.
  var fired: bool
  var reads: int

  // The newest report of the source, or `none` without one.
  pure def newest(olderReport: int, newerReport: int, none: int): int =
    if (newerReport != none) newerReport else olderReport
  pure def newestIdle(olderReport: int, newerReport: int): int =
    newest(olderReport, newerReport, NoSample)
  pure def newestPhone(olderReport: int, newerReport: int): int =
    newest(olderReport, newerReport, Absent)
  // The rule of the source fires on its newest report.
  pure def fires(isHid: bool, olderReport: int, newerReport: int): bool =
    if (isHid) newestIdle(olderReport, newerReport) >= IdleLimit
    else newestPhone(olderReport, newerReport) == Disconnected

  action init = {
    nondet isHid = Set(true, false).oneOf()
    nondet hidOlder = Set(NoSample, 5, 1199, 1200).oneOf()
    nondet hidNewer = Set(NoSample, 5, 1199, 1200).oneOf()
    nondet phoneOlder = Set(Absent, Connected, Disconnected).oneOf()
    nondet phoneNewer = Set(Absent, Connected, Disconnected).oneOf()
    all {
      hid' = isHid,
      older' = if (isHid) hidOlder else phoneOlder,
      newer' = if (isHid) hidNewer else phoneNewer,
      phase' = Start,
      fired' = false,
      reads' = 0,
    }
  }
  // The next replay step runs: the older report is stored (nothing is stored
  // without one), then the newer report, then the schedule is inspected.
  action advance = all {
    phase != Inspected,
    hid' = hid,
    older' = older,
    newer' = newer,
    phase' = phase + 1,
    fired' =
      if (phase == NewerStored) fires(hid, older, newer)
      else fired,
    reads' = if (phase == NewerStored) reads + 1 else reads,
  }
  // The next step has not run yet.
  action stutter = all {
    hid' = hid,
    older' = older,
    newer' = newer,
    phase' = phase,
    fired' = fired,
    reads' = reads,
  }
  action step = any { advance, stutter }

  val ModelState = {
    hid: hid,
    older: older,
    newer: newer,
    phase: phase,
    fired: fired,
    reads: reads,
  }
  val Finished = phase == Inspected
  temporal ReplayEndsWithoutFairness = eventually(Finished)
  temporal ReplayEnds = advance.weakFair(ModelState)
    .implies(ReplayEndsWithoutFairness)

  // The idle rule fires when the newest HID sample shows 20 minutes idle.
  val NewestIdleSampleFires =
    phase != Inspected or not(hid) or newestIdle(older, newer) < IdleLimit or
      fired
  // A newest HID sample with input in the last 20 minutes ends the idle rule,
  // whatever an older sample reported.
  val RecentInputEndsIdle =
    phase != Inspected or not(hid) or newestIdle(older, newer) >= IdleLimit or
      not(fired)
  // The disconnect rule fires when the newest iPhone report is a disconnect.
  val NewestDisconnectFires =
    phase != Inspected or hid or newestPhone(older, newer) != Disconnected or
      fired
  // A reconnect, or no report at all, ends the disconnect rule.
  val ReconnectEndsDisconnect =
    phase != Inspected or hid or newestPhone(older, newer) == Disconnected or
      not(fired)
  val TypeOK = and {
    if (hid) Set(NoSample, 5, 1199, 1200).contains(older)
    else Set(Absent, Connected, Disconnected).contains(older),
    if (hid) Set(NoSample, 5, 1199, 1200).contains(newer)
    else Set(Absent, Connected, Disconnected).contains(newer),
    phase.in(Start.to(Inspected)),
    reads.in(0.to(1)),
    (phase == Inspected) == (reads == 1),
    phase == Inspected or not(fired),
  }
}
