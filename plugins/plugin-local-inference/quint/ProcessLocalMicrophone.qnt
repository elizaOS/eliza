// Shared Android local speech uses one process slot across independent capture owners.
module ProcessLocalMicrophone {
  // Owner 1 and 2 are independent live controllers. Owner 3 is a draft recorder.
  type State = { owner: int, token: int, issued: int, phase: str, open: bool, refused: int }
  var s: State
  action init = s' = { owner: 0, token: 0, issued: 0, phase: "idle", open: false, refused: 0 }

  action reserve(owner: int): bool = all {
    s.owner != 0 or s.issued < 3,
    s' = if (s.owner == 0)
      { ...s, owner: owner, token: s.issued + 1, issued: s.issued + 1, phase: "opening", refused: 0 }
    else { ...s, refused: owner }
  }
  action opened = all {
    s.phase == "opening", s' = { ...s, phase: "running", open: true }
  }
  action cancel = all {
    Set("opening", "running").contains(s.phase), s' = { ...s, phase: "closing" }
  }
  action lateOpen = all {
    s.phase == "closing", not(s.open), s' = { ...s, open: true }
  }
  action released = all {
    Set("opening", "closing").contains(s.phase) or (s.phase == "unconfirmed" and s.owner == 3),
    s' = { ...s, owner: 0, token: 0, phase: "idle", open: false }
  }
  action releaseUnconfirmed = all {
    Set("opening", "closing").contains(s.phase), s' = { ...s, phase: "unconfirmed" }
  }
  action staleRelease(ticket: int): bool = all {
    ticket <= s.issued, ticket != s.token, s' = s
  }
  action closeSettles = all {
    s.phase == "closing", any { released, releaseUnconfirmed }
  }
  action step = any {
    { nondet owner = 1.to(3).oneOf() reserve(owner) },
    { nondet ticket = 1.to(3).oneOf() staleRelease(ticket) },
    opened, cancel, lateOpen, released, releaseUnconfirmed, s' = s
  }

  val OnlyAnOwnerMayOpen = s.open implies (s.owner != 0 and s.token != 0)
  val NoReleaseWithoutReceipt = Set("opening", "running", "closing", "unconfirmed").contains(s.phase) implies
    (s.owner.in(1.to(3)) and s.token == s.issued and s.token > 0)
  val EmptySlotIsIdle = (s.owner == 0) iff (s.phase == "idle" and s.token == 0 and not(s.open))
  temporal ClosingReportsOutcome = closeSettles.weakFair(s).implies(
    always((s.phase == "closing").implies(eventually(s.phase != "closing"))))

  run twoLiveOwnersTest = init.then(reserve(1)).then(opened).then(reserve(2))
    .expect(s.owner == 1 and s.refused == 2 and s.open)
  run draftRetainsOwnerTest = init.then(reserve(3)).then(opened).then(reserve(1))
    .expect(s.owner == 3 and s.refused == 1 and s.open)
  run openingCancelledTest = init.then(reserve(1)).then(cancel).then(reserve(2))
    .expect(s.owner == 1 and s.refused == 2).then(lateOpen).then(released)
    .then(reserve(2)).then(opened).expect(s.owner == 2 and s.open)
  run releaseUnconfirmedTest = init.then(reserve(1)).then(opened).then(cancel)
    .then(releaseUnconfirmed).then(reserve(3)).expect(s.owner == 1 and s.refused == 3)
  run knownOpenFailureTest = init.then(reserve(1)).then(released).then(reserve(3))
    .expect(s.owner == 3 and s.phase == "opening")
  run failedSetupCleanupAllowsRetryTest = init.then(reserve(1)).then(opened)
    .then(cancel).then(released).then(reserve(2)).expect(s.owner == 2 and not(s.open))
  run draftReleaseRetryTest = init.then(reserve(3)).then(opened).then(cancel)
    .then(releaseUnconfirmed).then(released).then(reserve(1)).expect(s.owner == 1)
  run staleReleaseTest = init.then(reserve(1)).then(released).then(reserve(2))
    .then(staleRelease(1)).expect(s.owner == 2 and s.token == 2)
}
