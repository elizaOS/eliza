# Remote agent pairing

A device pairs with one selected agent instance in two ways. Directly, the
agent's host issues a short code that the device redeems for a revocable
session. The pairing link, and the device's trust decision on its origin and
instance before it pairs, are the
[remote agent pairing contract](../contracts/remoteAgentPairing.md). Through
the cloud, a registered host creates a pairing session that a controller
claims, confirms and commits before the host accepts its commands; revoking
the host ends its sessions and settles its commands.

## Story: Pair a device with the exact selected agent instance

> As the owner of an agent, I pair my device with the instance I selected,
> after checking that I trust its origin, and the code I was shown can be
> used once.

### The agent host consumes a code only after admitting session minting

Only a trusted operator of a deployment with pairing enabled, and not
managed, reads the owner or guest code. Redeeming it needs the exact current
instance and a known peer address; an expired code is refused, invalid
attempts spend the rate limit, and a missing session store asks the device
to retry and keeps the code. Once ready, the host consumes the code before it
mints the session, so a failed mint cannot restore it; a success issues a
session with the code's owner or guest access.

```quint
type PairAccess = PairedOwner | PairedGuest
type PairPhase = UnissuedCode | AvailableCode | MintingSession | SessionIssued | SessionIssueFailed
type PairReply = NoPairReply | RetryPairing | MismatchedPairing | ExpiredPairing | InvalidPairing | ThrottledPairing | PairingDisabled | IssuedPairing | FailedPairing
type Pairing = { phase: PairPhase, role: PairAccess, serial: int, sessionId: int, reply: PairReply }
type SessionStatus = SessionPending | SessionClaimed | SessionActivating | SessionActive | SessionDenied | SessionRevoked | SessionExpired
type RemoteSession = { id: int, status: SessionStatus, verifier: bool, controller: int, confirmed: bool, committedAt: int, pairUntil: int, grantUntil: int }
type CommandStatus = CommandPending | CommandClaimed | CommandStarted | CommandCompleted | CommandFailed | CommandCancelled | CommandAmbiguous
type RemoteCommand = { command: int, session: int, status: CommandStatus, claimToken: bool, ended: bool }
type Remote = {
  code: Pairing, now: int, hostActive: bool, sessions: List[RemoteSession], commands: List[RemoteCommand], observedClaim: int,
  lockedSessions: Set[int], lockedCommands: Set[int], revocationReceipt: bool, more: bool
}
pure val initial: Remote = {
  code: { phase: UnissuedCode, role: PairedOwner, serial: 0, sessionId: 0, reply: NoPairReply }, now: 0, hostActive: true, sessions: List(), commands: List(), observedClaim: 0,
  lockedSessions: Set(), lockedCommands: Set(), revocationReceipt: false, more: false
}
pure def canIssueCode(s: Remote, operator: bool, pairingEnabled: bool): bool = s.code.phase == UnissuedCode and operator and pairingEnabled
pure def issueCode(s: Remote, operator: bool, pairingEnabled: bool, access: PairAccess): Remote =
  { ...s, code: { ...s.code, phase: AvailableCode, role: access, serial: s.code.serial + 1 } }
pure def redeemedCode(p: Pairing, pairingEnabled: bool, peerKnown: bool, instanceExact: bool, tokenExact: bool, codeExpired: bool, hasBudget: bool, storeReady: bool): Pairing =
  if (not(pairingEnabled)) { ...p, reply: PairingDisabled }
  else if (not(peerKnown)) { ...p, reply: InvalidPairing }
  else if (not(instanceExact)) { ...p, reply: MismatchedPairing }
  else if (p.phase == AvailableCode and tokenExact and codeExpired) { ...p, phase: UnissuedCode, reply: ExpiredPairing }
  else if (p.phase != AvailableCode or not(tokenExact)) { ...p, reply: if (hasBudget) InvalidPairing else ThrottledPairing }
  else if (not(storeReady)) { ...p, reply: RetryPairing }
  else { ...p, phase: MintingSession, reply: NoPairReply }
pure def canRedeemCode(s: Remote): bool = s.code.phase != MintingSession
pure def redeemCode(s: Remote, pairingEnabled: bool, peerKnown: bool, instanceExact: bool, tokenExact: bool, codeExpired: bool, hasBudget: bool, storeReady: bool): Remote =
  { ...s, code: redeemedCode(s.code, pairingEnabled, peerKnown, instanceExact, tokenExact, codeExpired, hasBudget, storeReady) }
pure def canFinishMint(s: Remote): bool = s.code.phase == MintingSession
pure def finishMint(s: Remote, saved: bool): Remote =
  if (saved) { ...s, code: { ...s.code, phase: SessionIssued, sessionId: s.code.serial, reply: IssuedPairing } }
  else { ...s, code: { ...s.code, phase: SessionIssueFailed, reply: FailedPairing } }
pure def alwaysPairingCoordinates(s: Remote): bool =
  s.code.serial >= 0 and s.code.sessionId >= 0 and s.code.sessionId <= s.code.serial and
  ((s.code.phase == SessionIssued) == (s.code.sessionId > 0)) and (s.code.phase != UnissuedCode implies s.code.serial > 0)
pure def alwaysTransientPairReplyKeepsCode(s: Remote): bool = s.code.reply == RetryPairing implies s.code.phase == AvailableCode
pure def stepFinishedMintCannotBeRepeated(before: Remote, via: str, after: Remote): bool =
  ((before.code.phase == SessionIssued or before.code.phase == SessionIssueFailed) and via == "redeemCode") implies
    after.code.phase == before.code.phase and after.code.sessionId == before.code.sessionId
pure def sometimesPairingRetries(s: Remote): bool = s.code.reply == RetryPairing
pure def sometimesGuestPaired(s: Remote): bool = s.code.phase == SessionIssued and s.code.role == PairedGuest
pure def sometimesCodeConsumedWithoutSession(s: Remote): bool = s.code.phase == SessionIssueFailed
```

