// DynamicViewSessionManager owns every window until its canvas acknowledges
// close. The historical record target is applied on the next open.
module DesktopDynamicViewRetention {
  pure val SessionIds = Set(1, 2, 3, 4, 5)
  pure val HistoryTarget = 2
  pure val WindowPhases = Set("open", "error", "closing")
  type State = {
    issued: int,
    records: int -> str,
    windows: Set[int],
    closeReceipts: Set[int],
  }

  var s: State

  action init = s' = {
    issued: 0, records: SessionIds.mapBy(_ => "unused"),
    windows: Set(), closeReceipts: Set(),
  }

  pure def countRetained(records: int -> str): int =
    SessionIds.filter(id => not(Set("unused", "pruned").contains(records.get(id)))).size()

  pure def trimClosed(records: int -> str): int -> str = {
    val excess = countRetained(records) - HistoryTarget
    val closed = SessionIds.filter(id => records.get(id) == "closed")
    closed.fold(records, (kept, id) =>
      if (closed.filter(other => other <= id).size() <= excess)
        kept.set(id, "pruned")
      else kept
    )
  }

  action requestOpen(id: int): bool = all {
    id == s.issued + 1,
    s' = { ...s, issued: id, records: trimClosed(s.records.set(id, "opening")) },
  }

  // The failed initial event follows a successful mount. Even with a
  // rejected open promise the record still owns that canvas receipt.
  action finishOpen(id: int, initialized: bool): bool = all {
    s.records.get(id) == "opening",
    id != 1 implies initialized,
    s' = {
      ...s, records: s.records.set(id, if (initialized) "open" else "error"),
      windows: s.windows.union(Set(id)),
    },
  }

  action requestClose(id: int): bool = all {
    Set("open", "error").contains(s.records.get(id)),
    s' = { ...s, records: s.records.set(id, "closing") },
  }

  action acknowledgeClose(id: int): bool = all {
    s.records.get(id) == "closing",
    s' = {
      ...s, records: s.records.set(id, "closed"),
      windows: s.windows.exclude(Set(id)), closeReceipts: s.closeReceipts.union(Set(id)),
    },
  }

  action settleOpen(id: int): bool = any { finishOpen(id, true), finishOpen(id, false) }

  action step = any {
    { nondet id = SessionIds.oneOf() requestOpen(id) },
    { nondet id = SessionIds.oneOf() settleOpen(id) },
    { nondet id = SessionIds.oneOf() requestClose(id) },
    { nondet id = SessionIds.oneOf() acknowledgeClose(id) },
    s' = s,
  }

  val EveryWindowHasAnAddressableOwner =
    s.windows == SessionIds.filter(id => WindowPhases.contains(s.records.get(id)))

  val OnlyClosedReceiptsCanBePruned =
    s.closeReceipts == SessionIds.filter(id => Set("closed", "pruned").contains(s.records.get(id)))

  temporal OpenTrimsAvailableHistory = always((
    next(s.issued) > s.issued implies
      countRetained(next(s.records)) <= HistoryTarget or
        SessionIds.forall(id => next(s.records.get(id)) != "closed")
  ).orKeep(s))

  temporal RequestedCanvasOperationsSettle = SessionIds.forall(id => and {
    (s.records.get(id) == "opening").leadsTo(Set("open", "error").contains(s.records.get(id))),
    (s.records.get(id) == "closing").leadsTo(s.closeReceipts.contains(id)),
  })

  temporal UnderFairCanvasReceipts = SessionIds.forall(id =>
    settleOpen(id).weakFair(s) and acknowledgeClose(id).weakFair(s)
  ) implies RequestedCanvasOperationsSettle

  run OpenOwnerSurvivesOverflowTest = init
    .then(requestOpen(1)).then(finishOpen(1, true))
    .then(requestOpen(2)).then(finishOpen(2, true))
    .then(requestOpen(3)).then(finishOpen(3, true))
    .expect(s.windows == Set(1, 2, 3) and EveryWindowHasAnAddressableOwner)
    .then(requestClose(1)).then(acknowledgeClose(1))
    .expect(s.windows == Set(2, 3) and OnlyClosedReceiptsCanBePruned)

  run FailedOwnerAndMultipleClosedRecordsTest = init
    .then(requestOpen(1)).then(finishOpen(1, false))
    .then(requestOpen(2)).then(finishOpen(2, true))
    .then(requestOpen(3)).then(finishOpen(3, true))
    .then(requestOpen(4)).then(finishOpen(4, true))
    .expect(s.records.get(1) == "error" and s.windows.contains(1))
    .then(requestClose(1)).then(acknowledgeClose(1))
    .then(requestClose(2)).then(acknowledgeClose(2))
    .then(requestClose(3)).then(acknowledgeClose(3))
    .then(requestOpen(5)).then(finishOpen(5, true))
    .expect(countRetained(s.records) == HistoryTarget and s.windows == Set(4, 5)
      and OnlyClosedReceiptsCanBePruned)
}
