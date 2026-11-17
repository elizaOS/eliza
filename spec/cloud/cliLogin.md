# Command-line login

A command-line client starts a login session, opens the browser for the
person to approve it, and polls the cloud until the session yields an API
key. The approval mints the key and stores it encrypted; the first poller
that claims it receives the plaintext once. A reaper removes expired
sessions and revokes any key nobody collected. Device-code login for
clients without a browser is the same session.

## Story: Log a command-line client in through the browser

> As a developer, I run the login command, approve it in the browser, and
> the command receives one API key; a session I abandon or that expires
> leaves no usable key behind.

### A session is approved once, before it expires, and mints one key

Approval captures its time before the database work, so a completion that
arrives after the session deadline cannot authenticate it. The first
approval binds the session to the approving owner and mints that owner's
key; any other approval finds the session already decided. A client is
named by a positive number, the session clock never runs below zero, and a
session still pending has minted nothing.

```quint
type CliPhase = CliPending | CliAuthenticated | CliExpired | CliDeleted
type PollStep = PollDecrypting | PollClaimed | PollDone
type PreparedApproval = { client: int, at: int }
type Poll = { poller: int, step: PollStep, key: int, owner: int, hash: int }
type KeyChange = RevokeKey | ReassignKey | RotateKeyHash
type CliLogin = { clock: int, phase: CliPhase, owner: int, key: int, keyOwner: int, keyActive: bool, keyHash: int, keyChanged: bool, consumed: bool, claimedAt: int, minted: int, approvals: List[PreparedApproval], polls: List[Poll], reveals: int }
pure val sessionDeadline = 1
pure val initial: CliLogin = { clock: 0, phase: CliPending, owner: 0, key: 0, keyOwner: 0, keyActive: false, keyHash: 1, keyChanged: false, consumed: false, claimedAt: -1, minted: 0, approvals: List(), polls: List(), reveals: 0 }
pure val clientValues = Set(1, 2)
pure def canTick(s: CliLogin): bool = true
pure def tick(s: CliLogin): CliLogin = { ...s, clock: s.clock + 1 }
pure def canPrepareApproval(s: CliLogin, client: int): bool = client > 0 and not(s.approvals.some(a => a.client == client))
pure def prepareApproval(s: CliLogin, client: int): CliLogin = { ...s, approvals: s.approvals.append({ client: client, at: s.clock }) }
pure def canCompleteApproval(s: CliLogin, client: int): bool = client > 0 and s.approvals.some(a => a.client == client and a.at >= 0)
pure def completeApproval(s: CliLogin, client: int): CliLogin = {
  val at = s.approvals.select(a => a.client == client).nthOr(0, { client: 0, at: sessionDeadline }).at
  val done = s.approvals.listMap(a => if (a.client == client) { client: client, at: -1 } else a)
  if (s.phase == CliPending and at < sessionDeadline) { ...s, phase: CliAuthenticated, owner: client, key: client, keyOwner: client, keyActive: true, minted: s.minted + 1, approvals: done }
  else { ...s, approvals: done }
}
pure def canExpireStatus(s: CliLogin): bool = s.clock >= sessionDeadline and (s.phase == CliPending or s.phase == CliAuthenticated)
pure def expireStatus(s: CliLogin): CliLogin = { ...s, phase: CliExpired }
pure def alwaysOneMintedKey(s: CliLogin): bool = s.minted <= 1 and (s.minted == 1 iff s.key != 0)
pure def alwaysPendingSessionMintedNothing(s: CliLogin): bool = s.phase == CliPending implies s.minted == 0
pure def alwaysClockNeverNegative(s: CliLogin): bool = s.clock >= 0
pure def sometimesLateApprovalRefused(s: CliLogin): bool = s.minted == 0 and s.approvals.some(a => a.at == -1) and s.phase != CliPending
```

### The plaintext key is revealed at most once, to a poller whose read still matches the session's key

A poller reads the stored key while the session is authenticated, not yet
collected and still within its deadline, and decrypts it outside the
transaction. Claiming re-reads the session and requires the same key,
owner and stored hash, the key still active, and the deadline not passed.
A lost reply after the claim never makes the key collectable again. Each
poller has one poll, and a claimed poll exists only after the session was
collected and before its key was revealed.

