# Durable interaction sessions

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/messaging/interaction-sessions.ts` and `quint/InteractionSession.qnt`. A session authorizes one external invocation under a claim identity, response digest, owner binding, lease and absolute expiry. Claim, commit, invocation, completion and reconciliation are distinct transitions. A committed session remains recoverable after process loss and never returns to claimable pending state.

## Story: Retry an interaction without repeating its external effect

As a caller, I can retry a response with the same digest and obtain its existing status. A different response digest cannot reuse the committed authority. An expired uncommitted lease may be reacquired with a fresh claim token. Only the current claim can commit before both deadlines. The session row is retained while a committed outcome is ambiguous.

### Creating a session binds its owner and expiration

```quint
type SessionOwner = { agentId: str, actorId: str, connector: str }
type SessionPhase = Absent | Pending | Claimed | Committed | Completed
type Session = { phase: SessionPhase, rowPresent: bool, owner: SessionOwner, digest: str, claimSequence: int, currentClaim: int, invokedClaim: int, leaseUntil: int, expiresAt: int, now: int, authorized: bool, effects: int, executorAlive: bool, outcomeKnown: bool }
pure val initial: Session = { phase: Absent, rowPresent: false, owner: { agentId: "", actorId: "", connector: "" }, digest: "", claimSequence: 0, currentClaim: 0, invokedClaim: 0, leaseUntil: 0, expiresAt: 0, now: 0, authorized: false, effects: 0, executorAlive: false, outcomeKnown: false }
pure val byValues = Set({ agentId: "agent1", actorId: "actor1", connector: "web" }, { agentId: "agent2", actorId: "actor2", connector: "chat" })
pure def canCreate(s: Session, by: SessionOwner, expiresAt: int): bool = s.phase == Absent and by.agentId != "" and by.actorId != "" and by.connector != "" and expiresAt > s.now
pure def create(s: Session, by: SessionOwner, expiresAt: int): Session = { ...s, phase: Pending, rowPresent: true, owner: by, expiresAt: expiresAt, authorized: true }
pure val expiresAtValues = Set(5, 10, 20)
pure def canElapse(s: Session, elapsed: int): bool = elapsed >= 0
pure def elapse(s: Session, elapsed: int): Session = { ...s, now: s.now + elapsed }
pure val elapsedValues = Set(0, 1, 3, 10)
```

### A current matching claim commits only before lease and session expiry

Claim tokens increase for every acquisition. A holder of an expired token cannot commit after another caller reacquires the same response. Owner identity must match the durable session owner.

```quint
pure def canAcquire(s: Session, by: SessionOwner, responseDigest: str, leaseDuration: int): bool =
  s.rowPresent and s.owner == by and s.authorized and s.now < s.expiresAt and responseDigest != "" and leaseDuration > 0 and (s.phase == Pending or (s.phase == Claimed and s.now >= s.leaseUntil and responseDigest == s.digest))
pure def acquire(s: Session, by: SessionOwner, responseDigest: str, leaseDuration: int): Session = { ...s, phase: Claimed, digest: responseDigest, claimSequence: s.claimSequence + 1, currentClaim: s.claimSequence + 1, leaseUntil: s.now + leaseDuration, executorAlive: true }
pure val responseDigestValues = Set("responseA", "responseB")
pure val leaseDurationValues = Set(1, 3, 5)
pure val claimTokenValues = Set(0, 1, 2, 3)
pure def canCommit(s: Session, by: SessionOwner, claimToken: int, responseDigest: str): bool = s.rowPresent and s.phase == Claimed and s.authorized and s.owner == by and s.currentClaim == claimToken and s.digest == responseDigest and s.now < s.leaseUntil and s.now < s.expiresAt
pure def commit(s: Session, by: SessionOwner, claimToken: int, responseDigest: str): Session = { ...s, phase: Committed }
pure def stepCommitIsAuthorizedAndTimely(before: Session, via: str, after: Session): bool =
  via != "commit" or (before.authorized and before.now < before.leaseUntil and before.now < before.expiresAt and after.phase == Committed)
