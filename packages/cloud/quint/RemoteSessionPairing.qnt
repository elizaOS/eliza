// The target-created pairing lifecycle in RemoteSessionsRepository. Host and
// session locks linearize transactions. Confirmation rereads the row after
// its separate authenticated preflight, so a retained read grants no authority.
module RemoteSessionPairing {
  pure val Sessions = Set(1, 2)
  pure val Controllers = Set(1, 2)
  pure val Unstaged = Set("pending", "claimed")
  pure val BeforeCommit = Unstaged.union(Set("activating"))
  pure val Open = BeforeCommit.union(Set("active"))
  pure val Terminal = Set("denied", "revoked", "expired")

  type Row = { status: str, verifier: bool, controller: int, confirmed: bool,
    committedAt: int, pairUntil: int, grantUntil: int }
  type State = { now: int, hostActive: bool, sessions: int -> Row, observedClaim: int }
  var s: State

  pure val Missing: Row = {
    status: "absent", verifier: false, controller: 0, confirmed: false,
    committedAt: -1, pairUntil: -1, grantUntil: -1
  }
  pure def pending(now: int): Row = { ...Missing, status: "pending", verifier: true,
    pairUntil: now + 2, grantUntil: now + 3 }
  pure def end(row: Row, status: str): Row = { ...row, status: status, verifier: false }
  pure def expired(row: Row, now: int): bool = now >= row.pairUntil
  pure def grantCurrent(row: Row, now: int): bool = now < row.grantUntil
  pure def permitsCommands(x: State, id: int): bool =
    x.hostActive and x.sessions.get(id).status == "active" and grantCurrent(x.sessions.get(id), x.now)

