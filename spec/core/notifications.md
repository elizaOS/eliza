# Durable notification inbox

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/services/notification.ts`, and the NotificationDurability, NotificationHydration, NotificationRecovery, NotificationGroupPolicy and NativeNotificationCursor models. This machine covers serialized inbox mutation, acknowledged and ambiguous persistence, reconciliation, read fences and restart. Payload validation, migration coordinate validation and recipient group authorization remain explicit boundary obligations in the source model mapping.

## Story: Read durable notifications across retries and restart

As a user, I see an inbox whose read cursor is tied to its durable epoch and sequence. A failed or ambiguous write must be reconciled before another mutation. Observational fan-out failure leaves durable data intact. Closing waits for in-flight work and rejects new admission.

### Inbox mutations retain stable IDs and increasing sequence coordinates

Admission snapshots a mutation and appends it to the serialized tail. Accepted operations survive a subsequent close request. The head evaluates against the then-current inbox; removing a missing row and marking a missing or already-read row complete without persistence. Notification IDs are fresh values from the host UUID boundary. `issuedIds` is ghost history for that boundary, including deleted rows and failed writes; it is not a new runtime registry. The model selects the future fresh ID at admission, while the source calls its UUID generator when the serialized add executes. At execution, add prunes expired rows, removes all matching group rows and derives count from the first surviving prior group only when coalescing is requested. The replacement receives a fresh sequence and unread state. The source numeric sequence ceiling is JavaScript's maximum safe integer; exhaustion rejects an accepted add before mutation.

```quint
type ExpiryMode = Unspecified | Permanent | Deadline
type Expiry = { mode: ExpiryMode, at: int }
type GroupCount = { explicit: bool, value: int }
type Notice = { id: str, sequence: int, read: bool, groupKey: str, count: GroupCount, expiry: Expiry }
type NoticeInput = { id: str, groupKey: str, hasCount: bool, count: int, expiry: Expiry, silent: bool, coalesce: bool }
pure val emptyInput: NoticeInput = { id: "", groupKey: "", hasCount: false, count: 0, expiry: { mode: Unspecified, at: 0 }, silent: false, coalesce: true }
pure val inputValues = Set({ ...emptyInput, id: "notice1", groupKey: "group1" }, { ...emptyInput, id: "notice2", groupKey: "group1", silent: true }, { ...emptyInput, id: "notice3", groupKey: "group1", hasCount: true, count: 7, coalesce: false })
type InboxPhase = Ready | Writing | Uncertain | Closed
type WriteOutcome = Acknowledged | RejectedBefore | LostAcknowledgement
type MutationKind = AddNotice | RemoveNotice | MarkNotice | MarkGroup | MarkAll | ClearNotices
type ProjectionDecision = ProjectionMatches | ProjectionDiffers | ProjectionThrows
type NoticeMutation = { kind: MutationKind, id: str, input: NoticeInput, checkProjection: bool }
pure val emptyMutation: NoticeMutation = { kind: ClearNotices, id: "", input: emptyInput, checkProjection: false }
pure val emptyNotice: Notice = { id: "", sequence: 0, read: false, groupKey: "", count: { explicit: false, value: 0 }, expiry: { mode: Unspecified, at: 0 } }
type Inbox = { issuedIds: Set[str], affected: int, reusedProjection: str, now: int, phase: InboxPhase, memory: List[Notice], disk: List[Notice], sequence: int, diskSequence: int, epoch: int, readValid: bool, readRows: List[Notice], readSequence: int, readEpoch: int, failed: bool, published: bool, acknowledged: bool, closing: bool, pending: List[NoticeMutation], executing: bool, admitted: int, completed: int }
pure val initial: Inbox = { issuedIds: Set(), affected: 0, reusedProjection: "", now: 0, phase: Ready, memory: List(), disk: List(), sequence: 0, diskSequence: 0, epoch: 0, readValid: false, readRows: List(), readSequence: 0, readEpoch: 0, failed: false, published: false, acknowledged: false, closing: false, pending: List(), executing: false, admitted: 0, completed: 0 }
pure def canEnqueueNotice(s: Inbox, id: str): bool = not(s.closing) and s.phase != Closed and id != "" and not(s.issuedIds.contains(id))
pure def enqueueNotice(s: Inbox, id: str): Inbox = { ...s, issuedIds: s.issuedIds.union(Set(id)), pending: s.pending.append({ kind: AddNotice, id: id, input: { ...emptyInput, id: id }, checkProjection: false }), admitted: s.admitted + 1, readValid: false }
pure val idValues = Set("notice1", "notice2", "notice3")
pure def canRemove(s: Inbox, id: str): bool = not(s.closing) and s.phase != Closed
pure def remove(s: Inbox, id: str): Inbox = { ...s, pending: s.pending.append({ kind: RemoveNotice, id: id, input: emptyInput, checkProjection: false }), admitted: s.admitted + 1, readValid: false }
pure def canMarkRead(s: Inbox, id: str): bool = not(s.closing) and s.phase != Closed
pure def markRead(s: Inbox, id: str): Inbox = { ...s, pending: s.pending.append({ kind: MarkNotice, id: id, input: emptyInput, checkProjection: false }), admitted: s.admitted + 1, readValid: false }
pure def canMarkGroupRead(s: Inbox, groupKey: str): bool = not(s.closing) and s.phase != Closed
pure def markGroupRead(s: Inbox, groupKey: str): Inbox = { ...s, pending: s.pending.append({ kind: MarkGroup, id: groupKey, input: emptyInput, checkProjection: false }), admitted: s.admitted + 1, readValid: false }
pure def canMarkAllRead(s: Inbox): bool = not(s.closing) and s.phase != Closed
pure def markAllRead(s: Inbox): Inbox = { ...s, pending: s.pending.append({ kind: MarkAll, id: "", input: emptyInput, checkProjection: false }), admitted: s.admitted + 1, readValid: false }
pure def matchesRead(mutation: NoticeMutation, row: Notice): bool = mutation.kind == MarkAll or (mutation.kind == MarkNotice and row.id == mutation.id) or (mutation.kind == MarkGroup and mutation.id != "" and row.groupKey == mutation.id)
pure val groupKeyValues = Set("", "group1", "missing")
pure def canClear(s: Inbox): bool = not(s.closing) and s.phase != Closed
pure def clear(s: Inbox): Inbox = { ...s, pending: s.pending.append({ kind: ClearNotices, id: "", input: emptyInput, checkProjection: false }), admitted: s.admitted + 1, readValid: false }
pure def canEnqueueGrouped(s: Inbox, input: NoticeInput): bool = canEnqueueNotice(s, input.id)
pure def enqueueGrouped(s: Inbox, input: NoticeInput): Inbox = { ...s, issuedIds: s.issuedIds.union(Set(input.id)), pending: s.pending.append({ kind: AddNotice, id: input.id, input: input, checkProjection: false }), admitted: s.admitted + 1, readValid: false }
pure def canSetClock(s: Inbox, now: int): bool = now >= 0
pure def setClock(s: Inbox, now: int): Inbox = { ...s, now: now }
pure val nowValues = Set(0, 1, 1000, 86400001)
pure def pendingProjection(s: Inbox): List[Notice] = {
  val queuedMutation = s.pending.nthOr(0, emptyMutation)
  if (queuedMutation.checkProjection and queuedMutation.kind == AddNotice) s.memory.select(row => row.groupKey == queuedMutation.input.groupKey) else List()
}
pure def tailReady(s: Inbox): bool = s.phase == Ready and not(s.executing) and s.pending.length() > 0
pure def canStartNext(s: Inbox): bool = tailReady(s) and pendingProjection(s).length() != 1
pure def retainedBeforeAdd(rows: List[Notice], groupKey: str, now: int): List[Notice] =
  rows.select(row => notificationVisible(row.expiry, now) and (groupKey == "" or row.groupKey != groupKey))
