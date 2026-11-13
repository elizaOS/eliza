// Three issued tickets bound request, successful registration, refusal and explicit unwatch.
// A previous observer may remain allocated while a new request runs, but may not publish.
module StorageWatch {
  var s: { generation: int, active: int, installed: Set[int], stopped: Set[int], refused: bool }
  action init = s' = {generation: 0, active: -1, installed: Set(), stopped: Set(), refused: false}
  action request = all { s.generation < 3, s' = {...s, generation: s.generation + 1, refused: false} }
  action install(ticket: int): bool = all {
    ticket > 0, ticket == s.generation, not(s.installed.contains(ticket)),
    s' = {...s, active: ticket, installed: s.installed.union(Set(ticket)),
      stopped: if (s.active < 0) s.stopped else s.stopped.union(Set(s.active)), refused: false}
  }
  action refuse(ticket: int): bool = s' = if (ticket == s.generation)
    {...s, active: -1, stopped: if (s.active < 0) s.stopped else s.stopped.union(Set(s.active)), refused: true}
    else s
  action clear = all { s.generation < 3,
    s' = {...s, generation: s.generation + 1, active: -1,
      stopped: if (s.active < 0) s.stopped else s.stopped.union(Set(s.active)), refused: false}
  }
  action step = any {
    request,
    { nondet ticket = 1.to(3).oneOf(); install(ticket) },
    { nondet ticket = 1.to(3).oneOf(); refuse(ticket) },
    clear,
    s' = s
  }
  val TypeOK = s.generation >= 0 and s.generation <= 3 and s.active >= -1 and s.active <= 3
  val ActiveResourceIsLive = (s.active >= 0).implies(s.installed.contains(s.active) and not(s.stopped.contains(s.active)))
  val RefusalReleasesResources = s.refused.implies(s.active == -1)
  val safety = TypeOK and ActiveResourceIsLive and RefusalReleasesResources
  run latestRefusalReleasesPreviousTest = init.then(request).then(install(1)).then(request)
    .then(refuse(2)).expect(safety and s.active == -1 and s.stopped == Set(1))
  run staleRefusalPreservesNewerTest = init.then(request).then(request).then(install(2))
    .then(refuse(1)).expect(safety and s.active == 2 and s.stopped == Set())
  run unwatchRetiresPendingTest = init.then(request).then(install(1)).then(request).then(clear)
    .then(refuse(2)).expect(safety and s.active == -1 and s.stopped == Set(1))
}
