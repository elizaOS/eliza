----------------------------- MODULE InteractiveTask -----------------------------
(***************************************************************************)
(* src/messaging/interactive-task.ts: transitionInteractiveTask.            *)
(*                                                                         *)
(* The abstract task of test/interactive-task-conformance.test.ts. That    *)
(* test drives the real reducer from every state with every event and      *)
(* compares it with this state graph, so the reducer refines this module.  *)
(* Context gates (owner, revision, clock, expiry) and malformed proposals  *)
(* only refuse; they add no state and are checked by the test alone.       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

Ops == {"op1", "op2"}
Origins == {"A", "B"}
OpStates == {"none", "prepared", "dispatched", "succeeded", "failed",
             "cancelled", "unknown"}
Statuses == {"active", "paused", "blocked", "waiting", "completed", "cancelled"}

VARIABLES
    status,    \* the task status
    auth,      \* authorization.state
    obs,       \* origin of the current observation, or "none"
    op,        \* op[o]: status of operation o, or "none" before it is prepared
    scopeB,    \* B is an allowed origin through an active grant
    extended   \* the task carries originGrants

vars == <<status, auth, obs, op, scopeB, extended>>

Unresolved(s) == s \in {"prepared", "dispatched", "unknown"}
(* The reducer looks at op1 first; at most one operation is unresolved. *)
U == IF Unresolved(op["op1"]) THEN "op1"
     ELSE IF Unresolved(op["op2"]) THEN "op2" ELSE "none"
Ended == status \in {"completed", "cancelled"}

(* Supersede a prepared operation: it becomes cancelled. *)
CancelPrepared(o) == IF U # "none" /\ op[U] = "prepared"
                     THEN [o EXCEPT ![U] = "cancelled"] ELSE o

TypeOK ==
    /\ status \in Statuses
    /\ auth \in {"active", "revoked"}
    /\ obs \in Origins \cup {"none"}
    /\ op \in [Ops -> OpStates]
    /\ scopeB \in BOOLEAN
    /\ extended \in BOOLEAN

Init ==
    /\ status = "active"
    /\ auth = "active"
    /\ obs = "none"
    /\ op = [o \in Ops |-> "none"]
    /\ scopeB = FALSE
    /\ extended = FALSE

(* observe and resume: a fresh observation supersedes a prepared action. *)
Observe(origin, resume) ==
    /\ ~Ended
    /\ auth = "active"
    /\ resume => status = "paused"
    /\ U # "none" => op[U] = "prepared"
    /\ origin = "B" => scopeB
    /\ op' = CancelPrepared(op)
    /\ obs' = origin
    /\ status' = IF resume THEN "active" ELSE status
    /\ UNCHANGED <<auth, scopeB, extended>>

Extend ==
    /\ ~Ended
    /\ auth = "active"
    /\ U # "none" => op[U] = "prepared"
    /\ ~scopeB
    /\ op' = CancelPrepared(op)
    /\ obs' = "none"
    /\ scopeB' = TRUE
    /\ extended' = TRUE
    /\ UNCHANGED <<status, auth>>

(* Retracting an origin makes an in-flight dispatch unknown and pauses. *)
Retract ==
    /\ scopeB
    /\ IF U # "none" /\ op[U] = "dispatched"
       THEN /\ op' = [op EXCEPT ![U] = "unknown"]
            /\ status' = "paused"
       ELSE /\ op' = CancelPrepared(op)
            /\ UNCHANGED status
    /\ obs' = "none"
    /\ scopeB' = FALSE
    /\ UNCHANGED <<auth, extended>>

(* pause, cancel, recover and revoke; recover and revoke also apply after   *)
(* the task ended, and then keep its status.                              *)
Interrupt(kind) ==
    /\ kind \in {"pause", "cancel"} => ~Ended
    /\ op' = IF U # "none" /\ op[U] = "dispatched"
             THEN [op EXCEPT ![U] = "unknown"] ELSE CancelPrepared(op)
    /\ auth' = IF kind = "revoke" THEN "revoked" ELSE auth
    /\ status' = IF Ended THEN status
                 ELSE IF kind = "cancel" THEN "cancelled" ELSE "paused"
    /\ UNCHANGED <<obs, scopeB, extended>>

Prepare(o) ==
    /\ status = "active"
    /\ auth = "active"
    /\ obs # "none"
    /\ U = "none"
    /\ op[o] = "none"
    /\ op' = [op EXCEPT ![o] = "prepared"]
    /\ UNCHANGED <<status, auth, obs, scopeB, extended>>

Dispatch(o) ==
    /\ ~Ended
    /\ U = o
    /\ op[o] = "prepared"
    /\ op' = [op EXCEPT ![o] = "dispatched"]
    /\ status' = "waiting"
    /\ UNCHANGED <<auth, obs, scopeB, extended>>

Result(o, st) ==
    /\ ~Ended
    /\ op[o] = "dispatched"
    /\ op' = [op EXCEPT ![o] = st]
    /\ status' = IF status = "waiting"
                 THEN IF st = "unknown" THEN "blocked" ELSE "active"
                 ELSE status
    /\ UNCHANGED <<auth, obs, scopeB, extended>>

(* Reconciling an unknown outcome; a resolved one drops the observation. *)
Reconcile(o, st) ==
    /\ op[o] = "unknown"
    /\ op' = [op EXCEPT ![o] = st]
    /\ obs' = IF st = "unknown" THEN obs ELSE "none"
    /\ status' = IF st # "unknown" /\ status = "blocked" THEN "paused" ELSE status
    /\ UNCHANGED <<auth, scopeB, extended>>

Complete ==
    /\ ~Ended
    /\ U = "none"
    /\ status' = "completed"
    /\ UNCHANGED <<auth, obs, op, scopeB, extended>>

Next ==
    \/ \E origin \in Origins, resume \in BOOLEAN : Observe(origin, resume)
    \/ Extend
    \/ Retract
    \/ \E kind \in {"pause", "cancel", "recover", "revoke"} : Interrupt(kind)
    \/ \E o \in Ops : Prepare(o) \/ Dispatch(o)
    \/ \E o \in Ops, st \in {"succeeded", "failed", "unknown"} :
           Result(o, st) \/ Reconcile(o, st)
    \/ Complete

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* The invariants validateInteractiveTask stores with every task. *)

AtMostOneUnresolved == Cardinality({o \in Ops : Unresolved(op[o])}) <= 1
WaitingIffDispatched == (status = "waiting") <=> (\E o \in Ops : op[o] = "dispatched")
BlockedHasUnknown == status = "blocked" => \E o \in Ops : op[o] = "unknown"
RevokedIsNotRunning == auth = "revoked" => status \notin {"active", "waiting"}
(* A prepared action is bound to a live observation under an active grant. *)
PreparedIsFenced ==
    (\E o \in Ops : op[o] = "prepared") =>
        /\ obs # "none" /\ auth = "active" /\ status = "active"
ObservedOriginIsAllowed == obs = "B" => scopeB
ScopeComesFromGrant == scopeB => extended
(* An ended task has nothing in flight. *)
EndedIsSettled == Ended => \A o \in Ops : op[o] \notin {"prepared", "dispatched"}

(* Settled outcomes are final, and each operation is prepared at most once. *)
OutcomesAreFinal ==
    [][\A o \in Ops :
         /\ op[o] \in {"succeeded", "failed", "cancelled"} => op'[o] = op[o]
         /\ op[o] # "none" => op'[o] # "none"]_vars
(* Revocation is permanent. *)
RevocationIsFinal == [][auth = "revoked" => auth' = "revoked"]_vars
=============================================================================