pure def addedNotification(s: Inbox, mutation: NoticeMutation): Notice = {
  val group = s.memory.select(row => notificationVisible(row.expiry, s.now) and mutation.input.groupKey != "" and row.groupKey == mutation.input.groupKey)
  val prior = group.nthOr(0, emptyNotice)
  {
    id: mutation.id,
    sequence: s.sequence + 1,
    read: false,
    groupKey: mutation.input.groupKey,
    count: groupCount(mutation.input.hasCount, mutation.input.count, mutation.input.coalesce and group.length() > 0, prior.count.explicit, prior.count.value),
    expiry: groupExpiry(mutation.input.expiry, mutation.input.silent, s.now, 86400000)
  }
}
pure def markedNotifications(rows: List[Notice], mutation: NoticeMutation): List[Notice] =
  rows.listMap(row => if (matchesRead(mutation, row)) { ...row, read: true } else row)
pure def removesNotification(rows: List[Notice], id: str): List[Notice] =
  rows.select(row => row.id != id)
pure def readMark(mutation: NoticeMutation): bool =
  mutation.kind == MarkNotice or mutation.kind == MarkGroup or mutation.kind == MarkAll
pure def startNext(s: Inbox): Inbox = {
  val mutation = s.pending.nthOr(0, emptyMutation)
  val exhausted = mutation.kind == AddNotice and s.sequence >= 9007199254740991
  val readChanges = s.memory.select(row => matchesRead(mutation, row) and not(row.read))
  val affected = if (mutation.kind == AddNotice) 1 else if (mutation.kind == RemoveNotice) s.memory.select(row => row.id == mutation.id).length() else if (mutation.kind == ClearNotices) s.memory.length() else readChanges.length()
  val changed = not(exhausted) and (mutation.kind == AddNotice or mutation.kind == ClearNotices or (mutation.kind == RemoveNotice and s.memory.some(row => row.id == mutation.id)) or readChanges.length() > 0)
  val rows = if (not(changed)) s.memory
    else if (mutation.kind == AddNotice) retainedBeforeAdd(s.memory, mutation.input.groupKey, s.now).append(addedNotification(s, mutation))
    else if (mutation.kind == RemoveNotice) removesNotification(s.memory, mutation.id)
    else if (readMark(mutation)) markedNotifications(s.memory, mutation)
    else List()
  {
    ...s,
    affected: if (exhausted) 0 else affected,
    reusedProjection: "",
    pending: s.pending.removeAt(0),
    memory: rows,
    sequence: if (changed and mutation.kind == AddNotice) s.sequence + 1 else s.sequence,
    phase: if (changed) Writing else Ready,
    executing: changed,
    completed: if (changed) s.completed else s.completed + 1,
    readValid: false,
    failed: exhausted,
    acknowledged: false,
    published: false
  }
}
pure def alwaysNoticeIdsAreUnique(s: Inbox): bool = s.memory.every(row => s.memory.select(other => other.id == row.id).length() == 1) and s.disk.every(row => s.disk.select(other => other.id == row.id).length() == 1)
pure def stepAddPrunesExpiredPriorRows(before: Inbox, via: str, after: Inbox): bool =
  via != "startNext" or after.phase != Writing or before.pending.nthOr(0, emptyMutation).kind != AddNotice or before.memory.every(row => notificationVisible(row.expiry, before.now) or not(after.memory.some(remaining => remaining.id == row.id)))
