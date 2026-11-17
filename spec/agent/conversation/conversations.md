# Conversation records

The agent keeps each conversation as a room with metadata. Three paths
change it: the raw mutation queue, the create route, and the restore that
republishes rooms read back from the database. Prompts and replies are in [chat](./chat.md); which owner may use
a conversation through a device gateway is in [ownership](./ownership.md).
Connector health probes belong to [connectors](../connectors.md).

## Story: Rename, delete and recreate a conversation without lost or resurrected writes

> As a user, I can rename or delete a conversation while other changes are
> in flight, and no stale write lands on a room that was deleted or
> replaced.

### Each runtime runs one numbered mutation at a time, room tokens are never reused, and only a current descriptor may write

A caller captures a descriptor: the room's token and the runtime's topology
generation, with the proof identity of what it wants written. It enqueues a
mutation only while that descriptor is current, no deletion is queued and
no queued mutation has timed out. A second caller with the exact same
descriptor and proof joins the queued mutation instead of adding one. One
mutation runs at a time, from the head of the queue, and a stale head is
skipped without writing. A write that settles reports ready only for a
descriptor that is still current; a failed write invalidates the topology so
that queued descriptors stop being current. Job numbers count up from one and
room tokens from zero: every queued job has a number below the next one, and
room tokens are never reused.

