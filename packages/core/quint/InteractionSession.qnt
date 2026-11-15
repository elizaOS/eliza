// src/messaging/interaction-sessions.ts and durable interaction store adapters.
// None claim IDs are represented by {client: None, attempts: 0}; real IDs retain
// both tuple components. Commit, execute, completion and reconciliation remain
// separate so a crash after commit cannot become a second external execution.
module InteractionSession {
  const Clients: Set[str]
  const Mismatched: Set[str]
  const MaxRuns: int
  const MaxTime: int
  const Expiry: int
  const Ttl: int
  const None: str
  type ClaimId = {client: str, attempts: int}
  type State = {exists: bool, cstate: str, owner: ClaimId, digest: str, lease: int,
    committedAt: int, completedAt: int, auth: str, now: int, pc: str -> str,
    attempts: str -> int, mine: str -> ClaimId, last: str -> str, effects: int,
    reached: str, late: bool}
  pure val noClaim = {client: None, attempts: 0}
  pure val Outcomes = Set("none", "acquired", "resumed", "in_progress", "replay", "error", "completed", "lost", "crashed")
  pure def response(c: str): str = if (Mismatched.contains(c)) "B" else "A"
  pure def validClaim(id: ClaimId): bool = id == noClaim or
    (Clients.contains(id.client) and id.attempts >= 1 and id.attempts <= MaxRuns)
  var s: State
  action init = all {
    Mismatched.subseteq(Clients), Expiry > 0, Expiry <= MaxTime, Ttl > 0,
    s' = {exists: true, cstate: "pending", owner: noClaim, digest: None,
      lease: 0, committedAt: 0, completedAt: 0, auth: "active", now: 0,
      pc: Clients.mapBy(c => "idle"), attempts: Clients.mapBy(c => 0),
      mine: Clients.mapBy(c => noClaim), last: Clients.mapBy(c => "none"),
      effects: 0, reached: "open", late: false}
  }
  pure def returned(v: State, c: str, outcome: str): State =
    {...v, pc: v.pc.set(c, "idle"), last: v.last.set(c, outcome)}
  pure def taken(v: State, c: str, outcome: str): State = {
    val id = {client: c, attempts: v.attempts.get(c)}
    {...v, cstate: "claimed", owner: id, digest: response(c), lease: v.now + Ttl,
      pc: v.pc.set(c, "claimed"), mine: v.mine.set(c, id), last: v.last.set(c, outcome)}
  }
  action Claim(c: str): bool = {
    val same = s.digest == response(c)
    val v = {...s, attempts: s.attempts.set(c, s.attempts.get(c) + 1)}
    all {s.pc.get(c) == "idle", s.attempts.get(c) < MaxRuns, s' =
      if (not(s.exists)) returned(v, c, "error")
      else if (Set("pending", "claimed").contains(s.cstate) and (s.auth != "active" or s.now >= Expiry)) returned(v, c, "error")
      else if (s.cstate == "completed") returned(v, c, if (same) "replay" else "error")
      else if (s.cstate == "committed") returned(v, c, if (same) "in_progress" else "error")
      else if (s.cstate == "claimed") (
        if (not(same)) returned(v, c, "error")
        else if (s.lease > s.now) returned(v, c, "in_progress")
        else taken(v, c, "resumed"))
      else taken(v, c, "acquired")
    }
  }
  val CommitInTime = s.now < s.lease and s.now < Expiry
  action Commit(c: str): bool = all {
    s.pc.get(c) == "claimed",
    s' = if (s.exists and s.cstate == "claimed" and s.owner == s.mine.get(c) and s.auth == "active" and CommitInTime)
      {...s, cstate: "committed", committedAt: s.now, pc: s.pc.set(c, "committed"),
        reached: "committed", late: s.late or s.now >= s.lease or s.now >= Expiry}
      else returned(s, c, "error")
  }
  action Execute(c: str): bool = all {
    s.pc.get(c) == "committed",
    s' = {...s, effects: s.effects + 1, pc: s.pc.set(c, "executed")}
  }
  action Complete(c: str): bool = all {
    s.pc.get(c) == "executed",
    s' = if (not(s.exists)) returned(s, c, "lost")
      else if (s.cstate == "completed" and s.digest == response(c)) returned(s, c, "completed")
      else if (s.cstate == "committed" and s.owner == s.mine.get(c))
        {...s, cstate: "completed", completedAt: s.now, reached: "completed",
          pc: s.pc.set(c, "idle"), last: s.last.set(c, "completed")}
      else returned(s, c, "error")
  }
  action Crash(c: str): bool = all {
    Set("claimed", "committed", "executed").contains(s.pc.get(c)), s' = returned(s, c, "crashed")
  }
  action Reconcile = all {
    s.exists, s.cstate == "committed", s.committedAt <= s.now, s.effects == 1,
    s' = {...s, cstate: "completed", completedAt: s.now, reached: "completed"}
  }
  action Revoke = all {
    s.exists, s.auth == "active", s.cstate != "committed", s' = {...s, auth: "revoked"}
  }
  val Sweepable = (s.cstate == "completed" and s.completedAt <= s.now) or
    (Set("pending", "claimed").contains(s.cstate) and Expiry <= s.now)
  action DeleteExpired = all {s.exists, Sweepable, s' = {...s, exists: false}}
  action Tick = all {s.now < MaxTime, s' = {...s, now: s.now + 1}}
  val Finished = s.now == MaxTime and Clients.forall(c => s.pc.get(c) == "idle" and s.attempts.get(c) == MaxRuns)
  action nextStep = {
    nondet c = Clients.oneOf()
    any {Claim(c), Commit(c), Execute(c), Complete(c), Crash(c), Reconcile, Revoke,
      DeleteExpired, Tick, all {Finished, s' = s}}
  }
  action step = any {nextStep, s' = s}
  val TypeOK = and {
    Set("pending", "claimed", "committed", "completed").contains(s.cstate), validClaim(s.owner),
    Set("A", "B", None).contains(s.digest), s.lease >= 0,
    s.committedAt >= 0, s.committedAt <= MaxTime, s.completedAt >= 0, s.completedAt <= MaxTime,
    Set("active", "revoked").contains(s.auth), s.now >= 0, s.now <= MaxTime,
    s.pc.keys() == Clients, s.attempts.keys() == Clients, s.mine.keys() == Clients, s.last.keys() == Clients,
    Clients.forall(c => Set("idle", "claimed", "committed", "executed").contains(s.pc.get(c)) and
      s.attempts.get(c) >= 0 and s.attempts.get(c) <= MaxRuns and validClaim(s.mine.get(c)) and Outcomes.contains(s.last.get(c))),
    s.effects >= 0, Set("open", "committed", "completed").contains(s.reached)
  }
  val ExactlyOnceAuthority = s.effects + Clients.filter(c => s.pc.get(c) == "committed").size() <= 1
  val AtMostOnce = s.effects <= 1
  val CompletedHasEffect = (s.exists and s.cstate == "completed" implies s.effects == 1) and
    Clients.forall(c => Set("replay", "completed").contains(s.last.get(c)) implies s.effects == 1)
  val NoCommitWhileRevoked = s.exists and s.cstate == "committed" implies s.auth == "active"
  val NoLateCommit = not(s.late)
  val AmbiguousRetained = s.reached == "committed" implies s.exists and s.cstate == "committed"
  val ExecutorHasRecord = Clients.forall(c =>
    Set("committed", "executed").contains(s.pc.get(c)) and s.reached != "completed" implies
      s.exists and s.cstate == "committed" and s.owner == s.mine.get(c))
  temporal Fairness = Reconcile.weakFair(s) and Clients.forall(c =>
    Commit(c).weakFair(s) and Execute(c).weakFair(s) and Complete(c).weakFair(s))
  temporal EffectOnlyByCommitter = always((next(s.effects) != s.effects implies
    Clients.exists(c => s.pc.get(c) == "committed" and next(s.pc.get(c)) == "executed")).orKeep(s))
  temporal EffectRecorded = Fairness implies (s.effects == 1 leadsTo s.reached == "completed")
  temporal DeadlockFree = always(enabled(nextStep))
}
module InteractionSession_leases {
  import InteractionSession(Clients = Set("c1", "c2", "c3"), Mismatched = Set("c3"),
    MaxRuns = 2, MaxTime = 4, Expiry = 3, Ttl = 1, None = "None").*
}
module InteractionSession_retries {
  import InteractionSession(Clients = Set("c1", "c2"), Mismatched = Set(),
    MaxRuns = 3, MaxTime = 5, Expiry = 4, Ttl = 2, None = "None").*
}
