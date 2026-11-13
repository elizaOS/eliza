// runner.ts applySkip / mutateComplete / useUpRecurringOccurrence with due.ts:
// a daily recurring task over three occurrences. The scheduler tick reaches
// each occurrence in turn and dispatches it unless the row has used it up or
// was dismissed; a skipped or completed row reopens for its next occurrence.
// Between ticks the owner may skip, complete or dismiss a row that is
// scheduled or fired (the personal-assistant action refuses a closed row).
// A verb on a fired row settles the occurrence that fired. A verb on a
// scheduled row, which has not fired the occurrence it waits for, settles
// that pending occurrence.
module ScheduledTaskPendingOccurrence {
  pure val Days = 3
  pure val Never = Days + 1
  var day: int
  var status: str
  var usedUp: int
  var dispatched: List[int]
  var settledPending: Set[int]
  var dismissedFrom: int
  var events: List[str]
  pure def has(list: List[int], value: int): bool =
    list.indices().exists(i => list[i] == value)
  action init = all {
    day' = 1, status' = "scheduled", usedUp' = 0, dispatched' = [],
    settledPending' = Set(), dismissedFrom' = Never, events' = []
  }
  action tick = {
    val fires = status != "dismissed" and day > usedUp
    all {
      day <= Days,
      day' = day + 1,
      status' = if (fires) "fired" else status,
      usedUp' = if (fires) day else usedUp,
      dispatched' = if (fires) dispatched.append(day) else dispatched,
      settledPending' = settledPending, dismissedFrom' = dismissedFrom,
      events' = events.append("tick")
    }
  }
  action settle(verb: str): bool = {
    val pending = status == "scheduled"
    all {
      day <= Days,
      Set("scheduled", "fired").contains(status),
      status' = verb,
      usedUp' = if (pending) day else usedUp,
      settledPending' = if (pending) settledPending.union(Set(day)) else settledPending,
      day' = day, dispatched' = dispatched, dismissedFrom' = dismissedFrom,
      events' = events.append(verb)
    }
  }
  action dismiss = all {
    day <= Days,
    Set("scheduled", "fired").contains(status),
    status' = "dismissed", dismissedFrom' = day,
    day' = day, usedUp' = usedUp, dispatched' = dispatched,
    settledPending' = settledPending,
    events' = events.append("dismissed")
  }
  action finished = all {
    day > Days,
    day' = day, status' = status, usedUp' = usedUp, dispatched' = dispatched,
    settledPending' = settledPending, dismissedFrom' = dismissedFrom,
    events' = events
  }
  action step = any {
    tick, settle("skipped"), settle("completed"), dismiss, finished
  }
  val SettledPendingNeverDispatched =
    settledPending.forall(d => not(has(dispatched, d)))
  val DispatchOncePerOccurrence =
    dispatched.indices().forall(i => i == 0 or dispatched[i - 1] < dispatched[i])
  val UnsettledOccurrencesFire =
    1.to(day - 1).forall(d =>
      (not(settledPending.contains(d)) and d < dismissedFrom) implies has(dispatched, d))
  val DismissStopsDispatch = dispatched.indices().forall(i => dispatched[i] < dismissedFrom)
  val TypeOK =
    Set("scheduled", "fired", "skipped", "completed", "dismissed").contains(status) and
    day >= 1 and day <= Never and usedUp >= 0 and usedUp <= Days and
    dispatched.length() <= Days and settledPending.subseteq(1.to(Days))
}
