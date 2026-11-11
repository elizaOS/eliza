// Renewal lineage of one mobile sign-in. An acknowledged credential asks for a
// successor code without a browser. Authorization is one primary read; the
// issuing transaction locks and re-reads the predecessor. The successor grant
// copies the sign-in time, so no code is issued after the absolute cap.
// Exchange and acknowledgement of a code are refined by MobileAppCredential
// and are one atomic redemption here.
module MobileAppKeyRenewal {
  pure val Cap = 2
  pure val Ttl = 3
  pure val CodeTtl = 1
  pure val Horizon = 6
  pure val Keys = Set(1, 2, 3)
  pure val Requests = Set(1, 2)
  type Key = { status: str, expires: int, start: int }
  type Grant = { status: str, issuedAt: int, start: int }
  type State = {
    clock: int,
    keys: int -> Key,
    grants: int -> Grant,
    ownerOk: bool,
    clientOk: bool,
    phase: int -> str,
    reqTime: int -> int,
    reqKey: int -> int,
    reqStart: int -> int,
    issuedForDeadKey: bool
  }
  var s: State
  pure val NoKey: Key = { status: "none", expires: 0, start: 0 }
  pure val NoGrant: Grant = { status: "none", issuedAt: 0, start: 0 }

  // Key 1 is the credential of the browser sign-in at clock 0.
  action init = s' = {
    clock: 0,
    keys: Keys.mapBy(k => if (k == 1) { status: "active", expires: Ttl, start: 0 } else NoKey),
    grants: Requests.mapBy(_ => NoGrant),
    ownerOk: true, clientOk: true,
    phase: Requests.mapBy(_ => "new"),
    reqTime: Requests.mapBy(_ => 0),
    reqKey: Requests.mapBy(_ => 1),
    reqStart: Requests.mapBy(_ => 0),
    issuedForDeadKey: false
  }

  def Usable(k: int, at: int): bool =
    s.keys.get(k).status == "active" and at < s.keys.get(k).expires
  // Settled request locals have no further readers.
  pure def End(state: State, r: int): State = {
    ...state, phase: state.phase.set(r, "done"), reqTime: state.reqTime.set(r, 0),
    reqKey: state.reqKey.set(r, 1), reqStart: state.reqStart.set(r, 0)
  }

  action Tick = all { s.clock < Horizon, s' = { ...s, clock: s.clock + 1 } }
  // The owner is deactivated, leaves the organization, or it closes.
  action OwnerLeaves = all { s.ownerOk, s' = { ...s, ownerOk: false } }
  // The client is disabled, re-registered, or its app row is deactivated.
  action ClientStops = all { s.clientOk, s' = { ...s, clientOk: false } }
  // The phone revokes its old key after renewal, or the owner revokes a device.
  action Revoke(k: int): bool = all {
    s.keys.get(k).status == "active",
    s' = { ...s, keys: s.keys.set(k, { ...s.keys.get(k), status: "revoked" }) }
  }

  // One primary read at the request's captured time decides 401, 403 and 409.
  action BeginRenew(r: int, k: int): bool = all {
    s.phase.get(r) == "new",
    s' = if (Usable(k, s.clock) and s.clientOk and s.ownerOk and
      s.clock <= s.keys.get(k).start + Cap) {
      ...s, phase: s.phase.set(r, "authorized"), reqTime: s.reqTime.set(r, s.clock),
      reqKey: s.reqKey.set(r, k), reqStart: s.reqStart.set(r, s.keys.get(k).start)
    } else End(s, r)
  }
  // The issuing transaction locks the app and the predecessor row. The code
  // deadline and the predecessor's expiry use the captured request time.
  action CommitRenew(r: int): bool = all {
    s.phase.get(r) == "authorized",
    s' = if (s.clientOk and Usable(s.reqKey.get(r), s.reqTime.get(r))) End({
      ...s,
      grants: s.grants.set(r, { status: "pending", issuedAt: s.reqTime.get(r), start: s.reqStart.get(r) }),
      issuedForDeadKey: s.issuedForDeadKey or s.keys.get(s.reqKey.get(r)).status != "active"
    }, r) else End(s, r)
  }
  // Admission refuses (429) or a dependency fails (503) after authorization.
  action RenewFails(r: int): bool = all { s.phase.get(r) == "authorized", s' = End(s, r) }

  // Exchange and acknowledgement of request r's code mint key r + 1. The
  // acknowledgement requires the active client and an active owner in the
  // credential's organization.
  action Redeem(r: int): bool = all {
    s.grants.get(r).status == "pending",
    s.clock < s.grants.get(r).issuedAt + CodeTtl,
    s.clientOk, s.ownerOk,
    s' = {
      ...s,
      grants: s.grants.set(r, { ...s.grants.get(r), status: "redeemed" }),
      keys: s.keys.set(r + 1, { status: "active", expires: s.clock + Ttl, start: s.grants.get(r).start })
    }
  }

  action step = any {
    Tick, OwnerLeaves, ClientStops,
    { nondet k = Keys.oneOf(); Revoke(k) },
    { nondet r = Requests.oneOf(); nondet k = Keys.oneOf(); BeginRenew(r, k) },
    { nondet r = Requests.oneOf(); CommitRenew(r) },
    { nondet r = Requests.oneOf(); RenewFails(r) },
    { nondet r = Requests.oneOf(); Redeem(r) },
    s' = s
  }

  val TypeOK = and {
    s.clock >= 0, s.clock <= Horizon,
    Keys.forall(k => Set("none", "active", "revoked").contains(s.keys.get(k).status)),
    Requests.forall(r => Set("none", "pending", "redeemed").contains(s.grants.get(r).status)),
    Requests.forall(r => Set("new", "authorized", "done").contains(s.phase.get(r))),
    Requests.forall(r => Keys.contains(s.reqKey.get(r)))
  }
  // Every grant and credential of the lineage counts from the one sign-in.
  val SignInTimeNeverMoves = and {
    Keys.forall(k => s.keys.get(k).start == 0),
    Requests.forall(r => s.grants.get(r).start == 0)
  }
  val NoCodeAfterCap = Requests.forall(r =>
    s.grants.get(r).status == "none" or s.grants.get(r).issuedAt <= s.grants.get(r).start + Cap)
  // Renewal cannot stretch a sign-in past cap + code lifetime + key lifetime.
  val BoundedLineage = Keys.forall(k =>
    s.keys.get(k).status == "none" or s.keys.get(k).expires < s.keys.get(k).start + Cap + CodeTtl + Ttl)
  val RevokedKeyIssuesNothing = not(s.issuedForDeadKey)
  val safety = TypeOK and SignInTimeNeverMoves and NoCodeAfterCap and BoundedLineage and
    RevokedKeyIssuesNothing
  val Idle = Requests.forall(r => s.phase.get(r) != "authorized")
  temporal Fairness = Requests.forall(r => CommitRenew(r).weakFair(s))
  temporal RequestsSettle = Fairness implies eventually(always(Idle))

  run renewalChainKeepsSignInTimeTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(Redeem(1)).then(Revoke(1))
    .then(Tick).then(BeginRenew(2, 2)).then(CommitRenew(2)).then(Redeem(2))
    .expect(s.keys.get(3).status == "active" and s.keys.get(3).start == 0 and
      s.keys.get(3).expires == 5 and s.keys.get(1).status == "revoked")
  // At clock 3 the successor is still a valid key; only the cap refuses it.
  run capClosesRenewalTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(Redeem(1))
    .then(Tick).then(Tick).then(BeginRenew(2, 2))
    .expect(s.phase.get(2) == "done" and s.grants.get(2).status == "none" and
      s.keys.get(2).status == "active" and s.clock < s.keys.get(2).expires)
  run revokedPredecessorIssuesNothingTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(Revoke(1)).then(CommitRenew(1))
    .expect(s.grants.get(1).status == "none" and s.phase.get(1) == "done")
  run replayedRenewalKeepsSignInTimeTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(BeginRenew(2, 1)).then(CommitRenew(1)).then(CommitRenew(2))
    .then(Redeem(1)).then(Redeem(2))
    .expect(s.keys.get(2).start == 0 and s.keys.get(3).start == 0 and
      s.keys.get(2).expires == 4 and s.keys.get(3).expires == 4)
  run departedOwnerIsRefusedTest = init.then(Tick).then(OwnerLeaves).then(BeginRenew(1, 1))
    .expect(s.phase.get(1) == "done" and s.grants.get(1).status == "none")
  run disabledClientIsRefusedTest = init.then(Tick).then(BeginRenew(1, 1)).then(ClientStops)
    .then(CommitRenew(1)).then(BeginRenew(2, 1))
    .expect(Requests.forall(r => s.phase.get(r) == "done" and s.grants.get(r).status == "none"))
  run expiredCodeMintsNothingTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(Tick)
    .expect(s.grants.get(1).status == "pending" and
      not(s.clock < s.grants.get(1).issuedAt + CodeTtl) and s.keys.get(2).status == "none")
}
