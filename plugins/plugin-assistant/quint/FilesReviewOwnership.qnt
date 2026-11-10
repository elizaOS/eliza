// client-coordinator.ts owns the current review and its per-proposal identity pin.
// BrowserStorageVolume compares that pin with the current storage object before
// BrowserFiles commits a revision-checked change. Server and journal authority
// remain external. Bounds are three refreshes, one proposal and one replaced path.
module FilesReviewOwnership {
  type Phase = Fresh | Listing | NeedsIdentity | AwaitingIdentity | Returned | Aborted
  var s: {
    latest: int, phases: List[Phase], contexts: List[int],
    captured: List[int], cancelled: Set[int], file: int,
    pin: int, displayed: int, proposalToken: int, proposalContext: int,
    dispatched: bool, dispatchToken: int, appliedFile: int,
  }
  pure val Reviews = Set(0, 1, 2)
  pure val Contexts = Set(0, 1)
  pure val Flags = Set(false, true)

  action init = s' = {
    latest: -1, phases: [Fresh, Fresh, Fresh], contexts: [0, 0, 0], captured: [-1, -1, -1],
    cancelled: Set(), file: 0, pin: -1, displayed: -1,
    proposalToken: -1, proposalContext: -1,
    dispatched: false, dispatchToken: -1, appliedFile: -1,
  }
  def current(index: int): bool = index == s.latest and not(s.cancelled.contains(index))
  val pending = s.phases.indices().exists(index =>
    s.phases.nth(index).in(Set(Listing, NeedsIdentity, AwaitingIdentity)))

  action start(context: int): bool = all {
    s.latest < 2,
    s.phases.indices().filter(index =>
      s.phases.nth(index).in(Set(Listing, NeedsIdentity, AwaitingIdentity))).size() < 2,
    val index = s.latest + 1
    s' = s.with("latest", index)
      .with("phases", s.phases.replaceAt(index, Listing))
      .with("contexts", s.contexts.replaceAt(index, context)),
  }
  action listReturns(index: int, present: bool): bool = all {
    s.phases.nth(index) == Listing,
    s' =
      if (not(current(index)))
        s.with("phases", s.phases.replaceAt(index, Aborted))
      else if (not(present))
        s.with("phases", s.phases.replaceAt(index, Returned))
          .with("pin", -1).with("displayed", -1)
          .with("proposalToken", -1).with("proposalContext", -1)
      else if (s.pin >= 0)
        s.with("phases", s.phases.replaceAt(index, Returned))
          .with("proposalToken", s.pin).with("proposalContext", s.contexts.nth(index))
      else
        s.with("phases", s.phases.replaceAt(index, NeedsIdentity))
          .with("proposalToken", -1).with("proposalContext", -1),
  }
  action readIdentity(index: int): bool = all {
    s.phases.nth(index) == NeedsIdentity,
    s' = s.with("phases", s.phases.replaceAt(index, AwaitingIdentity))
      .with("captured", s.captured.replaceAt(index, s.file)),
  }
  action identityReturns(index: int, ok: bool): bool = all {
    s.phases.nth(index) == AwaitingIdentity,
    val token = if (s.pin >= 0) s.pin else s.captured.nth(index)
    s' =
      if (not(current(index)))
        s.with("phases", s.phases.replaceAt(index, Aborted))
      else if (not(ok))
        s.with("phases", s.phases.replaceAt(index, Returned))
      else
        s.with("phases", s.phases.replaceAt(index, Returned))
          .with("pin", token).with("displayed", token)
          .with("proposalToken", token).with("proposalContext", s.contexts.nth(index)),
  }
  action abort(index: int): bool = all {
    not(s.cancelled.contains(index)), s.phases.nth(index) != Fresh,
    s' = s.with("cancelled", s.cancelled.union(Set(index))),
  }
  action replaceFile = all {
    s.file == 0, s' = s.with("file", 1),
  }
  // Admission/claim/journal are premises at this boundary. One dispatch compares
  // the preserved review token, and a replacement file remains untouched.
  action dispatch(context: int): bool = all {
    not(s.dispatched), s.proposalToken >= 0, s.proposalContext == context,
    s' = s.with("dispatched", true).with("dispatchToken", s.proposalToken)
      .with("appliedFile", if (s.file == s.proposalToken) s.file else -1),
  }

  action completeList = {
    nondet index = Reviews.oneOf()
    nondet present = Flags.oneOf()
    listReturns(index, present)
  }
  action readOne = {
    nondet index = Reviews.oneOf()
    readIdentity(index)
  }
  action completeIdentity = {
    nondet index = Reviews.oneOf()
    nondet ok = Flags.oneOf()
    identityReturns(index, ok)
  }
  action staleCompletion = {
    nondet index = Reviews.oneOf()
    nondet flag = Flags.oneOf()
    all {
      not(current(index)),
      any { listReturns(index, flag), identityReturns(index, flag) },
    }
  }
  action step = any {
    s' = s, completeList, readOne, completeIdentity, replaceFile,
    nondet context = Contexts.oneOf()
    any { start(context), dispatch(context) },
    nondet index = Reviews.oneOf()
    abort(index),
  }

  val PinMatchesDisplayedIdentity = s.pin == s.displayed
  val LatestReturnedContext = all {
    (s.latest >= 0 and s.phases.nth(s.latest) == Returned and s.proposalToken >= 0)
      implies s.proposalContext == s.contexts.nth(s.latest),
    s.proposalToken >= 0 implies s.proposalToken == s.pin,
  }
  val OnlyReviewedObjectChanges = s.appliedFile >= 0 implies s.appliedFile == s.dispatchToken
  temporal StaleCompletionRetainsBindings = always((
    staleCompletion.implies(
      next(s.pin) == s.pin and next(s.displayed) == s.displayed and
      next(s.proposalToken) == s.proposalToken and next(s.proposalContext) == s.proposalContext)
  ).orKeep(s))
  temporal RefreshRetainsPin = always((
    (s.pin >= 0 and next(s.pin) >= 0).implies(next(s.pin) == s.pin)
  ).orKeep(s))
  temporal WaitingCallbacksCanHang = pending.leadsTo(not(pending))
  temporal ReviewSettles = (
    completeList.weakFair(s) and readOne.weakFair(s) and completeIdentity.weakFair(s)
  ).implies(WaitingCallbacksCanHang)

  run refreshPinsTheOriginalObjectTest = init.then(start(0)).then(listReturns(0, true))
    .then(readIdentity(0)).then(identityReturns(0, true)).then(replaceFile)
    .then(start(0)).then(listReturns(1, true)).then(dispatch(0))
    .expect(s.pin == 0 and s.appliedFile == -1)
  run oldEmptyListCannotEvictNewerPinTest = init.then(start(0)).then(start(0))
    .then(listReturns(1, true)).then(readIdentity(1)).then(identityReturns(1, true))
    .then(replaceFile).then(listReturns(0, false)).then(start(0))
    .then(listReturns(2, true)).then(dispatch(0))
    .expect(s.phases.nth(0) == Aborted and s.pin == 0 and s.appliedFile == -1)
  run oldIdentityCannotOverwriteNewContextTest = init.then(start(0)).then(listReturns(0, true))
    .then(readIdentity(0)).then(start(1)).then(listReturns(1, true))
    .then(readIdentity(1)).then(identityReturns(1, true)).then(identityReturns(0, true))
    .then(dispatch(1)).expect(s.proposalContext == 1 and s.appliedFile == 0)
  run cancellationNeverPinsUnseenFilesTest = init.then(start(0)).then(listReturns(0, true))
    .then(readIdentity(0)).then(abort(0)).then(replaceFile).then(identityReturns(0, true))
    .expect(s.pin == -1).then(start(0)).then(listReturns(1, true))
    .then(readIdentity(1)).then(identityReturns(1, true)).then(dispatch(0))
    .expect(s.pin == 1 and s.appliedFile == 1)
}