pure def stepGroupedAddReplacesEveryPriorGroupRow(before: Inbox, via: str, after: Inbox): bool = {
  val mutation = before.pending.nthOr(0, emptyMutation)
  via != "startNext" or after.phase != Writing or mutation.kind != AddNotice or mutation.input.groupKey == "" or (after.memory.select(row => row.groupKey == mutation.input.groupKey).length() == 1 and after.memory.some(row => row.id == mutation.id and not(row.read)))
}
pure def sometimesGroupedCountIncreases(s: Inbox): bool = s.memory.some(row => row.groupKey != "" and row.count.explicit and row.count.value > 1)
pure def alwaysQueueAccountsForEveryAdmission(s: Inbox): bool = s.admitted >= 0 and s.completed >= 0 and s.admitted == s.completed + s.pending.length() + (if (s.executing) 1 else 0)
pure def alwaysActiveWriteOwnsTail(s: Inbox): bool = (s.phase == Writing implies s.executing) and (s.executing implies (s.phase == Writing or s.phase == Uncertain or (s.phase == Ready and s.acknowledged and not(s.published))))
pure def alwaysCoordinatesRemainValid(s: Inbox): bool = s.now >= 0 and s.sequence >= 0 and s.diskSequence >= 0 and s.memory.every(row => row.sequence > 0 and row.sequence <= s.sequence) and s.disk.every(row => row.sequence > 0 and row.sequence <= s.diskSequence)
```

### Acknowledgement publishes success while ambiguity requires reconciliation

Both failure-before-commit and lost-acknowledgement paths report failure. A lost acknowledgement may nevertheless have changed disk. Reconciliation re-reads the durable state instead of guessing the outcome. Fan-out is permitted only after an acknowledged write.

```quint
pure def canPersist(s: Inbox, writeOutcome: WriteOutcome): bool = s.phase == Writing
pure def persist(s: Inbox, writeOutcome: WriteOutcome): Inbox = {
  ...s,
  disk: if (writeOutcome == RejectedBefore) s.disk else s.memory,
  diskSequence: if (writeOutcome == RejectedBefore) s.diskSequence else s.sequence,
  phase: if (writeOutcome == Acknowledged) Ready else Uncertain,
  failed: writeOutcome != Acknowledged,
  acknowledged: writeOutcome == Acknowledged,
  published: false,
  executing: true,
  completed: s.completed
}
pure def canReconcile(s: Inbox, readable: bool): bool = s.phase == Uncertain
pure def reconcile(s: Inbox, readable: bool): Inbox =
  if (readable) { ...s, memory: s.disk, sequence: s.diskSequence, phase: Ready, executing: false, completed: if (s.executing) s.completed + 1 else s.completed } else { ...s, executing: false, completed: if (s.executing) s.completed + 1 else s.completed }
