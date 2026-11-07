--------------------------- MODULE InteractionSession ---------------------------
(***************************************************************************)
(* src/messaging/interaction-sessions.ts: one durable message-interaction  *)
(* session and the clients that consume it.                                *)
(*                                                                         *)
(* Store (InMemoryMessageInteractionSessionStore; every method is one      *)
(* atomic() step): claimIfCurrent -> applyMessageInteractionClaim,         *)
(* commitIfClaimed -> applyMessageInteractionCommit, completeIfClaimed ->  *)
(* applyMessageInteractionCompletion, reconcileCommitted ->                *)
(* applyMessageInteractionReconciliation, revokeAuthorization ->           *)
(* applyMessageInteractionRevocation, and deleteExpired.                   *)
(*                                                                         *)
(* Client (MessageInteractionSessionAuthority.consumeOutcome): claim,      *)
(* await, commit, await, execute the effect, await, complete. Each await   *)
(* is a place where time passes, other clients and the operator act, or    *)
(* the client crashes. A crashed or refused client may call again with a   *)
(* fresh claimId (the same user callback delivered again).                 *)
(*                                                                         *)
(* Clients in Mismatched send another response (another replay key and    *)
(* digest) for the same reference. The reconciler completes a committed    *)
(* session only with a verified external receipt, so only once the effect *)
(* ran. Time is a discrete clock; the session expires at Expiry and a      *)
(* claim lease lasts Ttl ticks.                                            *)
(*                                                                         *)
(* This spec models the code with two fixes: commit refuses an expired     *)
(* lease or session (CommitInTime), and deleteExpired keeps committed      *)
(* sessions (Sweepable).                                                   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Clients, Mismatched, MaxRuns, MaxTime, Expiry, Ttl, None

ASSUME Mismatched \subseteq Clients /\ 0 < Expiry /\ Expiry <= MaxTime /\ 0 < Ttl

VARIABLES
    exists,      \* the store still holds the session
    cstate,      \* consume.state
    owner,       \* consume.claimId, or None
    digest,      \* consume.replayKey + responseDigest, or None
    lease,       \* consume.claimExpiresAt
    committedAt, \* consume.committedAt
    completedAt, \* consume.completedAt
    auth,        \* authorization.state
    now,         \* the trusted clock
    pc,          \* pc[c]: where client c is in consumeOutcome
    run,         \* run[c]: how many times client c called consume
    mine,        \* mine[c]: the claimId client c holds
    last,        \* last[c]: the outcome client c last saw
    effects,     \* how many times the external effect ran
    reached,     \* ghost: "open", "committed" (ambiguous) or "completed"
    late         \* ghost: a commit happened after its lease or the session expired

vars == <<exists, cstate, owner, digest, lease, committedAt, completedAt, auth,
          now, pc, run, mine, last, effects, reached, late>>

Time == 0..MaxTime
ClaimIds == Clients \X (1..MaxRuns)
Response(c) == IF c \in Mismatched THEN "B" ELSE "A"
Outcomes == {"none", "acquired", "resumed", "in_progress", "replay", "error",
             "completed", "lost", "crashed"}

TypeOK ==
    /\ exists \in BOOLEAN
    /\ cstate \in {"pending", "claimed", "committed", "completed"}
    /\ owner \in ClaimIds \cup {None}
    /\ digest \in {"A", "B", None}
    /\ lease \in Nat
    /\ committedAt \in Time
    /\ completedAt \in Time
    /\ auth \in {"active", "revoked"}
    /\ now \in Time
    /\ pc \in [Clients -> {"idle", "claimed", "committed", "executed"}]
    /\ run \in [Clients -> 0..MaxRuns]
    /\ mine \in [Clients -> ClaimIds \cup {None}]
    /\ last \in [Clients -> Outcomes]
    /\ effects \in Nat
    /\ reached \in {"open", "committed", "completed"}
    /\ late \in BOOLEAN

Init ==
    /\ exists = TRUE
    /\ cstate = "pending"
    /\ owner = None
    /\ digest = None
    /\ lease = 0
    /\ committedAt = 0
    /\ completedAt = 0
    /\ auth = "active"
    /\ now = 0
    /\ pc = [c \in Clients |-> "idle"]
    /\ run = [c \in Clients |-> 0]
    /\ mine = [c \in Clients |-> None]
    /\ last = [c \in Clients |-> "none"]
    /\ effects = 0
    /\ reached = "open"
    /\ late = FALSE

Store == <<exists, cstate, owner, digest, lease, committedAt, completedAt, auth>>

(* The client returns to idle with outcome o and the store unchanged. *)
Return(c, o) ==
    /\ pc' = [pc EXCEPT ![c] = "idle"]
    /\ last' = [last EXCEPT ![c] = o]
    /\ UNCHANGED Store

(* consumeOutcome -> claimIfCurrent -> applyMessageInteractionClaim       *)
(* (interaction-sessions.ts applyMessageInteractionClaim). A pending or   *)
(* claimed session needs active authorization and an unexpired session    *)
(* (assertCurrentContext requireActive); a committed or completed one      *)
(* does not.                                                              *)
Claim(c) ==
    LET id == <<c, run[c] + 1>>
        same == digest = Response(c)
        Take(o) ==
            /\ cstate' = "claimed"
            /\ owner' = id
            /\ digest' = Response(c)
            /\ lease' = now + Ttl
            /\ pc' = [pc EXCEPT ![c] = "claimed"]
            /\ mine' = [mine EXCEPT ![c] = id]
            /\ last' = [last EXCEPT ![c] = o]
            /\ UNCHANGED <<exists, committedAt, completedAt, auth>>
    IN
    /\ pc[c] = "idle"
    /\ run[c] < MaxRuns
    /\ run' = [run EXCEPT ![c] = @ + 1]
    /\ IF ~exists THEN Return(c, "error") /\ UNCHANGED mine
       ELSE IF cstate \in {"pending", "claimed"} /\ (auth # "active" \/ now >= Expiry)
       THEN Return(c, "error") /\ UNCHANGED mine
       ELSE IF cstate = "completed"
       THEN Return(c, IF same THEN "replay" ELSE "error") /\ UNCHANGED mine
       ELSE IF cstate = "committed"
       THEN Return(c, IF same THEN "in_progress" ELSE "error") /\ UNCHANGED mine
       ELSE IF cstate = "claimed"
       THEN IF ~same THEN Return(c, "error") /\ UNCHANGED mine
            ELSE IF lease > now THEN Return(c, "in_progress") /\ UNCHANGED mine
            ELSE Take("resumed")
       ELSE Take("acquired")
    /\ UNCHANGED <<now, effects, reached, late>>

(* The fixed commit refuses a claim whose lease or session has expired    *)
(* (the check sqlite-message-interaction-session-store.ts makes).          *)
CommitInTime == now < lease /\ now < Expiry

(* consumeOutcome -> commitIfClaimed -> applyMessageInteractionCommit. *)
Commit(c) ==
    /\ pc[c] = "claimed"
    /\ IF /\ exists
          /\ cstate = "claimed"
          /\ owner = mine[c]
          /\ auth = "active"
          /\ CommitInTime
       THEN /\ cstate' = "committed"
            /\ committedAt' = now
            /\ pc' = [pc EXCEPT ![c] = "committed"]
            /\ reached' = "committed"
            /\ late' = (late \/ now >= lease \/ now >= Expiry)
            /\ UNCHANGED <<exists, owner, digest, lease, completedAt, auth, last>>
       ELSE Return(c, "error") /\ UNCHANGED <<reached, late>>
    /\ UNCHANGED <<now, run, mine, effects>>

(* consumeOutcome -> executor.execute: the external side effect. *)
Execute(c) ==
    /\ pc[c] = "committed"
    /\ effects' = effects + 1
    /\ pc' = [pc EXCEPT ![c] = "executed"]
    /\ UNCHANGED <<exists, cstate, owner, digest, lease, committedAt, completedAt,
                   auth, now, run, mine, last, reached, late>>

(* consumeOutcome -> completeIfClaimed -> applyMessageInteractionCompletion. *)
(* An already completed session with the same replay key is idempotent.     *)
Complete(c) ==
    /\ pc[c] = "executed"
    /\ IF ~exists THEN Return(c, "lost") /\ UNCHANGED reached
       ELSE IF cstate = "completed" /\ digest = Response(c)
       THEN Return(c, "completed") /\ UNCHANGED reached
       ELSE IF cstate = "committed" /\ owner = mine[c]
       THEN /\ cstate' = "completed"
            /\ completedAt' = now
            /\ reached' = "completed"
            /\ pc' = [pc EXCEPT ![c] = "idle"]
            /\ last' = [last EXCEPT ![c] = "completed"]
            /\ UNCHANGED <<exists, owner, digest, lease, committedAt, auth>>
       ELSE Return(c, "error") /\ UNCHANGED reached
    /\ UNCHANGED <<now, run, mine, effects, late>>

(* The process dies at an await. After commit the outcome is ambiguous and *)
(* is never re-executed; only reconciliation can complete it.              *)
Crash(c) ==
    /\ pc[c] \in {"claimed", "committed", "executed"}
    /\ Return(c, "crashed")
    /\ UNCHANGED <<now, run, mine, effects, reached, late>>

(* reconcileCommitted with a verified receipt (listCommitted finds it). *)
Reconcile ==
    /\ exists
    /\ cstate = "committed"
    /\ committedAt <= now
    /\ effects = 1
    /\ cstate' = "completed"
    /\ completedAt' = now
    /\ reached' = "completed"
    /\ UNCHANGED <<exists, owner, digest, lease, committedAt, auth, now, pc, run,
                   mine, last, effects, late>>

(* revokeAuthorization: refused while committed, a no-op once revoked. *)
Revoke ==
    /\ exists
    /\ auth = "active"
    /\ cstate # "committed"
    /\ auth' = "revoked"
    /\ UNCHANGED <<exists, cstate, owner, digest, lease, committedAt, completedAt,
                   now, pc, run, mine, last, effects, reached, late>>

(* deleteExpired(before = now). The fixed sweep never deletes a committed *)
(* session: its outcome is ambiguous until reconciled.                    *)
Sweepable ==
    \/ cstate = "completed" /\ completedAt <= now
    \/ cstate \in {"pending", "claimed"} /\ Expiry <= now

DeleteExpired ==
    /\ exists
    /\ Sweepable
    /\ exists' = FALSE
    /\ UNCHANGED <<cstate, owner, digest, lease, committedAt, completedAt, auth,
                   now, pc, run, mine, last, effects, reached, late>>

Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<exists, cstate, owner, digest, lease, committedAt, completedAt,
                   auth, pc, run, mine, last, effects, reached, late>>

Finished ==
    /\ now = MaxTime
    /\ \A c \in Clients : pc[c] = "idle" /\ run[c] = MaxRuns

Next ==
    \/ \E c \in Clients :
          Claim(c) \/ Commit(c) \/ Execute(c) \/ Complete(c) \/ Crash(c)
    \/ Reconcile \/ Revoke \/ DeleteExpired \/ Tick
    \/ (Finished /\ UNCHANGED vars)

Fairness ==
    /\ WF_vars(Reconcile)
    /\ \A c \in Clients : WF_vars(Commit(c)) /\ WF_vars(Execute(c)) /\ WF_vars(Complete(c))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* The effect runs at most once, counting a client that may still run it. *)
ExactlyOnceAuthority ==
    effects + Cardinality({c \in Clients : pc[c] = "committed"}) <= 1

AtMostOnce == effects <= 1

(* A completion receipt, and every replay of it, stands for one real effect. *)
CompletedHasEffect ==
    /\ (exists /\ cstate = "completed") => effects = 1
    /\ \A c \in Clients : last[c] \in {"replay", "completed"} => effects = 1

(* A committed session always had active authorization: revocation is    *)
(* refused while committed, and commit is refused after revocation.        *)
NoCommitWhileRevoked == (exists /\ cstate = "committed") => auth = "active"

(* No commit after the claim lease or the session expired. *)
NoLateCommit == ~late

(* An ambiguous committed outcome stays in the store until it completes, *)
(* so listCommitted can find it and a retry sees in_progress.            *)
AmbiguousRetained == reached = "committed" => exists /\ cstate = "committed"

(* A client that may run or has run the effect still has its record    *)
(* until the outcome completes (a completed record may be swept).       *)
ExecutorHasRecord ==
    \A c \in Clients : pc[c] \in {"committed", "executed"} /\ reached # "completed" =>
        /\ exists
        /\ cstate = "committed"
        /\ owner = mine[c]

(* Replay and completion never execute: effects grows only in Execute. *)
EffectOnlyByCommitter ==
    [][effects' # effects => \E c \in Clients : pc[c] = "committed" /\ pc'[c] = "executed"]_vars

---------------------------------------------------------------------------
(* Liveness: an effect that ran is eventually recorded, by its client or   *)
(* by reconciliation.                                                     *)

EffectRecorded == effects = 1 ~> reached = "completed"
=============================================================================
