# Atomic multi-session interaction store

The source is `packages/core/src/messaging/interaction-sessions.ts:870-1023`. This aggregate owns the full reference-keyed map and FIFO atomic-operation tail. Each row composes [the session protocol](./sessions.md), complete trusted context bindings, authorization decision identity, revision and commit/completion times. The store's `get` is an internal unscoped clone; claim authorization compares every binding field. Absolute clock observations may rewind, matching the supplied source `now` values; claim and commit guards re-evaluate their deadlines against that observation. Reconciliation and cleanup keep their separately supplied cutoff. Reference collation for reconciliation listing is an explicit host locale-comparison boundary; the supplied ordered reference list must contain the complete eligible set before the requested page limit is applied.

## Story: Serialize independent sessions without sharing authority

### One admitted transaction owns each atomic map operation

```quint
import sessions as S from "./sessions"
type SessionBindings = { actorId: str, audienceKind: str, audienceId: str, agentId: str, connectorSource: str, accountId: str, roomId: str, sourceMessageId: str }
type StoredSession = { reference: str, bindings: SessionBindings, decisionId: str, replayKey: str, revision: int, committedAt: int, completedAt: int, session: S::Session }
type SessionTransaction = { id: int, reference: str }
type SessionCommand = AcquireSession | CommitSession | InvokeSession | LoseSessionExecutor | RecordSessionOutcome | CompleteSession | RevokeSession
 type SessionStore = { rows: List[StoredSession], waiting: List[SessionTransaction], usedTransactions: Set[int], active: SessionTransaction, applied: bool, now: int, snapshot: StoredSession, snapshotPresent: bool, listed: List[str] }
pure val emptyBindings: SessionBindings = { actorId: "", audienceKind: "", audienceId: "", agentId: "", connectorSource: "", accountId: "", roomId: "", sourceMessageId: "" }
pure val emptyRow: StoredSession = { reference: "", bindings: emptyBindings, decisionId: "", replayKey: "", revision: 0, committedAt: 0, completedAt: 0, session: S::initial }
pure val initial: SessionStore = { rows: List(), waiting: List(), usedTransactions: Set(), active: { id: 0, reference: "" }, applied: false, now: 0, snapshot: emptyRow, snapshotPresent: false, listed: List() }
pure val transactionIdValues = Set(1, 2, 3, 4)
pure val referenceValues = Set("session1", "session2", "unknown")
pure val bindingsValues = Set({ actorId: "actor1", audienceKind: "dm", audienceId: "room1", agentId: "agent1", connectorSource: "web", accountId: "account1", roomId: "room1", sourceMessageId: "message1" }, { actorId: "actor2", audienceKind: "dm", audienceId: "room2", agentId: "agent2", connectorSource: "chat", accountId: "account2", roomId: "room2", sourceMessageId: "message2" })
pure val commandValues = Set(AcquireSession, CommitSession, InvokeSession, LoseSessionExecutor, RecordSessionOutcome, CompleteSession, RevokeSession)
pure val decisionIdValues = Set("decision1", "decision2")
pure val replayKeyValues = Set("replay1", "replay2")
pure val responseDigestValues = S::responseDigestValues
pure val leaseDurationValues = S::leaseDurationValues
pure val claimTokenValues = S::claimTokenValues
pure val expiresAtValues = S::expiresAtValues
pure val elapsedValues = S::elapsedValues
pure val cutoffValues = Set(0, 3, 10, 20)
pure val limitValues = Set(1, 2, 3)
pure val orderedReferencesValues = Set(List(), List("session1"), List("session2"), List("session1", "session2"))
pure def rowAt(s: SessionStore, reference: str): StoredSession = s.rows.select(row => row.reference == reference).nthOr(0, emptyRow)
pure def owner(bindings: SessionBindings): S::SessionOwner = { agentId: bindings.agentId, actorId: bindings.actorId, connector: bindings.connectorSource }
pure def canAdmitTransaction(s: SessionStore, transactionId: int, reference: str): bool = transactionId > 0 and not(s.usedTransactions.contains(transactionId))
pure def admitTransaction(s: SessionStore, transactionId: int, reference: str): SessionStore = { ...s, waiting: s.waiting.append({ id: transactionId, reference: reference }), usedTransactions: s.usedTransactions.union(Set(transactionId)) }
pure def canBeginTransaction(s: SessionStore): bool = s.active.id == 0 and s.waiting.length() > 0
pure def beginTransaction(s: SessionStore): SessionStore = { ...s, active: s.waiting.nthOr(0, { id: 0, reference: "" }), waiting: s.waiting.removeAt(0), applied: false }
pure def canEndTransaction(s: SessionStore): bool = s.active.id != 0 and s.applied
pure def endTransaction(s: SessionStore): SessionStore = { ...s, active: { id: 0, reference: "" }, applied: false }
pure def canRejectTransaction(s: SessionStore): bool = s.active.id != 0 and not(s.applied)
pure def rejectTransaction(s: SessionStore): SessionStore = { ...s, applied: true }
pure def canCreateSession(s: SessionStore, bindings: SessionBindings, decisionId: str, expiresAt: int): bool = s.active.id != 0 and not(s.applied) and s.active.reference != "" and not(s.rows.some(row => row.reference == s.active.reference)) and decisionId != "" and S::canCreate({ ...S::initial, now: s.now }, owner(bindings), expiresAt)
pure def createSession(s: SessionStore, bindings: SessionBindings, decisionId: str, expiresAt: int): SessionStore = { ...s, applied: true, rows: s.rows.append({ reference: s.active.reference, bindings: bindings, decisionId: decisionId, replayKey: "", revision: 0, committedAt: 0, completedAt: 0, session: S::create({ ...S::initial, now: s.now }, owner(bindings), expiresAt) }) }
pure def canReadSession(s: SessionStore): bool = s.active.id != 0 and not(s.applied)
pure def readSession(s: SessionStore): SessionStore = { ...s, applied: true, snapshot: rowAt(s, s.active.reference), snapshotPresent: rowAt(s, s.active.reference).reference != "" }
pure def canModifyReturnedSnapshot(s: SessionStore): bool = s.snapshotPresent
pure def modifyReturnedSnapshot(s: SessionStore): SessionStore = { ...s, snapshot: { ...s.snapshot, revision: s.snapshot.revision + 1 } }
```

