// Durable inbox write queue and ambiguous-write reconciliation. Memory can be
// provisional during writes. Only a quiescent native read publishes a fence.
module NotificationDurability {
  pure val ids = Set(1, 2)
  var s: { memory: Set[int], disk: Set[int], readMarks: Set[int], diskReadMarks: Set[int], sequence: int, diskSequence: int,
    phase: str, uncertain: bool, closing: bool, stopped: bool, operation: str,
    target: int, published: Set[int], everCommitted: Set[int], readRows: Set[int], observedReadMarks: Set[int], readSequence: int,
    readValid: bool, result: str }
  action init = s' = { memory: Set(), disk: Set(), readMarks: Set(), diskReadMarks: Set(), sequence: 0, diskSequence: 0,
    phase: "idle", uncertain: false, closing: false, stopped: false, operation: "none",
    target: 1, published: Set(), everCommitted: Set(), readRows: Set(), observedReadMarks: Set(), readSequence: 0, readValid: false, result: "none" }
  action admit(operation: str, target: int): bool = all {
    s.phase == "idle" and not(s.closing),
    s' = { ...s, operation: operation, target: target,
      phase: if (s.uncertain) "recovering" else "mutating", readValid: false, result: "pending" },
  }
  action mutate = all {
    s.phase == "mutating",
    s.operation != "append" or s.sequence < 2,
    val sequence = if (s.operation == "append") s.sequence + 1 else s.sequence
    val memory = if (s.operation == "append") s.memory.union(Set(sequence))
      else if (s.operation == "delete") s.memory.exclude(Set(s.target))
      else if (s.operation == "mark-read") s.memory else Set()
    val readMarks = if (s.operation == "clear") Set()
      else if (s.operation == "delete") s.readMarks.exclude(Set(s.target))
      else if (s.operation == "mark-read" and memory.contains(s.target)) s.readMarks.union(Set(s.target))
      else s.readMarks
    s' = { ...s, sequence: sequence, memory: memory, readMarks: readMarks, phase: "persisting" },
  }
  action exhausted = all {
    s.phase == "mutating" and s.operation == "append" and s.sequence == 2,
    s' = { ...s, phase: "idle", result: "failed" },
  }
  action persist(outcome: str): bool = all {
    s.phase == "persisting",
    val committed = outcome != "reject-before"
    s' = { ...s, disk: if (committed) s.memory else s.disk,
      diskSequence: if (committed) s.sequence else s.diskSequence,
      diskReadMarks: if (committed) s.readMarks else s.diskReadMarks,
      everCommitted: if (committed) s.everCommitted.union(s.memory) else s.everCommitted,
      phase: if (outcome == "ack") "broadcasting" else "reconciling",
      uncertain: outcome != "ack" },
  }
  action reconcile(readable: bool): bool = all {
    Set("reconciling", "recovering").contains(s.phase),
    s' = { ...s, memory: if (readable) s.disk else s.memory,
      sequence: if (readable) s.diskSequence else s.sequence,
      readMarks: if (readable) s.diskReadMarks else s.readMarks, uncertain: not(readable),
      phase: if (readable and s.phase == "recovering") "mutating" else "idle",
      result: if (readable and s.phase == "recovering") "pending" else "failed" },
  }
  // Observational fan-out may succeed or fail. Both outcomes leave durable data.
  action broadcast(delivered: bool): bool = all {
    s.phase == "broadcasting",
    s' = { ...s, published: if (delivered and s.operation == "append")
      s.published.union(Set(s.sequence)) else s.published, phase: "idle", result: "ok" },
  }
  action read = all {
    s.phase == "idle" and not(s.closing) and not(s.uncertain),
    s' = { ...s, readRows: s.memory, observedReadMarks: s.readMarks, readSequence: s.sequence, readValid: true },
  }
  action stop = all { not(s.closing), s' = { ...s, closing: true, readValid: false } }
  action drained = all {
    s.closing and s.phase == "idle" and not(s.stopped),
    s' = { ...s, stopped: true, memory: Set(), readMarks: Set(), readValid: false },
  }
  action restart = all {
    s.stopped,
    s' = { ...s, memory: s.disk, readMarks: s.diskReadMarks, sequence: s.diskSequence, uncertain: false,
      closing: false, stopped: false, readValid: false },
  }
  action step = {
    nondet target = ids.oneOf()
    nondet operation = Set("append", "delete", "clear", "mark-read").oneOf()
    nondet outcome = Set("ack", "reject-before", "reject-after").oneOf()
    nondet flag = Set(true, false).oneOf()
    any { admit(operation, target), mutate, exhausted, persist(outcome), reconcile(flag),
      broadcast(flag), read, stop, drained, restart, s' = s }
  }
  val ValidSequences = s.memory.forall(id => id > 0 and id <= s.sequence) and
    s.disk.forall(id => id > 0 and id <= s.diskSequence) and s.sequence <= 2 and s.diskSequence <= 2
  val ReadMarksReferenceRows = s.readMarks.subseteq(s.memory) and s.diskReadMarks.subseteq(s.disk)
  val PublishedWasCommitted = s.published.subseteq(s.everCommitted)
  val UncertaintyFencesMutation = (s.phase == "mutating").implies(not(s.uncertain))
  val DurableFence = s.readValid.implies(s.readRows == s.disk and s.readSequence == s.diskSequence and s.observedReadMarks == s.diskReadMarks)
  val StoppedHasNoProvisionalRows = s.stopped.implies(s.memory == Set() and s.phase == "idle")
  val SuccessAfterAcknowledgement = (s.phase == "broadcasting").implies(
    s.disk == s.memory and s.sequence == s.diskSequence and s.readMarks == s.diskReadMarks and not(s.uncertain))
  temporal AdmittedOperationSettles = (mutate.weakFair(s) and exhausted.weakFair(s)
    and persist("ack").weakFair(s) and reconcile(true).weakFair(s)
    and broadcast(true).weakFair(s)).implies((s.phase != "idle").leadsTo(s.phase == "idle"))
  run rejectedBeforeCommitRestoresDiskTest = init.then(admit("append", 1)).then(mutate)
    .then(persist("reject-before")).then(reconcile(true)).then(read)
    .expect(s.readRows == Set() and s.readSequence == 0 and DurableFence)
  run rejectedAfterCommitRestoresCoordinatesTest = init.then(admit("append", 1)).then(mutate)
    .then(persist("reject-after")).then(reconcile(true)).then(read)
    .expect(s.result == "failed" and s.readSequence == 1 and s.readRows == Set(1))
  run unreadableCommitBlocksNextMutationTest = init.then(admit("append", 1)).then(mutate)
    .then(persist("reject-after")).then(reconcile(false)).then(admit("append", 2))
    .expect(s.phase == "recovering" and s.sequence == 1)
    .then(reconcile(true)).then(mutate).then(persist("ack")).then(broadcast(false)).then(read)
    .expect(s.readRows == Set(1, 2) and s.readSequence == 2)
  run shutdownDrainsAdmittedWriteTest = init.then(admit("append", 1)).then(stop).then(mutate)
    .then(persist("ack")).then(broadcast(true)).then(drained).then(restart).then(read)
    .expect(s.readRows == Set(1) and s.readSequence == 1)
}