## Story: Pair a controller with a registered host through the cloud

> As the owner of a host registered with the cloud, I start a pairing on the
> host, claim it from my controller with the code, confirm it, and the host
> commits it; only then does the host accept my commands, and revoking the
> host stops all of it.

### A host has at most one unclaimed pairing, and a pending pairing holds only its verifier

An authenticated host creates a pairing with a code deadline and a longer
grant deadline. Creating one denies any other pairing that was not yet
claimed or was claimed but not confirmed, or expires it if its code
deadline passed.

```quint
pure val pairWindow = 2
pure val grantWindow = 3
pure val noSession: RemoteSession = { id: 0, status: SessionDenied, verifier: false, controller: 0, confirmed: false, committedAt: -1, pairUntil: -1, grantUntil: -1 }
pure def sessionOf(s: Remote, id: int): RemoteSession = s.sessions.select(r => r.id == id).nthOr(0, noSession)
pure def hasSession(s: Remote, id: int): bool = s.sessions.some(r => r.id == id)
pure def putSession(s: Remote, row: RemoteSession): List[RemoteSession] = s.sessions.listMap(r => if (r.id == row.id) row else r)
pure def unstaged(st: SessionStatus): bool = st == SessionPending or st == SessionClaimed
pure def beforeCommit(st: SessionStatus): bool = unstaged(st) or st == SessionActivating
pure def openSession(st: SessionStatus): bool = beforeCommit(st) or st == SessionActive
pure def codeExpiredAt(r: RemoteSession, now: int): bool = now >= r.pairUntil
pure def ended(r: RemoteSession, st: SessionStatus): RemoteSession = { ...r, status: st, verifier: false }
pure val idValues = Set(1, 2)
pure val controllerValues = Set(1, 2)
pure def canTick(s: Remote): bool = true
pure def tick(s: Remote): Remote = { ...s, now: s.now + 1 }
pure def canIssueSession(s: Remote, id: int, authenticated: bool): bool = authenticated and s.hostActive and id > 0 and not(hasSession(s, id))
pure def issueSession(s: Remote, id: int, authenticated: bool): Remote = {
  val others = s.sessions.listMap(r => if (r.status == SessionPending and codeExpiredAt(r, s.now)) ended(r, SessionExpired) else if (unstaged(r.status)) ended(r, SessionDenied) else r)
  { ...s, sessions: others.append({ id: id, status: SessionPending, verifier: true, controller: 0, confirmed: false, committedAt: -1, pairUntil: s.now + pairWindow, grantUntil: s.now + grantWindow }) }
}
pure def alwaysOneUnclaimedPairing(s: Remote): bool = s.sessions.select(r => unstaged(r.status)).length() <= 1
pure def alwaysPendingHoldsOnlyVerifier(s: Remote): bool = s.sessions.every(r => (r.status == SessionPending implies r.verifier and r.controller == 0) and (r.verifier implies (r.status == SessionPending or r.status == SessionExpired)))
```

