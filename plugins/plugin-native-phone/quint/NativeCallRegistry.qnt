// One Android InCallService, two unique call ids, and one queued callback per call.
// Android invokes lifecycle methods on Main; unregister does not revoke posted callbacks.
module NativeCallRegistry {
  pure val Ids = Set(1, 2)
  type State = { live: bool, issued: Set[int], calls: Set[int],
    callbacks: Set[int], connected: Set[int], notifications: Set[int], queued: Set[int] }
  var s: State
  action init = s' = { live: true, issued: Set(), calls: Set(), callbacks: Set(),
    connected: Set(), notifications: Set(), queued: Set() }
  action add(id: int): bool = all { s.live, not(s.issued.contains(id)),
    s' = { ...s, issued: s.issued.union(Set(id)), calls: s.calls.union(Set(id)),
      callbacks: s.callbacks.union(Set(id)), connected: s.connected.union(Set(id)),
      notifications: s.notifications.union(Set(id)) } }
  action nativeUpdate(id: int, connected: bool): bool = all {
    s.live, s.calls.contains(id), not(s.queued.contains(id)),
    s' = { ...s, connected: if (connected) s.connected.union(Set(id)) else s.connected.exclude(Set(id)),
      queued: s.queued.union(Set(id)) } }
  action remove(id: int): bool = all { s.calls.contains(id),
    s' = { ...s, calls: s.calls.exclude(Set(id)), callbacks: s.callbacks.exclude(Set(id)),
      notifications: s.notifications.exclude(Set(id)) } }
  action destroy = all { s.live, s' = { ...s, live: false, calls: Set(),
    callbacks: Set(), notifications: Set() } }
  // The native runnable already holds its callback. Its current registry identity
  // must still match before it can reach notification publication.
  action drain(id: int): bool = all { s.queued.contains(id),
    s' = { ...s, queued: s.queued.exclude(Set(id)), notifications:
      if (s.calls.contains(id) and s.callbacks.contains(id))
        (if (s.connected.contains(id)) s.notifications.union(Set(id)) else s.notifications.exclude(Set(id)))
      else s.notifications } }
  action step = any {
    { nondet id = Ids.oneOf() add(id) },
    { nondet id = Ids.oneOf() nativeUpdate(id, true) },
    { nondet id = Ids.oneOf() nativeUpdate(id, false) },
    { nondet id = Ids.oneOf() remove(id) },
    { nondet id = Ids.oneOf() drain(id) }, destroy, s' = s }
  val CallbacksMatchRegistry = s.callbacks == s.calls
  val NotificationsHaveCurrentOwner = s.notifications.subseteq(s.calls)
  val DestroyedOwnerHasNoPublishedCalls = not(s.live) implies
    (s.calls.size() == 0 and s.callbacks.size() == 0 and s.notifications.size() == 0)
  val TypeOK = s.issued.subseteq(Ids) and s.calls.subseteq(s.issued)
    and s.connected.subseteq(s.issued) and s.queued.subseteq(s.issued)
  temporal RetiredCallsStayAbsent = always(Ids.forall(id =>
    ((s.issued.contains(id) and not(s.calls.contains(id))) implies
      not(next(s.calls).contains(id)))).orKeep(s))
  temporal RetiredCallbacksSettle = Ids.forall(id =>
    (s.queued.contains(id) and not(s.calls.contains(id))).leadsTo(not(s.queued.contains(id))))
  temporal FairRetiredCallbacksSettle = Ids.forall(id => drain(id).weakFair(s)) implies RetiredCallbacksSettle
  run removedCallbackCannotNotifyTest = init.then(add(1)).then(nativeUpdate(1, true))
    .then(remove(1)).then(drain(1)).expect(s.notifications.size() == 0)
  run destroyedCallbackCannotNotifyTest = init.then(add(1)).then(nativeUpdate(1, true))
    .then(destroy).then(drain(1)).expect(DestroyedOwnerHasNoPublishedCalls)
  run otherCallRemainsOwnedTest = init.then(add(1)).then(add(2)).then(nativeUpdate(1, true))
    .then(remove(1)).then(drain(1)).expect(s.calls == Set(2) and s.notifications == Set(2))
  run disconnectedCallRemainsRegisteredUntilRemovalTest = init.then(add(1)).then(nativeUpdate(1, false))
    .then(drain(1)).expect(s.calls == Set(1) and s.notifications.size() == 0)
  run currentCallbackStillNotifiesTest = init.then(add(1)).then(nativeUpdate(1, true))
    .then(drain(1)).expect(s.notifications == Set(1))
  run destructionClearsBothCallsTest = init.then(add(1)).then(add(2)).then(destroy)
    .expect(DestroyedOwnerHasNoPublishedCalls)
}

// Contact I/O and its posted result retain the service, call and current grant admission.
module NativeCallContactLookup {
  var s: { live: bool, call: bool, grant: bool, phase: str, cache: bool,
    published: bool, admitted: bool }
  action init = s' = { live: true, call: true, grant: true, phase: "idle", cache: false,
    published: false, admitted: false }
  action lookup = all { s.live, s.call, s.grant, s.phase == "idle", s' = { ...s, phase: "io" } }
  action ioReturns = all { s.phase == "io", s' = { ...s, phase: "main" } }
  action publish = all { s.phase == "main", s' = { ...s, phase: "done",
    cache: s.live and s.call and s.grant,
    published: s.live and s.call and s.grant,
    admitted: s.live and s.call and s.grant } }
  action cachedRefresh = all { s.phase == "done", s.live, s.call,
    s' = { ...s, published: s.cache and s.grant, admitted: s.grant } }
  action withdraw = all { s.grant, s' = { ...s, grant: false } }
  action remove = all { s.call, s' = { ...s, call: false, cache: false, published: false } }
  action destroy = all { s.live, s' = { ...s, live: false, call: false, cache: false, published: false } }
  action step = any { lookup, ioReturns, publish, cachedRefresh, withdraw, remove, destroy, s' = s }
  val TypeOK = Set("idle", "io", "main", "done").contains(s.phase)
  val PublicationHasCurrentAdmission = s.published implies s.admitted
  val RetiredOwnerDoesNotPublish = (not(s.live) or not(s.call)) implies not(s.published)
  temporal LookupSettles = (s.phase == "io" or s.phase == "main").leadsTo(s.phase == "done")
  temporal FairLookupSettles = (ioReturns.weakFair(s) and publish.weakFair(s)) implies LookupSettles
  run withdrawnGrantBeforeMainDoesNotPublishTest = init.then(lookup).then(ioReturns).then(withdraw)
    .then(publish).expect(not(s.published) and not(s.cache))
  run removedCallBeforeMainDoesNotPublishTest = init.then(lookup).then(ioReturns).then(remove)
    .then(publish).expect(not(s.published))
  run destroyedServiceBeforeMainDoesNotPublishTest = init.then(lookup).then(ioReturns).then(destroy)
    .then(publish).expect(not(s.published))
  run currentLookupCanPublishTest = init.then(lookup).then(ioReturns).then(publish).expect(s.published)
  run cachedRefreshRechecksGrantTest = init.then(lookup).then(ioReturns).then(publish).then(withdraw)
    .then(cachedRefresh).expect(not(s.published))
}
