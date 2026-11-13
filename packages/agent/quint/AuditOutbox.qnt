// security/audit-log.ts. Two records and two independently configured sinks.
// Record capture, observer copies, ordered delivery and durable effects remain
// separate. A failed append may already have committed its row. Restart keeps
// committed rows and loses in-memory promises and uncommitted queue entries.
module AuditOutbox {
  val ids = Set(1, 2)
  val sinks = Set(1, 2)
  val terminal = Set("resolved", "rejected", "lost")
  type State = {
    requiresDurable: bool,
    durable: Set[int],
    required: Set[int],
    attached: List[int],
    stage: int -> str,
    owner: int -> int,
    view: int -> int,
    recorded: List[int],
    outbox: List[int],
    queue: List[int],
    current: int,
    sinkOrder: List[int],
    sinkIndex: int,
    requiredFailed: bool,
    durableSucceeded: bool,
    acknowledgedRequiredFailure: int -> bool,
    acknowledgedDurability: int -> bool,
    attachment: int -> str,
    batch: int -> Set[int],
    rows: int -> List[int],
    previousRows: int -> List[int],
    crashed: bool,
    afterCrash: bool,
  }
  var s: State
  pure def entrySet(values: List[int]): Set[int] =
    values.foldl(Set(), (seen, id) => seen.union(Set(id)))

