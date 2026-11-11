// Renewal lineage of one mobile sign-in. An acknowledged credential asks for a
// successor code without a browser. Authorization is one primary read; the
// issuing transaction locks the session and re-reads the predecessor. The
// successor grant copies the sign-in time and names its predecessor. No code
// is issued after the absolute cap and no credential expires after it. A
// predecessor has one live successor, a successor is minted only while its
// predecessor is still usable, and a revocation ends the whole sign-in unless
// it is the last step of a renewal. Exchange and acknowledgement of a code are
// refined by MobileAppCredential and are one atomic redemption here.
module MobileAppKeyRenewal {
  pure val Cap = 4
  pure val Ttl = 3
  pure val CodeTtl = 1
  pure val Horizon = 6
  pure val Keys = Set(1, 2, 3)
  pure val Requests = Set(1, 2)
  type Key = { status: str, expires: int, start: int }
  // `from` is the credential that asked for the code.
  type Grant = { status: str, issuedAt: int, start: int, from: int }
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
    issuedForDeadKey: bool,
    // The sign-in was ended: by the owner, by a sign-out, or by a reused key.
    ended: bool
  }
  var s: State
  pure val NoKey: Key = { status: "none", expires: 0, start: 0 }
  pure val NoGrant: Grant = { status: "none", issuedAt: 0, start: 0, from: 1 }
  pure def Earlier(a: int, b: int): int = if (a < b) a else b

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
    issuedForDeadKey: false,
    ended: false
  }

  def Usable(k: int, at: int): bool =
    s.keys.get(k).status == "active" and at < s.keys.get(k).expires
  // The successor of k was acknowledged: k was renewed.
  def Renewed(k: int): bool =
    Requests.exists(r => s.grants.get(r).from == k and s.grants.get(r).status == "redeemed")
  // Every credential of the sign-in is tombstoned in one transaction.
  def SessionRevoked: int -> Key = Keys.mapBy(k =>
    if (s.keys.get(k).status == "active") { ...s.keys.get(k), status: "revoked" } else s.keys.get(k))
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
  // The owner revokes a device from the account: the whole sign-in ends.
  action OwnerRevoke(k: int): bool = all {
    s.keys.get(k).status == "active",
    s' = { ...s, keys: SessionRevoked, ended: true }
  }
  // The credential revokes itself. After its successor was acknowledged this
  // is the last step of a renewal and ends only that credential; otherwise it
  // is a sign-out and ends the sign-in.
  action SelfRevoke(k: int): bool = all {
    s.keys.get(k).status == "active",
    s' = if (Renewed(k)) { ...s, keys: s.keys.set(k, { ...s.keys.get(k), status: "revoked" }) }
      else { ...s, keys: SessionRevoked, ended: true }
  }

  // One primary read at the request's captured time decides 401, 403 and 409.
  // A credential that already lives to the cap gains nothing from a successor.
  action BeginRenew(r: int, k: int): bool = all {
    s.phase.get(r) == "new",
    s' = if (Usable(k, s.clock) and s.clientOk and s.ownerOk and
      s.clock <= s.keys.get(k).start + Cap and s.keys.get(k).expires < s.keys.get(k).start + Cap) {
      ...s, phase: s.phase.set(r, "authorized"), reqTime: s.reqTime.set(r, s.clock),
      reqKey: s.reqKey.set(r, k), reqStart: s.reqStart.set(r, s.keys.get(k).start)
    } else End(s, r)
  }
  // The issuing transaction locks the app, the session and the predecessor
  // row. The code deadline and the predecessor's expiry use the captured
  // request time. A predecessor that was already renewed is being reused: no
  // code is issued and the sign-in ends. A code still in flight for the same
  // predecessor is superseded.
  action CommitRenew(r: int): bool = all {
    s.phase.get(r) == "authorized",
    val k = s.reqKey.get(r)
    s' = if (not(s.clientOk and Usable(k, s.reqTime.get(r)))) End(s, r)
      else if (Renewed(k)) End({ ...s, keys: SessionRevoked, ended: true }, r)
      else End({
        ...s,
        grants: Requests.mapBy(q =>
          if (q == r) { status: "pending", issuedAt: s.reqTime.get(r), start: s.reqStart.get(r), from: k }
          else if (s.grants.get(q).from == k and s.grants.get(q).status == "pending")
            { ...s.grants.get(q), status: "void" }
          else s.grants.get(q)),
        issuedForDeadKey: s.issuedForDeadKey or s.keys.get(k).status != "active"
      }, r)
  }
  // Admission refuses (429) or a dependency fails (503) after authorization.
  action RenewFails(r: int): bool = all { s.phase.get(r) == "authorized", s' = End(s, r) }

  // Exchange and acknowledgement of request r's code mint key r + 1. Both
  // re-read the predecessor under a row lock and require it to be usable, and
  // the acknowledgement requires the active client and an active owner in the
  // credential's organization. The successor never expires after the cap.
  action Redeem(r: int): bool = all {
    s.grants.get(r).status == "pending",
    s.clock < s.grants.get(r).issuedAt + CodeTtl,
    s.clientOk, s.ownerOk,
    Usable(s.grants.get(r).from, s.clock),
    s' = {
      ...s,
      grants: s.grants.set(r, { ...s.grants.get(r), status: "redeemed" }),
      keys: s.keys.set(r + 1, {
        status: "active",
        expires: Earlier(s.clock + Ttl, s.grants.get(r).start + Cap),
        start: s.grants.get(r).start
      })
    }
  }

  action step = any {
    Tick, OwnerLeaves, ClientStops,
    { nondet k = Keys.oneOf(); OwnerRevoke(k) },
    { nondet k = Keys.oneOf(); SelfRevoke(k) },
    { nondet r = Requests.oneOf(); nondet k = Keys.oneOf(); BeginRenew(r, k) },
    { nondet r = Requests.oneOf(); CommitRenew(r) },
    { nondet r = Requests.oneOf(); RenewFails(r) },
    { nondet r = Requests.oneOf(); Redeem(r) },
    s' = s
  }

  val TypeOK = and {
    s.clock >= 0, s.clock <= Horizon,
    Keys.forall(k => Set("none", "active", "revoked").contains(s.keys.get(k).status)),
    Requests.forall(r => Set("none", "pending", "void", "redeemed").contains(s.grants.get(r).status)),
    Requests.forall(r => Set("new", "authorized", "done").contains(s.phase.get(r))),
    Requests.forall(r => Keys.contains(s.reqKey.get(r))),
    Requests.forall(r => Keys.contains(s.grants.get(r).from))
  }
  // Every grant and credential of the lineage counts from the one sign-in.
  val SignInTimeNeverMoves = and {
    Keys.forall(k => s.keys.get(k).start == 0),
    Requests.forall(r => s.grants.get(r).start == 0)
  }
  val NoCodeAfterCap = Requests.forall(r =>
    s.grants.get(r).status == "none" or s.grants.get(r).issuedAt <= s.grants.get(r).start + Cap)
  // No credential of a sign-in outlives its absolute cap.
  val NoKeyOutlivesCap = Keys.forall(k =>
    s.keys.get(k).status == "none" or s.keys.get(k).expires <= s.keys.get(k).start + Cap)
  val RevokedKeyIssuesNothing = not(s.issuedForDeadKey)
  // A predecessor never has two successors that are live or could become so.
  val OneLiveSuccessor = Keys.forall(k => Requests.filter(r =>
    s.grants.get(r).from == k and Set("pending", "redeemed").contains(s.grants.get(r).status)).size() <= 1)
  // Once the sign-in was ended no credential of it is active, and none appears later.
  val EndedSignInHasNoKey = s.ended implies Keys.forall(k => s.keys.get(k).status != "active")
  val safety = TypeOK and SignInTimeNeverMoves and NoCodeAfterCap and NoKeyOutlivesCap and
    RevokedKeyIssuesNothing and OneLiveSuccessor and EndedSignInHasNoKey
  val Idle = Requests.forall(r => s.phase.get(r) != "authorized")
  temporal Fairness = Requests.forall(r => CommitRenew(r).weakFair(s))
  temporal RequestsSettle = Fairness implies eventually(always(Idle))

  // Two renewals in a row; the second successor is cut at the cap.
  run renewalChainKeepsSignInTimeTest = init
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(Redeem(1)).then(SelfRevoke(1))
    .then(Tick).then(Tick).then(BeginRenew(2, 2)).then(CommitRenew(2)).then(Redeem(2))
    .expect(s.keys.get(3).status == "active" and s.keys.get(3).start == 0 and
      s.keys.get(3).expires == Cap and s.keys.get(2).status == "active" and
      s.keys.get(1).status == "revoked" and not(s.ended))
  // A credential that lives to the cap is a valid key that cannot renew.
  run capClosesRenewalTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(Redeem(1))
    .then(Tick).then(BeginRenew(2, 2))
    .expect(s.phase.get(2) == "done" and s.grants.get(2).status == "none" and
      s.keys.get(2).status == "active" and s.keys.get(2).expires == Cap and
      s.clock < s.keys.get(2).expires)
  run revokedPredecessorIssuesNothingTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(OwnerRevoke(1)).then(CommitRenew(1))
    .expect(s.grants.get(1).status == "none" and s.phase.get(1) == "done")
  // The owner revokes the device after the code was issued: the code is dead.
  run revokedPredecessorMintsNothingTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(OwnerRevoke(1))
    .expect(s.grants.get(1).status == "pending" and s.ended and
      not(Usable(s.grants.get(1).from, s.clock)) and s.keys.get(2).status == "none")
  // A repeated request supersedes the code still in flight.
  run repeatedRenewalHasOneSuccessorTest = init.then(Tick)
    .then(BeginRenew(1, 1)).then(BeginRenew(2, 1)).then(CommitRenew(1)).then(CommitRenew(2))
    .then(Redeem(2))
    .expect(s.grants.get(1).status == "void" and s.keys.get(2).status == "none" and
      s.keys.get(3).status == "active" and s.keys.get(3).start == 0)
  // A copy of key 1 renewed first; when key 1 renews again the sign-in ends.
  run reusedKeyEndsSignInTest = init
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(Redeem(1))
    .then(Tick).then(BeginRenew(2, 1)).then(CommitRenew(2))
    .expect(s.ended and s.grants.get(2).status == "none" and
      Keys.forall(k => s.keys.get(k).status != "active"))
  // Signing out with the newest key ends a predecessor that was never revoked.
  run signOutEndsSignInTest = init
    .then(BeginRenew(1, 1)).then(CommitRenew(1)).then(Redeem(1)).then(SelfRevoke(2))
    .expect(s.ended and s.keys.get(1).status == "revoked" and s.keys.get(2).status == "revoked")
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
