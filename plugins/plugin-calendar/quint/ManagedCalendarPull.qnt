// Managed feed reconciliation reuses the canonical mapped-event reconciler.
// Local revision is fixed in these cases; concurrent edits use the existing reconciler rules.
module ManagedCalendarPull {
  var phase: int
  var current: bool
  var allowed: bool
  var clean: bool
  var mapped: bool
  var local: int
  var remote: int
  var visibleCopies: int
  var providerWrites: int
  var readable: bool
  var cached: int
  val eligible = current and allowed and clean and mapped
  action init = {
    nondet ownerCurrent = Bool.oneOf()
    nondet canRead = Bool.oneOf()
    nondet writesAllowed = Bool.oneOf()
    nondet linkClean = Bool.oneOf()
    nondet exactMapping = Bool.oneOf()
    nondet providerVersion = Set(0, 1, 2).oneOf()
    all {phase' = 0, current' = ownerCurrent, allowed' = writesAllowed, clean' = linkClean,
      mapped' = exactMapping, local' = 0, remote' = providerVersion,
      visibleCopies' = 0, providerWrites' = 0, readable' = canRead, cached' = -1}
  }
  action reconcile = all {
    phase == 0, phase' = 1,
    local' = if (eligible) remote else local,
    cached' = if (current and readable and remote != 2) remote else cached, readable' = readable,
    current' = current, allowed' = allowed, clean' = clean, mapped' = mapped,
    remote' = remote, visibleCopies' = visibleCopies, providerWrites' = providerWrites
  }
  action project = all {
    phase == 1, phase' = 2,
    cached' = cached, readable' = readable,
    visibleCopies' = if (eligible and remote == 2) 0 else if (eligible) 1 else 0,
    local' = local, remote' = remote, current' = current, allowed' = allowed,
    clean' = clean, mapped' = mapped, providerWrites' = providerWrites
  }
  action done = all {
    phase == 2, phase' = phase, local' = local, remote' = remote, cached' = cached, readable' = readable,
    current' = current, allowed' = allowed, clean' = clean, mapped' = mapped,
    visibleCopies' = visibleCopies, providerWrites' = providerWrites
  }
  action step = any {reconcile, project, done}
  val NoProviderWrites = providerWrites == 0
  val HeldLinksUnchanged = eligible or local == 0
  val LocalReadbackBeforeProjection = phase != 2 or not(eligible) or local == remote
  val NoDuplicateMappedEvent = phase != 2 or not(eligible) or visibleCopies <= 1
  val ReadableObservationRetained = phase == 0 or not(current and readable and remote != 2) or cached == remote
  val UnobservedCacheUnchanged = current and readable and remote != 2 or cached == -1
  val invariant = ReadableObservationRetained and UnobservedCacheUnchanged and NoProviderWrites and HeldLinksUnchanged and LocalReadbackBeforeProjection and NoDuplicateMappedEvent
}

