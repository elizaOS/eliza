// Two writers prepare two immutable payloadSlots before an atomic SQL pointer update.
// Provider work may finish after another slot failed. There is no speculative GC.
module generation_object_versions {
  type State = { phase: int -> str, pending: Set[int], accepted: Set[int],
    bodies: int -> int, pointers: int -> int, expected: int -> int }
  var s: State
  pure val writers = Set(1, 2)
  pure val payloadSlots = Set(0, 1)
  pure val objectKeys = 0.to(5)
  pure def owner(key: int): int = if (key < 2) 0 else if (key < 4) 1 else 2
  pure def writerKeys(writer: int): Set[int] = Set(2 * writer, 2 * writer + 1)
  action init = s' = { phase: writers.mapBy(_ => "idle"), pending: Set(), accepted: Set(),
    bodies: objectKeys.mapBy(key => if (key < 2) 0 else -1),
    pointers: payloadSlots.mapBy(slot => slot), expected: payloadSlots.mapBy(_ => 0) }
  action begin(writer) = all {
    s.phase.get(writer) == "idle",
    s' = { ...s, phase: s.phase.set(writer, "preparing"),
      pending: s.pending.union(writerKeys(writer)) }
  }
  action putSucceeded(key) = all {
    s.pending.contains(key), s.bodies.get(key) == -1,
    s' = { ...s, pending: s.pending.exclude(Set(key)),
      accepted: s.accepted.union(Set(key)), bodies: s.bodies.set(key, owner(key)) }
  }
  action putFailed(key, ambiguous) = all {
    s.pending.contains(key),
    s' = { ...s, phase: s.phase.set(owner(key), "failed"),
      pending: s.pending.exclude(Set(key)),
      bodies: if (ambiguous) s.bodies.set(key, owner(key)) else s.bodies }
  }
  def prepared(writer) = s.phase.get(writer) == "preparing"
    and writerKeys(writer).subseteq(s.accepted)
  action publish(writer, replyLost) = all {
    prepared(writer),
    s' = { ...s, phase: s.phase.set(writer, if (replyLost) "unknown" else "published"),
      pointers: payloadSlots.mapBy(slot => 2 * writer + slot), expected: payloadSlots.mapBy(_ => writer) }
  }
  action sqlFailed(writer) = all {
    prepared(writer), s' = { ...s, phase: s.phase.set(writer, "failed") }
  }
  action finish = {
    nondet writer = writers.oneOf()
    nondet key = 2.to(5).oneOf()
    any { putSucceeded(key), putFailed(key, false), putFailed(key, true),
      publish(writer, false), publish(writer, true), sqlFailed(writer) }
  }
  action step = {
    nondet writer = writers.oneOf()
    any { begin(writer), finish, s' = s }
  }
  val referencedBytesMatch = payloadSlots.forall(slot =>
    s.bodies.get(s.pointers.get(slot)) == s.expected.get(slot))
  val keysNeverChangeOwner = objectKeys.forall(key =>
    s.bodies.get(key) == -1 or s.bodies.get(key) == owner(key))
  val legacyBytesRetained = s.bodies.get(0) == 0 and s.bodies.get(1) == 0
  val safety = referencedBytesMatch and keysNeverChangeOwner and legacyBytesRetained
  // This debt is retained, not evidence of authorized cleanup. Unknown SQL
  // outcomes can still own their objects through committed pointers.
  val unreferencedObjects = objectKeys.filter(key => s.bodies.get(key) >= 0
    and not(payloadSlots.exists(slot => s.pointers.get(slot) == key)))
  temporal PreparedAttemptsSettle = finish.weakFair(s) implies
    always(writers.forall(writer => s.phase.get(writer) == "preparing"
      implies eventually(s.phase.get(writer) != "preparing")))
  temporal OutstandingPutsSettle = finish.weakFair(s) implies
    always(s.pending != Set() implies eventually(s.pending == Set()))

  run sqlFailureRetainsOldPointersTest = init.then(begin(1)).then(putSucceeded(2))
    .then(putSucceeded(3)).then(sqlFailed(1)).expect(safety and s.pointers.get(0) == 0
      and unreferencedObjects == Set(2, 3))
  run writersPublishTheirOwnBytesTest = init.then(begin(1)).then(putSucceeded(2))
    .then(putSucceeded(3)).then(begin(2)).then(putSucceeded(4)).then(putSucceeded(5))
    .then(publish(2, false)).then(publish(1, false)).expect(safety and s.expected.get(0) == 1)
  run ambiguousPutCannotPublishTest = init.then(begin(1)).then(putFailed(2, true))
    .then(putSucceeded(3)).expect(safety and s.phase.get(1) == "failed"
      and s.pointers.get(0) == 0 and unreferencedObjects == Set(2, 3))
  run lateSiblingPutRetainsOldBytesTest = init.then(begin(1)).then(putFailed(2, false))
    .then(putSucceeded(3)).expect(safety and s.pointers.get(1) == 1)
  run unknownSqlCommitKeepsReferencedObjectsTest = init.then(begin(1)).then(putSucceeded(2))
    .then(putSucceeded(3)).then(publish(1, true)).expect(safety and s.phase.get(1) == "unknown")

  action oldOverwriteCommittedKey = s' = { ...s, bodies: s.bodies.set(0, 1) }
  action unsafeCleanupUnknownWriter = s' = { ...s, bodies: s.bodies.set(2, -1).set(3, -1) }
  run oldMutableKeyWitnessTest = init.then(begin(1)).then(oldOverwriteCommittedKey)
    .expect(not(safety))
  run unknownOutcomeCleanupWitnessTest = init.then(begin(1)).then(putSucceeded(2))
    .then(putSucceeded(3)).then(publish(1, true)).then(unsafeCleanupUnknownWriter)
    .expect(not(safety))
}