```quint
type Stamp = { topology: int, room: int }
type Job = { jobId: int, stamp: Stamp, proof: int, deletion: bool, timedOut: bool, joined: bool }
type MutationOutcome = Quiet | ReadyFor(Stamp) | MutationFailed | MutationDeadline | RoomDeleted
type RestorePhase = { stored: bool, pending: bool, deleted: bool, liveVersion: int, capturedVersion: int, published: bool }
type CreatePhase = Ensuring | ReadingMetadata | UpdatingMetadata | Publishing | CreateAccepted | CreateRejected
type Creation = { phase: CreatePhase, roomRegistered: bool, roomCurrent: bool, runtimeCurrent: bool, topologyCurrent: bool }
type Conversations = { topology: int, room: int, roomSequence: int, captured: Stamp, capturedProof: int, nextJob: int, queue: List[Job], running: bool, outcome: MutationOutcome, restore: RestorePhase, create: Creation }
pure val emptyStamp: Stamp = { topology: -1, room: -1 }
pure val noJob: Job = { jobId: 0, stamp: emptyStamp, proof: -1, deletion: false, timedOut: false, joined: false }
pure val freshRestore: RestorePhase = { stored: true, pending: false, deleted: false, liveVersion: 0, capturedVersion: 0, published: false }
pure val freshCreation: Creation = { phase: Ensuring, roomRegistered: true, roomCurrent: true, runtimeCurrent: true, topologyCurrent: true }
pure val initial: Conversations = { topology: 0, room: 0, roomSequence: 0, captured: emptyStamp, capturedProof: 0, nextJob: 1, queue: List(), running: false, outcome: Quiet, restore: freshRestore, create: freshCreation }
pure def deletionQueued(c: Conversations): bool = c.queue.some(j => j.deletion)
pure def quarantined(c: Conversations): bool = c.queue.some(j => j.timedOut)
pure def stampCurrent(c: Conversations, stamp: Stamp): bool =
  stamp.topology == c.topology and stamp.room == c.room and c.room >= 0 and not(deletionQueued(c))
pure def matchingQueued(c: Conversations): bool =
  c.queue.some(j => not(j.deletion) and j.stamp == c.captured and j.proof == c.capturedProof)
pure def headJob(c: Conversations): Job = c.queue.nthOr(0, noJob)
pure def captureDescriptor(c: Conversations): Conversations = {
  val token = if (c.room < 0) c.roomSequence + 1 else c.room
  { ...c, room: token, roomSequence: if (token > c.roomSequence) token else c.roomSequence, captured: { topology: c.topology, room: token }, outcome: Quiet }
}
pure def canCaptureOther(c: Conversations): bool = c.room >= 0
pure def captureOther(c: Conversations): Conversations =
  { ...c, captured: { topology: c.topology, room: c.room }, capturedProof: 1 - c.capturedProof, outcome: Quiet }
pure def canEnqueueMutation(c: Conversations): bool = stampCurrent(c, c.captured) and not(quarantined(c)) and not(matchingQueued(c))
pure def enqueueMutation(c: Conversations): Conversations =
  { ...c, nextJob: c.nextJob + 1, queue: c.queue.append({ jobId: c.nextJob, stamp: c.captured, proof: c.capturedProof, deletion: false, timedOut: false, joined: false }), outcome: Quiet }
pure def canJoinMutation(c: Conversations, jobId: int): bool =
  stampCurrent(c, c.captured) and c.queue.some(j => j.jobId == jobId and not(j.deletion) and j.stamp == c.captured and j.proof == c.capturedProof and not(j.timedOut) and not(j.joined))
pure def joinMutation(c: Conversations, jobId: int): Conversations =
  { ...c, queue: c.queue.listMap(j => if (j.jobId == jobId) { ...j, joined: true } else j), outcome: Quiet }
pure def invalidateTopology(c: Conversations): Conversations = { ...c, topology: c.topology + 1, outcome: Quiet }
pure def canBeginMutation(c: Conversations): bool =
  c.queue.length() > 0 and not(c.running) and not(headJob(c).timedOut) and (headJob(c).deletion or stampCurrent(c, headJob(c).stamp))
pure def beginMutation(c: Conversations): Conversations = { ...c, running: true, outcome: Quiet }
pure def canSkipMutation(c: Conversations): bool =
  c.queue.length() > 0 and not(c.running) and (headJob(c).timedOut or (not(headJob(c).deletion) and not(stampCurrent(c, headJob(c).stamp))))
pure def skipMutation(c: Conversations): Conversations = {
  val job = headJob(c)
  { ...c, queue: if (c.queue.length() > 0) c.queue.tail() else List(), outcome: if (job.timedOut) Quiet else MutationFailed, room: if (job.deletion) -1 else c.room }
}
pure def canSettleMutation(c: Conversations): bool = c.running and c.queue.length() > 0
pure def settleMutation(c: Conversations, ok: bool): Conversations = {
  val job = headJob(c)
  val fresh = not(job.deletion) and stampCurrent(c, job.stamp)
  { ...c, queue: if (c.queue.length() > 0) c.queue.tail() else List(), running: false, room: if (job.deletion) -1 else c.room,
    topology: if (not(ok) and fresh) c.topology + 1 else c.topology,
    outcome: if (job.timedOut) Quiet else if (not(ok)) MutationFailed else if (job.deletion) RoomDeleted else if (fresh) ReadyFor({ topology: job.stamp.topology, room: job.stamp.room }) else MutationFailed }
}
pure val jobIdValues = Set(1, 2, 3)
pure def alwaysOneRunningMutationAtTheHead(c: Conversations): bool =
  (c.running implies c.queue.length() > 0) and c.room <= c.roomSequence and c.roomSequence >= 0 and c.queue.select(j => j.deletion).length() <= 1 and
  (deletionQueued(c) implies c.room >= 0) and c.nextJob > 0 and c.queue.every(j => j.jobId > 0 and j.jobId < c.nextJob)
pure def alwaysReadyOnlyForCurrentDescriptor(c: Conversations): bool = {
  val ready = c.outcome
  match ready { | ReadyFor(stamp) => stamp.topology == c.topology and stamp.room == c.room and c.room >= 0 and not(deletionQueued(c)) | _ => true }
}
pure def sometimesMutationReady(c: Conversations): bool = {
  val ready = c.outcome
  match ready { | ReadyFor(stamp) => stamp.topology >= 0 | _ => false }
}
pure def sometimesSharedMutation(c: Conversations): bool = c.queue.some(j => j.joined)
```

### Deleting a conversation retires its room token

