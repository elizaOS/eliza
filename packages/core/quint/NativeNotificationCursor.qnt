// Each request reads one fixed append fence. Sequence numbers can be reused
// after inbox replacement, so the cursor also owns its original epoch.
module NativeNotificationCursor {
  type Cursor = { epoch: int, after: int, through: int }
  type Page = { query: Cursor, status: str, returned: Set[int], complete: bool }
  type State = {
    rows: Set[int], sequence: int, epoch: int, blocked: int,
    cursor: Cursor, prior: Cursor, page: Page
  }
  pure val emptyCursor = { epoch: -1, after: 0, through: 0 }
  var s: State

  action init = s' = {
    rows: Set(), sequence: 0, epoch: 0, blocked: 0,
    cursor: emptyCursor, prior: emptyCursor,
    page: { query: emptyCursor, status: "none", returned: Set(), complete: false }
  }

  action appendNotice = all {
    s.sequence < 3,
    s' = { ...s, rows: s.rows.union(Set(s.sequence + 1)), sequence: s.sequence + 1 },
  }
  action remove(id: int): bool = all {
    s.rows.contains(id),
    s' = { ...s, rows: s.rows.exclude(Set(id)), blocked: if (s.blocked == id) 0 else s.blocked },
  }
  action block(id: int): bool = all {
    id == 0 or s.rows.contains(id),
    s' = { ...s, blocked: id },
  }
  action replaceInbox = all {
    s.epoch == 0,
    s' = { ...s, rows: Set(), sequence: 0, epoch: 1, blocked: 0, prior: s.cursor },
  }

  action read(q: Cursor): bool = {
    val eligible = s.rows.filter(id => q.after < id and id <= q.through)
    val first = eligible.fold(4, (smallest, id) => if (id < smallest) id else smallest)
    val status = if (q.epoch != s.epoch) "epoch-changed"
      else if (q.after > q.through or q.through > s.sequence) "invalid"
      else if (first == s.blocked) "projection-error"
      else "ok"
    val complete = status == "ok" and eligible.size() <= 1
    val nextAfter = if (complete) q.through else first
    s' = { ...s,
      cursor: if (status == "ok") { ...q, after: nextAfter } else s.cursor,
      page: { query: q, status: status, complete: complete,
        returned: if (status == "ok" and eligible != Set()) Set(first) else Set() },
    }
  }

  // An explicit fresh request captures its fence and reads its first page
  // together. The modeled client finishes or abandons its one current scan.
  action begin = all {
    s.cursor.epoch != s.epoch or s.cursor.after == s.cursor.through,
    read({ epoch: s.epoch, after: 0, through: s.sequence }),
  }
  action nextPage = all { s.cursor.epoch >= 0, read(s.cursor) }
  action replayOld = all { s.prior.epoch == 0 and s.epoch == 1, read(s.prior) }
  action invalidCurrent = read({
    epoch: s.epoch, after: s.sequence + 1, through: s.sequence + 1
  })
  action step = {
    nondet id = 0.to(3).oneOf()
    any {
      appendNotice, remove(id), block(id), replaceInbox, begin, nextPage,
      replayOld, invalidCurrent, s' = s
    }
  }

  val SequenceBounds = s.sequence >= 0 and s.sequence <= 3 and
    s.rows.forall(id => id > 0 and id <= s.sequence)
  val BlockBelongsToRetainedRow = s.blocked == 0 or s.rows.contains(s.blocked)
  val ReturnedRowsWithinFence = (s.page.status == "ok").implies(
    s.page.returned.forall(id => id > s.page.query.after and id <= s.page.query.through))
  val IncompleteAlwaysAdvances = (s.page.status == "ok" and not(s.page.complete)).implies(
    s.cursor.after > s.page.query.after and s.cursor.after <= s.page.query.through)
  val CompleteConsumesFence = (s.page.status == "ok" and s.page.complete).implies(
    s.cursor.after == s.page.query.through)
  pure val errors = Set("epoch-changed", "invalid", "projection-error")
  val RejectedPagesReturnNothing = errors.contains(s.page.status).implies(
    s.page.returned == Set() and not(s.page.complete))
  temporal FailedPagesKeepCursor = always((
    errors.contains(next(s.page.status)).implies(next(s.cursor) == s.cursor)
  ).orKeep(s))
  temporal RejectsStaleEpoch = always((
    (next(s.page) != s.page and next(s.page.query.epoch) != s.epoch)
      .implies(next(s.page.status) == "epoch-changed")
  ).orKeep(s))

  temporal PagesFinish = (nextPage.weakFair(s) and eventually(always(s.blocked == 0))).implies(
    (s.cursor.epoch == s.epoch and s.cursor.after < s.cursor.through).leadsTo(
      s.cursor.after == s.cursor.through or s.cursor.epoch != s.epoch))
  temporal EpochRecovery = (s.prior.epoch == 0 and s.cursor.epoch != s.epoch).leadsTo(
    s.cursor.epoch == s.epoch and s.cursor.after == s.cursor.through)
  temporal FairEpochRecovery =
    (begin.weakFair(s) and nextPage.weakFair(s) and eventually(always(s.blocked == 0)))
      .implies(EpochRecovery)

  run appendsDoNotExtendCapturedFenceTest = init.then(appendNotice).then(appendNotice).then(begin)
    .expect(s.page.returned == Set(1) and not(s.page.complete))
    .then(appendNotice).then(remove(2)).then(nextPage)
    .expect(s.page.complete and s.cursor.after == 2 and s.page.returned == Set())
  run badHeadCannotBeSkippedTest = init.then(appendNotice).then(appendNotice).then(block(1))
    .then(begin).expect(s.page.status == "projection-error" and s.cursor == emptyCursor)
    .then(remove(1)).then(begin)
    .expect(s.page.complete and s.page.returned == Set(2))
  run replacedInboxRejectsOldEpochTest = init.then(appendNotice).then(appendNotice)
    .then(begin).then(block(1)).then(replaceInbox).then(appendNotice)
    .then(nextPage).expect(s.page.status == "epoch-changed" and s.page.returned == Set())
    .then(invalidCurrent).expect(s.page.status == "invalid")
    .then(begin).expect(s.cursor.epoch == 1 and s.page.returned == Set(1))
    .then(replayOld).expect(s.page.status == "epoch-changed" and s.cursor.epoch == 1)
}
