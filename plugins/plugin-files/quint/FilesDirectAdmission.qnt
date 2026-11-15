// Cold Files open, independent storage admission, and retirement of a late selection.
module FilesDirectAdmission {
  type Phase = Idle | AwaitingView | AwaitingAccess | Selecting | Opened | Refused
  type Load = Unread | Loading | Loaded | LoadFailed
  type State = { phase: Phase, active: bool, viewEpoch: int, actionEpoch: int,
    cancelled: bool, load: Load, selected: bool, released: bool }
  var s: State

  pure val Pending = Set(AwaitingView, AwaitingAccess, Selecting)
  val current = s.active and s.viewEpoch == s.actionEpoch and not(s.cancelled)
  action init = s' = { phase: Idle, active: false, viewEpoch: 0, actionEpoch: 0,
    cancelled: false, load: Unread, selected: false, released: false }
  action begin = all { s.phase == Idle,
    s' = { ...s, phase: if (s.active) AwaitingAccess else AwaitingView, actionEpoch: s.viewEpoch } }
  action commitView(confirmed: bool): bool = all { s.phase == AwaitingView,
    s' = if (confirmed and not(s.cancelled) and s.viewEpoch == s.actionEpoch and s.viewEpoch < 2)
      { ...s, phase: AwaitingAccess, active: true, viewEpoch: s.viewEpoch + 1,
        actionEpoch: s.viewEpoch + 1, load: Loading }
      else { ...s, phase: Refused } }
  action enter = all { not(s.active), s.viewEpoch < 2,
    s' = { ...s, active: true, viewEpoch: s.viewEpoch + 1, load: Loading } }
  action leave = all { s.active, s' = { ...s, active: false } }
  action cancel = all { s.phase.in(Pending), not(s.cancelled), s' = { ...s, cancelled: true } }
  action loadReply(success: bool): bool = all { s.active, s.load == Loading,
    s' = { ...s, load: if (success) Loaded else LoadFailed } }
  action accessReply(granted: bool): bool = all { s.phase == AwaitingAccess,
    s' = { ...s, phase: if (granted and current) Selecting else Refused } }
  action selectionReply(granted: bool): bool = all { s.phase == Selecting,
    s' = { ...s, phase: if (granted and current) Opened else Refused,
      selected: granted and current, released: granted and not(current) } }
  action advance = {
    nondet granted = Bool.oneOf()
    any { commitView(granted), accessReply(granted), selectionReply(granted) }
  }
  action step = any { begin, enter, leave, cancel, advance,
    { nondet success = Bool.oneOf(); loadReply(success) }, s' = s }

  val OneGrantOutcome = not(s.selected and s.released) and (s.phase == Opened) == s.selected
  val CancelledNeverOpened = s.cancelled implies not(s.selected)
  temporal ReloadDoesNotRetireAction = always((
    (loadReply(true) or loadReply(false)).implies(next(s.phase) == s.phase and next(s.actionEpoch) == s.actionEpoch)
  ).orKeep(s))
  temporal RetiredGrantIsReleased = always((
    (s.phase == Selecting and not(current) and selectionReply(true)).implies(next(s.released) and not(next(s.selected)))
  ).orKeep(s))
  temporal FairCompletion = advance.weakFair(s).implies(always(s.phase.in(Pending)
    .implies(eventually(s.phase.in(Set(Opened, Refused))))))

  run coldOpenWhileReloadPendingTest = init.then(begin).then(commitView(true))
    .then(accessReply(true)).then(selectionReply(true)).expect(s.selected and s.load == Loading)
  run lateSelectionAfterReturnTest = init.then(begin).then(commitView(true)).then(accessReply(true))
    .then(leave).then(enter).then(selectionReply(true)).expect(s.released and not(s.selected))
  run cancelledSelectionTest = init.then(enter).then(begin).then(accessReply(true))
    .then(cancel).then(selectionReply(true)).expect(s.released and not(s.selected))
}