A deletion is queued only when no other deletion is queued and the queue is
not quarantined. Queuing it moves the room to a fresh token at once, so
every descriptor captured before it stops being current. When the deletion
settles or is skipped the room has no token; the next capture takes a new
one, never an old one.

```quint
pure def canEnqueueDeletion(c: Conversations): bool = not(deletionQueued(c)) and not(quarantined(c))
pure def enqueueDeletion(c: Conversations): Conversations =
  { ...c, room: c.roomSequence + 1, roomSequence: c.roomSequence + 1, nextJob: c.nextJob + 1,
    queue: c.queue.append({ ...noJob, jobId: c.nextJob, deletion: true }), outcome: Quiet }
pure def stepRoomTokensAreNeverReused(before: Conversations, after: Conversations): bool =
  after.roomSequence >= before.roomSequence and (after.room > 0 and after.room != before.room implies after.room > before.roomSequence)
pure def sometimesRoomDeleted(c: Conversations): bool = c.outcome == RoomDeleted and c.room == -1
```

### A timed-out mutation quarantines the queue until it drains, and never starts late

A caller may give up on a queued or running mutation at its deadline. A
timed-out mutation that has not started is skipped at the head without
writing; one that is running keeps its slot until its I/O returns. A
timeout of a non-deletion mutation invalidates the topology. While any
timed-out mutation is queued, no new mutation can be enqueued.

```quint
pure def canTimeOutMutation(c: Conversations, jobId: int): bool = c.queue.some(j => j.jobId == jobId and not(j.timedOut))
pure def timeOutMutation(c: Conversations, jobId: int): Conversations = {
  val job = c.queue.select(j => j.jobId == jobId).nthOr(0, noJob)
  { ...c, queue: c.queue.listMap(j => if (j.jobId == jobId) { ...j, timedOut: true } else j),
    topology: if (job.deletion) c.topology else c.topology + 1, outcome: MutationDeadline }
}
pure def stepTimedOutMutationNeverStarts(before: Conversations, via: str, after: Conversations): bool =
  via == "beginMutation" implies not(headJob(before).timedOut)
pure def sometimesQuarantined(c: Conversations): bool = quarantined(c) and c.running
```

### A quarantined queue drains when the runtime keeps advancing it

Without fairness a timed-out observer can leave raw I/O in flight
indefinitely. Assuming the queue keeps advancing and
database I/O eventually returns, success or failure, the quarantine ends.

```quint
pure def leadsToQuarantineDrains(c: Conversations, later: Conversations): bool = quarantined(c) implies not(quarantined(later))
pure val fair_beginMutation = "weak"
pure val fair_skipMutation = "weak"
pure val fair_settleMutation = "weak"
```

## Story: Restore conversations without resurrecting a deleted one

> As a user, a conversation I deleted stays deleted, and a newer change to
> it wins, even when a restore read the database before either happened.

### A restore publishes its snapshot only over a room that is still live and unchanged

Restore reads a snapshot of a stored, live room and later publishes it. A
deletion in between leaves a tombstone that the late publication cannot
overwrite, and newer live metadata written in between wins over the older
snapshot.

```quint
pure def canReadSnapshot(c: Conversations): bool = c.restore.stored and not(c.restore.deleted) and c.restore.liveVersion == 0 and not(c.restore.pending)
pure def readSnapshot(c: Conversations): Conversations = { ...c, restore: { ...c.restore, pending: true, capturedVersion: 1 } }
pure def tombstoneConversation(c: Conversations): Conversations = { ...c, restore: { ...c.restore, deleted: true, stored: false, liveVersion: 0 } }
pure def canWriteNewerMetadata(c: Conversations): bool = not(c.restore.deleted)
pure def writeNewerMetadata(c: Conversations): Conversations = { ...c, restore: { ...c.restore, liveVersion: 2 } }
pure def canPublishRestore(c: Conversations): bool = c.restore.pending
pure def publishRestore(c: Conversations): Conversations =
  { ...c, restore: { ...c.restore, pending: false, published: true, liveVersion: if (not(c.restore.deleted) and c.restore.liveVersion == 0) c.restore.capturedVersion else c.restore.liveVersion } }
pure def alwaysTombstoneWins(c: Conversations): bool = c.restore.deleted implies c.restore.liveVersion == 0
pure def sometimesTombstoneSurvivesRestore(c: Conversations): bool = c.restore.deleted and c.restore.published
pure def sometimesNewerMetadataWins(c: Conversations): bool = c.restore.published and c.restore.liveVersion == 2
pure def sometimesRestorePublished(c: Conversations): bool = c.restore.published and c.restore.liveVersion == 1
```

