// One inbox group under a serial writer. Visibility is computed from wall
// time. A clock tick does not delete a durable row.
module NotificationGroupPolicy {
  type Count = Implicit | Explicit(int)
  type Expiry = Unspecified | Permanent | Deadline(int)
  type Request = { title: str, silent: bool, expiry: Expiry, count: Count }
  type Notice = { id: int, title: str, silent: bool, expiry: Expiry, count: Count, read: bool }
  type Slot = Empty | Row(Notice)
  type Intent = Idle | Coalesce(Request) | EnsureApproval

  var s: { now: int, sequence: int, stored: Slot, pending: Intent }

  pure val approval = { title: "approval", silent: false, expiry: Unspecified, count: Implicit }
  pure val digest = { title: "digest", silent: false, expiry: Unspecified, count: Implicit }
  pure val silent = { title: "silent", silent: true, expiry: Unspecified, count: Implicit }
  pure val pinned = { ...silent, expiry: Permanent }
  pure val deadline = { ...digest, expiry: Deadline(1) }
  pure val override = { ...digest, count: Explicit(7) }
  pure val requests = Set(approval, digest, silent, pinned, deadline, override)

  pure def active(stored: Slot, now: int): bool = match stored {
    | Empty => false
    | Row(n) => match n.expiry {
      | Deadline(end) => now < end
      | _ => true
    }
  }
  pure def countAfter(stored: Slot, now: int): Count =
    if (not(active(stored, now))) Implicit
    else match stored {
      | Empty => Implicit
      | Row(n) => match n.count {
        | Implicit => Explicit(2)
        | Explicit(previous) => Explicit(previous + 1)
      }
    }
  pure def expiration(request: Request, now: int): Expiry =
    if (request.silent and request.expiry == Unspecified) Deadline(now + 1)
    else request.expiry
  pure def exactApproval(stored: Slot): bool = match stored {
    | Empty => false
    | Row(n) => n.title == approval.title and not(n.read) and not(n.silent)
      and Set(Unspecified, Permanent).contains(n.expiry) and n.count == Implicit
  }
  pure def createRow(sequence: int, now: int, request: Request, count: Count): Slot =
    Row({ id: sequence + 1, title: request.title, silent: request.silent,
      expiry: expiration(request, now), count: count, read: false })