pure def canRevoke(s: Session): bool = s.phase == Pending or s.phase == Claimed
pure def revoke(s: Session): Session = { ...s, authorized: false }
```

### Only the committing owner may invoke and committed ambiguity cannot be reclaimed

A process loss after commit retains the committed row. Reconciliation can complete only after authoritative evidence establishes invocation. Retrying a committed or completed response reports existing status and never grants another invocation.

```quint
pure def canInvoke(s: Session, by: SessionOwner, claimToken: int): bool = s.phase == Committed and s.owner == by and s.currentClaim == claimToken and s.effects == 0 and s.executorAlive
pure def invoke(s: Session, by: SessionOwner, claimToken: int): Session = { ...s, effects: 1, invokedClaim: claimToken }
pure def canLoseExecutor(s: Session): bool = s.phase == Claimed or s.phase == Committed
pure def loseExecutor(s: Session): Session = { ...s, executorAlive: false }
pure def canRecordOutcome(s: Session): bool = s.phase == Committed and s.effects == 1
pure def recordOutcome(s: Session): Session = { ...s, outcomeKnown: true }
pure def canComplete(s: Session): bool = s.phase == Committed and s.effects == 1 and s.outcomeKnown
pure def complete(s: Session): Session = { ...s, phase: Completed }
pure def replayAllowed(s: Session, by: SessionOwner, responseDigest: str): bool = s.rowPresent and s.phase == Completed and s.owner == by and s.digest == responseDigest
pure def alwaysEffectHasCommittedOwner(s: Session): bool = s.effects > 0 implies ((s.phase == Committed or s.phase == Completed) and s.invokedClaim == s.currentClaim and s.currentClaim > 0)
pure def alwaysAtMostOneInvocation(s: Session): bool = s.effects >= 0 and s.effects <= 1
pure def alwaysCompletedHasOutcome(s: Session): bool = s.phase == Completed implies (s.effects == 1 and s.outcomeKnown)
pure def alwaysLiveClaimHasToken(s: Session): bool = (s.phase == Claimed or s.phase == Committed or s.phase == Completed) implies s.currentClaim > 0
pure def alwaysClaimSequenceIsValid(s: Session): bool = s.claimSequence >= 0 and s.currentClaim >= 0 and s.currentClaim <= s.claimSequence and s.now >= 0
pure def stepCommitNeverReopens(before: Session, after: Session): bool = (before.phase == Committed or before.phase == Completed) implies (after.phase == Committed or after.phase == Completed)
pure def sometimesReacquiredLease(s: Session): bool = s.currentClaim > 1 and s.phase == Claimed
pure def sometimesAmbiguousCommitSurvivesCrash(s: Session): bool = s.phase == Committed and not(s.executorAlive) and not(s.outcomeKnown)
pure def sometimesSessionCompletes(s: Session): bool = s.phase == Completed
```

### An invoked effect eventually records its outcome when authoritative evidence arrives

Reconciliation and final persistence must run under weak fairness after an invoked effect has authoritative outcome evidence. A committed session which crashed before invocation retains its ambiguous authority and has no automatic re-execution promise.

```quint
pure val fair_recordOutcome = "weak"
pure val fair_complete = "weak"
pure def leadsToInvokedEffectRecorded(s: Session, later: Session): bool = s.effects == 1 implies later.phase == Completed
```

### Cleanup retains ambiguous committed sessions and removes only eligible rows

Completed sessions and expired uncommitted sessions are sweepable. A committed session without an established terminal outcome stays durable for reconciliation.

```quint
pure def canDeleteExpired(s: Session): bool = s.rowPresent and (s.phase == Completed or ((s.phase == Pending or s.phase == Claimed) and s.now >= s.expiresAt))
pure def deleteExpired(s: Session): Session = { ...s, rowPresent: false }
pure def alwaysAmbiguousCommitRemainsDurable(s: Session): bool = s.phase == Committed implies s.rowPresent
pure val fair_deleteExpired = "weak"
pure def leadsToEligibleCleanup(s: Session, later: Session): bool = canDeleteExpired(s) implies not(later.rowPresent)
```
