// One private organization/day Durable Object. Key 0 is the organization.
// Reserve, release and import commit atomically before scheduling and reply.
module VoiceUsage {
  type Row = { units: int, expires: int }
  type Usage = {
    rows: int -> Row,
    imports: int -> Row,
    serving: bool,
    now: int,
    alarmAt: int,
    phase: str,
    result: str,
    user: int,
    amount: int
  }

  pure val Users = Set(1, 2)
  pure val Keys = Set(0, 1, 2)
  pure val Amounts = Set(1, 2)
  pure val QuotaResults = Set("reserved", "org-limit", "user-limit", "released")
  pure val Empty = { units: 0, expires: 0 }
  pure val EmptyRows = Keys.mapBy(_ => Empty)
  pure val OrganizationLimit = 3
  pure val UserLimit = 2
  pure val ClockEnd = 3
  pure val ImportRows = Set(Empty,
    { units: 1, expires: 1 }, { units: 2, expires: 1 }, { units: 1, expires: 2 })

  var s: Usage
  action init = s' = {
    rows: EmptyRows, imports: EmptyRows, serving: false, now: 0, alarmAt: 0,
    phase: "idle", result: "none", user: 0, amount: 0
  }

  pure def liveRows(rows: int -> Row, now: int): int -> Row =
    Keys.mapBy(key => if (rows.get(key).expires <= now) Empty else rows.get(key))

  pure def idle(state: Usage): Usage = state
    .with("phase", "idle").with("result", "none").with("user", 0).with("amount", 0)

  pure def clamp(value: int): int = if (value < 0) 0 else value

  action operation(user: int, amount: int, reserve: bool): bool = all {
    s.phase == "idle",
    s.now < ClockEnd,
    {
      val rows = liveRows(s.rows, s.now)
      val organization = rows.get(0).units
      val person = rows.get(user).units
      val result = if (not(reserve)) "released"
        else if (organization + amount > OrganizationLimit) "org-limit"
        else if (person + amount > UserLimit) "user-limit"
        else "reserved"
      val expires = s.now + 2
      val updated = if (result == "reserved")
        rows.set(0, { units: organization + amount, expires: expires })
          .set(user, { units: person + amount, expires: expires })
        else if (result == "released")
          rows.set(0, { units: clamp(organization - amount), expires: expires })
            .set(user, { units: clamp(person - amount), expires: expires })
        else rows
      s' = s.with("rows", updated).with("serving", true)
        .with("phase", "scheduling").with("result", result)
        .with("user", user).with("amount", amount)
    }
  }

  action importSnapshot(batch: int -> Row, quiesced: bool, scoped: bool): bool = all {
    s.phase == "idle",
    {
      val submitted = Keys.filter(key => batch.get(key).expires > 0)
      val admitted = scoped and quiesced and not(s.serving) and
        submitted.forall(key => s.imports.get(key) == Empty or s.imports.get(key) == batch.get(key))
      if (admitted) {
        val receipts = submitted.fold(s.imports, (acc, key) => acc.set(key, batch.get(key)))
        val rows = submitted.fold(s.rows, (acc, key) =>
          if (batch.get(key).expires > s.now and acc.get(key) == Empty)
            acc.set(key, batch.get(key))
          else acc)
        s' = s.with("imports", receipts).with("rows", rows)
          .with("phase", "scheduling").with("result", "imported")
      } else s' = s
    }
  }

  action tick = all { s.now < ClockEnd, s' = s.with("now", s.now + 1) }

  action fireAlarm = all {
    s.phase == "idle",
    s.alarmAt > 0 and s.alarmAt <= s.now,
    s' = s.with("rows", liveRows(s.rows, s.now)).with("alarmAt", 0)
      .with("phase", "scheduling").with("result", "alarm")
  }

  action schedule = all {
    s.phase == "scheduling",
    {
      val expiries = Keys.map(key => s.rows.get(key).expires).exclude(Set(0))
      val first = expiries.fold(ClockEnd + 2, (earliest, expires) =>
        if (expires < earliest) expires else earliest)
      val alarm = if (expiries == Set()) 0 else if (first <= s.now) s.now + 1 else first
      val nextState = s.with("alarmAt", alarm)
      s' = if (s.result == "alarm") idle(nextState) else nextState.with("phase", "replying")
    }
  }

  // Failure here occurs after the SQL commit. The previous alarm may remain.
  action scheduleError = all { s.phase == "scheduling", s' = idle(s) }
  action settleSchedule = any { schedule, scheduleError }
  action settleReply = all { s.phase == "replying", s' = idle(s) }
  action restart = s' = idle(s)
  action wait = s' = s

  action quota = {
    nondet user = Users.oneOf()
    nondet amount = Amounts.oneOf()
    nondet reserve = Set(true, false).oneOf()
    operation(user, amount, reserve)
  }

  // Rejected requests are represented by wait. Enumerate only mutable imports.
  action transfer = all {
    s.phase == "idle",
    not(s.serving),
    {
      nondet organization = ImportRows.oneOf()
      nondet first = ImportRows.oneOf()
      nondet second = ImportRows.oneOf()
      importSnapshot(Map(0 -> organization, 1 -> first, 2 -> second), true, true)
    }
  }

  action background = any { tick, fireAlarm, settleSchedule, settleReply, restart, wait }
  action step = any { quota, background }
  action transferStep = any { transfer, all { not(s.serving), quota }, background }

  val invariant = and {
    Keys.forall(key => s.rows.get(key).units >= 0),
    Keys.forall(key => s.rows.get(key).expires == 0 implies s.rows.get(key) == Empty),
    s.phase == "idle" implies s.result == "none",
    QuotaResults.contains(s.result) implies
      (s.serving and Users.contains(s.user) and Amounts.contains(s.amount))
  }

  temporal AtomicQuota = always(({
    val rows = liveRows(s.rows, s.now)
    Users.forall(user => Amounts.forall(amount => {
      val organization = rows.get(0).units + amount
      val person = rows.get(user).units + amount
      val affected = Set(0, user)
      (s.phase == "idle" and QuotaResults.contains(next(s.result)) and
        next(s.user) == user and next(s.amount) == amount) implies all {
        next(s.serving),
        Keys.exclude(affected).forall(key => next(s.rows.get(key)) == rows.get(key)),
        if (next(s.result) == "reserved") all {
          organization <= OrganizationLimit and person <= UserLimit,
          affected.forall(key => next(s.rows.get(key)) ==
            { units: rows.get(key).units + amount, expires: s.now + 2 })
        } else if (next(s.result) == "released")
          affected.forall(key => and {
            next(s.rows.get(key).expires) == s.now + 2,
            if (rows.get(key).units < amount) next(s.rows.get(key).units) == 0
            else next(s.rows.get(key).units) + amount == rows.get(key).units
          })
        else all {
          next(s.rows) == rows,
          if (next(s.result) == "org-limit") organization > OrganizationLimit
          else organization <= OrganizationLimit and person > UserLimit
        }
      }
    }))
  }).orKeep(s))

  temporal DurableImportFence = always((all {
    s.serving implies next(s.serving) and next(s.imports) == s.imports,
    Keys.forall(key => s.imports.get(key) != Empty implies
      next(s.imports.get(key)) == s.imports.get(key)),
    next(s.imports) != s.imports implies next(s.result) == "imported",
    (s.phase == "idle" and next(s.result) == "imported") implies Keys.forall(key =>
      if (s.imports.get(key) == Empty and next(s.imports.get(key).expires) > s.now)
        next(s.rows.get(key)) == next(s.imports.get(key))
      else next(s.rows.get(key)) == s.rows.get(key))
  }).orKeep(s))

  temporal ExpiryAndReplySafety = always((all {
    s.phase != "idle" implies next(s.rows) == s.rows and next(s.imports) == s.imports,
    (s.phase == "idle" and next(s.result) == "alarm") implies next(s.rows) == liveRows(s.rows, s.now)
  }).orKeep(s))

  temporal EventuallyIdle = (s.phase != "idle").leadsTo(s.phase == "idle")
  temporal FairSettlement = (settleSchedule.weakFair(s) and settleReply.weakFair(s)) implies EventuallyIdle

  run sharedQuotaTest = init
    .then(operation(1, 2, true)).then(schedule).then(settleReply)
    .then(operation(2, 2, true))
    .expect(s.result == "org-limit" and s.rows.get(2) == Empty)

  run isolatedReleaseTest = init
    .then(operation(1, 1, true)).then(schedule).then(settleReply)
    .then(operation(2, 1, true)).then(schedule).then(settleReply)
    .then(operation(1, 2, false))
    .expect(s.rows.get(0).units == 0 and s.rows.get(1).units == 0 and s.rows.get(2).units == 1)

  run rejectedSnapshotsDoNotOpenServingTest = {
    val batch = Map(0 -> { units: 1, expires: 2 }, 1 -> Empty, 2 -> Empty)
    init.then(importSnapshot(batch, true, false)).then(importSnapshot(batch, false, true))
      .expect(s.rows == EmptyRows and s.imports == EmptyRows and not(s.serving))
  }

  run conflictIsAtomicTest = {
    val original = { units: 1, expires: 2 }
    init.then(importSnapshot(Map(0 -> original, 1 -> Empty, 2 -> Empty), true, true))
      .then(schedule).then(settleReply).then(restart)
      .then(importSnapshot(Map(0 -> { units: 1, expires: 1 }, 1 -> original, 2 -> Empty), true, true))
      .expect(s.imports.get(0) == original and s.imports.get(1) == Empty and s.rows.get(1) == Empty)
  }

  run expiredImportRemainsFencedTest = {
    val batch = Map(0 -> { units: 2, expires: 1 }, 1 -> Empty, 2 -> Empty)
    init.then(importSnapshot(batch, true, true)).then(schedule).then(settleReply)
      .then(tick).then(fireAlarm).then(schedule).then(restart)
      .then(importSnapshot(batch, true, true)).then(schedule).then(settleReply)
      .expect(s.rows == EmptyRows and s.imports == batch)
  }

  run deniedFirstOperationClosesImportTest = {
    val batch = Map(0 -> { units: 2, expires: 2 }, 1 -> { units: 1, expires: 2 }, 2 -> Empty)
    init.then(importSnapshot(batch, true, true)).then(schedule).then(settleReply)
      .then(operation(2, 2, true)).expect(s.result == "org-limit")
      .then(scheduleError).then(restart)
      .then(importSnapshot(Map(0 -> Empty, 1 -> Empty, 2 -> { units: 1, expires: 2 }), true, true))
      .expect(s.serving and s.imports == batch and s.rows.get(2) == Empty)
  }

  run lostReplyDoesNotRollbackOrDeduplicateTest = init
    .then(operation(1, 1, true)).then(schedule).then(restart)
    .then(operation(1, 1, true))
    .expect(s.rows.get(0).units == 2 and s.rows.get(1).units == 2)
}