```quint
pure val pollerValues = Set(1, 2)
pure def pollOf(s: CliLogin, poller: int): Poll = s.polls.select(p => p.poller == poller).nthOr(0, { poller: 0, step: PollDone, key: 0, owner: 0, hash: 0 })
pure def putPoll(s: CliLogin, poll: Poll): List[Poll] = s.polls.listMap(p => if (p.poller == poll.poller) poll else p)
pure def canBeginPoll(s: CliLogin, poller: int): bool =
  not(s.polls.some(p => p.poller == poller)) and s.phase == CliAuthenticated and not(s.consumed) and s.clock < sessionDeadline and s.keyActive and s.keyOwner == s.owner
pure def beginPoll(s: CliLogin, poller: int): CliLogin = { ...s, polls: s.polls.append({ poller: poller, step: PollDecrypting, key: s.key, owner: s.owner, hash: s.keyHash }) }
pure def canClaimKey(s: CliLogin, poller: int): bool = pollOf(s, poller).poller == poller and pollOf(s, poller).step == PollDecrypting
pure def claimKey(s: CliLogin, poller: int): CliLogin = {
  val poll = pollOf(s, poller)
  if (s.phase == CliAuthenticated and not(s.consumed) and s.clock < sessionDeadline and s.keyActive and s.key == poll.key and s.keyOwner == poll.owner and s.owner == poll.owner and s.keyHash == poll.hash)
    { ...s, consumed: true, claimedAt: s.clock, polls: putPoll(s, { ...poll, step: PollClaimed }) }
  else { ...s, polls: putPoll(s, { ...poll, step: PollDone }) }
}
pure def canDeliver(s: CliLogin, poller: int): bool = pollOf(s, poller).poller == poller and pollOf(s, poller).step == PollClaimed
pure def deliver(s: CliLogin, poller: int): CliLogin = { ...s, reveals: s.reveals + 1, polls: putPoll(s, { ...pollOf(s, poller), step: PollDone }) }
pure def canLoseReply(s: CliLogin, poller: int): bool = canDeliver(s, poller)
pure def loseReply(s: CliLogin, poller: int): CliLogin = { ...s, polls: putPoll(s, { ...pollOf(s, poller), step: PollDone }) }
pure def canChangeKey(s: CliLogin, change: KeyChange): bool = s.key != 0 and not(s.keyChanged) and s.polls.some(p => p.step == PollDecrypting)
pure def changeKey(s: CliLogin, change: KeyChange): CliLogin =
  { ...s, keyChanged: true, keyActive: s.keyActive and change != RevokeKey, keyOwner: if (change == ReassignKey) 3 - s.keyOwner else s.keyOwner, keyHash: if (change == RotateKeyHash) 2 else s.keyHash }
pure def alwaysOneReveal(s: CliLogin): bool = s.reveals <= 1 and s.polls.select(p => p.step == PollClaimed).length() <= 1 and (s.reveals == 1 implies s.consumed)
pure def alwaysOnePollPerPoller(s: CliLogin): bool = s.polls.every(p => s.polls.select(o => o.poller == p.poller).length() == 1)
pure def alwaysClaimRevealedAtMostOnce(s: CliLogin): bool =
  s.reveals + s.polls.select(p => p.step == PollClaimed).length() <= 1 and (s.polls.some(p => p.step == PollClaimed) implies s.consumed)
pure def stepClaimMatchesSession(before: CliLogin, after: CliLogin): bool =
  (not(before.consumed) and after.consumed) implies (before.phase == CliAuthenticated and before.keyActive and before.keyOwner == before.owner and before.clock < sessionDeadline)
pure def sometimesKeyRevealed(s: CliLogin): bool = s.reveals == 1
pure def sometimesChangedKeyNotRevealed(s: CliLogin): bool = s.keyChanged and s.polls.some(p => p.step == PollDone) and not(s.consumed)
```

### An expired session never yields a key

```quint
pure def alwaysCollectedBeforeDeadline(s: CliLogin): bool = s.consumed implies s.claimedAt >= 0 and s.claimedAt < sessionDeadline
```

### Cleanup deletes an expired session and revokes its key only if nobody collected it

The reaper locks the session before reading its key and collection receipt,
so it serializes with approval and claiming. In one transaction it deletes
the session and revokes a key that was never collected; a collected key is
the developer's and stays active.

```quint
pure def canReap(s: CliLogin): bool = s.clock > sessionDeadline and s.phase != CliDeleted
pure def reap(s: CliLogin): CliLogin = { ...s, phase: CliDeleted, keyActive: s.keyActive and s.consumed }
pure def alwaysNoAbandonedActiveKey(s: CliLogin): bool = (s.phase == CliDeleted and not(s.consumed)) implies not(s.keyActive)
pure def stepCleanupKeepsCollectedKey(before: CliLogin, via: str, after: CliLogin): bool = (via == "reap" and before.consumed) implies after.keyActive == before.keyActive
pure def sometimesCollectedKeySurvivesCleanup(s: CliLogin): bool = s.phase == CliDeleted and s.consumed and s.keyActive
pure def sometimesAbandonedKeyRevoked(s: CliLogin): bool = s.phase == CliDeleted and s.minted == 1 and not(s.consumed) and not(s.keyActive)
```