pure def canBroadcast(s: Inbox): bool = s.phase == Ready and s.executing and s.acknowledged and not(s.failed) and not(s.published)
pure def broadcast(s: Inbox): Inbox = { ...s, published: true, executing: false, completed: s.completed + 1 }
pure def alwaysReadyMatchesDisk(s: Inbox): bool = s.phase != Ready or (s.memory == s.disk and s.sequence == s.diskSequence)
pure def alwaysPublishedWasAcknowledged(s: Inbox): bool = s.published implies (s.phase == Ready and s.acknowledged and not(s.failed))
pure def sometimesAmbiguousWrite(s: Inbox): bool = s.phase == Uncertain and s.failed and s.diskSequence > 0
```

### Read fences use quiescent durable state and restart reloads that state

A close request immediately rejects new admission and reads. Already admitted operations continue, including their acknowledged fan-out. A queued operation whose uncertainty reconciliation fails returns failure and releases its tail position. Close resolves only after every admitted position settles. Restart creates a new service over durable rows and cannot rebroadcast a prior write. Fairness assumes accepted persistence calls and fan-out return. Unreadable storage may reject each queued operation and release its position. An admitted prefix settles even while the inbox remains open and later operations are admitted. Queue counters measure that prefix because every mutation executes, completes or fails in admission order.

```quint
pure def canRead(s: Inbox): bool = s.phase == Ready and not(s.closing) and not(s.executing) and s.pending.length() == 0
pure def read(s: Inbox): Inbox = { ...s, readValid: true, readRows: s.disk, readSequence: s.diskSequence, readEpoch: s.epoch }
pure def canRequestClose(s: Inbox): bool = s.phase != Closed and not(s.closing)
pure def requestClose(s: Inbox): Inbox = { ...s, closing: true, readValid: false }
pure def canRejectQueuedUnreadable(s: Inbox): bool = s.phase == Uncertain and not(s.executing) and s.pending.length() > 0
pure def rejectQueuedUnreadable(s: Inbox): Inbox = { ...s, pending: s.pending.removeAt(0), completed: s.completed + 1, failed: true }
pure def canClose(s: Inbox): bool = s.closing and s.phase != Closed and not(s.executing) and s.pending.length() == 0
pure def close(s: Inbox): Inbox = { ...s, phase: Closed, memory: List(), readValid: false, acknowledged: false, published: false }
pure def alwaysClosedTailIsDrained(s: Inbox): bool = s.phase == Closed implies (s.closing and not(s.executing) and s.pending.length() == 0 and s.admitted == s.completed)
pure def lawClosingRejectsAdmission(s: Inbox, id: str): bool = s.closing implies (not(canEnqueueNotice(s, id)) and not(canEnsureGroupedProjection(s, { ...emptyInput, id: id })) and not(canRemove(s, id)) and not(canMarkRead(s, id)) and not(canClear(s)) and not(canMarkGroupRead(s, id)) and not(canMarkAllRead(s)))
pure def canRestart(s: Inbox): bool = s.phase == Closed
pure def restart(s: Inbox): Inbox = { ...s, phase: Ready, memory: s.disk, sequence: s.diskSequence, readValid: false, closing: false, failed: false, acknowledged: false, published: false }
pure def canReplaceInbox(s: Inbox): bool = s.phase == Closed
pure def replaceInbox(s: Inbox): Inbox = { ...s, memory: List(), disk: List(), sequence: 0, diskSequence: 0, epoch: s.epoch + 1, readValid: false }
pure def cursorAccepted(cursorEpoch: int, inboxEpoch: int, after: int, watermark: int): bool = cursorEpoch == inboxEpoch and after >= 0 and after <= watermark
pure def lawOldEpochCursorIsRejected(cursorEpoch: int, inboxEpoch: int, after: int, watermark: int): bool = cursorEpoch != inboxEpoch implies not(cursorAccepted(cursorEpoch, inboxEpoch, after, watermark))
pure def alwaysReadFenceMatchesDurableState(s: Inbox): bool = s.readValid implies (s.phase == Ready and not(s.closing) and not(s.executing) and s.pending.length() == 0 and s.readRows == s.disk and s.readSequence == s.diskSequence and s.readEpoch == s.epoch)
pure def sometimesReadDurableNotifications(s: Inbox): bool = s.readValid and s.readRows.length() > 0
pure def sometimesClosedInbox(s: Inbox): bool = s.phase == Closed
pure def sometimesClosingDrainsAcceptedWrite(s: Inbox): bool = s.closing and s.executing
pure def sometimesQueuedWriteSurvivesClosing(s: Inbox): bool = s.closing and s.pending.length() > 0
pure val fair_startNext = "weak"
pure val fair_checkGroupedProjection = "weak"
pure val fair_persist = "weak"
pure val fair_reconcile = "weak"
pure val fair_broadcast = "weak"
pure val fair_rejectQueuedUnreadable = "weak"
pure val fair_close = "weak"
pure def leadsToAdmittedTailDrains(s: Inbox, later: Inbox): bool = s.closing implies later.phase == Closed
pure def leadsToAdmittedOperationsSettle(s: Inbox, later: Inbox): bool =
  s.admitted > s.completed implies later.completed >= s.admitted
