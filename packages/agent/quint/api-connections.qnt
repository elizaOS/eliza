// conversation-connection-readiness.ts owns one raw mutation queue per runtime.
// One room lifecycle and two proof identities are observed. Tokens are never reused.
module api_connections {
  type Stamp = { topology: int, room: int }
  type Job = { stamp: Stamp, proof: int, deletion: bool, timedOut: bool, joined: bool }
  type Outcome = Quiet | Ready(Stamp) | Failed | Deadline | Deleted
  var s: {
    topology: int, room: int, roomSequence: int, captured: Stamp, capturedProof: int,
    queue: List[Job], running: bool, outcome: Outcome,
  }

  pure val emptyStamp: Stamp = { topology: -1, room: -1 }
  action init = s' = {
    topology: 0, room: 0, roomSequence: 0, captured: emptyStamp, capturedProof: 0,
    queue: [], running: false, outcome: Quiet,
  }
  val blocked = s.queue.indices().exists(index => s.queue.nth(index).deletion)
  val quarantined = s.queue.indices().exists(index => s.queue.nth(index).timedOut)
  val roomToken = if (s.room < 0) s.roomSequence + 1 else s.room
  def current(stamp: Stamp): bool =
    stamp.topology == s.topology and stamp.room == s.room and s.room >= 0 and not(blocked)
  val matching = s.queue.indices().exists(index => {
    val job = s.queue.nth(index)
    not(job.deletion) and job.stamp == s.captured and job.proof == s.capturedProof
  })
  val canEnqueue = not(quarantined) and s.queue.length() < 2

  action capture = all {
    roomToken <= 2,
    s' = s.with("room", roomToken).with("roomSequence", roomToken)
      .with("captured", { topology: s.topology, room: roomToken }).with("outcome", Quiet),
  }
  // Distinct descriptors can share current generations while retaining separate
  // work. Exact proof matches join the same observer instead of another slot.
  action captureOther = all {
    s.room >= 0,
    s' = s.with("captured", { topology: s.topology, room: s.room })
      .with("capturedProof", 1 - s.capturedProof).with("outcome", Quiet),
  }
  action enqueue = all {
    current(s.captured), canEnqueue, not(matching),
    s' = s.with("queue", s.queue.append({
      stamp: s.captured, proof: s.capturedProof, deletion: false, timedOut: false, joined: false,
    })).with("outcome", Quiet),
  }
  action join(index) = all {
    current(s.captured), index < s.queue.length(),
    val job = s.queue.nth(index)
    all {
      not(job.deletion), job.stamp == s.captured, job.proof == s.capturedProof, not(job.timedOut), not(job.joined),
      s' = s.with("queue", s.queue.replaceAt(index, job.with("joined", true))).with("outcome", Quiet),
    },
  }
  action invalidate = all {
    s.topology < 2,
    s' = s.with("topology", s.topology + 1).with("outcome", Quiet),
  }
  action enqueueDeletion = all {
    not(blocked), canEnqueue, s.roomSequence < 2,
    s' = s.with("room", s.roomSequence + 1).with("roomSequence", s.roomSequence + 1)
      .with("queue", s.queue.append({
        stamp: emptyStamp, proof: -1, deletion: true, timedOut: false, joined: false,
      })).with("outcome", Quiet),
  }
  action timeout(index) = all {
    index < s.queue.length(),
    val job = s.queue.nth(index)
    all {
      not(job.timedOut), job.deletion or s.topology < 2,
      s' = s.with("queue", s.queue.replaceAt(index, job.with("timedOut", true)))
        .with("topology", if (job.deletion) s.topology else s.topology + 1)
        .with("outcome", Deadline),
    },
  }
  action begin = all {
    s.queue.length() > 0, not(s.running),
    val job = s.queue.head()
    all {
      not(job.timedOut), job.deletion or current(job.stamp),
      s' = s.with("running", true).with("outcome", Quiet),
    },
  }
  // A deadline can expire in the queue. Its raw slot drains only at the head,
  // and it must not start database work. A stale head also skips the write.
  action skip = all {
    s.queue.length() > 0, not(s.running),
    val job = s.queue.head()
    all {
      job.timedOut or (not(job.deletion) and not(current(job.stamp))),
      s' = s.with("queue", s.queue.tail()).with("outcome", if (job.timedOut) Quiet else Failed)
        .with("room", if (job.deletion) -1 else s.room),
    },
  }
  action settle(ok) = all {
    s.running,
    val job = s.queue.head()
    val fresh = not(job.deletion) and current(job.stamp)
    all {
      ok or not(fresh) or s.topology < 2,
      s' = s.with("queue", s.queue.tail()).with("running", false)
        .with("room", if (job.deletion) -1 else s.room)
        .with("topology", if (not(ok) and fresh) s.topology + 1 else s.topology)
        .with("outcome",
          if (job.timedOut) Quiet
          else if (not(ok)) Failed
          else if (job.deletion) Deleted
          else if (fresh) Ready(job.stamp)
          else Failed),
    },
  }
  action advanceRaw = any { begin, skip, settle(true), settle(false) }
  action idle = s' = s
  action step = any {
    capture, captureOther, enqueue, join(0), join(1), invalidate, enqueueDeletion,
    timeout(0), timeout(1), advanceRaw, idle,
  }

  val safety = all {
    s.queue.length() <= 2,
    s.running implies s.queue.length() > 0,
    s.room <= s.roomSequence,
    s.queue.indices().filter(index => s.queue.nth(index).deletion).size() <= 1,
    blocked implies s.room >= 0,
    match s.outcome {
      | Ready(stamp) => current(stamp)
      | _ => true
    },
  }
  temporal rawDrain = advanceRaw.weakFair(s).implies(quarantined.leadsTo(not(quarantined)))
  temporal rawDrainWithoutFairness = quarantined.leadsTo(not(quarantined))

  run matchingObserverJoinsTest = init.then(capture).then(enqueue).then(join(0))
    .expect(s.queue.length() == 1 and s.queue.head().joined)
    .then(begin).then(settle(true)).expect(s.outcome == Ready(s.captured))
  run timedOutWriteRetainsOwnershipTest = init.then(capture).then(enqueue).then(begin)
    .then(timeout(0)).expect(s.running and quarantined)
    .then(settle(true)).expect(s.outcome == Quiet and not(quarantined))
  run queuedTimeoutNeverWritesTest = init.then(capture).then(enqueue).then(begin).then(invalidate)
    .then(capture).then(enqueue).then(timeout(1)).then(settle(true))
    .expect(not(s.running) and quarantined and s.outcome == Failed)
    .then(skip).expect(s.queue.length() == 0 and not(quarantined))
  run failedWriteInvalidatesQueuedDescriptorTest = init.then(capture).then(enqueue).then(begin)
    .then(settle(false)).expect(s.topology == 1 and not(current(s.captured)))
    .then(capture).then(enqueue).then(begin).then(settle(true))
    .expect(s.outcome == Ready(s.captured))
  run settledSuccessIsNotReadinessCacheTest = init.then(capture).then(enqueue).then(begin)
    .then(settle(true)).expect(s.outcome == Ready(s.captured))
    .then(enqueue).then(begin).then(settle(true)).expect(s.outcome == Ready(s.captured) and safety)
  run distinctDescriptorsTimeoutAndRecoverTest = init.then(capture).then(enqueue).then(join(0))
    .then(begin).then(captureOther).then(enqueue)
    .expect(s.queue.length() == 2 and s.queue.head().joined)
    .then(timeout(0)).then(timeout(1)).expect(s.running and quarantined)
    .then(settle(true)).then(skip).expect(s.queue.length() == 0 and not(quarantined))
    .then(capture).then(enqueue).then(begin).then(settle(true))
    .expect(s.outcome == Ready(s.captured) and safety)
  run deletionRetiresRoomTokenTest = init.then(capture).then(enqueueDeletion).then(begin)
    .then(capture).then(settle(true))
    .expect(s.room == -1 and not(current(s.captured)) and s.outcome == Deleted)
    .then(capture).expect(current(s.captured) and s.room == 2)
}

