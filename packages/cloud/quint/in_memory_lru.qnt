// Source: cloud/shared/src/lib/cache/in-memory-lru-cache.ts.
// Five keys, capacity four, with replacement, insertion, read, delete and clear.
// Entries remain live for the entire trace. TTL expiry, wall clocks, payload
// aliasing and prefix matching are outside this model. Capacity four makes the
// existing 75% new-key eviction policy remove one oldest entry before insertion.
module in_memory_lru {
  pure val Keys = Set(0, 1, 2, 3, 4)
  pure def keySet(order: List[int]): Set[int] = order.foldl(Set(), (acc, key) => acc.union(Set(key)))
  var s: { order: List[int], before: Set[int], updating: bool, written: int, event: str }
  action init = s' = { order: List(), before: Set(), updating: false, written: -1, event: "init" }
  action writeKey(key: int): bool = {
    val withoutKey = s.order.select(value => value != key)
    val admitted = if (withoutKey.length() >= 4) withoutKey.tail() else withoutKey
    s' = { order: admitted.append(key), before: keySet(s.order),
      updating: keySet(s.order).contains(key), written: key, event: "write" }
  }
  action readKey(key: int): bool = all {
    keySet(s.order).contains(key),
    s' = { ...s, order: s.order.select(value => value != key).append(key), event: "read" }
  }
  action removeKey(key: int): bool = s' = {
    ...s, order: s.order.select(value => value != key), event: "remove"
  }
  action clearAll = s' = { ...s, order: List(), event: "clear" }
  // Former implementation, excluded from step, for regression witnesses.
  action legacyWrite(key: int): bool = {
    val base = if (s.order.length() >= 4) s.order.tail() else s.order
    s' = { order: if (keySet(base).contains(key)) base else base.append(key),
      before: keySet(s.order), updating: keySet(s.order).contains(key), written: key, event: "write" }
  }
  action step = any {
    { nondet key = Keys.oneOf(); any { writeKey(key), readKey(key), removeKey(key) } },
    clearAll, s' = s
  }
  val safety = all {
    s.order.length() <= 4,
    keySet(s.order).size() == s.order.length(),
    (s.event == "write" and s.updating) implies keySet(s.order) == s.before,
    if (s.event == "write") s.order.nth(s.order.length() - 1) == s.written else true
  }
  run fullReplacementKeepsOtherKeysTest = init.then(writeKey(0)).then(writeKey(1))
    .then(writeKey(2)).then(writeKey(3)).then(writeKey(3))
    .expect(s.order == List(0, 1, 2, 3) and safety)
  run replacementPromotesRecencyTest = init.then(writeKey(0)).then(writeKey(1))
    .then(writeKey(2)).then(writeKey(0)).then(writeKey(3)).then(writeKey(4))
    .expect(s.order == List(2, 0, 3, 4) and safety)
  run newKeyStillEvictsOldestTest = init.then(writeKey(0)).then(writeKey(1))
    .then(writeKey(2)).then(writeKey(3)).then(writeKey(4))
    .expect(s.order == List(1, 2, 3, 4) and safety)
  run readPromotesRecencyTest = init.then(writeKey(0)).then(writeKey(1)).then(readKey(0))
    .expect(s.order == List(1, 0) and safety)
  run deletePreservesOtherKeysTest = init.then(writeKey(0)).then(writeKey(1)).then(removeKey(0))
    .expect(s.order == List(1) and safety)
  run clearRetiresEveryEntryTest = init.then(writeKey(0)).then(writeKey(1)).then(clearAll)
    .expect(s.order == List() and safety)
  run formerReplacementEvictionDetectedTest = init.then(writeKey(0)).then(writeKey(1))
    .then(writeKey(2)).then(writeKey(3)).then(legacyWrite(3)).expect(not(safety))
  run formerWriteRecencyDetectedTest = init.then(writeKey(0)).then(writeKey(1))
    .then(writeKey(2)).then(legacyWrite(0)).expect(not(safety))
}
