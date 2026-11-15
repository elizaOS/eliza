// RemoteHostsRepository.revokeMatching takes the host lock before selecting
// bounded session and command pages with SKIP LOCKED. Replays continue cleanup.
// One active session can already own commands while another pairing is pending.
module RemoteHostRevocation {
  pure val SessionBatch = 100
  pure val CommandBatch = 500
  pure val Sessions = Set(1, 2)
  pure val Commands = Set(1, 2)
  pure val SessionOpen = Set("pending", "claimed", "activating", "active")
  pure val SessionTerminal = Set("denied", "revoked", "expired")
  pure val CommandOpen = Set("pending", "claimed", "started")
  pure val CommandTerminal = Set("completed", "failed", "cancelled", "expired", "execution_ambiguous")
  type State = {
    hostRevoked: bool,
    sessionStatus: int -> str,
    commandStatus: int -> str,
    sessionVerifier: int -> bool,
    sessionEnded: int -> bool,
    commandClaimToken: int -> bool,
    commandEnded: int -> bool,
    sessionLocks: Set[int],
    commandLocks: Set[int],
    hasReceipt: bool,
    sessionsCleaned: int,
    commandsCleaned: int,
    more: bool
  }
  var s: State
  action initCase(pairing: str, commandOne: str, commandTwo: str,
      sessionLocks: Set[int], commandLocks: Set[int]): bool = s' = {
    hostRevoked: false,
    sessionStatus: Map(1 -> pairing, 2 -> "active"),
    commandStatus: Map(1 -> commandOne, 2 -> commandTwo),
    sessionVerifier: Map(1 -> (pairing == "pending"), 2 -> false),
    sessionEnded: Sessions.mapBy(_ => false),
    commandClaimToken: Map(1 -> (commandOne != "pending"), 2 -> (commandTwo != "pending")),
    commandEnded: Commands.mapBy(_ => false),
    sessionLocks: sessionLocks, commandLocks: commandLocks,
    hasReceipt: false, sessionsCleaned: 0, commandsCleaned: 0, more: true
  }
  action init = {
    nondet pairing = SessionOpen.oneOf()
    nondet commandOne = CommandOpen.oneOf()
    nondet commandTwo = CommandOpen.oneOf()
    nondet sessionLocks = Set(Set(), Set(1), Set(2)).oneOf()
    nondet commandLocks = Set(Set(), Set(1), Set(2)).oneOf()
    initCase(pairing, commandOne, commandTwo, sessionLocks, commandLocks)
  }
  action UnlockSession(id: int): bool = all {
    s.sessionLocks.contains(id),
    s' = {...s, sessionLocks: s.sessionLocks.exclude(Set(id))}
  }
  action UnlockCommand(id: int): bool = all {
    s.commandLocks.contains(id),
    s' = {...s, commandLocks: s.commandLocks.exclude(Set(id))}
  }
  // The SQL snapshot is one host-locked transaction. Ineligible callers return
  // no row. Other host users cannot enqueue or activate once it is revoked.
  action Revoke(authorized: bool): bool = {
    // The two modeled records fit within the source limits of 100 and 500.
    // Continuation is exercised by locked rows rather than changing those limits.
    val sessionPage = Sessions.filter(id => SessionOpen.contains(s.sessionStatus.get(id)) and
      not(s.sessionLocks.contains(id)))
    val commandPage = Commands.filter(id => CommandOpen.contains(s.commandStatus.get(id)) and
      not(s.commandLocks.contains(id)))
    val sessionStatus = Sessions.mapBy(id =>
      if (sessionPage.contains(id)) "revoked" else s.sessionStatus.get(id))
    val commandStatus = Commands.mapBy(id =>
      if (not(commandPage.contains(id))) s.commandStatus.get(id)
      else if (s.commandStatus.get(id) == "started") "execution_ambiguous" else "cancelled")
    s' = if (not(authorized)) s else {
      ...s, hostRevoked: true, sessionStatus: sessionStatus, commandStatus: commandStatus,
      sessionVerifier: Sessions.mapBy(id => not(sessionPage.contains(id)) and s.sessionVerifier.get(id)),
      sessionEnded: Sessions.mapBy(id => sessionPage.contains(id) or s.sessionEnded.get(id)),
      // Started receipts remain intact for ambiguity reconciliation. Pre-start
      // claim ownership is erased when cancellation commits.
      commandClaimToken: Commands.mapBy(id =>
        if (commandPage.contains(id) and s.commandStatus.get(id) != "started") false else s.commandClaimToken.get(id)),
      commandEnded: Commands.mapBy(id => commandPage.contains(id) or s.commandEnded.get(id)),
      hasReceipt: true, sessionsCleaned: sessionPage.size(), commandsCleaned: commandPage.size(),
      more: Sessions.exists(id => SessionOpen.contains(sessionStatus.get(id))) or
        Commands.exists(id => CommandOpen.contains(commandStatus.get(id)))
    }
  }
  // Transaction failure publishes neither the host revocation nor its page.
  action StorageFailure = s' = s
  action step = any {
    { nondet authorized = Set(true, false).oneOf(); Revoke(authorized) },
    { nondet id = Sessions.oneOf(); UnlockSession(id) },
    { nondet id = Commands.oneOf(); UnlockCommand(id) },
    StorageFailure, s' = s
  }
  val Drained = Sessions.forall(id => SessionTerminal.contains(s.sessionStatus.get(id))) and
    Commands.forall(id => CommandTerminal.contains(s.commandStatus.get(id)))
  val ReceiptCoversOutstandingRows = not(s.hasReceipt) or s.more or Drained
  val TerminalSessionClearsVerifier = Sessions.forall(id =>
    s.sessionStatus.get(id) != "revoked" or (not(s.sessionVerifier.get(id)) and s.sessionEnded.get(id)))
  val CancelledCommandDropsClaim = Commands.forall(id =>
    s.commandStatus.get(id) != "cancelled" or (not(s.commandClaimToken.get(id)) and s.commandEnded.get(id)))
  val StartedReceiptBecomesAmbiguous = Commands.forall(id =>
    s.commandStatus.get(id) != "execution_ambiguous" or (s.commandClaimToken.get(id) and s.commandEnded.get(id)))
  val PageBounds = s.sessionsCleaned <= SessionBatch and s.commandsCleaned <= CommandBatch
  val TypeOK = Sessions.forall(id => SessionOpen.union(SessionTerminal).contains(s.sessionStatus.get(id))) and
    Commands.forall(id => CommandOpen.union(CommandTerminal).contains(s.commandStatus.get(id)))
  val safety = TypeOK and PageBounds and ReceiptCoversOutstandingRows and
    TerminalSessionClearsVerifier and CancelledCommandDropsClaim and StartedReceiptBecomesAmbiguous
  temporal CleanupCompletes = and {
    Revoke(true).weakFair(s),
    Sessions.forall(id => UnlockSession(id).weakFair(s)),
    Commands.forall(id => UnlockCommand(id).weakFair(s))
  } implies eventually(s.hostRevoked and Drained)
  run lockedClaimedPairingKeepsMoreTest = initCase("claimed", "pending", "started", Set(1), Set())
    .then(Revoke(true)).expect(s.hostRevoked and s.more and s.sessionStatus.get(1) == "claimed")
    .then(UnlockSession(1)).then(Revoke(true)).then(Revoke(true))
    .expect(safety and Drained and not(s.more))
  run transactionFailureLeavesAuthorityUntouchedTest = initCase("pending", "claimed", "started", Set(), Set())
    .then(StorageFailure).expect(not(s.hostRevoked) and not(s.hasReceipt))
  run unauthorizedCallerCannotRevokeTest = initCase("pending", "claimed", "started", Set(), Set())
    .then(Revoke(false)).expect(not(s.hostRevoked) and not(s.hasReceipt))
  run claimedPairingParticipatesInCleanupTest = initCase("claimed", "pending", "started", Set(), Set())
    .then(Revoke(true))
    .expect(safety and Drained and s.sessionsCleaned == 2 and not(s.more))
  run startedEvidenceSurvivesRevocationTest = initCase("active", "claimed", "started", Set(), Set())
    .then(Revoke(true)).then(Revoke(true))
    .expect(safety and s.commandStatus.get(2) == "execution_ambiguous" and s.commandClaimToken.get(2))
}