  action initial(requiresDurable: bool, durable: Set[int], required: Set[int]): bool = {
    val rows = sinks.mapBy(_ => [])
    s' = {
      requiresDurable: requiresDurable, durable: durable, required: required,
      attached: [], stage: ids.mapBy(_ => "new"), owner: ids.mapBy(_ => 0),
      view: ids.mapBy(_ => 0), recorded: [], outbox: [], queue: [],
      current: 0, sinkOrder: [], sinkIndex: 0,
      requiredFailed: false, durableSucceeded: false,
      acknowledgedRequiredFailure: ids.mapBy(_ => false),
      acknowledgedDurability: ids.mapBy(_ => false),
      attachment: sinks.mapBy(_ => "absent"), batch: sinks.mapBy(_ => Set()),
      rows: rows, previousRows: rows, crashed: false, afterCrash: false,
    }
  }
  action init = {
    nondet requireDurability = Set(false, true).oneOf()
    nondet durable = Set(Set(), Set(1), Set(2), Set(1, 2)).oneOf()
    nondet required = Set(Set(), Set(1), Set(2), Set(1, 2)).oneOf()
    initial(requireDurability, durable, required)
  }

  action recordEntry(id: int): bool = all {
    s.stage.get(id) == "new",
    val held = s.requiresDurable and
      not(entrySet(s.attached).exists(sink => s.durable.contains(sink)))
    s' = {
      ...s,
      stage: s.stage.set(id, if (held) "outbox" else "queued"),
      owner: s.owner.set(id, 1), view: s.view.set(id, 1),
      recorded: s.recorded.append(id),
      outbox: if (held) s.outbox.append(id) else s.outbox,
      queue: if (held) s.queue else s.queue.append(id),
      previousRows: s.rows, afterCrash: false,
    },
  }

  action attachSink(sink: int): bool = all {
    not(entrySet(s.attached).contains(sink)),
    val moved = if (s.durable.contains(sink)) s.outbox else []
    s' = {
      ...s,
      attached: s.attached.append(sink),
      stage: ids.mapBy(id => if (entrySet(moved).contains(id)) "queued" else s.stage.get(id)),
      outbox: if (s.durable.contains(sink)) [] else s.outbox,
      queue: s.queue.concat(moved),
      attachment: s.attachment.set(sink, if (moved.length() == 0) "resolved" else "pending"),
      batch: s.batch.set(sink, entrySet(moved)),
      previousRows: s.rows, afterCrash: false,
    },
  }

  action finishAttachment(sink: int): bool = all {
    s.attachment.get(sink) == "pending",
    s.batch.get(sink).forall(id => terminal.contains(s.stage.get(id))),
    val failed = s.batch.get(sink).exists(id => s.stage.get(id) == "rejected")
    s' = {
      ...s,
      attachment: s.attachment.set(sink, if (failed) "rejected" else "resolved"),
      batch: s.batch.set(sink, Set()),
      previousRows: s.rows, afterCrash: false,
    },
  }

  action beginDelivery = all {
    s.current == 0,
    s.queue.length() > 0,
    s' = {
      ...s, current: s.queue.head(), queue: s.queue.tail(),
      stage: s.stage.set(s.queue.head(), "delivering"),
      sinkOrder: s.attached, sinkIndex: 0,
      requiredFailed: false, durableSucceeded: false,
      previousRows: s.rows, afterCrash: false,
    },
  }

  action appendOutcome(outcome: str): bool = all {
    s.current != 0,
    s.sinkIndex < s.sinkOrder.length(),
    val sink = s.sinkOrder.nth(s.sinkIndex)
    val successful = outcome == "ok"
    val committed = s.durable.contains(sink) and outcome != "fail-before"
    val committedRows = if (committed)
      s.rows.set(sink, s.rows.get(sink).append(s.current))
      else s.rows
    s' = {
      ...s,
      rows: committedRows,
      requiredFailed: s.requiredFailed or (not(successful) and s.required.contains(sink)),
      durableSucceeded: s.durableSucceeded or (successful and s.durable.contains(sink)),
      sinkIndex: s.sinkIndex + 1,
      previousRows: committedRows, afterCrash: false,
    },
  }
  action appendAnyOutcome = {
    nondet outcome = Set("ok", "fail-before", "fail-after").oneOf()
    appendOutcome(outcome)
  }

  action finishDelivery = all {
    s.current != 0,
    s.sinkIndex == s.sinkOrder.length(),
    val accepted = not(s.requiredFailed) and
      (not(s.requiresDurable) or s.durableSucceeded)
    s' = {
      ...s,
      stage: s.stage.set(s.current,
        if (accepted) "resolved" else "rejected"),
      acknowledgedRequiredFailure:
        s.acknowledgedRequiredFailure.set(s.current, s.requiredFailed),
      acknowledgedDurability:
        s.acknowledgedDurability.set(s.current, s.durableSucceeded),
      current: 0, sinkOrder: [], sinkIndex: 0,
      requiredFailed: false, durableSucceeded: false,
      previousRows: s.rows, afterCrash: false,
    },
  }

  // Caller, feed/query, subscriber and sink views do not own the queued entry.
  action mutateView(id: int): bool = all {
    s.owner.get(id) != 0,
    s' = {
      ...s, view: s.view.set(id, 2), previousRows: s.rows, afterCrash: false,
    },
  }

  action crash = all {
    not(s.crashed),
    s' = {
      ...s,
      stage: ids.mapBy(id =>
        if (Set("outbox", "queued", "delivering").contains(s.stage.get(id))) "lost"
        else s.stage.get(id)),
      attachment: sinks.mapBy(sink =>
        if (s.attachment.get(sink) == "pending") "lost"
        else s.attachment.get(sink)),
      attached: [], outbox: [], queue: [], current: 0,
      sinkOrder: [], sinkIndex: 0, crashed: true,
      requiredFailed: false, durableSucceeded: false,
      batch: sinks.mapBy(_ => Set()),
      previousRows: s.rows, afterCrash: true,
    },
  }

  action step = any {
    { nondet id = ids.oneOf() recordEntry(id) },
    { nondet sink = sinks.oneOf() attachSink(sink) },
    { nondet sink = sinks.oneOf() finishAttachment(sink) },
    beginDelivery, appendAnyOutcome, finishDelivery,
    { nondet id = ids.oneOf() mutateView(id) },
    crash,
    s' = s,
  }

  val TypeOK = and {
    s.durable.subseteq(sinks), s.required.subseteq(sinks),
    s.stage.keys() == ids, s.rows.keys() == sinks,
    ids.forall(id => s.stage.get(id).in(Set(
      "new", "outbox", "queued", "delivering", "resolved", "rejected", "lost"))),
    s.sinkIndex >= 0 and s.sinkIndex <= s.sinkOrder.length(),
    s.current.in(Set(0, 1, 2)),
  }
  val CapturedFactsStayOwned = ids.forall(id =>
    (s.stage.get(id) != "new").implies(s.owner.get(id) == 1))
  val ResolvedMeetsRequirements = ids.forall(id =>
    (s.stage.get(id) == "resolved").implies(
      not(s.acknowledgedRequiredFailure.get(id)) and
      (not(s.requiresDurable) or s.acknowledgedDurability.get(id))))
  val CommittedRowsWereRecorded = sinks.forall(sink =>
    entrySet(s.rows.get(sink)).subseteq(entrySet(s.recorded)))
  val SinkOrderIsRecordOrder = sinks.forall(sink =>
    s.rows.get(sink) == s.recorded.select(id => entrySet(s.rows.get(sink)).contains(id)))
  val CrashPreservesCommittedRows =
    s.afterCrash.implies(s.rows == s.previousRows)
  val OneDeliveryAtATime = ids.filter(id => s.stage.get(id) == "delivering").size() <= 1
  val invariant = TypeOK and CapturedFactsStayOwned and ResolvedMeetsRequirements and
    CommittedRowsWereRecorded and SinkOrderIsRecordOrder and
    CrashPreservesCommittedRows and OneDeliveryAtATime

  temporal FairDelivery = and {
    sinks.forall(sink => attachSink(sink).weakFair(s)),
    sinks.forall(sink => finishAttachment(sink).weakFair(s)),
    beginDelivery.weakFair(s), appendAnyOutcome.weakFair(s), finishDelivery.weakFair(s),
  }
  temporal PendingCallsSettle =
    ((not(s.requiresDurable) or s.durable.size() > 0) and FairDelivery).implies(
      ids.forall(id => always((s.stage.get(id) != "new").implies(eventually(
        terminal.contains(s.stage.get(id)))))))

  run heldUntilDurableSinkTest = initial(true, Set(1), Set(1))
    .then(recordEntry(1)).expect(s.stage.get(1) == "outbox")
    .then(attachSink(1)).then(beginDelivery).then(appendOutcome("ok"))
    .then(finishDelivery).then(finishAttachment(1))
    .expect(s.stage.get(1) == "resolved" and s.rows.get(1) == [1])
  run requiredFailureRejectsDespiteDurableFallbackTest = initial(true, Set(1, 2), Set(1))
    .then(attachSink(1)).then(attachSink(2)).then(recordEntry(1)).then(beginDelivery)
    .then(appendOutcome("fail-before")).then(appendOutcome("ok")).then(finishDelivery)
    .expect(s.stage.get(1) == "rejected" and s.rows.get(2) == [1])
  run optionalDurableFallbackTest = initial(true, Set(1, 2), Set())
    .then(attachSink(1)).then(attachSink(2)).then(recordEntry(1)).then(beginDelivery)
    .then(appendOutcome("fail-before")).then(appendOutcome("ok")).then(finishDelivery)
    .expect(s.stage.get(1) == "resolved")
  run failedEntryDoesNotBlockNextTest = initial(true, Set(1), Set(1))
    .then(attachSink(1)).then(recordEntry(1)).then(recordEntry(2))
    .then(beginDelivery).then(appendOutcome("fail-before")).then(finishDelivery)
    .then(beginDelivery).then(appendOutcome("ok")).then(finishDelivery)
    .expect(s.stage.get(1) == "rejected" and s.stage.get(2) == "resolved")
  run committedRowsSurviveRestartTest = initial(true, Set(1), Set(1))
    .then(attachSink(1)).then(recordEntry(1)).then(beginDelivery)
    .then(appendOutcome("ok")).then(finishDelivery).then(recordEntry(2)).then(crash)
    .expect(s.rows.get(1) == [1] and s.stage.get(2) == "lost")
  run failedAcknowledgementMayHaveCommittedTest = initial(true, Set(1), Set(1))
    .then(attachSink(1)).then(recordEntry(1)).then(beginDelivery)
    .then(appendOutcome("fail-after")).then(finishDelivery)
    .expect(s.stage.get(1) == "rejected" and s.rows.get(1) == [1])
  run callerViewsCannotRewriteCapturedFactsTest = initial(true, Set(1), Set(1))
    .then(recordEntry(1)).then(mutateView(1)).then(attachSink(1)).then(beginDelivery)
    .then(appendOutcome("ok")).then(finishDelivery)
    .expect(CapturedFactsStayOwned and s.view.get(1) == 2)
}