  action init = s' = { now: 0, sequence: 0, stored: Empty, pending: Idle }
  action request(intent: Intent): bool = all {
    s.pending == Idle and intent != Idle and s.sequence < 3,
    s' = { ...s, pending: intent },
  }
  action settle = all {
    s.pending != Idle,
    val stored = match s.pending {
      | Idle => s.stored
      | Coalesce(input) => {
        val count = if (input.count == Implicit) countAfter(s.stored, s.now) else input.count
        createRow(s.sequence, s.now, input, count)
      }
      | EnsureApproval => if (exactApproval(s.stored)) s.stored
        else createRow(s.sequence, s.now, approval, Implicit)
    }
    s' = { ...s, sequence: if (stored == s.stored) s.sequence else s.sequence + 1,
      pending: Idle, stored: stored },
  }
  action tick = all { s.now < 2, s' = { ...s, now: s.now + 1 } }
  action markRead = all {
    s.pending == Idle,
    val stored = match s.stored {
      | Empty => Empty
      | Row(n) => Row({ ...n, read: true })
    }
    all {
      stored != s.stored,
      s' = { ...s, stored: stored },
    }
  }
  action step = {
    nondet input = requests.oneOf()
    any { request(Coalesce(input)), request(EnsureApproval), settle, tick, markRead, s' = s }
  }

  val SequenceTracksRetainedRow = match s.stored {
    | Empty => s.sequence == 0
    | Row(n) => n.id == s.sequence and 1 <= s.sequence and s.sequence <= 3
  }
  temporal ClockTickKeepsHistory = always((next(s.now) > s.now)
    .implies(next(s.stored) == s.stored).orKeep(s))
  val retainedCount = match s.stored { | Empty => Implicit | Row(n) => n.count }
  val retainedExpiry = match s.stored { | Empty => Unspecified | Row(n) => n.expiry }
  val retainedUnread = match s.stored { | Empty => false | Row(n) => not(n.read) }
  val retainedIsExactApproval = exactApproval(s.stored)
  val incrementedCount = match retainedCount {
    | Implicit => Explicit(2)
    | Explicit(count) => Explicit(count + 1)
  }
  val pendingInput = match s.pending { | Coalesce(input) => input | _ => digest }
  val pendingCoalesce = s.pending != Idle and s.pending != EnsureApproval
  val priorIsActive = active(s.stored, s.now)
  temporal GroupWriteRules = always((
    (s.pending == EnsureApproval and next(s.pending) == Idle).implies(
      retainedIsExactApproval.implies(next(s.stored) == s.stored and next(s.sequence) == s.sequence)
      and not(retainedIsExactApproval).implies(next(retainedIsExactApproval) and next(s.sequence) == s.sequence + 1)
    )
    and (pendingCoalesce and next(s.pending) == Idle).implies(
      next(s.sequence) == s.sequence + 1 and next(retainedUnread)
      and (pendingInput.count != Implicit).implies(next(retainedCount) == pendingInput.count)
      and (pendingInput.count == Implicit and not(priorIsActive)).implies(next(retainedCount) == Implicit)
      and (pendingInput.count == Implicit and priorIsActive).implies(next(retainedCount) == incrementedCount)
      and (pendingInput.silent and pendingInput.expiry == Unspecified).implies(next(retainedExpiry) == Deadline(s.now + 1))
      and (not(pendingInput.silent) or pendingInput.expiry != Unspecified).implies(next(retainedExpiry) == pendingInput.expiry)
    )
  ).orKeep(s))
  temporal RequestFinishesWithoutFairness = (s.pending != Idle).leadsTo(s.pending == Idle)
  temporal RequestFinishes = settle.weakFair(s).implies(RequestFinishesWithoutFairness)

  run expiryAtWriteDoesNotSeedCountTest = init.then(request(Coalesce(deadline))).then(settle)
    .then(request(Coalesce(digest))).then(tick)
    .expect(not(active(s.stored, s.now)) and s.sequence == 1)
    .then(settle).expect(s.stored == Row({ id: 2, title: "digest", silent: false,
      expiry: Unspecified, count: Implicit, read: false }))

  run producerCountOverridesLiveCountTest = init.then(request(Coalesce(digest))).then(settle)
    .then(request(Coalesce(override))).then(settle)
    .expect(s.stored == Row({ id: 2, title: "digest", silent: false,
      expiry: Unspecified, count: Explicit(7), read: false }))

  run activeGroupCarriesCountTest = init.then(request(Coalesce(digest))).then(settle).then(markRead)
    .then(request(Coalesce(digest))).then(settle)
    .expect(s.stored == Row({ id: 2, title: "digest", silent: false,
      expiry: Unspecified, count: Explicit(2), read: false }))

  run exactApprovalReusesOnlyUnreadExactRowTest = init.then(request(Coalesce(approval))).then(settle)
    .then(request(EnsureApproval)).then(settle).expect(s.sequence == 1)
    .then(markRead).then(request(EnsureApproval)).then(settle)
    .expect(s.sequence == 2 and exactApproval(s.stored))

  run silentDefaultExpiresButExplicitNullPersistsTest = init.then(request(Coalesce(silent))).then(settle)
    .then(tick).expect(not(active(s.stored, s.now)) and s.sequence == 1)
    .then(request(Coalesce(pinned))).then(settle).then(tick).expect(active(s.stored, s.now))
}

// Full producer policy before rendering. Expiry uses wall time and can change
// visibility after a clock correction. Reading does not prune durable history.
module NotificationTriagePolicy {
  pure val categories = Set("reminder", "task", "workflow", "agent", "approval", "message", "health", "system", "general")
  pure val priorities = Set("low", "normal", "high", "urgent")
  type Expiry = Unspecified | Permanent | Deadline(int)
  type Request = { category: str, priority: str, expiry: Expiry }
  type Notice = { priority: str, expiry: Expiry, created: int, read: bool }
  type Row = Empty | Stored(Notice)
  type Admission = Open | Accepted(Request) | Committed(Request)
  var s: { now: int, admission: Admission, row: Row }

  pure def defaultPriority(category: str): str =
    if (category == "approval") "high" else if (category == "system") "low" else "normal"
  pure def chosenPriority(input: Request): str =
    if (input.priority == "default") defaultPriority(input.category) else input.priority
  pure def chosenExpiry(input: Request, now: int): Expiry =
    if (input.expiry == Unspecified and chosenPriority(input) == "low") Deadline(now + 1) else input.expiry
  val input = match s.admission {
    | Open => { category: "general", priority: "default", expiry: Unspecified }
    | Accepted(request) => request
    | Committed(request) => request
  }
  val notice = match s.row {
    | Empty => { priority: "normal", expiry: Unspecified, created: 0, read: false }
    | Stored(value) => value
  }
  val visible = s.row != Empty and (match notice.expiry {
    | Deadline(end) => s.now < end
    | _ => true
  })
  val unread = visible and not(notice.read)
  val badge = unread and notice.priority != "low"
  action init = s' = { now: 1, admission: Open, row: Empty }
  action admit(request: Request): bool = all {
    s.admission == Open,
    s' = { ...s, admission: Accepted(request) },
  }
  action persist = all {
    s.row == Empty and s.admission != Open,
    s' = { ...s, admission: Committed(input),
      row: Stored({ priority: chosenPriority(input), expiry: chosenExpiry(input, s.now), created: s.now, read: false }) },
  }
  action markRead = all {
    s.row != Empty and not(notice.read),
    s' = { ...s, row: Stored({ ...notice, read: true }) },
  }
  action clockChanges(now: int): bool = s' = { ...s, now: now }
  action step = {
    nondet category = categories.oneOf()
    nondet priority = priorities.union(Set("default")).oneOf()
    nondet expiry = Set(Unspecified, Permanent, Deadline(1)).oneOf()
    nondet now = 0.to(2).oneOf()
    any { admit({ category: category, priority: priority, expiry: expiry }),
      persist, markRead, clockChanges(now), s' = s }
  }
  val PriorityMatchesProducer = (s.row != Empty).implies(
    (input.priority != "default").implies(notice.priority == input.priority)
    and (input.priority == "default" and input.category == "approval").implies(notice.priority == "high")
    and (input.priority == "default" and input.category == "system").implies(notice.priority == "low")
    and (input.priority == "default" and not(Set("approval", "system").contains(input.category))).implies(notice.priority == "normal"))
  val ExpiryMatchesProducer = (s.row != Empty).implies(
    (input.expiry != Unspecified).implies(notice.expiry == input.expiry)
    and (input.expiry == Unspecified and notice.priority == "low").implies(notice.expiry == Deadline(notice.created + 1))
    and (input.expiry == Unspecified and notice.priority != "low").implies(notice.expiry == Unspecified))
  temporal WallClockPreservesHistory = always((next(s.now) != s.now).implies(next(s.row) == s.row).orKeep(s))
  temporal AdmissionSettlesWithoutFairness = (s.admission != Open).leadsTo(s.row != Empty)
  temporal AdmissionSettles = persist.weakFair(s).implies(AdmissionSettlesWithoutFairness)

  run explicitPriorityAndPermanentExpiryWinTest = init
    .then(admit({ category: "approval", priority: "low", expiry: Permanent })).then(persist)
    .expect(notice.priority == "low" and visible and not(badge))
    .then(markRead).then(clockChanges(2)).expect(visible and not(unread))
  run clockCorrectionRestoresUnprunedHistoryTest = init
    .then(admit({ category: "system", priority: "default", expiry: Unspecified })).then(persist)
    .then(clockChanges(2)).expect(not(visible) and s.row != Empty)
    .then(clockChanges(1)).expect(visible and unread and not(badge))
  run expiryUsesCommitTimeTest = init
    .then(admit({ category: "system", priority: "default", expiry: Unspecified }))
    .then(clockChanges(0)).then(persist).expect(notice.expiry == Deadline(1))
}
