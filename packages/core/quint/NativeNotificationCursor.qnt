// The native page endpoint fixes an append fence while retained rows can be
// deleted, superseded or expired. An unprojectable row fails the page.
module NativeNotificationCursor {
  pure val ids = Set(1, 2, 3)
  var s: { rows: Set[int], sequence: int, fence: int, after: int, epoch: int,
    queryEpoch: int, started: bool, returned: Set[int], next: int, complete: bool,
    status: str, previousAfter: int, blocked: int }
  action init = s' = { rows: Set(), sequence: 0, fence: 0, after: 0, epoch: 0,
    queryEpoch: 0, started: false, returned: Set(), next: 0, complete: true,
    status: "none", previousAfter: 0, blocked: 0 }
  action appendNotice = all {
    s.sequence < 3,
    s' = { ...s, rows: s.rows.union(Set(s.sequence + 1)), sequence: s.sequence + 1 },
  }
  action remove(id: int): bool = s' = { ...s, rows: s.rows.exclude(Set(id)) }
  action begin = all {
    not(s.started),
    s' = { ...s, fence: s.sequence, queryEpoch: s.epoch, started: true, status: "none" },
  }
  action restartEpoch = all {
    s.epoch == 0,
    s' = { ...s, rows: Set(), sequence: 0, epoch: 1 },
  }
  action page = all {
    s.started,
    val eligible = s.rows.filter(id => s.after < id and id <= s.fence)
    val first = eligible.fold(4, (smallest, id) => if (id < smallest) id else smallest)
    val invalid = s.queryEpoch != s.epoch or s.fence > s.sequence
    val blocked = eligible != Set() and first == s.blocked
    val success = not(invalid or blocked)
    val complete = eligible.size() <= 1
    val nextSequence = if (complete) s.fence else first
    s' = { ...s, returned: if (success and eligible != Set()) Set(first) else Set(),
      previousAfter: s.after, after: if (success) nextSequence else s.after,
      next: if (success) nextSequence else s.after, complete: complete,
      status: if (invalid) "invalid" else if (blocked) "projection-error" else "ok" },
  }
  action block(id: int): bool = s' = { ...s, blocked: id }
  action step = {
    nondet id = Set(0, 1, 2, 3).oneOf()
    any { appendNotice, remove(id), begin, restartEpoch, page, block(id), s' = s }
  }
  val SequenceBounds = s.sequence >= 0 and s.sequence <= 3 and
    s.rows.forall(id => id > 0 and id <= s.sequence)
  val ReturnedRowsWithinFence = (s.status == "ok").implies(
    s.returned.forall(id => id > s.previousAfter and id <= s.fence))
  val IncompleteAlwaysAdvances = (s.status == "ok" and not(s.complete)).implies(
    s.next > s.previousAfter and s.next <= s.fence)
  val CompleteConsumesFence = (s.status == "ok" and s.complete).implies(s.next == s.fence)
  val FailedPageDoesNotAdvance = Set("invalid", "projection-error").contains(s.status).implies(
    s.after == s.previousAfter and s.returned == Set())
  temporal PagesFinish = (page.weakFair(s) and eventually(always(s.blocked == 0))
    and always(s.queryEpoch == s.epoch)).implies(
      s.started.leadsTo(s.status == "ok" and s.complete))
  run appendsDoNotExtendCapturedFenceTest = init.then(appendNotice).then(appendNotice).then(begin)
    .then(appendNotice).then(page).expect(s.returned == Set(1) and not(s.complete))
    .then(remove(2)).then(page).expect(s.complete and s.next == 2 and s.returned == Set())
  run badHeadCannotBeSkippedTest = init.then(appendNotice).then(appendNotice).then(begin).then(block(1))
    .then(page).expect(s.status == "projection-error" and s.after == 0)
  run replacedInboxRejectsOldEpochTest = init.then(appendNotice).then(begin).then(restartEpoch)
    .then(page).expect(s.status == "invalid" and s.returned == Set())
}
