------------------------------- MODULE Serialise -------------------------------
(***************************************************************************)
(* src/utils/task-scheduling.ts: createSerialise.                           *)
(*                                                                         *)
(* Each call swaps `lock` for a fresh promise synchronously (Invoke), runs *)
(* fn once the previous lock resolves (Start), and resolves its own lock in *)
(* `finally` whether fn resolved or rejected (Finish). fn never calls the  *)
(* same serialiser and awaits it (no caller in the monorepo does; that     *)
(* would wait on its own lock).                                            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Calls

VARIABLES
    chain,  \* calls in the order they swapped `lock`
    pc,     \* pc[c]: idle | queued | running | done
    outcome \* outcome[c]: none | ok | threw

vars == <<chain, pc, outcome>>

Pos(c) == CHOOSE i \in 1..Len(chain) : chain[i] = c

TypeOK ==
    /\ chain \in Seq(Calls)
    /\ pc \in [Calls -> {"idle", "queued", "running", "done"}]
    /\ outcome \in [Calls -> {"none", "ok", "threw"}]

Init ==
    /\ chain = <<>>
    /\ pc = [c \in Calls |-> "idle"]
    /\ outcome = [c \in Calls |-> "none"]

(* prev = lock; lock = new Promise(...): one synchronous step. *)
Invoke(c) ==
    /\ pc[c] = "idle"
    /\ chain' = Append(chain, c)
    /\ pc' = [pc EXCEPT ![c] = "queued"]
    /\ UNCHANGED outcome

(* prev.then(fn): prev is the lock of the call just before c, which resolves *)
(* only in that call's finally.                                             *)
Start(c) ==
    /\ pc[c] = "queued"
    /\ IF Pos(c) = 1 THEN TRUE ELSE pc[chain[Pos(c) - 1]] = "done"
    /\ pc' = [pc EXCEPT ![c] = "running"]
    /\ UNCHANGED <<chain, outcome>>

(* .finally(() => resolve()): runs for a resolved and a rejected fn. *)
Finish(c) ==
    /\ pc[c] = "running"
    /\ \E o \in {"ok", "threw"} : outcome' = [outcome EXCEPT ![c] = o]
    /\ pc' = [pc EXCEPT ![c] = "done"]
    /\ UNCHANGED chain

Finished == \A c \in Calls : pc[c] = "done"

Next ==
    \/ \E c \in Calls : Invoke(c) \/ Start(c) \/ Finish(c)
    \/ (Finished /\ UNCHANGED vars)

Fairness == \A c \in Calls : WF_vars(Start(c)) /\ WF_vars(Finish(c))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* At most one fn runs at a time. *)
MutualExclusion == Cardinality({c \in Calls : pc[c] = "running"}) <= 1

(* fns start in call order: everything before a started call has finished. *)
CallOrder ==
    \A i, j \in 1..Len(chain) :
        i < j /\ pc[chain[j]] \in {"running", "done"} => pc[chain[i]] = "done"

(* A rejected fn never blocks the calls behind it. *)
CallFinishes == \A c \in Calls : pc[c] = "queued" ~> pc[c] = "done"
=============================================================================
