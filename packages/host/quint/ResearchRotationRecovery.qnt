// Offline rotation retains private key receipts before committing SQLite.
// A process interruption can leave the active configuration one key behind.
module ResearchRotationRecovery {
  var s: {
    phase: str, lease: str, databaseKey: int, configKey: int,
    previous: bool, nextFile: bool, result: str
  }
  action init = s' = {
    phase: "idle", lease: "none", databaseKey: 0, configKey: 0,
    previous: false, nextFile: false, result: "none"
  }

  action externalAcquire = all {
    s.phase == "idle", s.lease == "none",
    s' = s.with("lease", "writer"),
  }
  action externalRelease = all {
    s.lease == "writer",
    s' = s.with("lease", "none"),
  }
  action start(admin: bool): bool = all {
    s.phase.in(Set("idle", "done", "recoverable")),
    s' = if (not(admin)) s.with("result", "role-refused")
      else if (s.lease != "none") s.with("result", "lease-refused")
      else if (s.previous) s.with("result", "recovery-file-refused")
      else { ...s, phase: "leased", lease: "rotation", result: "pending" },
  }
  action writePrevious = all {
    s.phase == "leased",
    s' = { ...s, phase: "previous-written", previous: true },
  }
  action prepareNext = all {
    s.phase == "previous-written",
    s' = { ...s, phase: "prepared", nextFile: true },
  }
  action settleDatabase(commit: bool): bool = all {
    s.phase == "prepared",
    s' = if (commit) { ...s, phase: "committed", databaseKey: 1 }
      else { ...s, phase: "failed" },
  }
  action publishConfig = all {
    s.phase == "committed",
    s' = { ...s, phase: "published", configKey: 1, nextFile: false },
  }
  action interruptBeforePublish = all {
    s.phase == "committed",
    s' = { ...s, phase: "interrupted", lease: "stale", result: "interrupted" },
  }
  action releaseRotation = all {
    s.phase.in(Set("published", "failed")),
    s' = { ...s, phase: "done", lease: "none",
      result: if (s.phase == "published") "success" else "failed" },
  }
  // The operator must establish that the process has exited before removal.
  action confirmExitAndRemoveLock = all {
    s.phase == "interrupted", s.lease == "stale",
    s' = { ...s, phase: "recoverable", lease: "none" },
  }
  action probe(source: str): bool = all {
    s.phase.in(Set("idle", "done", "interrupted", "recoverable")),
    (source == "previous" implies s.previous) and (source == "next" implies s.nextFile),
    s' = s.with("result", if (s.lease != "none") "lease-refused"
      else if ((if (source == "active") s.configKey else if (source == "next") 1 else 0) == s.databaseKey)
        "readable" else "wrong-key"),
  }
  action advance = any {
    writePrevious, prepareNext, settleDatabase(true), settleDatabase(false),
    publishConfig, releaseRotation,
  }
  action step = any {
    start(true), start(false), externalAcquire, externalRelease, advance,
    interruptBeforePublish, confirmExitAndRemoveLock,
    probe("active"), probe("previous"), probe("next"), s' = s,
  }

  val CommittedKeyRemainsAvailable = s.databaseKey == 1 implies
    (s.previous and (s.configKey == 1 or s.nextFile))
  val PublishedKeyMatchesDatabase = s.configKey == 1 implies
    (s.databaseKey == 1 and not(s.nextFile))
  val SuccessRequiresPublishedKey = s.result == "success" implies
    (s.phase == "done" and s.lease == "none" and s.configKey == 1)
  val InterruptedLeaseRemainsOwned = (s.phase == "interrupted") == (s.lease == "stale")
  temporal PreviousReceiptPersists = always((s.previous implies next(s.previous)).orKeep(s))
  temporal RotationOwnerSettles = (s.lease == "rotation").leadsTo(s.lease != "rotation")
  temporal FairRotationOwnerSettles = advance.weakFair(s) implies RotationOwnerSettles

  run rotationRefusesAnotherWriterTest = init.then(externalAcquire).then(start(true))
    .expect(s.result == "lease-refused" and not(s.previous) and s.databaseKey == 0)
    .then(externalRelease).then(start(false)).expect(s.result == "role-refused")
  run successPublishesBeforeReleaseTest = init.then(start(true)).then(writePrevious)
    .then(prepareNext).then(settleDatabase(true)).then(publishConfig)
    .expect(s.configKey == 1 and s.lease == "rotation")
    .then(releaseRotation).expect(s.result == "success")
    .then(probe("previous")).expect(s.result == "wrong-key")
    .then(start(true)).expect(s.result == "recovery-file-refused")
  run failedTransactionPreservesBothReceiptsTest = init.then(start(true)).then(writePrevious)
    .then(prepareNext).then(settleDatabase(false)).then(releaseRotation)
    .expect(s.result == "failed" and s.databaseKey == 0 and s.previous and s.nextFile)
    .then(probe("active")).expect(s.result == "readable")
  run interruptedPublicationRequiresConfirmedRecoveryTest = init.then(start(true)).then(writePrevious)
    .then(prepareNext).then(settleDatabase(true)).then(interruptBeforePublish)
    .then(probe("next")).expect(s.result == "lease-refused" and s.configKey == 0)
    .then(confirmExitAndRemoveLock).then(probe("active")).expect(s.result == "wrong-key")
    .then(probe("next")).expect(s.result == "readable" and s.previous)
}