// conversation-routes.ts keeps its descriptor through the POST room metadata
// and optional greeting work. A DELETE can retire it while that work awaits.
module api_connection_creation {
  type Phase = Ensuring | ReadingMetadata | UpdatingMetadata | Publishing | Accepted | Rejected
  var s: {
    phase: Phase, roomRegistered: bool, roomCurrent: bool, runtimeCurrent: bool,
    topologyCurrent: bool, acceptedWithCurrentDescriptor: bool,
  }

  action init = s' = {
    phase: Ensuring, roomRegistered: true, roomCurrent: true, runtimeCurrent: true,
    topologyCurrent: true, acceptedWithCurrentDescriptor: false,
  }
  val current = s.roomCurrent and s.runtimeCurrent and s.topologyCurrent
  action readMetadata = all {
    s.phase == Ensuring, current,
    s' = s.with("phase", ReadingMetadata),
  }
  action metadataRead(needsUpdate) = all {
    s.phase == ReadingMetadata, current,
    s' = s.with("phase", if (needsUpdate) UpdatingMetadata else Publishing),
  }
  action metadataWritten = all {
    s.phase == UpdatingMetadata,
    s' = s.with("phase", Publishing),
  }
  action deleteRoom = all {
    s.roomRegistered,
    s' = s.with("roomRegistered", false).with("roomCurrent", false),
  }
  action replaceRuntime = all {
    s.runtimeCurrent,
    s' = s.with("runtimeCurrent", false),
  }
  action invalidateTopology = all {
    s.topologyCurrent,
    s' = s.with("topologyCurrent", false),
  }
  action publish = all {
    s.phase == Publishing, current,
    s' = s.with("phase", Accepted).with("acceptedWithCurrentDescriptor", current and s.roomRegistered),
  }
  action reject = all {
    s.phase != Accepted, s.phase != Rejected,
    s' = s.with("phase", Rejected).with("roomRegistered", false).with("roomCurrent", false),
  }
  action respond = any { publish, reject }
  action idle = s' = s
  action step = any {
    readMetadata, metadataRead(false), metadataRead(true), metadataWritten,
    deleteRoom, replaceRuntime, invalidateTopology, respond, idle,
  }
  val safety = s.phase == Accepted implies s.acceptedWithCurrentDescriptor

  run deletionDuringMetadataReadRejectsTest = init.then(readMetadata)
    .then(deleteRoom).then(reject).expect(s.phase == Rejected)
  run deletionDuringMetadataUpdateRejectsTest = init.then(readMetadata).then(metadataRead(true))
    .then(deleteRoom).then(metadataWritten).then(reject).expect(s.phase == Rejected)
  run currentCreationSucceedsTest = init.then(readMetadata).then(metadataRead(false))
    .then(publish).expect(s.phase == Accepted and safety)
}