```

## Story: Preserve notification group and expiry policy

As a user, grouped notifications carry an accurate count and unread state. Group reads and mark-all reads update every matching unread row without changing its ID, coordinate, or list position; their result is the number changed. An empty group key and already-read rows are no-ops. Explicit producer counts and expiry values win. Implicit counts increase only from an active prior group. Silent notifications receive the existing default expiry, while explicit permanent expiry survives. Expiry affects visibility immediately. The next notification prunes expired rows before group resolution and persists the resulting inbox; it does not retain those expired rows indefinitely.

### Exact grouped projections reuse the durable row

A durable producer can ensure a grouped projection while an earlier write
is still in the inbox tail. Admission snapshots the input. At the head, the
host's exactness callback receives a copy when exactly one stored row has
the requested group key. A match returns that row with its durable
coordinates. A callback throw fails this operation. A mismatch, zero
matches or multiple matches replaces the group with coalescing disabled.
The callback sees stored rows past their expiry. Replacement still prunes
expired rows before creating a row.

```quint
pure def canEnsureGroupedProjection(s: Inbox, input: NoticeInput): bool = canEnqueueNotice(s, input.id)
pure def ensureGroupedProjection(s: Inbox, input: NoticeInput): Inbox = {
  ...s,
  issuedIds: s.issuedIds.union(Set(input.id)),
  pending: s.pending.append({ kind: AddNotice, id: input.id, input: { ...input, coalesce: false }, checkProjection: true }),
  admitted: s.admitted + 1,
  readValid: false
}
pure def canCheckGroupedProjection(s: Inbox, decision: ProjectionDecision): bool = tailReady(s) and pendingProjection(s).length() == 1
pure def checkGroupedProjection(s: Inbox, decision: ProjectionDecision): Inbox = {
  val queuedMutation = s.pending.nthOr(0, emptyMutation)
  val candidate = pendingProjection(s).nthOr(0, emptyNotice)
  if (decision == ProjectionDiffers) {
    ...s,
    pending: s.pending.listMap(mutation => if (mutation.kind == AddNotice and mutation.id == queuedMutation.id) { ...mutation, checkProjection: false } else mutation)
  } else {
    ...s,
    pending: s.pending.removeAt(0),
    completed: s.completed + 1,
    failed: decision == ProjectionThrows,
    acknowledged: false,
    published: false,
    affected: 0,
    reusedProjection: if (decision == ProjectionMatches) candidate.id else ""
  }
}
pure def stepProjectionEvaluationKeepsRows(before: Inbox, via: str, after: Inbox): bool = via != "checkGroupedProjection" or (after.memory == before.memory and after.disk == before.disk and after.sequence == before.sequence and after.diskSequence == before.diskSequence)
pure def sometimesExactProjectionReused(s: Inbox): bool = s.reusedProjection != ""
```

### Group count and expiry use the current row and commit time

```quint
pure val expiryValues = Set({ mode: Unspecified, at: 0 }, { mode: Permanent, at: 0 }, { mode: Deadline, at: 1000 })
pure def groupCount(producerHasCount: bool, producerCount: int, priorActive: bool, priorHasCount: bool, priorCount: int): GroupCount =
  if (producerHasCount) { explicit: true, value: producerCount } else if (not(priorActive)) { explicit: false, value: 0 } else if (priorHasCount) { explicit: true, value: priorCount + 1 } else { explicit: true, value: 2 }
