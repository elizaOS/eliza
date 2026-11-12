// Fresh reminder creation must verify the original request before writing.
// The classifier's semantic accuracy and existing owner permissions are external.
module ReminderCreateIntent {
  // Delivery choices use -1 for unknown and 0/1 for resolved alternatives.
  var s: { phase: str, requested: bool, proposed: bool, checked: bool, writes: int,
    plannedClock: int, extractedClock: int, savedClock: int,
    plannedDestination: int, extractedDestination: int, savedDestination: int,
    plannedAlert: int, extractedAlert: int, savedAlert: int }
  pure def recover(planned: int, extracted: int): int = if (planned >= 0) planned else extracted
  val resolvedDestination = recover(s.plannedDestination, s.extractedDestination)
  val resolvedAlert = recover(s.plannedAlert, s.extractedAlert)
  action init = {
    nondet requested = Bool.oneOf()
    nondet proposed = Bool.oneOf()
    nondet plannedClock = Set(0, 1).oneOf()
    nondet extractedClock = Set(0, 1).oneOf()
    nondet plannedDestination = Set(-1, 0, 1).oneOf()
    nondet extractedDestination = Set(-1, 0, 1).oneOf()
    nondet plannedAlert = Set(-1, 0, 1).oneOf()
    nondet extractedAlert = Set(-1, 0, 1).oneOf()
    s' = { phase: "pending", requested: requested, proposed: proposed, checked: false, writes: 0,
      plannedClock: plannedClock, extractedClock: extractedClock, savedClock: -1,
      plannedDestination: plannedDestination, extractedDestination: extractedDestination, savedDestination: -1,
      plannedAlert: plannedAlert, extractedAlert: extractedAlert, savedAlert: -1 }
  }
  action check = all { s.phase == "pending",
    s' = s.with("checked", true).with("phase", if (s.requested) "ready" else "rejected") }
  action unavailable = all { s.phase == "pending", s' = s.with("phase", "rejected") }
  action cancel = all { s.phase == "pending" or s.phase == "ready", s' = s.with("phase", "cancelled") }
  action create = all { s.phase == "ready", s.checked, s.requested,
    s' = s.with("phase", "saved").with("writes", 1).with("savedClock", s.plannedClock)
      .with("savedDestination", resolvedDestination).with("savedAlert", resolvedAlert) }
  action step = any { check, unavailable, cancel, create, s' = s }
  val VerifiedBeforeWrite = s.writes > 0 implies s.checked and s.requested
  val VerifiedPlanClockRetained = s.writes > 0 implies s.savedClock == s.plannedClock
  val VerifiedDeliveryChoicesRetained = s.writes > 0 implies
    s.savedDestination == resolvedDestination and s.savedAlert == resolvedAlert
  val NoDuplicateWrite = s.writes <= 1
  val RefusalHasNoEffect = Set("rejected", "cancelled").contains(s.phase) implies s.writes == 0
  val Settled = Set("saved", "rejected", "cancelled").contains(s.phase)
  temporal FairSettles = (check.weakFair(s) and create.weakFair(s)) implies eventually(Settled)
}