// One service, two calendar reads, one grant-scoped purge, and at most one
// fresh read after its receipt. Source/provider authorization is a broker fact.
module ManagedCalendarCacheDrain {
  type State = { sameGrant: bool, valid: int -> bool, phase: int -> int,
    epoch: int -> int, purge: int, failedPurge: bool, cancelled: Set[int], writing: Set[int],
    cached: Set[int], written: Set[int], success: Set[int], lateOldWrite: bool }
  var s: State
  pure val reads = Set(0, 1)
  action initialize(same: bool, valid0: bool, valid1: bool): bool = s' = {
    sameGrant: same, valid: Map(0 -> valid0, 1 -> valid1),
    phase: Map(0 -> 1, 1 -> 0), epoch: Map(0 -> 0, 1 -> 0), purge: 0, failedPurge: false,
    cancelled: Set(), writing: Set(), cached: Set(), written: Set(),
    success: Set(), lateOldWrite: false }
  action init = {
    nondet same = Bool.oneOf()
    nondet valid0 = Bool.oneOf()
    nondet valid1 = Bool.oneOf()
    initialize(same, valid0, valid1)
  }
  def target(i: int): bool = i == 0 or s.sameGrant
  action admit(i: int): bool = all {
    s.phase.get(i) == 0, not(target(i) and s.purge == 1),
    s' = s.with("phase", s.phase.set(i, 1))
      .with("epoch", s.epoch.set(i, if (target(i) and s.purge == 2) 1 else 0)) }
  action freshRead = all {
    s.purge == 2, s.phase.get(0) == 3, s.epoch.get(0) == 0,
    s' = s.with("phase", s.phase.set(0, 1)).with("epoch", s.epoch.set(0, 1))
      .with("cancelled", s.cancelled.exclude(Set(0)))
      .with("success", s.success.exclude(Set(0))) }
  action feed(i: int): bool = all {
    s.phase.get(i) == 1,
    s' = if (s.valid.get(i) and not(s.cancelled.contains(i)))
      s.with("phase", s.phase.set(i, 2)).with("writing", s.writing.union(Set(i)))
      else s.with("phase", s.phase.set(i, 3)) }
  action persist(i: int): bool = all {
    s.phase.get(i) == 2,
    s' = s.with("phase", s.phase.set(i, 3))
      .with("cached", s.cached.union(Set(i)))
      .with("written", s.written.union(Set(i)))
      .with("success", if (s.cancelled.contains(i)) s.success else s.success.union(Set(i)))
      .with("lateOldWrite", s.lateOldWrite or
        (target(i) and s.purge == 2 and s.epoch.get(i) == 0)) }
  action failWrite(i: int): bool = all {
    s.phase.get(i) == 2, s' = s.with("phase", s.phase.set(i, 3)) }
  action settle(i: int): bool = any { persist(i), failWrite(i) }
  action cancel(i: int): bool = all {
    Set(1, 2).contains(s.phase.get(i)), not(s.cancelled.contains(i)),
    s' = s.with("cancelled", s.cancelled.union(Set(i))) }
  action requestPurge = all { s.purge == 0, s' = s.with("purge", 1) }
  val drained = reads.forall(i => not(target(i)) or not(Set(1, 2).contains(s.phase.get(i))))
  action remove = all {
    s.purge == 1, drained,
    s' = s.with("purge", 2).with("cached", s.cached.filter(i => not(target(i)))) }
  action failRemove = all { s.purge == 1, drained, not(s.failedPurge),
    s' = s.with("purge", 3).with("failedPurge", true) }
  action retryRemove = all { s.purge == 3, s' = s.with("purge", 1) }
  action step = any { admit(0), admit(1), freshRead, feed(0), feed(1),
    settle(0), settle(1), cancel(0), cancel(1), requestPurge, remove, failRemove, retryRemove, s' = s }
  val NoOldReadWritesAfterReceipt = not(s.lateOldWrite)
  val ReceiptDrainedOldReads = s.purge != 2 or reads.forall(i =>
    not(target(i)) or s.epoch.get(i) == 1 or
      (not(Set(1, 2).contains(s.phase.get(i))) and not(s.cached.contains(i))))
  val WritesNeedValidatedFeed = s.cached.forall(i => s.valid.get(i) and s.writing.contains(i))
  val NoFabricatedSuccess = s.success.forall(i => s.valid.get(i) and not(s.cancelled.contains(i)))
  val UnrelatedCacheRetained = s.sameGrant or not(s.written.contains(1)) or s.cached.contains(1)
  temporal FairPurgeCompletes = (feed(0).weakFair(s) and feed(1).weakFair(s) and
    settle(0).weakFair(s) and settle(1).weakFair(s) and remove.weakFair(s) and
    retryRemove.weakFair(s)) implies
    (Set(1, 3).contains(s.purge)).leadsTo(s.purge == 2)
  temporal PurgeCompletes = (s.purge == 1).leadsTo(s.purge == 2)
  run purgeDrainsHeldReadTest = initialize(true, true, true)
    .then(requestPurge).expect(not(drained)).then(feed(0)).then(persist(0))
    .then(remove).expect(s.purge == 2 and s.cached.size() == 0)
  run cancelledBeforeCacheTest = initialize(true, true, true)
    .then(cancel(0)).then(feed(0)).then(requestPurge).then(remove)
    .expect(s.cached.size() == 0 and s.success.size() == 0)
  run cancelledAdmittedWriteStillDrainsTest = initialize(true, true, true)
    .then(feed(0)).then(cancel(0)).then(requestPurge).then(persist(0))
    .then(remove).expect(s.cached.size() == 0 and s.success.size() == 0)
  run unrelatedGrantStaysConcurrentTest = initialize(false, true, true)
    .then(admit(1)).then(requestPurge).then(feed(1)).then(persist(1))
    .then(feed(0)).then(persist(0)).then(remove)
    .expect(s.cached == Set(1))
  run enabledReadAfterRemovalMayImportTest = initialize(true, true, true)
    .then(requestPurge).then(feed(0)).then(persist(0)).then(remove)
    .then(freshRead).then(feed(0)).then(persist(0))
    .expect(s.cached == Set(0) and NoOldReadWritesAfterReceipt)
  run failedRemovalRetainsCacheUntilRetryTest = initialize(true, true, true)
    .then(feed(0)).then(persist(0)).then(requestPurge).then(failRemove)
    .expect(s.purge == 3 and s.cached == Set(0))
    .then(retryRemove).then(remove).expect(s.purge == 2 and s.cached.size() == 0)
  run partialOrRevokedFeedNeverCachesTest = initialize(true, false, true)
    .then(feed(0)).then(requestPurge).then(remove).expect(s.cached.size() == 0)
}

// One globally keyed cache row and one incoming complete event. Equal/different
// values abstract stable IDs; display labels do not participate in identity.
module ManagedCalendarCacheIdentity {
  type Identity = { agent: int, provider: int, side: int, grant: int,
    calendar: int, external: int, account: int }
  pure val original: Identity = { agent: 0, provider: 0, side: 0, grant: 0,
    calendar: 0, external: 0, account: 0 }
  type State = { hadRow: bool, present: bool, row: Identity, candidate: Identity,
    phase: int, payload: int, result: int, retried: bool }
  var s: State
  action initialize(present: bool, candidate: Identity): bool = s' = {
    hadRow: present, present: present, row: original, candidate: candidate,
    phase: 0, payload: if (present) 11 else 0, result: 0, retried: false }
  action init = {
    nondet present = Bool.oneOf()
    nondet agent = Set(0, 1).oneOf()
    nondet provider = Set(0, 1).oneOf()
    nondet side = Set(0, 1).oneOf()
    nondet grant = Set(0, 1).oneOf()
    nondet calendar = Set(0, 1).oneOf()
    nondet external = Set(0, 1).oneOf()
    nondet account = Set(0, 1).oneOf()
    initialize(present, { agent: agent, provider: provider, side: side,
      grant: grant, calendar: calendar, external: external, account: account })
  }
  val compatible = not(s.present) or s.row == s.candidate
  action write = all { s.phase == 0,
    s' = s.with("phase", 1).with("result", if (compatible) 1 else 2)
      .with("present", if (compatible) true else s.present)
      .with("row", if (compatible) s.candidate else s.row)
      .with("payload", if (compatible) 17 else s.payload) }
  // A later read of the original exact source can still update its own row.
  action freshMatchingRead = all { s.phase == 1, s.result == 2, not(s.retried),
    s' = s.with("phase", 0).with("result", 0).with("candidate", original)
      .with("retried", true) }
  action done = all { s.phase == 1, s' = s }
  action step = any { write, freshMatchingRead, done }
  val ExistingIdentityRetained = not(s.hadRow) or s.row == original
  val ConflictLeavesPayloadUnchanged = s.phase != 1 or not(s.hadRow) or
    s.candidate == original or (s.result == 2 and s.payload == 11 and s.row == original)
  val SuccessNeedsExactSourceAndWholePayload = s.result != 1 or
    (s.present and s.row == s.candidate and s.payload == 17)
  val NonCollidingInsertWorks = s.hadRow or s.phase == 0 or
    (s.result == 1 and s.row == s.candidate and s.payload == 17)
  run anotherAgentCannotReplacePayloadTest = initialize(true, original.with("agent", 1))
    .then(write).expect(s.result == 2 and s.payload == 11 and s.row == original)
    .then(freshMatchingRead).then(write).expect(s.result == 1 and s.payload == 17)
  run anotherCalendarCannotReplacePayloadTest = initialize(true, original.with("calendar", 1))
    .then(write).expect(s.result == 2 and s.payload == 11 and s.row == original)
  run nonCollidingInsertPreservesWholePayloadTest = initialize(false, original.with("agent", 1))
    .then(write).expect(s.result == 1 and s.row == s.candidate and s.payload == 17)
}