  action init = s' = {
    now: 0, hostActive: true, sessions: Sessions.mapBy(_ => Missing), observedClaim: 0
  }

  action issue(id: int, authenticated: bool): bool = {
    val rows = Sessions.mapBy(other => {
      val row = s.sessions.get(other)
      if (other == id) pending(s.now)
      else if (row.status == "pending" and expired(row, s.now)) end(row, "expired")
      else if (Unstaged.contains(row.status)) end(row, "denied")
      else row
    })
    all {
      s.sessions.get(id).status == "absent",
      // Later issuance is omitted so bounded time can reach every deadline.
      s' = if (authenticated and s.hostActive and s.now <= 2) { ...s, sessions: rows } else s
    }
  }

  // Code verification matches tenant, owner, host, session and signed expiry.
  // An incorrect scope or code leaves the durable challenge untouched.
  action claim(id: int, controller: int, ownerAndCodeMatch: bool): bool = {
    val row = s.sessions.get(id)
    val allowed = ownerAndCodeMatch and s.hostActive and not(expired(row, s.now)) and
      row.status == "pending" and row.verifier
    val claimed = { ...row, status: "claimed", verifier: false, controller: controller }
    s' = if (allowed) { ...s, sessions: s.sessions.set(id, claimed) } else s
  }

  // Authenticated preflight can also expire an unconfirmed challenge.
  action observe(id: int, authenticated: bool): bool = {
    val row = s.sessions.get(id)
    all {
      s.observedClaim == 0,
      s' = if (not(authenticated and s.hostActive)) s
        else if (Unstaged.contains(row.status) and expired(row, s.now))
          { ...s, sessions: s.sessions.set(id, end(row, "expired")) }
        else if (row.status == "claimed") { ...s, observedClaim: id }
        else s
    }
  }

  action confirm = all {
    Sessions.contains(s.observedClaim),
    val row = s.sessions.get(s.observedClaim)
    val result =
      if (not(s.hostActive) or row.status != "claimed") row
      else if (expired(row, s.now)) end(row, "expired")
      else { ...row, status: "activating", confirmed: true }
    s' = { ...s, sessions: s.sessions.set(s.observedClaim, result), observedClaim: 0 }
  }

  // The separate controller-created activation methods can attempt to consume
  // a target-created pending row. The migration 0332 controller-identity
  // check aborts the transaction, leaving the verifier and row unchanged.
  action legacyActivation(id: int): bool = all {
    s.hostActive,
    s.sessions.get(id).status == "pending",
    not(expired(s.sessions.get(id), s.now)),
    s' = s
  }

  // The host bearer owns the commit request. Local installation is a caller
  // contract. Cloud checks the live host, exact stage, and both deadlines.
  action commit(id: int, authenticated: bool): bool = {
    val row = s.sessions.get(id)
    val result =
      if (expired(row, s.now) or not(grantCurrent(row, s.now))) end(row, "expired")
      else { ...row, status: "active", committedAt: s.now }
    s' = if (authenticated and s.hostActive and row.status == "activating")
      { ...s, sessions: s.sessions.set(id, result) }
      else s
  }

  action compensate(id: int, authenticated: bool): bool = {
    val row = s.sessions.get(id)
    s' = if (authenticated and BeforeCommit.contains(row.status))
      { ...s, sessions: s.sessions.set(id, end(row, "denied")) }
      else s
  }

  action revokeSession(id: int, authorized: bool): bool = {
    val row = s.sessions.get(id)
    val status = if (Unstaged.contains(row.status) and expired(row, s.now)) "expired" else "revoked"
    s' = if (authorized and Open.contains(row.status))
      { ...s, sessions: s.sessions.set(id, end(row, status)) }
      else s
  }

  // Both modeled rows fit within one unlocked cleanup page. Lock skips and
  // continuation are verified separately in RemoteHostRevocation.
  action revokeHost = all {
    s.hostActive,
    s' = { ...s, hostActive: false, sessions: Sessions.mapBy(id => {
      val row = s.sessions.get(id)
      if (Open.contains(row.status)) end(row, "revoked") else row
    }) }
  }

  action sweep(id: int): bool = {
    val row = s.sessions.get(id)
    all {
      BeforeCommit.contains(row.status) and expired(row, s.now),
      // The sweeper leaves the old hash on a terminal row. It cannot be read
      // as a pending verifier because all admission queries require pending.
      s' = { ...s, sessions: s.sessions.set(id, { ...row, status: "expired" }) }
    }
  }

  action tick = all { s.now < 5, s' = { ...s, now: s.now + 1 } }
  // Storage rollback, lost replies after a commit, and a restarted caller
  // preserve the modeled durable state. A lost preflight just drops its read.
  action noDurableChange = s' = s
  action dropObservation = s' = { ...s, observedClaim: 0 }
  action step = any {
    confirm, revokeHost, tick, noDurableChange, dropObservation,
    {
      nondet id = Sessions.oneOf()
      nondet controller = Controllers.oneOf()
      nondet authorized = Set(true, false).oneOf()
      any {
        issue(id, authorized), claim(id, controller, authorized), observe(id, authorized),
        legacyActivation(id), commit(id, authorized), compensate(id, authorized),
        revokeSession(id, authorized), sweep(id)
      }
    }
  }

  val safety = all {
    Sessions.filter(id => Unstaged.contains(s.sessions.get(id).status)).size() <= 1,
    Sessions.forall(id => {
      val row = s.sessions.get(id)
      all {
        Open.union(Terminal).union(Set("absent")).contains(row.status),
        row.status == "pending" implies (row.verifier and row.controller == 0),
        row.verifier implies Set("pending", "expired").contains(row.status),
        Set("claimed", "activating", "active").contains(row.status)
          implies (Controllers.contains(row.controller) and not(row.verifier)),
        Set("activating", "active").contains(row.status) implies row.confirmed,
        row.committedAt >= 0 implies (row.confirmed and not(expired(row, row.committedAt))),
        permitsCommands(s, id) implies (row.confirmed and row.committedAt >= 0),
        not(s.hostActive) implies not(Open.contains(row.status))
      }
    })
  }

  temporal DurableOwnership = always((Sessions.forall(id => {
    val row = s.sessions.get(id)
    all {
      row.status != "absent" implies (
        next(s.sessions.get(id).pairUntil) == row.pairUntil and
        next(s.sessions.get(id).grantUntil) == row.grantUntil),
      row.controller != 0 implies next(s.sessions.get(id).controller) == row.controller,
      row.confirmed implies next(s.sessions.get(id).confirmed),
      row.committedAt >= 0 implies next(s.sessions.get(id).committedAt) == row.committedAt,
      Terminal.contains(row.status) implies next(s.sessions.get(id)) == row
    }
  })).orKeep(s))

  temporal PairingResolves = Sessions.forall(id => always(
    BeforeCommit.contains(s.sessions.get(id).status)
      implies eventually(not(BeforeCommit.contains(s.sessions.get(id).status)))))
  temporal FairExpiry = all {
    tick.weakFair(s),
    Sessions.forall(id => sweep(id).weakFair(s))
  } implies PairingResolves

  run exactControllerOwnsOneClaimTest = init
    .then(issue(1, true)).then(claim(1, 1, false)).then(legacyActivation(1))
    .expect(s.sessions.get(1) == pending(0))
    .then(claim(1, 2, true)).then(claim(1, 1, true))
    .expect(s.sessions.get(1).controller == 2 and s.sessions.get(1).status == "claimed")
    .then(commit(1, true)).expect(not(permitsCommands(s, 1)))
    .then(observe(1, true)).then(confirm).expect(not(permitsCommands(s, 1)))
    .then(commit(1, false)).expect(not(permitsCommands(s, 1)))
    .then(commit(1, true)).then(noDurableChange).then(commit(1, true))
    .expect(safety and permitsCommands(s, 1) and s.sessions.get(1).controller == 2)

  run replacementFencesObservedClaimTest = init
    .then(issue(1, true)).then(claim(1, 1, true)).then(observe(1, true))
    .then(issue(2, true)).then(confirm).then(commit(1, true))
    .expect(safety and s.sessions.get(1).status == "denied" and s.sessions.get(2) == pending(0))

  run expiryBetweenConfirmationLocksTest = init
    .then(issue(1, true)).then(claim(1, 2, true)).then(observe(1, true))
    .then(tick).then(tick).then(confirm)
    .expect(safety and s.sessions.get(1).status == "expired" and not(permitsCommands(s, 1)))

  run expiredStagedCommitCannotPublishTest = init
    .then(issue(1, true)).then(claim(1, 1, true)).then(observe(1, true)).then(confirm)
    .then(tick).then(tick).then(commit(1, true))
    .expect(safety and s.sessions.get(1).status == "expired" and not(permitsCommands(s, 1)))

  run revocationFencesCommitAndCompensationReplayTest = init
    .then(issue(1, true)).then(claim(1, 1, true)).then(observe(1, true)).then(confirm)
    .then(revokeHost).then(commit(1, true)).then(compensate(1, true))
    .expect(safety and s.sessions.get(1).status == "revoked" and not(permitsCommands(s, 1)))

  run compensationTerminatesStagedGrantTest = init
    .then(issue(1, true)).then(claim(1, 1, true)).then(observe(1, true)).then(confirm)
    .then(compensate(1, true)).then(compensate(1, true)).then(commit(1, true))
    .expect(safety and s.sessions.get(1).status == "denied" and not(permitsCommands(s, 1)))

  run activeGrantOutlivesCodeButNotGrantDeadlineTest = init
    .then(issue(1, true)).then(claim(1, 1, true)).then(observe(1, true)).then(confirm)
    .then(commit(1, true)).then(tick).then(tick).then(commit(1, true))
    .expect(safety and permitsCommands(s, 1))
    .then(tick).expect(safety and not(permitsCommands(s, 1)))
}