## Story: Create a conversation that is still mine when the reply arrives

> As a user, a new conversation is reported created only if it was not
> deleted, and its runtime and topology not replaced, while it was being set
> up.

### A create response is accepted only with a current room, runtime and topology

Creating a conversation ensures its room, reads its metadata and, if
needed, writes it, then publishes the response. Deletion of the room,
replacement of the runtime or a topology change may happen at any of those
awaits; the response is then rejected, and rejection unregisters the room.

```quint
pure def creationCurrent(k: Creation): bool = k.roomCurrent and k.runtimeCurrent and k.topologyCurrent
pure def canBeginCreation(c: Conversations): bool = c.create.phase == CreateAccepted or c.create.phase == CreateRejected
pure def beginCreation(c: Conversations): Conversations = { ...c, create: freshCreation }
pure def canReadMetadata(c: Conversations): bool = c.create.phase == Ensuring and creationCurrent(c.create)
pure def readMetadata(c: Conversations): Conversations = { ...c, create: { ...c.create, phase: ReadingMetadata } }
pure def canMetadataRead(c: Conversations): bool = c.create.phase == ReadingMetadata and creationCurrent(c.create)
pure def metadataRead(c: Conversations, needsUpdate: bool): Conversations = { ...c, create: { ...c.create, phase: if (needsUpdate) UpdatingMetadata else Publishing } }
pure def canMetadataWritten(c: Conversations): bool = c.create.phase == UpdatingMetadata
pure def metadataWritten(c: Conversations): Conversations = { ...c, create: { ...c.create, phase: Publishing } }
pure def canDeleteCreatedRoom(c: Conversations): bool = c.create.roomRegistered
pure def deleteCreatedRoom(c: Conversations): Conversations = { ...c, create: { ...c.create, roomRegistered: false, roomCurrent: false } }
pure def canReplaceCreationRuntime(c: Conversations): bool = c.create.runtimeCurrent
pure def replaceCreationRuntime(c: Conversations): Conversations = { ...c, create: { ...c.create, runtimeCurrent: false } }
pure def canChangeCreationTopology(c: Conversations): bool = c.create.topologyCurrent
pure def changeCreationTopology(c: Conversations): Conversations = { ...c, create: { ...c.create, topologyCurrent: false } }
pure def canPublishCreation(c: Conversations): bool = c.create.phase == Publishing and creationCurrent(c.create) and c.create.roomRegistered
pure def publishCreation(c: Conversations): Conversations = { ...c, create: { ...c.create, phase: CreateAccepted } }
pure def canRejectCreation(c: Conversations): bool = c.create.phase != CreateAccepted and c.create.phase != CreateRejected
pure def rejectCreation(c: Conversations): Conversations = { ...c, create: { ...c.create, phase: CreateRejected, roomRegistered: false, roomCurrent: false } }
pure def stepCreationAcceptedOnlyWhenCurrent(before: Conversations, via: str, after: Conversations): bool =
  via == "publishCreation" implies (creationCurrent(before.create) and before.create.roomRegistered)
pure def alwaysRejectedCreationHoldsNoRoom(c: Conversations): bool = c.create.phase == CreateRejected implies not(c.create.roomRegistered)
pure def sometimesCreationAccepted(c: Conversations): bool = c.create.phase == CreateAccepted
pure def sometimesDeletedDuringCreationRejected(c: Conversations): bool = c.create.phase == CreateRejected and c.create.runtimeCurrent and c.create.topologyCurrent
```