### A claim binds one controller and spends the verifier

The claim must match the tenant, owner, host, pairing and code, while the
host is active and the code deadline has not passed. A wrong code leaves the
pairing untouched.

```quint
pure def canClaimSession(s: Remote, id: int, controller: int, codeMatches: bool): bool = {
  val r = sessionOf(s, id)
  codeMatches and s.hostActive and hasSession(s, id) and r.status == SessionPending and r.verifier and not(codeExpiredAt(r, s.now)) and controller > 0
}
pure def claimSession(s: Remote, id: int, controller: int, codeMatches: bool): Remote = { ...s, sessions: putSession(s, { ...sessionOf(s, id), status: SessionClaimed, verifier: false, controller: controller }) }
pure def alwaysClaimedHasController(s: Remote): bool = s.sessions.every(r => (r.status == SessionClaimed or r.status == SessionActivating or r.status == SessionActive) implies (r.controller > 0 and not(r.verifier)))
```

### Confirmation re-reads the pairing, so an earlier read grants no authority

The controller's authenticated preflight observes a claimed pairing (or
expires one whose code deadline passed). Confirmation then reads the row
again and moves it to activation only if the host is still active, the row
is still claimed and its code deadline has not passed.

```quint
pure def canObserveClaim(s: Remote, id: int, authenticated: bool): bool = {
  val r = sessionOf(s, id)
  s.observedClaim == 0 and authenticated and s.hostActive and hasSession(s, id) and (r.status == SessionClaimed or (unstaged(r.status) and codeExpiredAt(r, s.now)))
}
pure def observeClaim(s: Remote, id: int, authenticated: bool): Remote = {
  val r = sessionOf(s, id)
  if (unstaged(r.status) and codeExpiredAt(r, s.now)) { ...s, sessions: putSession(s, ended(r, SessionExpired)) } else { ...s, observedClaim: id }
}
pure def canConfirmClaim(s: Remote): bool = s.observedClaim > 0
pure def confirmClaim(s: Remote): Remote = {
  val r = sessionOf(s, s.observedClaim)
  val result = if (not(s.hostActive) or r.status != SessionClaimed) r else if (codeExpiredAt(r, s.now)) ended(r, SessionExpired) else { ...r, status: SessionActivating, confirmed: true }
  { ...s, sessions: putSession(s, result), observedClaim: 0 }
}
pure def canDropObservation(s: Remote): bool = s.observedClaim > 0
pure def dropObservation(s: Remote): Remote = { ...s, observedClaim: 0 }
pure def alwaysActivationIsConfirmed(s: Remote): bool = s.sessions.every(r => (r.status == SessionActivating or r.status == SessionActive) implies r.confirmed)
```

### The host commits a confirmed pairing before both deadlines, and only a committed pairing carries commands

The host's own credential commits the activation; the cloud checks the live
host, the exact stage and both deadlines. A pairing that missed a deadline
expires instead. The host may deny a pairing before it commits, and the
owner may revoke any open pairing. The clock is never negative, and a
pairing still awaiting its commit has no commit time.

```quint
pure def canCommitSession(s: Remote, id: int, authenticated: bool): bool = authenticated and s.hostActive and sessionOf(s, id).status == SessionActivating
pure def commitSession(s: Remote, id: int, authenticated: bool): Remote = {
  val r = sessionOf(s, id)
  { ...s, sessions: putSession(s, if (codeExpiredAt(r, s.now) or s.now >= r.grantUntil) ended(r, SessionExpired) else { ...r, status: SessionActive, committedAt: s.now }) }
}
pure def canRevokeSession(s: Remote, id: int, authorized: bool): bool = authorized and hasSession(s, id) and openSession(sessionOf(s, id).status)
pure def revokeSession(s: Remote, id: int, authorized: bool): Remote = {
  val r = sessionOf(s, id)
  { ...s, sessions: putSession(s, ended(r, if (unstaged(r.status) and codeExpiredAt(r, s.now)) SessionExpired else SessionRevoked)) }
}
pure def canCompensate(s: Remote, id: int, authenticated: bool): bool = authenticated and hasSession(s, id) and beforeCommit(sessionOf(s, id).status)
pure def compensate(s: Remote, id: int, authenticated: bool): Remote = { ...s, sessions: putSession(s, ended(sessionOf(s, id), SessionDenied)) }
pure def permitsCommands(s: Remote, id: int): bool = s.hostActive and sessionOf(s, id).status == SessionActive and s.now < sessionOf(s, id).grantUntil
pure def alwaysCommitTimeIsSetOnlyByCommit(s: Remote): bool = s.now >= 0 and s.sessions.every(r => beforeCommit(r.status) implies r.committedAt < 0)
pure def alwaysCommittedBeforeDeadline(s: Remote): bool = s.sessions.every(r => r.committedAt >= 0 implies (r.confirmed and r.committedAt < r.pairUntil))
pure def alwaysCommandsNeedCommittedPairing(s: Remote): bool = s.sessions.every(r => permitsCommands(s, r.id) implies (r.confirmed and r.committedAt >= 0))
pure def sometimesPairingCommitted(s: Remote): bool = s.sessions.some(r => r.status == SessionActive)
```

