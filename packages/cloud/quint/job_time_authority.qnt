// DB retry deadlines and renewable claims are separate from application clocks.
// The unsafe actions appear only in regression witnesses, never in step.
module job_time_authority {
  type State = {
    now: int, phase: str, generation: int, attempts: int, stamp: int,
    expiry: int, due: int, expectedDue: int, hostOffset: int, databaseOffset: int,
    snapshotGeneration: int, snapshotStamp: int, decodedStamp: int,
    renewal: str, transactionGeneration: int, transactionStart: int,
    badDeadline: bool, badDecode: bool, badRenewal: bool
  }
  var s: State
  pure val offsets = Set(-2, 0, 2)
  action init = s' = {
    now: 0, phase: "pending", generation: 0, attempts: 0, stamp: 0,
    expiry: 0, due: 0, expectedDue: 0, hostOffset: 0, databaseOffset: 0,
    snapshotGeneration: 0, snapshotStamp: -1, decodedStamp: -1,
    renewal: "idle", transactionGeneration: 0, transactionStart: 0,
    badDeadline: false, badDecode: false, badRenewal: false
  }
  action configure(host, database) = all {
    s.generation == 0, s.now == 0,
    s' = s.with("hostOffset", host).with("databaseOffset", database)
  }
  action tick = all { s.now < 6, s' = s.with("now", s.now + 1) }
  action claim = all {
    s.phase == "pending", s.now >= s.due, s.generation < 2,
    s' = s.with("phase", "running").with("generation", s.generation + 1)
      .with("expiry", s.now + 2).with("stamp", s.stamp + 1)
  }
  action readSnapshot(canonical) = all {
    s.phase == "running",
    s' = s.with("snapshotGeneration", s.generation).with("snapshotStamp", s.stamp)
      .with("decodedStamp", if (canonical) s.stamp else s.stamp + s.hostOffset)
  }
  val currentSnapshot = s.phase == "running" and s.snapshotGeneration == s.generation
    and s.snapshotStamp == s.stamp
  action retry(databaseClock) = all {
    currentSnapshot, s.now < s.expiry, s.attempts < 2, s.renewal != "locked",
    if (s.decodedStamp != s.snapshotStamp) {
      s' = s.with("badDecode", true)
    } else {
      val actual = if (databaseClock) s.now + 2
        else s.now + 2 + s.hostOffset - s.databaseOffset
      s' = s.with("phase", "pending").with("attempts", s.attempts + 1)
        .with("expiry", 0).with("stamp", s.stamp + 1)
        .with("expectedDue", s.now + 2).with("due", actual)
        .with("badDeadline", s.badDeadline or actual != s.now + 2)
    }
  }
  action rejectStaleSnapshot = all { not(currentSnapshot), s' = s }
  action beginRenewal = all {
    s.phase == "running", s.renewal == "idle",
    s' = s.with("renewal", "waiting").with("transactionStart", s.now)
      .with("transactionGeneration", s.generation)
  }
  action lockRenewal = all {
    s.renewal == "waiting", s.phase == "running", s.transactionGeneration == s.generation,
    s' = s.with("renewal", "locked")
  }
  action renew(postLockClock) = all {
    s.renewal == "locked", s.phase == "running", s.transactionGeneration == s.generation,
    val renewedExpiry = (if (postLockClock) s.now else s.transactionStart) + 2
    s' = s.with("expiry", renewedExpiry).with("renewal", "idle")
      .with("badRenewal", s.badRenewal or renewedExpiry <= s.now)
  }
  action rejectLostRenewal = all {
    s.renewal == "waiting",
    s.phase != "running" or s.transactionGeneration != s.generation,
    s' = s.with("renewal", "idle")
  }
  action recover = all {
    s.phase == "running", s.renewal != "locked", s.now >= s.expiry + 1,
    s' = s.with("phase", "pending").with("due", s.now).with("expectedDue", s.now)
      .with("stamp", s.stamp + 1).with("expiry", 0)
  }
  action cancel = all {
    s.phase == "running", s.renewal != "locked",
    s' = s.with("phase", "terminal").with("stamp", s.stamp + 1).with("expiry", 0)
  }
  action idle = s' = s
  action step = {
    nondet host = offsets.oneOf()
    nondet database = offsets.oneOf()
    any { configure(host, database), tick, claim, readSnapshot(true), retry(true),
      rejectStaleSnapshot, beginRenewal, lockRenewal, renew(true), rejectLostRenewal,
      recover, cancel, idle }
  }
  // The former boundary choices are retained solely for counterexample checks.
  action legacyStep = {
    nondet host = offsets.oneOf()
    nondet database = offsets.oneOf()
    any { configure(host, database), tick, claim, readSnapshot(false), retry(false),
      rejectStaleSnapshot, beginRenewal, lockRenewal, renew(false), rejectLostRenewal,
      recover, cancel, idle }
  }
  val safety = not(s.badDeadline) and not(s.badDecode) and not(s.badRenewal)
  run timezoneBackoffWitnessTest = init.then(configure(0, -2)).then(claim)
    .then(readSnapshot(true)).then(retry(false)).expect(s.badDeadline)
  run applicationSkewWitnessTest = init.then(configure(2, 0)).then(claim)
    .then(readSnapshot(true)).then(retry(false)).expect(s.badDeadline)
  run rawTimestampDecodeWitnessTest = init.then(configure(2, 0)).then(claim)
    .then(readSnapshot(false)).then(retry(true)).expect(s.badDecode)
  run databaseClockIgnoresBothOffsetsTest = init.then(configure(2, -2)).then(claim)
    .then(readSnapshot(true)).then(retry(true)).expect(safety and s.due == 2)
  run transactionStartRenewalWitnessTest = init.then(claim).then(beginRenewal)
    .then(tick).then(tick).then(lockRenewal).then(renew(false)).expect(s.badRenewal)
  run postLockRenewalStaysLiveTest = init.then(claim).then(beginRenewal)
    .then(tick).then(tick).then(lockRenewal).then(renew(true)).expect(safety and s.expiry == 4)
  run lostRenewalCannotOverwriteSuccessorTest = init.then(claim).then(beginRenewal)
    .then(tick).then(tick).then(tick).then(recover).then(claim).then(rejectLostRenewal)
    .expect(safety and s.generation == 2 and s.expiry == 5)
  run cancellationRejectsOriginalSnapshotTest = init.then(claim).then(readSnapshot(true))
    .then(cancel).then(rejectStaleSnapshot).expect(safety and s.phase == "terminal")
}