pure def groupExpiry(expiry: Expiry, silent: bool, committedAt: int, defaultLifetime: int): Expiry =
  if (silent and expiry.mode == Unspecified) { mode: Deadline, at: committedAt + defaultLifetime } else expiry
pure def notificationVisible(expiry: Expiry, now: int): bool = expiry.mode != Deadline or now < expiry.at
pure def notificationBadge(expiry: Expiry, now: int, readByUser: bool, silent: bool): bool = notificationVisible(expiry, now) and not(readByUser) and not(silent)
pure def notificationPriority(category: str, explicitPriority: str): str =
  if (explicitPriority != "") explicitPriority else if (category == "approval") "high" else if (category == "system") "low" else "normal"
pure def lawProducerCountWins(producerCount: int, priorActive: bool, priorHasCount: bool, priorCount: int): bool = groupCount(true, producerCount, priorActive, priorHasCount, priorCount) == { explicit: true, value: producerCount }
pure def lawPermanentExpiryWins(silent: bool, committedAt: int, defaultLifetime: int): bool = groupExpiry({ mode: Permanent, at: 0 }, silent, committedAt, defaultLifetime).mode == Permanent
pure def lawReadNotificationsHaveNoBadge(expiry: Expiry, now: int, silent: bool): bool = not(notificationBadge(expiry, now, true, silent))
```

## Story: Reject invalid persisted inbox coordinates

As a host, I become ready only after the entire stored snapshot validates or a migration write is acknowledged. The coordinate keys equal the row IDs, are strictly increasing in insertion order, remain positive and do not exceed the watermark. Invalid snapshots require repair. Legacy migration assigns successive coordinates in original insertion order before publishing readiness.

### Hydration validates every row and the complete coordinate map

```quint
type Coordinate = { id: str, value: int }
type Snapshot = { rowIds: List[str], coordinates: List[Coordinate], watermark: int, headerValid: bool }
type CoordinateCheck = { valid: bool, previous: int }
pure val snapshotValues = Set(
  { rowIds: List(), coordinates: List(), watermark: 0, headerValid: true },
  { rowIds: List("a", "b"), coordinates: List({ id: "a", value: 1 }, { id: "b", value: 3 }), watermark: 3, headerValid: true },
  { rowIds: List("a", "b"), coordinates: List({ id: "a", value: 1 }), watermark: 3, headerValid: true },
  { rowIds: List("a", "a"), coordinates: List({ id: "a", value: 1 }), watermark: 3, headerValid: true },
  { rowIds: List("a"), coordinates: List({ id: "a", value: 2 }, { id: "extra", value: 3 }), watermark: 3, headerValid: true }
)
pure val checkedValues = Set({ valid: true, previous: 0 }, { valid: false, previous: 2 })
pure def checkCoordinate(snapshot: Snapshot, checked: CoordinateCheck, id: str): CoordinateCheck = {
  val entries = snapshot.coordinates.select(entry => entry.id == id)
  val coordinate = entries.nthOr(0, { id: "", value: 0 }).value
  { valid: checked.valid and entries.length() == 1 and coordinate > checked.previous and coordinate <= snapshot.watermark, previous: coordinate }
}
pure def validSnapshot(snapshot: Snapshot): bool =
  snapshot.headerValid and snapshot.watermark >= 0 and snapshot.coordinates.length() == snapshot.rowIds.length() and snapshot.rowIds.foldl({ valid: true, previous: 0 }, (checked, id) => checkCoordinate(snapshot, checked, id)).valid
