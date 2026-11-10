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
  val eligible = current and allowed and clean and mapped
  action init = {
    nondet ownerCurrent = Bool.oneOf()
    nondet writesAllowed = Bool.oneOf()
    nondet linkClean = Bool.oneOf()
    nondet exactMapping = Bool.oneOf()
    nondet providerVersion = Set(0, 1, 2).oneOf()
    all {phase' = 0, current' = ownerCurrent, allowed' = writesAllowed, clean' = linkClean,
      mapped' = exactMapping, local' = 0, remote' = providerVersion,
      visibleCopies' = 0, providerWrites' = 0}
  }
  action reconcile = all {
    phase == 0, phase' = 1,
    local' = if (eligible) remote else local,
    current' = current, allowed' = allowed, clean' = clean, mapped' = mapped,
    remote' = remote, visibleCopies' = visibleCopies, providerWrites' = providerWrites
  }
  action project = all {
    phase == 1, phase' = 2,
    visibleCopies' = if (eligible and remote == 2) 0 else if (eligible) 1 else 0,
    local' = local, remote' = remote, current' = current, allowed' = allowed,
    clean' = clean, mapped' = mapped, providerWrites' = providerWrites
  }
  action done = all {
    phase == 2, phase' = phase, local' = local, remote' = remote,
    current' = current, allowed' = allowed, clean' = clean, mapped' = mapped,
    visibleCopies' = visibleCopies, providerWrites' = providerWrites
  }
  action step = any {reconcile, project, done}
  val NoProviderWrites = providerWrites == 0
  val HeldLinksUnchanged = eligible or local == 0
  val LocalReadbackBeforeProjection = phase != 2 or not(eligible) or local == remote
  val NoDuplicateMappedEvent = phase != 2 or not(eligible) or visibleCopies <= 1
  val invariant = NoProviderWrites and HeldLinksUnchanged and LocalReadbackBeforeProjection and NoDuplicateMappedEvent
}