### Each pairing id names one pairing, whose owner, deadlines and outcome never change once recorded

A pairing id is positive and names exactly one pairing.

```quint
pure def alwaysOnePairingPerId(s: Remote): bool = s.sessions.every(a => a.id > 0 and s.sessions.every(b => a.id == b.id implies a == b))
pure def stepPairingOwnershipIsDurable(before: Remote, after: Remote): bool =
  before.sessions.every(r => hasSession(after, r.id) and sessionOf(after, r.id).pairUntil == r.pairUntil and sessionOf(after, r.id).grantUntil == r.grantUntil
    and (r.controller != 0 implies sessionOf(after, r.id).controller == r.controller) and (r.confirmed implies sessionOf(after, r.id).confirmed)
    and (r.committedAt >= 0 implies sessionOf(after, r.id).committedAt == r.committedAt)
    and ((r.status == SessionDenied or r.status == SessionRevoked or r.status == SessionExpired) implies sessionOf(after, r.id).status == r.status))
```

### Each command number names one command, claimed, started and completed at most once, and only while its pairing carries commands

A command number names one command, and a claimed or started command holds
its claim receipt.

```quint
pure val commandValues = Set(1, 2)
pure val noCommand: RemoteCommand = { command: 0, session: 0, status: CommandCancelled, claimToken: false, ended: false }
pure def commandOf(s: Remote, command: int): RemoteCommand = s.commands.select(c => c.command == command).nthOr(0, noCommand)
pure def putCommand(s: Remote, c: RemoteCommand): List[RemoteCommand] = s.commands.listMap(x => if (x.command == c.command) c else x)
pure def commandOpen(st: CommandStatus): bool = st == CommandPending or st == CommandClaimed or st == CommandStarted
pure def canEnqueueCommand(s: Remote, command: int, id: int): bool = command > 0 and not(s.commands.some(c => c.command == command)) and permitsCommands(s, id)
pure def enqueueCommand(s: Remote, command: int, id: int): Remote = { ...s, commands: s.commands.append({ command: command, session: id, status: CommandPending, claimToken: false, ended: false }) }
pure def canAdvanceCommand(s: Remote, command: int, succeeded: bool): bool = commandOpen(commandOf(s, command).status) and commandOf(s, command).command == command and permitsCommands(s, commandOf(s, command).session)
pure def advanceCommand(s: Remote, command: int, succeeded: bool): Remote = {
  val c = commandOf(s, command)
  { ...s, commands: putCommand(s, if (c.status == CommandPending) { ...c, status: CommandClaimed, claimToken: true }
    else if (c.status == CommandClaimed) { ...c, status: CommandStarted }
    else { ...c, status: if (succeeded) CommandCompleted else CommandFailed, ended: true }) }
}
pure def alwaysOneCommandPerNumber(s: Remote): bool = s.commands.every(a => s.commands.every(b => a.command == b.command implies a == b))
pure def alwaysClaimedCommandHoldsItsClaim(s: Remote): bool = s.commands.every(c => (c.status == CommandClaimed or c.status == CommandStarted) implies c.claimToken)
pure def stepSettledCommandIsFinal(before: Remote, after: Remote): bool =
  before.commands.every(c => not(commandOpen(c.status)) implies commandOf(after, c.command) == c)
pure def sometimesCommandCompleted(s: Remote): bool = s.commands.some(c => c.status == CommandCompleted)
```

## Story: Revoke a host and everything it was paired with

> As an owner, I revoke a registered host; it accepts no new pairing or
> command at once, and every pairing and command it had is ended, even when
> some of them were busy at that moment.

### Revocation ends the host at once and cleans up its pairings and commands in bounded pages

