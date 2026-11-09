// App container publication: original tenant/generation/row identity plus a
// primary database snapshot feed one atomic running+placement CAS. Retirement
// must retain its delete ownership; stale cleanup must retain a newer slot.
// Sources: app-container-store.ts, app-container-store-queries.ts,
// container-job-executors.ts and container-retirement.ts.
// Bounds: one container, two generations/row identities, one metadata edit.
// Original timestamp text is assumed unique for each row incarnation. No
// provider truth, route publication or unbounded liveness/refinement is proved.
module app_container_publication {
  type State = {
    status: str, generation: int, birth: int, revision: int, metadata: int,
    captured: bool, snapGeneration: int, snapBirth: int, snapRevision: int, snapMetadata: int,
    retired: bool, deleteMarker: bool, placement: bool, completed: bool, rejected: bool,
    statusWritten: bool, slotHeld: bool, releaseMarker: bool, releases: int
  }
  var s: State
  action init = s' = {
    status: "deploying", generation: 0, birth: 0, revision: 0, metadata: 0,
    captured: false, snapGeneration: 0, snapBirth: 0, snapRevision: 0, snapMetadata: 0,
    retired: false, deleteMarker: false, placement: false, completed: false, rejected: false,
    statusWritten: false, slotHeld: true, releaseMarker: false, releases: 0
  }
  action capture = all {
    not(s.captured), not(s.completed),
    s' = s.with("captured", true).with("snapGeneration", s.generation).with("snapBirth", s.birth)
      .with("snapRevision", s.revision).with("snapMetadata", s.metadata)
  }
  action retire = all {
    not(s.retired), s' = s.with("status", "deleting").with("retired", true)
      .with("deleteMarker", true).with("revision", s.revision + 1)
  }
  // The original retirement finalizer may hold the earlier node identity.
  action delete = all {
    s.status == "deleting", originalAuthority,
    s' = s.with("status", "deleted").with("revision", s.revision + 1)
      .with("slotHeld", false).with("releaseMarker", true)
      .with("releases", if (s.releaseMarker) s.releases else s.releases + 1)
  }
  action supersedeGeneration = all {
    s.generation == 0, not(s.retired),
    s' = s.with("generation", 1).with("revision", s.revision + 1).with("placement", false).with("slotHeld", true)
  }
  action replaceRow = all {
    s.birth == 0,
    s' = s.with("birth", 1).with("revision", 0).with("metadata", 0).with("status", "deploying")
      .with("retired", false).with("deleteMarker", false).with("placement", false).with("slotHeld", true)
      .with("releaseMarker", false)
  }
  action mutateMetadata = all {
    s.metadata == 0, s' = s.with("metadata", 1)
  }
  val originalAuthority = s.generation == 0 and s.birth == 0
  val exactSnapshot = s.generation == s.snapGeneration and s.birth == s.snapBirth
    and s.revision == s.snapRevision and s.metadata == s.snapMetadata
  action publish = all {
    s.captured, not(s.completed),
    s' = if (originalAuthority and exactSnapshot and not(s.retired))
      s.with("status", "running").with("placement", true).with("completed", true)
    else s.with("rejected", true).with("completed", true)
  }
  action cleanupOriginalSlot = all {
    originalAuthority, s.retired, s.slotHeld,
    s' = s.with("slotHeld", false).with("releaseMarker", true).with("releases", s.releases + 1)
  }
  action rejectStaleCleanup = all { not(originalAuthority), s' = s }
  action idle = s' = s
  action step = any {
    capture, retire, delete, supersedeGeneration, replaceRow, mutateMetadata, publish,
    cleanupOriginalSlot, rejectStaleCleanup, idle
  }
  val safety = all {
    s.releases <= 1,
    s.retired implies (Set("deleting", "deleted").contains(s.status) and s.deleteMarker),
    s.placement implies originalAuthority,
    not(originalAuthority) implies s.slotHeld
  }
  temporal PendingPublicationCompletes = publish.weakFair(s) implies
    always((s.captured and not(s.completed)) implies eventually(s.completed))
  run retirementBeforeCommitWinsTest = init.then(capture).then(retire).then(publish)
    .expect(s.rejected and s.deleteMarker and safety)
  run retirementAfterCommitKeepsOwnershipTest = init.then(capture).then(publish).then(retire)
    .expect(s.status == "deleting" and s.deleteMarker and safety)
  run originalGenerationRequiredTest = init.then(supersedeGeneration).then(capture).then(publish)
    .expect(s.rejected and safety)
  run originalRowRequiredTest = init.then(replaceRow).then(capture).then(publish)
    .expect(s.rejected and safety)
  run newMetadataCannotBeOverwrittenTest = init.then(capture).then(mutateMetadata).then(publish)
    .expect(s.rejected and safety)
  run staleCleanupRetainsNewSlotTest = init.then(replaceRow).then(rejectStaleCleanup)
    .expect(s.slotHeld and safety)
  run retirementFinalizerDoesNotReleaseNeighborSlotTest = init.then(capture).then(retire)
    .then(publish).then(cleanupOriginalSlot).then(delete).expect(s.releases == 1 and safety)
  // Prior two-write implementation: status checked only hard-deleted, then
  // placement rebuilt from an older read overwrote new retirement metadata.
  action oldStatusWrite = all {
    s.captured, s.status != "deleted",
    s' = s.with("status", "running").with("statusWritten", true)
  }
  action oldMetadataWrite = all {
    s.statusWritten, s' = s.with("deleteMarker", false).with("placement", true)
  }
  run splitStatusWindowDetectedTest = init.then(capture).then(retire).then(oldStatusWrite)
    .expect(not(safety))
  run splitMetadataWindowDetectedTest = init.then(capture).then(oldStatusWrite).then(retire)
    .then(oldMetadataWrite).expect(not(safety))
}

