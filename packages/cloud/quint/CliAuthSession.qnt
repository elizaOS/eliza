// CLI browser completion and one-shot plaintext delivery. The reaper's key
// update and session deletion are separate statements in one SQL transaction.
// Request timestamps are captured before asynchronous policy/database work.
module CliAuthSession {
  const Initial: str
  pure val Clients = Set(1, 2)
  pure val SessionDeadline = 1
  pure val KeyDeadline = 3
  type State = {
    clock: int,
    session: str,
    sessionOwner: int,
    key: int,
    keyOwner: int,
    keyActive: bool,
    keyCipher: bool,
    keyHash: int,
    keyChanged: bool,
    consumed: bool,
    completions: int -> str,
    completionTime: int -> int,
    pollers: int -> str,
    pollKey: int -> int,
    pollOwner: int -> int,
    pollHash: int -> int,
    claimTime: int -> int,
    revealed: Set[int],
    minted: Set[int],
    cleanup: str,
    cleanupTime: int,
    pendingRevocation: bool,
    cleanupHasSession: bool,
    revokedConsumed: bool,
    leakedInvalidBinding: bool
  }
  var s: State

  action init = s' = {
    clock: 0,
    session: if (Initial == "pending") "pending" else "authenticated",
    sessionOwner: if (Initial == "pending") 0 else 1,
    key: if (Initial == "pending" or Initial == "missing-key") 0 else 1,
    keyOwner: if (Initial == "wrong-owner") 2 else if (Initial == "pending") 0 else 1,
    keyActive: Initial != "pending" and Initial != "missing-key",
    keyCipher: Initial != "missing-cipher",
    keyHash: 1,
    keyChanged: false,
    consumed: false,
    completions: Clients.mapBy(_ => "new"),
    completionTime: Clients.mapBy(_ => 0),
    pollers: Clients.mapBy(_ => "new"),
    pollKey: Clients.mapBy(_ => 0),
    pollOwner: Clients.mapBy(_ => 0),
    pollHash: Clients.mapBy(_ => 0),
    claimTime: Clients.mapBy(_ => 0),
    revealed: Set(),
    minted: if (Initial == "pending" or Initial == "missing-key") Set() else Set(1),
    cleanup: "new",
    cleanupTime: 0,
    pendingRevocation: false,
    cleanupHasSession: false,
    revokedConsumed: false,
    leakedInvalidBinding: false
  }

  action Tick = all {
    s.clock < 3,
    s' = {...s, clock: s.clock + 1}
  }
  // Encryption precedes the transaction. A rejected candidate is never stored.
  action ExpireStatus = all {
    s.clock >= SessionDeadline, s.session != "deleted", not(s.cleanupHasSession),
    s' = {...s, session: "expired"}
  }
  action Prepare(c: int): bool = all {
    s.completions.get(c) == "new",
    s' = {...s, completions: s.completions.set(c, "prepared"),
      completionTime: s.completionTime.set(c, s.clock)}
  }
  action CompletionFails(c: int): bool = all {
    Set("new", "prepared").contains(s.completions.get(c)),
    s' = {...s, completions: s.completions.set(c, "done")}
  }
  action Complete(c: int): bool = all {
    s.completions.get(c) == "prepared",
    not(s.cleanupHasSession),
    s' = if (s.session == "pending" and s.completionTime.get(c) < SessionDeadline) {
      ...s, session: "authenticated", sessionOwner: c,
      key: c, keyOwner: c, keyActive: true, keyCipher: true,
      minted: s.minted.union(Set(c)), completions: s.completions.set(c, "done")
    } else {...s, completions: s.completions.set(c, "done")}
  }

  action Read(p: int): bool = all {
    s.pollers.get(p) == "new",
    s' = if (s.session == "authenticated" and not(s.consumed) and
      s.clock < SessionDeadline and s.key != 0 and s.keyActive and
      s.keyCipher and s.keyOwner == s.sessionOwner) {
      ...s, pollers: s.pollers.set(p, "read"),
      pollKey: s.pollKey.set(p, s.key), pollOwner: s.pollOwner.set(p, s.sessionOwner),
      pollHash: s.pollHash.set(p, s.keyHash)
    } else {...s, pollers: s.pollers.set(p, "done")}
  }
  action Decrypt(p: int): bool = all {
    s.pollers.get(p) == "read",
    s' = {...s, pollers: s.pollers.set(p, "decrypted")}
  }
  action DecryptFails(p: int): bool = all {
    s.pollers.get(p) == "read",
    s' = {...s, pollers: s.pollers.set(p, "done")}
  }
  action BeginClaim(p: int): bool = all {
    s.pollers.get(p) == "decrypted",
    s' = {...s, pollers: s.pollers.set(p, "claim"), claimTime: s.claimTime.set(p, s.clock)}
  }
  action Claim(p: int): bool = all {
    s.pollers.get(p) == "claim",
    not(s.cleanupHasSession),
    s' = if (s.session == "authenticated" and not(s.consumed) and
      s.claimTime.get(p) < SessionDeadline and s.claimTime.get(p) < KeyDeadline and
      s.keyActive and s.key == s.pollKey.get(p) and
      s.keyOwner == s.pollOwner.get(p) and s.sessionOwner == s.pollOwner.get(p) and
      s.keyHash == s.pollHash.get(p)) {
      ...s, consumed: true, pollers: s.pollers.set(p, "claimed"),
      leakedInvalidBinding: s.leakedInvalidBinding or s.pollKey.get(p) == 0 or s.pollOwner.get(p) == 0
    } else {...s, pollers: s.pollers.set(p, "done")}
  }
  action Deliver(p: int): bool = all {
    s.pollers.get(p) == "claimed",
    s' = {...s, pollers: s.pollers.set(p, "done"), revealed: s.revealed.union(Set(p))}
  }
  // Losing the response after consumption never makes plaintext replayable.
  action LoseReply(p: int): bool = all {
    s.pollers.get(p) == "claimed",
    s' = {...s, pollers: s.pollers.set(p, "done")}
  }

  // Negative authority probes while an external decrypt is in flight. These
  // mutations remain external to the CLI protocol; the final claim must recheck.
  action ChangeKey = {
    nondet change = Set("revoke", "owner", "hash").oneOf()
    all {
      s.key != 0, not(s.keyChanged), s.cleanup == "new",
      Clients.exists(p => Set("read", "decrypted", "claim").contains(s.pollers.get(p))),
      s' = {...s, keyChanged: true,
        keyActive: s.keyActive and change != "revoke",
        keyOwner: if (change == "owner") (if (s.keyOwner == 1) 2 else 1) else s.keyOwner,
        keyHash: if (change == "hash") 2 else s.keyHash}
    }
  }

  action BeginCleanup = all {
    s.cleanup == "new",
    s' = {...s, cleanup: "planned", cleanupTime: s.clock}
  }
  // Session rows are locked before inspecting their current credential and
  // consumed receipt. The same lock serializes both completion and reveal.
  action LockExpiredSessions = all {
    s.cleanup == "planned",
    s' = {...s, cleanup: "session-locked",
      cleanupHasSession: s.session != "deleted" and SessionDeadline < s.cleanupTime}
  }
  action StageKeyRevocation = all {
    s.cleanup == "session-locked",
    s' = {...s, cleanup: "key-staged",
      pendingRevocation: s.cleanupHasSession and not(s.consumed) and
        s.key != 0 and s.keyActive}
  }
  action CommitCleanup = all {
    s.cleanup == "key-staged",
    s' = {...s, cleanup: "done",
      session: if (s.cleanupHasSession) "deleted" else s.session,
      cleanupHasSession: false,
      keyActive: s.keyActive and not(s.pendingRevocation),
      revokedConsumed: s.revokedConsumed or (s.pendingRevocation and s.consumed)}
  }
  action CleanupFails = all {
    Set("planned", "key-staged", "session-locked").contains(s.cleanup),
    s' = {...s, cleanup: "done", pendingRevocation: false, cleanupHasSession: false}
  }

  action step = any {
    Tick, ExpireStatus,
    {nondet c = Clients.oneOf(); Prepare(c)},
    {nondet c = Clients.oneOf(); Complete(c)},
    {nondet c = Clients.oneOf(); CompletionFails(c)},
    {nondet p = Clients.oneOf(); Read(p)},
    {nondet p = Clients.oneOf(); Decrypt(p)},
    {nondet p = Clients.oneOf(); DecryptFails(p)},
    {nondet p = Clients.oneOf(); BeginClaim(p)},
    {nondet p = Clients.oneOf(); Claim(p)},
    {nondet p = Clients.oneOf(); Deliver(p)},
    {nondet p = Clients.oneOf(); LoseReply(p)},
    ChangeKey, BeginCleanup, LockExpiredSessions, StageKeyRevocation, CommitCleanup,
    CleanupFails, s' = s
  }
  val TypeOK = and {
    Set(0, 1, 2, 3).contains(s.clock),
    Set("pending", "authenticated", "expired", "deleted").contains(s.session),
    Set(0, 1, 2).contains(s.key),
    Clients.forall(c => Set("new", "prepared", "done").contains(s.completions.get(c))),
    Clients.forall(p => Set("new", "read", "decrypted", "claim", "claimed", "done").contains(s.pollers.get(p))),
    Set("new", "planned", "key-staged", "session-locked", "done").contains(s.cleanup)
  }
  val OneMintedCredential = s.minted.size() <= 1
  val OnePlaintextReveal = s.revealed.size() <= 1
  val ExactRevealBinding = not(s.leakedInvalidBinding)
  val ReaperPreservesConsumedCredential = not(s.revokedConsumed)
  val NoAbandonedActiveCredential = s.cleanup == "done" and s.session == "deleted" and not(s.consumed) implies not(s.keyActive)

  val OperationsIdle = Clients.forall(c => s.completions.get(c) != "prepared") and
    Clients.forall(p => Set("new", "done").contains(s.pollers.get(p))) and
    Set("new", "done").contains(s.cleanup)
  temporal Fairness = and {
    Clients.forall(c => Complete(c).weakFair(s)),
    Clients.forall(p => Decrypt(p).weakFair(s)),
    Clients.forall(p => BeginClaim(p).weakFair(s)),
    Clients.forall(p => Claim(p).weakFair(s)),
    Clients.forall(p => Deliver(p).weakFair(s)),
    LockExpiredSessions.weakFair(s), StageKeyRevocation.weakFair(s), CommitCleanup.weakFair(s)
  }
  temporal OperationsSettle = Fairness implies eventually(always(OperationsIdle))
}
module CliAuthSession_pending {
  import CliAuthSession(Initial = "pending").*
  run revealHasOneWinnerTest = init
    .then(Prepare(1)).then(Complete(1)).then(Read(1)).then(Read(2))
    .then(Decrypt(1)).then(Decrypt(2)).then(BeginClaim(1)).then(BeginClaim(2))
    .then(Claim(1)).then(Claim(2)).then(Deliver(1))
    .expect(s.revealed == Set(1) and s.pollers.get(2) == "done")
  run staleCompletionMustNotLeaveOrphanTest = init
    .then(Prepare(1)).then(Tick).then(Tick).then(BeginCleanup)
    .then(LockExpiredSessions).then(StageKeyRevocation)
    .expect(s.cleanupHasSession and s.session == "pending")
    .then(CommitCleanup).then(Complete(1))
    .expect(NoAbandonedActiveCredential and s.minted.size() == 0)
  run consumedCredentialSurvivesCleanupTest = init
    .then(Prepare(1)).then(Complete(1)).then(Read(1)).then(Decrypt(1))
    .then(BeginClaim(1)).then(Claim(1)).then(Tick).then(Tick)
    .then(BeginCleanup).then(LockExpiredSessions).then(StageKeyRevocation)
    .then(CommitCleanup).then(Deliver(1))
    .expect(s.keyActive and s.consumed and not(s.revokedConsumed))

}
module CliAuthSession_existing { import CliAuthSession(Initial = "authenticated").* }
module CliAuthSession_wrongOwner { import CliAuthSession(Initial = "wrong-owner").* }
module CliAuthSession_missingKey { import CliAuthSession(Initial = "missing-key").* }
module CliAuthSession_missingCipher { import CliAuthSession(Initial = "missing-cipher").* }
