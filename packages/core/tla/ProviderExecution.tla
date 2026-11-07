--------------------------- MODULE ProviderExecution ---------------------------
(***************************************************************************)
(* Coalesced provider execution with reference-counted cancellation.       *)
(*                                                                         *)
(* src/runtime/state-composition.ts ProviderStateComposer: composeState's  *)
(* per-provider block (get or create the in-flight execution, register     *)
(* releaseExecution, attach) and stop(). src/runtime/provider-execution.ts: *)
(* awaitProviderExecution (waiter count, per-caller abort, evict) and      *)
(* runProviderExecution (the work races the execution signal).             *)
(*                                                                         *)
(* One in-flight key. Callers in Keyed coalesce through the map; the others *)
(* (no message id, or an explicit refresh) always create one-off work.     *)
(* Callers in Signalled race the work against their own signal; the others *)
(* have none and release only when the work settles. The lookup, creation  *)
(* and attach run with no await between them, so Attach is one step.       *)
(* `stopping` is runtime.stopRequested (isStopping); StopComposer is the   *)
(* later providerState.stop() call in _stopServices.                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Callers, Signalled, Keyed, MaxExec

Execs == 1..MaxExec
Causes == {"none", "waiters", "stop"}

VARIABLES
    map,       \* providerExecutionsInFlight.get(key), or 0
    active,    \* providerExecutionsActive
    created,   \* executions created so far
    waiters,   \* waiters[e]: execution.waiters
    cause,     \* cause[e]: why execution.controller was aborted, or none
    settled,   \* settled[e]: execution.promise has settled
    cleaned,   \* cleaned[e]: the creator's releaseExecution ran
    exec,      \* exec[c]: the execution c attached to, or 0
    pc,        \* pc[c]: idle | attached | done
    sigAborted,\* sigAborted[c]: c's own signal is aborted
    stopping,  \* runtime.stopRequested
    stopped    \* providerState.stop() ran

vars == <<map, active, created, waiters, cause, settled, cleaned, exec, pc,
          sigAborted, stopping, stopped>>

Attached(e) == {c \in Callers : pc[c] = "attached" /\ exec[c] = e}

TypeOK ==
    /\ map \in Execs \cup {0}
    /\ active \subseteq Execs
    /\ created \subseteq Execs
    /\ waiters \in [Execs -> Nat]
    /\ cause \in [Execs -> Causes]
    /\ settled \in [Execs -> BOOLEAN]
    /\ cleaned \in [Execs -> BOOLEAN]
    /\ exec \in [Callers -> Execs \cup {0}]
    /\ pc \in [Callers -> {"idle", "attached", "done"}]
    /\ sigAborted \in [Callers -> BOOLEAN]
    /\ stopping \in BOOLEAN
    /\ stopped \in BOOLEAN

Init ==
    /\ map = 0
    /\ active = {}
    /\ created = {}
    /\ waiters = [e \in Execs |-> 0]
    /\ cause = [e \in Execs |-> "none"]
    /\ settled = [e \in Execs |-> FALSE]
    /\ cleaned = [e \in Execs |-> FALSE]
    /\ exec = [c \in Callers |-> 0]
    /\ pc = [c \in Callers |-> "idle"]
    /\ sigAborted = [c \in Callers |-> FALSE]
    /\ stopping = FALSE
    /\ stopped = FALSE

Fresh == CHOOSE e \in Execs : e = Cardinality(created) + 1

(* composeState's provider block, up to its first await. A new execution   *)
(* is aborted at once while stopping (line "if (this.lifecycle.isStopping())"). *)
(* awaitProviderExecution increments waiters; an already-aborted caller     *)
(* runs onAbort synchronously: it releases, and if it was the last waiter   *)
(* it evicts the key and aborts the controller.                             *)
Attach(c) ==
    /\ pc[c] = "idle"
    /\ Cardinality(created) < MaxExec \/ (c \in Keyed /\ map # 0)
    /\ LET coalesced == c \in Keyed /\ map # 0
           e == IF coalesced THEN map ELSE Fresh
           map1 == IF ~coalesced /\ c \in Keyed THEN e ELSE map
           cause1 == IF ~coalesced /\ stopping THEN "stop" ELSE cause[e]
           leaves == c \in Signalled /\ sigAborted[c]
           w == IF leaves THEN waiters[e] ELSE waiters[e] + 1
           last == leaves /\ w = 0
       IN /\ created' = created \cup {e}
          /\ active' = IF coalesced THEN active ELSE active \cup {e}
          /\ waiters' = [waiters EXCEPT ![e] = w]
          /\ cause' = [cause EXCEPT ![e] =
                         IF last /\ cause1 = "none" THEN "waiters" ELSE cause1]
          /\ map' = IF last /\ map1 = e THEN 0 ELSE map1
          /\ exec' = [exec EXCEPT ![c] = e]
          /\ pc' = [pc EXCEPT ![c] = IF leaves THEN "done" ELSE "attached"]
    /\ UNCHANGED <<settled, cleaned, sigAborted, stopping, stopped>>

(* The caller's own signal aborts; its onAbort listener runs synchronously. *)
AbortSignal(c) ==
    /\ c \in Signalled
    /\ ~sigAborted[c]
    /\ sigAborted' = [sigAborted EXCEPT ![c] = TRUE]
    /\ IF pc[c] = "attached"
       THEN LET e == exec[c] IN
            /\ waiters' = [waiters EXCEPT ![e] = @ - 1]
            /\ pc' = [pc EXCEPT ![c] = "done"]
            /\ IF waiters[e] = 1
               THEN /\ map' = IF map = e THEN 0 ELSE map            \* evict()
                    /\ cause' = [cause EXCEPT ![e] =
                                   IF @ = "none" THEN "waiters" ELSE @]
               ELSE UNCHANGED <<map, cause>>
       ELSE UNCHANGED <<waiters, pc, map, cause>>
    /\ UNCHANGED <<active, created, settled, cleaned, exec, stopping, stopped>>

(* The provider finishes on its own: resolve or reject. *)
SettleWork(e) ==
    /\ e \in created
    /\ ~settled[e]
    /\ settled' = [settled EXCEPT ![e] = TRUE]
    /\ UNCHANGED <<map, active, created, waiters, cause, cleaned, exec, pc,
                   sigAborted, stopping, stopped>>

(* runProviderExecution: an aborted execution signal rejects the race. *)
SettleAborted(e) ==
    /\ e \in created
    /\ ~settled[e]
    /\ cause[e] # "none"
    /\ settled' = [settled EXCEPT ![e] = TRUE]
    /\ UNCHANGED <<map, active, created, waiters, cause, cleaned, exec, pc,
                   sigAborted, stopping, stopped>>

(* releaseExecution: registered by the creator before any waiter's handler, *)
(* so it is the first reaction to run when the promise settles.            *)
Cleanup(e) ==
    /\ settled[e]
    /\ ~cleaned[e]
    /\ cleaned' = [cleaned EXCEPT ![e] = TRUE]
    /\ active' = active \ {e}
    /\ map' = IF map = e THEN 0 ELSE map
    /\ UNCHANGED <<created, waiters, cause, settled, exec, pc, sigAborted,
                   stopping, stopped>>

(* A waiter's settle handler (or the finally of a signal-less caller). *)
CallerSettle(c) ==
    /\ pc[c] = "attached"
    /\ settled[exec[c]]
    /\ cleaned[exec[c]]
    /\ waiters' = [waiters EXCEPT ![exec[c]] = @ - 1]
    /\ pc' = [pc EXCEPT ![c] = "done"]
    /\ UNCHANGED <<map, active, created, cause, settled, cleaned, exec,
                   sigAborted, stopping, stopped>>

(* runtime.stop(): stopRequested becomes true. *)
RequestStop ==
    /\ ~stopping
    /\ stopping' = TRUE
    /\ UNCHANGED <<map, active, created, waiters, cause, settled, cleaned,
                   exec, pc, sigAborted, stopped>>

(* ProviderStateComposer.stop(): abort every active execution, clear both. *)
StopComposer ==
    /\ stopping
    /\ ~stopped
    /\ stopped' = TRUE
    /\ cause' = [e \in Execs |->
                   IF e \in active /\ cause[e] = "none" THEN "stop" ELSE cause[e]]
    /\ active' = {}
    /\ map' = 0
    /\ UNCHANGED <<created, waiters, settled, cleaned, exec, pc, sigAborted,
                   stopping>>

Finished ==
    /\ \A c \in Callers : pc[c] = "done"
    /\ \A e \in created : cleaned[e]
    /\ stopped

Next ==
    \/ \E c \in Callers : Attach(c) \/ AbortSignal(c) \/ CallerSettle(c)
    \/ \E e \in Execs : SettleWork(e) \/ SettleAborted(e) \/ Cleanup(e)
    \/ RequestStop \/ StopComposer
    \/ (Finished /\ UNCHANGED vars)

(* Provider work itself may never finish; an aborted race always does. *)
Fairness ==
    /\ \A e \in Execs : WF_vars(SettleAborted(e)) /\ WF_vars(Cleanup(e))
    /\ \A c \in Callers : WF_vars(CallerSettle(c))
    /\ WF_vars(StopComposer)

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* execution.waiters counts exactly the callers still attached to it. *)
WaiterCount == \A e \in created : waiters[e] = Cardinality(Attached(e))

(* Shared work is aborted for lack of interest only when nobody is attached, *)
(* and for stop only once stop was requested.                               *)
AbortOnlyWhenUnwanted ==
    \A e \in created :
        /\ cause[e] = "waiters" => Attached(e) = {}
        /\ cause[e] = "stop" => stopping

(* Unsettled work with no interested caller is always aborted. *)
UnwantedWorkAborted ==
    \A e \in created : ~settled[e] /\ waiters[e] = 0 => cause[e] # "none"

(* A new caller never joins an execution aborted for lack of interest. While *)
(* stopping it can join one aborted for stop, which is what creating its own *)
(* would give it.                                                           *)
NoJoinAborting ==
    map # 0 => \/ cause[map] = "none"
               \/ cause[map] = "stop" /\ stopping

(* After stop() no execution that was running is left un-aborted. *)
StopReachesAll ==
    stopped => \A e \in created : ~settled[e] => cause[e] # "none"

(* The map only holds live, active executions. *)
MapActive == map # 0 => map \in active

---------------------------------------------------------------------------
(* Liveness *)

(* Aborted work settles, so every caller attached to it leaves. *)
AbortedCallerLeaves ==
    \A c \in Callers :
        (pc[c] = "attached" /\ cause[exec[c]] # "none") ~> pc[c] = "done"

(* After stop every caller leaves, whatever its provider does. *)
StopReleasesCallers ==
    \A c \in Callers : (pc[c] = "attached" /\ stopped) ~> pc[c] = "done"
=============================================================================