// The job-owned path adds withMutation's job -> lease -> resource lock order.
// The original module above retains the optional, non-job publication path.
// Authority is checked after the resource wait. Once admitted, the same SQL
// transaction protects its mutation until commit, even if the clock advances.
module app_container_publication_owned {
  import app_container_publication.*
  type OwnedState = {
    phase: str, currentGeneration: int, currentOwner: int, jobStatus: str,
    requestedOwner: int, identityMatches: bool, now: int, expiry: int,
    resourceHeldElsewhere: bool, admitted: bool, admittedAt: int,
    admittedExpiry: int, admittedGeneration: int, admittedOwner: int
  }
  var a: OwnedState
  action initOwnedAs(owner: int, matchingIdentity: bool): bool = all {
    init,
    a' = {phase: "idle", currentGeneration: 1, currentOwner: 1, jobStatus: "running",
      requestedOwner: owner, identityMatches: matchingIdentity, now: 0, expiry: 2,
      resourceHeldElsewhere: false, admitted: false, admittedAt: 0,
      admittedExpiry: 0, admittedGeneration: 0, admittedOwner: 0}
  }
  action ownedInit = {
    nondet owner = Set(1, 2).oneOf()
    nondet identity = Set(true, false).oneOf()
    initOwnedAs(owner, identity)
  }
  val jobLocked = Set("job_locked", "resource_locked", "admitted", "captured").contains(a.phase)
  val resourceLocked = Set("resource_locked", "admitted", "captured").contains(a.phase)
  val liveAuthority = a.identityMatches and a.currentGeneration == 1 and
    a.currentOwner == a.requestedOwner and a.jobStatus == "running" and a.now < a.expiry
  action beginOwned = all {
    a.phase == "idle", s' = s,
    a' = {...a, phase: if (a.identityMatches) "job_locked" else "done"}
  }
  action lockOwnedResource = all {
    a.phase == "job_locked", not(a.resourceHeldElsewhere), s' = s,
    a' = {...a, phase: "resource_locked"}
  }
  action admitOwned = all {
    a.phase == "resource_locked", s' = s,
    a' = if (liveAuthority) {...a, phase: "admitted", admitted: true,
      admittedAt: a.now, admittedExpiry: a.expiry,
      admittedGeneration: a.currentGeneration, admittedOwner: a.currentOwner}
      else {...a, phase: "done"}
  }
  action captureOwned = all {
    a.phase == "admitted", capture, a' = {...a, phase: "captured"}
  }
  action publishOwned = all {
    a.phase == "captured", publish, a' = {...a, phase: "done"}
  }
  action failOwned = all {
    jobLocked, s' = s, a' = {...a, phase: "done"}
  }
  action ownedClock = all {
    a.now < 6, s' = s, a' = {...a, now: a.now + 1}
  }
  action renewOwned = all {
    not(jobLocked), a.jobStatus == "running", s' = s,
    a' = {...a, expiry: a.now + 2}
  }
  action cancelOwned = all {
    not(jobLocked), a.jobStatus == "running", a.now < a.expiry, s' = s,
    a' = {...a, jobStatus: "cancelled", currentOwner: 0}
  }
  action takeoverOwned = all {
    not(jobLocked), a.jobStatus == "running", a.currentGeneration == 1, a.now >= a.expiry + 1, s' = s,
    a' = {...a, currentGeneration: 2, currentOwner: 2, jobStatus: "running", expiry: a.now + 2}
  }
  action holdExternalResource = all {
    not(resourceLocked), not(a.resourceHeldElsewhere), s' = s,
    a' = {...a, resourceHeldElsewhere: true}
  }
  action releaseExternalResource = all {
    a.resourceHeldElsewhere, s' = s, a' = {...a, resourceHeldElsewhere: false}
  }
  action externalContainerStep = all {
    not(resourceLocked), any {retire, delete, supersedeGeneration, replaceRow, mutateMetadata},
    a' = a
  }
  action finishOwnedStep = any {
    lockOwnedResource, admitOwned, captureOwned, publishOwned, failOwned
  }
  action ownedStep = any {
    beginOwned, finishOwnedStep, ownedClock, renewOwned, cancelOwned, takeoverOwned,
    holdExternalResource, releaseExternalResource, externalContainerStep,
    all {s' = s, a' = a}
  }
  val ownedSafety = safety and (a.admitted implies all {
    a.admittedGeneration == 1, a.admittedOwner == a.requestedOwner,
    a.identityMatches, a.admittedAt < a.admittedExpiry
  }) and (s.placement implies a.admitted)
  temporal PendingOwnedMutationCompletes = finishOwnedStep.weakFair(a) implies
    always(jobLocked implies eventually(a.phase == "done"))

  run cancelledJobCannotPublishUnchangedAppGenerationTest = initOwnedAs(1, true)
    .then(cancelOwned).then(beginOwned).then(lockOwnedResource).then(admitOwned)
    .expect(a.phase == "done" and not(s.placement) and ownedSafety)
  run resourceWaitRechecksLeaseTest = initOwnedAs(1, true).then(holdExternalResource)
    .then(beginOwned).then(ownedClock).then(ownedClock).then(releaseExternalResource)
    .then(lockOwnedResource).then(admitOwned)
    .expect(a.phase == "done" and not(s.placement) and ownedSafety)
  run admittedTransactionKeepsItsAuthorityTest = initOwnedAs(1, true).then(beginOwned)
    .then(lockOwnedResource).then(admitOwned).then(ownedClock).then(ownedClock)
    .then(captureOwned).then(publishOwned)
    .expect(s.status == "running" and a.now >= a.expiry and ownedSafety)
  run replacedJobCannotPublishSameAppGenerationTest = initOwnedAs(1, true)
    .then(ownedClock).then(ownedClock).then(ownedClock).then(takeoverOwned)
    .then(beginOwned).then(lockOwnedResource).then(admitOwned)
    .expect(a.phase == "done" and s.generation == 0 and not(s.placement) and ownedSafety)
  run differentOwnerCannotPublishTest = initOwnedAs(2, true).then(beginOwned)
    .then(lockOwnedResource).then(admitOwned)
    .expect(a.phase == "done" and not(s.placement) and ownedSafety)
  run differentTenantCannotPublishTest = initOwnedAs(1, false).then(beginOwned)
    .expect(a.phase == "done" and not(s.placement) and ownedSafety)
}
