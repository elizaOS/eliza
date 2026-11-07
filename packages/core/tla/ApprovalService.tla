---------------------------- MODULE ApprovalService ----------------------------
(***************************************************************************)
(* src/services/approval.ts: ApprovalService, one approval request.        *)
(*                                                                         *)
(* requestApproval / requestApprovalAsync have created the task, put the   *)
(* pending entry in pendingApprovals and armed the timeout. Then these run *)
(* concurrently, each split at its awaits:                                 *)
(*   - the timer: handleTimeout (getTask, onTimeout, resolve, deleteTask); *)
(*   - selections: the task worker's execute -> handleSelection (getTask,  *)
(*     onSelect, resolve), then runtime.deleteTask; CHOOSE_OPTION delivers *)
(*     one while it can still find the task;                               *)
(*   - cancelApproval (resolve cancelled, deleteTask) and stop().          *)
(* A callback can throw (CanFail). The caller's promise settles once: the  *)
(* first resolve or reject wins.                                           *)
(*                                                                         *)
(* This spec models the fixed code: the handler that runs a callback first *)
(* takes the entry out of pendingApprovals synchronously (handleTimeout at *)
(* its start, handleSelection right after its getTask), so the timer,      *)
(* cancel, stop and other selections no longer find it; a failed onSelect  *)
(* rejects the caller, as a failed onTimeout already does (armTimeout).    *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Selectors, CanFail

VARIABLES
    inMap,       \* pendingApprovals has the entry
    timer,       \* "armed", "fired" or "cleared"
    taskExists,  \* the runtime still has the task
    result,      \* how the caller's promise settled, or "none"
    selRuns,     \* onSelect calls started
    toRuns,      \* onTimeout calls started
    tpc,         \* where handleTimeout is
    tHas,        \* handleTimeout took the entry
    spc,         \* spc[s]: where selection s is
    sHas,        \* sHas[s]: selection s took the entry
    cpc,         \* where cancelApproval is
    stopped      \* stop() ran

vars == <<inMap, timer, taskExists, result, selRuns, toRuns, tpc, tHas, spc, sHas,
          cpc, stopped>>

TypeOK ==
    /\ inMap \in BOOLEAN
    /\ timer \in {"armed", "fired", "cleared"}
    /\ taskExists \in BOOLEAN
    /\ result \in {"none", "selected", "timedOut", "cancelled", "rejected"}
    /\ selRuns \in Nat /\ toRuns \in Nat
    /\ tpc \in {"idle", "getTask", "onTimeout", "resolve", "deleteTask", "done"}
    /\ tHas \in BOOLEAN
    /\ spc \in [Selectors -> {"idle", "getTask", "onSelect", "deleteTask", "done"}]
    /\ sHas \in [Selectors -> BOOLEAN]
    /\ cpc \in {"idle", "deleteTask", "done"}
    /\ stopped \in BOOLEAN

(* pending.resolve / pending.reject: only the first settles the promise. *)
Settle(r) == result' = IF result = "none" THEN r ELSE result

Init ==
    /\ inMap = TRUE
    /\ timer = "armed"
    /\ taskExists = TRUE
    /\ result = "none"
    /\ selRuns = 0
    /\ toRuns = 0
    /\ tpc = "idle"
    /\ tHas = FALSE
    /\ spc = [s \in Selectors |-> "idle"]
    /\ sHas = [s \in Selectors |-> FALSE]
    /\ cpc = "idle"
    /\ stopped = FALSE

(* The setTimeout callback runs handleTimeout up to its first await: it   *)
(* returns when the entry is gone, else takes it.                         *)
Fire ==
    /\ timer = "armed"
    /\ timer' = "fired"
    /\ tHas' = inMap
    /\ inMap' = FALSE
    /\ tpc' = IF inMap THEN "getTask" ELSE "done"
    /\ UNCHANGED <<taskExists, result, selRuns, toRuns, spc, sHas, cpc, stopped>>

(* After await getTask: onTimeout runs only for a task that still exists. *)
TGetTask ==
    /\ tpc = "getTask"
    /\ IF taskExists
       THEN tpc' = "onTimeout" /\ toRuns' = toRuns + 1
       ELSE tpc' = "resolve" /\ UNCHANGED toRuns
    /\ UNCHANGED <<inMap, timer, taskExists, result, selRuns, tHas, spc, sHas, cpc,
                   stopped>>

TCallbackDone ==
    /\ tpc = "onTimeout"
    /\ tpc' = "resolve"
    /\ UNCHANGED <<inMap, timer, taskExists, result, selRuns, toRuns, tHas, spc, sHas,
                   cpc, stopped>>

(* armTimeout's catch: report, drop the entry, reject the caller. *)
TCallbackFails ==
    /\ CanFail
    /\ tpc = "onTimeout"
    /\ tpc' = "done"
    /\ inMap' = FALSE
    /\ Settle("rejected")
    /\ UNCHANGED <<timer, taskExists, selRuns, toRuns, tHas, spc, sHas, cpc, stopped>>

TResolve ==
    /\ tpc = "resolve"
    /\ Settle("timedOut")
    /\ tpc' = "deleteTask"
    /\ UNCHANGED <<inMap, timer, taskExists, selRuns, toRuns, tHas, spc, sHas, cpc,
                   stopped>>

TDelete ==
    /\ tpc = "deleteTask"
    /\ taskExists' = FALSE
    /\ tpc' = "done"
    /\ UNCHANGED <<inMap, timer, result, selRuns, toRuns, tHas, spc, sHas, cpc, stopped>>

(* CHOOSE_OPTION found the task and calls worker.execute -> handleSelection, *)
(* which first awaits getTask.                                              *)
Deliver(s) ==
    /\ spc[s] = "idle"
    /\ taskExists
    /\ spc' = [spc EXCEPT ![s] = "getTask"]
    /\ UNCHANGED <<inMap, timer, taskExists, result, selRuns, toRuns, tpc, tHas, sHas,
                   cpc, stopped>>

(* After await getTask: a missing task returns (the worker still deletes  *)
(* it); otherwise the selection takes the entry, clears the timer and runs *)
(* onSelect only if it got the entry.                                      *)
SGetTask(s) ==
    /\ spc[s] = "getTask"
    /\ IF ~taskExists
       THEN /\ spc' = [spc EXCEPT ![s] = "deleteTask"]
            /\ UNCHANGED <<inMap, timer, selRuns, sHas>>
       ELSE /\ sHas' = [sHas EXCEPT ![s] = inMap]
            /\ inMap' = FALSE
            /\ timer' = IF inMap /\ timer = "armed" THEN "cleared" ELSE timer
            /\ IF inMap
               THEN spc' = [spc EXCEPT ![s] = "onSelect"] /\ selRuns' = selRuns + 1
               ELSE spc' = [spc EXCEPT ![s] = "deleteTask"] /\ UNCHANGED selRuns
    /\ UNCHANGED <<taskExists, result, toRuns, tpc, tHas, cpc, stopped>>

(* onSelect returned: resolve, then the worker awaits deleteTask. *)
SCallbackDone(s) ==
    /\ spc[s] = "onSelect"
    /\ Settle("selected")
    /\ spc' = [spc EXCEPT ![s] = "deleteTask"]
    /\ UNCHANGED <<inMap, timer, taskExists, selRuns, toRuns, tpc, tHas, sHas, cpc,
                   stopped>>

(* onSelect threw: reject the caller and rethrow; the worker never deletes *)
(* the task, so a later selection finds no entry and only deletes it.      *)
SCallbackFails(s) ==
    /\ CanFail
    /\ spc[s] = "onSelect"
    /\ Settle("rejected")
    /\ spc' = [spc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<inMap, timer, taskExists, selRuns, toRuns, tpc, tHas, sHas, cpc,
                   stopped>>

SDelete(s) ==
    /\ spc[s] = "deleteTask"
    /\ taskExists' = FALSE
    /\ spc' = [spc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<inMap, timer, result, selRuns, toRuns, tpc, tHas, sHas, cpc, stopped>>

(* cancelApproval: resolve cancelled if the entry is still there, then    *)
(* await deleteTask.                                                      *)
Cancel ==
    /\ cpc = "idle"
    /\ IF inMap
       THEN /\ timer' = IF timer = "armed" THEN "cleared" ELSE timer
            /\ Settle("cancelled")
            /\ inMap' = FALSE
       ELSE UNCHANGED <<timer, result, inMap>>
    /\ cpc' = "deleteTask"
    /\ UNCHANGED <<taskExists, selRuns, toRuns, tpc, tHas, spc, sHas, stopped>>

CancelDelete ==
    /\ cpc = "deleteTask"
    /\ taskExists' = FALSE
    /\ cpc' = "done"
    /\ UNCHANGED <<inMap, timer, result, selRuns, toRuns, tpc, tHas, spc, sHas, stopped>>

(* stop(): resolve every entry still in the map as cancelled and clear it. *)
Stop ==
    /\ ~stopped
    /\ stopped' = TRUE
    /\ IF inMap
       THEN /\ timer' = IF timer = "armed" THEN "cleared" ELSE timer
            /\ Settle("cancelled")
            /\ inMap' = FALSE
       ELSE UNCHANGED <<timer, result, inMap>>
    /\ UNCHANGED <<taskExists, selRuns, toRuns, tpc, tHas, spc, sHas, cpc>>

Finished ==
    /\ timer # "armed"
    /\ tpc \in {"idle", "done"}
    /\ cpc \in {"idle", "done"}
    /\ \A s \in Selectors : spc[s] \in {"idle", "done"}

Next ==
    \/ Fire \/ TGetTask \/ TCallbackDone \/ TCallbackFails \/ TResolve \/ TDelete
    \/ \E s \in Selectors :
          Deliver(s) \/ SGetTask(s) \/ SCallbackDone(s) \/ SCallbackFails(s) \/ SDelete(s)
    \/ Cancel \/ CancelDelete \/ Stop
    \/ (Finished /\ UNCHANGED vars)

(* The timer fires and every started handler runs to its end. Users,     *)
(* cancel and stop act only if they choose to.                           *)
Fairness ==
    /\ WF_vars(Fire)
    /\ WF_vars(TGetTask)
    /\ WF_vars(TCallbackDone \/ TCallbackFails)
    /\ WF_vars(TResolve)
    /\ WF_vars(TDelete)
    /\ \A s \in Selectors :
          /\ WF_vars(SGetTask(s))
          /\ WF_vars(SCallbackDone(s) \/ SCallbackFails(s))
          /\ WF_vars(SDelete(s))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* onSelect and onTimeout together run at most once per approval. *)
AtMostOneCallback == selRuns + toRuns <= 1

(* The caller's result names the callback that ran: a cancelled approval *)
(* ran neither, a selection never timed out and a timeout never selected. *)
ResultAgrees ==
    /\ result = "cancelled" => selRuns + toRuns = 0
    /\ result = "selected" => toRuns = 0
    /\ result = "timedOut" => selRuns = 0

(* At most one handler owns the entry. *)
SingleOwner ==
    LET owners == (IF tHas THEN 1 ELSE 0)
                  + (IF inMap THEN 1 ELSE 0)
    IN /\ owners <= 1
       /\ \A s \in Selectors : sHas[s] => ~inMap /\ ~tHas
                                /\ \A o \in Selectors \ {s} : ~sHas[o]

(* The promise settles once. *)
SettlesOnce == [][result # "none" => result' = result]_vars

---------------------------------------------------------------------------
(* Liveness: an approval with a timeout always settles the caller. *)

CallerSettles == <>(result # "none")
=============================================================================