### Complete context and claim identities authorize only the selected row

Discovered by the proof: the queue contains only positive transaction IDs, and each stored session retains its component claim and completion invariants. The zero ID is the idle slot, not a queued transaction; a durable row cannot create a second invocation from fabricated claim state. The store clock stays nonnegative even before its first row is inserted.

```quint
pure def canAdvanceSession(s: SessionStore, command: SessionCommand, bindings: SessionBindings, decisionId: str, replayKey: str, responseDigest: str, leaseDuration: int, claimToken: int): bool = {
  val row = rowAt(s, s.active.reference)
  val session = row.session
  val claimsMatch = replayKey == row.replayKey and claimToken == session.currentClaim
  s.active.id != 0 and not(s.applied) and row.reference != "" and (
    if (command == AcquireSession) row.bindings == bindings and replayKey != "" and (row.replayKey == "" or row.replayKey == replayKey) and S::canAcquire(session, owner(bindings), responseDigest, leaseDuration)
    else if (command == CommitSession) claimsMatch and S::canCommit(session, session.owner, claimToken, responseDigest)
    else if (command == InvokeSession) claimsMatch and S::canInvoke(session, session.owner, claimToken)
    else if (command == LoseSessionExecutor) S::canLoseExecutor(session)
    else if (command == RecordSessionOutcome) claimsMatch and S::canRecordOutcome(session)
    else if (command == CompleteSession) claimsMatch and S::canComplete(session)
    else row.decisionId == decisionId and S::canRevoke(session)
  )
}
pure def advanceSession(s: SessionStore, command: SessionCommand, bindings: SessionBindings, decisionId: str, replayKey: str, responseDigest: str, leaseDuration: int, claimToken: int): SessionStore = {
  val row = rowAt(s, s.active.reference)
  val session = row.session
  val nextState = if (command == AcquireSession) S::acquire(session, owner(bindings), responseDigest, leaseDuration) else if (command == CommitSession) S::commit(session, session.owner, claimToken, responseDigest) else if (command == InvokeSession) S::invoke(session, session.owner, claimToken) else if (command == LoseSessionExecutor) S::loseExecutor(session) else if (command == RecordSessionOutcome) S::recordOutcome(session) else if (command == CompleteSession) S::complete(session) else S::revoke(session)
  { ...s, applied: true, rows: s.rows.listMap(existing => if (existing.reference == row.reference) { ...row, session: nextState, replayKey: if (command == AcquireSession) replayKey else row.replayKey, revision: row.revision + (if (command == AcquireSession or command == CommitSession or command == CompleteSession or command == RevokeSession) 1 else 0), committedAt: if (command == CommitSession) s.now else row.committedAt, completedAt: if (command == CompleteSession) s.now else row.completedAt } else existing) }
}
pure def canElapse(s: SessionStore, elapsed: int): bool = elapsed >= 0
pure def elapse(s: SessionStore, elapsed: int): SessionStore = { ...s, now: s.now + elapsed, rows: s.rows.listMap(row => { ...row, session: S::elapse(row.session, elapsed) }) }
pure val nowValues = Set(0, 1, 5, 10)
pure def canObserveTime(s: SessionStore, now: int): bool = now >= 0
pure def observeTime(s: SessionStore, now: int): SessionStore = { ...s, now: now, rows: s.rows.listMap(row => { ...row, session: { ...row.session, now: now } }) }
pure def eligibleCommitted(s: SessionStore, cutoff: int): Set[str] = s.rows.select(row => row.session.phase == S::Committed and row.committedAt <= cutoff).foldl(Set(), (references, row) => references.union(Set(row.reference)))
pure def canListCommitted(s: SessionStore, cutoff: int, limit: int, orderedReferences: List[str]): bool = s.active.id != 0 and not(s.applied) and cutoff >= 0 and limit > 0 and orderedReferences.length() == eligibleCommitted(s, cutoff).size() and orderedReferences.every(reference => eligibleCommitted(s, cutoff).contains(reference)) and orderedReferences.every(reference => orderedReferences.select(other => other == reference).length() == 1)
pure def listCommitted(s: SessionStore, cutoff: int, limit: int, orderedReferences: List[str]): SessionStore = { ...s, applied: true, listed: orderedReferences.foldl(List(), (page, reference) => if (page.length() < limit) page.append(reference) else page) }
pure def canDeleteExpired(s: SessionStore, cutoff: int): bool = s.active.id != 0 and not(s.applied) and cutoff >= 0
pure def deleteExpired(s: SessionStore, cutoff: int): SessionStore = { ...s, applied: true, rows: s.rows.select(row => row.session.phase == S::Committed or (if (row.session.phase == S::Completed) row.completedAt > cutoff else row.session.expiresAt > cutoff)) }
pure def alwaysSessionReferencesAreUnique(s: SessionStore): bool = s.now >= 0 and s.rows.every(row => row.reference != "" and s.rows.select(other => other.reference == row.reference).length() == 1 and row.session.now == s.now and row.session.owner == owner(row.bindings))
pure def alwaysEverySessionKeepsItsEffect(s: SessionStore): bool = s.rows.every(row => S::alwaysAtMostOneInvocation(row.session) and S::alwaysEffectHasCommittedOwner(row.session) and S::alwaysAmbiguousCommitRemainsDurable(row.session) and S::alwaysCompletedHasOutcome(row.session) and S::alwaysLiveClaimHasToken(row.session) and S::alwaysClaimSequenceIsValid(row.session))
pure def alwaysAtomicTailHasOneOwner(s: SessionStore): bool = (s.active.id == 0 or s.usedTransactions.contains(s.active.id)) and s.waiting.every(waiter => waiter.id > 0 and waiter.id != s.active.id and s.usedTransactions.contains(waiter.id) and s.waiting.select(other => other.id == waiter.id).length() == 1)
pure def stepOnlySelectedSessionChanges(before: SessionStore, via: str, after: SessionStore): bool = via != "advanceSession" or before.rows.every(row => row.reference == before.active.reference or after.rows.includes(row))
pure def sometimesIndependentSessions(s: SessionStore): bool = s.rows.length() > 1
pure def sometimesQueuedAtomicOperations(s: SessionStore): bool = s.active.id != 0 and s.waiting.length() > 0
```