// Project a nested JSON payload to one distinguishable value. The producer
// and an observer can change their own copies during the inbox write.
module NotificationPayloadOwnership {
  type Payload = Missing | Present(str)
  var s: { producer: str, admitted: Payload, memory: Payload, disk: Payload, observer: Payload }

  action init = s' = { producer: "original", admitted: Missing, memory: Missing, disk: Missing, observer: Missing }
  action submit = all {
    s.admitted == Missing,
    s' = { ...s, admitted: Present(s.producer) },
  }
  action producerChanges(value: str): bool = s' = { ...s, producer: value }
  action materialize = all {
    s.admitted != Missing and s.memory == Missing and s.disk == Missing,
    s' = { ...s, memory: s.admitted },
  }
  action persist = all {
    s.memory != Missing,
    s' = { ...s, disk: s.memory },
  }
  // A normal read may see provisional memory. Durable reads and events use
  // the same detached payload after commit.
  action expose = all {
    s.memory != Missing,
    s' = { ...s, observer: s.memory },
  }
  action observerChanges(value: str): bool = all {
    s.observer != Missing,
    s' = { ...s, observer: Present(value) },
  }
  action stop = all {
    s.disk != Missing and s.memory != Missing,
    s' = { ...s, memory: Missing },
  }
  action restart = all {
    s.disk != Missing and s.memory == Missing,
    s' = { ...s, memory: s.disk },
  }
  action step = {
    nondet value = Set("original", "edited").oneOf()
    any { submit, producerChanges(value), materialize, persist, expose, observerChanges(value), stop, restart, s' = s }
  }
  val OwnedPayloadMatchesAdmission = (s.memory == Missing or s.memory == s.admitted) and
    (s.disk == Missing or s.disk == s.admitted)
  temporal AdmissionCapturesPayload = always((
    (s.admitted != Missing).implies(next(s.admitted) == s.admitted) and
    (s.admitted == Missing and next(s.admitted) != Missing).implies(next(s.admitted) == Present(s.producer))
  ).orKeep(s))
  temporal AdmittedPayloadPersistsWithoutFairness = (s.admitted != Missing).leadsTo(s.disk != Missing)
  temporal AdmittedPayloadPersists = (materialize.weakFair(s) and persist.weakFair(s))
    .implies(AdmittedPayloadPersistsWithoutFairness)

  run callerAndObserverEditsDoNotPersistTest = init.then(submit).then(producerChanges("edited"))
    .then(materialize).then(expose).then(observerChanges("edited")).then(persist)
    .then(expose).then(observerChanges("edited")).then(persist).then(stop).then(restart)
    .expect(s.memory == Present("original") and s.disk == Present("original") and s.observer == Present("edited"))
}