Revocation takes the host lock, marks the host revoked and, in the same
transaction, ends every open pairing and settles every open command that is
not locked by other work: a command that had started becomes ambiguous and
keeps its claim receipt for reconciliation, and one that had not started is
cancelled and loses its claim. Locked rows are skipped, and the receipt says
whether rows remain; repeating the revocation continues the cleanup. A
failed transaction publishes nothing. Only revocation writes a receipt, and
the same transaction ends the host, so a live host has no revocation
receipt.

```quint
pure def canLockSession(s: Remote, id: int): bool = hasSession(s, id) and not(s.lockedSessions.contains(id))
pure def lockSession(s: Remote, id: int): Remote = { ...s, lockedSessions: s.lockedSessions.union(Set(id)) }
pure def canUnlockSession(s: Remote, id: int): bool = s.lockedSessions.contains(id)
pure def unlockSession(s: Remote, id: int): Remote = { ...s, lockedSessions: s.lockedSessions.exclude(Set(id)) }
pure def canLockCommand(s: Remote, command: int): bool = s.commands.some(c => c.command == command) and not(s.lockedCommands.contains(command))
pure def lockCommand(s: Remote, command: int): Remote = { ...s, lockedCommands: s.lockedCommands.union(Set(command)) }
pure def canUnlockCommand(s: Remote, command: int): bool = s.lockedCommands.contains(command)
pure def unlockCommand(s: Remote, command: int): Remote = { ...s, lockedCommands: s.lockedCommands.exclude(Set(command)) }
pure def canRevokeHost(s: Remote, authorized: bool): bool = authorized and (s.hostActive or s.more)
pure def revokeHost(s: Remote, authorized: bool): Remote = {
  val sessions = s.sessions.listMap(r => if (openSession(r.status) and not(s.lockedSessions.contains(r.id))) ended(r, SessionRevoked) else r)
  val commands = s.commands.listMap(c => if (commandOpen(c.status) and not(s.lockedCommands.contains(c.command)))
    (if (c.status == CommandStarted) { ...c, status: CommandAmbiguous, ended: true } else { ...c, status: CommandCancelled, claimToken: false, ended: true }) else c)
  { ...s, hostActive: false, sessions: sessions, commands: commands, observedClaim: 0, revocationReceipt: true,
    more: sessions.some(r => openSession(r.status)) or commands.some(c => commandOpen(c.status)) }
}
pure def alwaysLiveHostHasNoRevocationReceipt(s: Remote): bool = s.hostActive implies not(s.revocationReceipt)
pure def alwaysReceiptCoversOutstandingRows(s: Remote): bool = (s.revocationReceipt and not(s.more)) implies (s.sessions.every(r => not(openSession(r.status))) and s.commands.every(c => not(commandOpen(c.status))))
pure def alwaysRevokedHostKeepsOnlyLockedWork(s: Remote): bool = not(s.hostActive) implies (s.revocationReceipt and (s.more or (s.sessions.every(r => not(openSession(r.status))) and s.commands.every(c => not(commandOpen(c.status))))))
pure def alwaysCancelledCommandDropsClaim(s: Remote): bool = s.commands.every(c => c.status == CommandCancelled implies (not(c.claimToken) and c.ended))
pure def alwaysStartedCommandBecomesAmbiguous(s: Remote): bool = s.commands.every(c => c.status == CommandAmbiguous implies (c.claimToken and c.ended))
pure def alwaysRevokedPairingHasNoVerifier(s: Remote): bool = s.sessions.every(r => r.status == SessionRevoked implies not(r.verifier))
pure def sometimesRevocationLeavesLockedWork(s: Remote): bool = not(s.hostActive) and s.more
pure def sometimesRevocationDrained(s: Remote): bool = not(s.hostActive) and not(s.more) and s.commands.some(c => c.status == CommandAmbiguous)
```

### An unclaimed or unconfirmed pairing always resolves once time passes

The sweeper expires a pairing whose code deadline passed before it was
committed.

```quint
pure def canSweep(s: Remote, id: int): bool = hasSession(s, id) and beforeCommit(sessionOf(s, id).status) and codeExpiredAt(sessionOf(s, id), s.now)
pure def sweep(s: Remote, id: int): Remote = { ...s, sessions: putSession(s, { ...sessionOf(s, id), status: SessionExpired }) }
pure val fair_tick = "weak"
pure val fair_sweep = "weak"
pure def leadsToPairingResolves(s: Remote, later: Remote): bool = s.sessions.every(r => beforeCommit(r.status) implies not(beforeCommit(sessionOf(later, r.id).status)))
```
