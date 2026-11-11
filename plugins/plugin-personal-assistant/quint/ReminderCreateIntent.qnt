// Fresh reminder creation must verify the original request before writing.
// The classifier's semantic accuracy and existing owner permissions are external.
module ReminderCreateIntent {
  var s: { phase: str, requested: bool, proposed: bool, checked: bool, writes: int }
  action init = {
    nondet requested = Bool.oneOf()
    nondet proposed = Bool.oneOf()
    s' = { phase: "pending", requested: requested, proposed: proposed, checked: false, writes: 0 }
  }
  action check = all { s.phase == "pending",
    s' = s.with("checked", true).with("phase", if (s.requested) "ready" else "rejected") }
  action unavailable = all { s.phase == "pending", s' = s.with("phase", "rejected") }
  action cancel = all { s.phase == "pending" or s.phase == "ready", s' = s.with("phase", "cancelled") }
  action create = all { s.phase == "ready", s.checked, s.requested,
    s' = s.with("phase", "saved").with("writes", 1) }
  action step = any { check, unavailable, cancel, create, s' = s }
  val VerifiedBeforeWrite = s.writes > 0 implies s.checked and s.requested
  val NoDuplicateWrite = s.writes <= 1
  val RefusalHasNoEffect = Set("rejected", "cancelled").contains(s.phase) implies s.writes == 0
  val Settled = Set("saved", "rejected", "cancelled").contains(s.phase)
  temporal FairSettles = (weakFair(check, step) and weakFair(create, step)) implies eventually(Settled)
}