pure def hydrationReady(snapshot: Snapshot, legacyMigration: bool, migrationAcknowledged: bool): bool = validSnapshot(snapshot) and (not(legacyMigration) or migrationAcknowledged)
pure def lawUnacknowledgedMigrationCannotBecomeReady(snapshot: Snapshot): bool = not(hydrationReady(snapshot, true, false))
pure def lawReadySnapshotIsValid(snapshot: Snapshot, legacyMigration: bool, migrationAcknowledged: bool): bool = hydrationReady(snapshot, legacyMigration, migrationAcknowledged) implies validSnapshot(snapshot)
```

### Pending fresh IDs remain separate from existing inbox rows

Discovered by the proof: unique live rows alone do not constrain a fabricated
pending add to carry a distinct ID after an ambiguous write reconciles. The
UUID boundary supplies fresh IDs across admissions. Ghost history records
that assumption, and pending additions retain distinct IDs and their original
input identity while serialized mutations and reconciliation run. A published
result is in the ready phase. An uncertain write can only publish after
its acknowledgement. A published
result is in the ready phase. An uncertain write cannot have published its
result before its acknowledgement.

```quint
pure def freshPendingAgainstRows(s: Inbox, mutation: NoticeMutation): bool =
  mutation.kind == AddNotice implies mutation.id != "" and mutation.id == mutation.input.id and
    s.issuedIds.contains(mutation.id) and
    not(s.memory.some(row => row.id == mutation.id)) and not(s.disk.some(row => row.id == mutation.id))
pure def alwaysFreshNotificationIdentity(s: Inbox): bool =
  s.memory.every(row => s.issuedIds.contains(row.id)) and s.disk.every(row => s.issuedIds.contains(row.id)) and
  s.pending.every(mutation => freshPendingAgainstRows(s, mutation) and
    (mutation.kind == AddNotice implies s.pending.select(other => other.kind == AddNotice and other.id == mutation.id).length() == 1))
pure def alwaysAffectedRowsNonnegative(s: Inbox): bool = s.affected >= 0
pure def stepReadMarksPreserveCoordinates(before: Inbox, via: str, after: Inbox): bool = {
  val mutation = before.pending.nthOr(0, emptyMutation)
  val isReadMark = mutation.kind == MarkNotice or mutation.kind == MarkGroup or mutation.kind == MarkAll
  via != "startNext" or not(isReadMark) or (after.memory.length() == before.memory.length() and after.sequence == before.sequence and before.memory.every(row => after.memory.some(updated => updated.id == row.id and updated.sequence == row.sequence)))
}
```
