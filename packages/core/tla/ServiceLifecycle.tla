---------------------------- MODULE ServiceLifecycle ----------------------------
(***************************************************************************)
(* Start and stop of the sibling classes registered under one service type. *)
(*                                                                         *)
(* src/runtime/service-lifecycle.ts: startServiceEagerly (eager retry),     *)
(*   _ensureServiceStarted (per-class dedupe, sibling settlement),          *)
(*   _runServiceStart (stop-during-start, unload-during-start),            *)
(*   _stopServiceInstance and stopServiceOnce (per-instance single-flight   *)
(*   stop).                                                                 *)
(* src/runtime.ts: registerPlugin's service part and registerService (a      *)
(*   sibling class registered later), _stopServices (runtime stop).          *)
(* src/plugin-lifecycle.ts: stopOwnedServices for one owned class beside a   *)
(*   sibling that stays. PluginLifecycle.tla models the rest of unload:      *)
(*   teardown, connectors, several owned classes and failing stops.          *)
(*                                                                         *)
(* This models the code WITH the fixes from the TLA+ review applied:        *)
(*   - _runServiceStart sets the type "registered" when it publishes, and a *)
(*     single class failure no longer marks the type "failed" (the type is  *)
(*     settled by _ensureServiceStarted from the published list);           *)
(*   - _stopServices clears runtime.services;                               *)
(*   - stopOwnedServices withdraws the class from serviceTypes and takes    *)
(*     its instance out of every lookup before its first await, so a        *)
(*     sibling that publishes meanwhile cannot leave the instance where a   *)
(*     runtime stop clears it unstopped; it then awaits the one             *)
(*     startingServices entry present then and the owned class's own start, *)
(*     and stops the instance through the single-flight stop;               *)
(*   - a start that settles after the withdrawal stops its instance instead *)
(*     of publishing it;                                                    *)
(*   - stopOwnedServices then sets the registration status from the current *)
(*     services and serviceTypes, and a caller whose starts settle with no  *)
(*     class left for the type deletes the status instead of writing        *)
(*     "failed", so neither order leaves a phantom entry.                   *)
(*                                                                         *)
(* Everything between two awaits is one action. Instances are numbered in   *)
(* creation order; cls[i] is the class that created instance i.             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Classes,      \* sibling classes of the one service type
    LateClasses,  \* classes registered after boot (registerService / registerPlugin)
    Owned,        \* the one class owned by the plugin that may be unloaded
    Callers,      \* concurrent _ensureServiceStarted callers (eager start or getServiceLoadPromise)
    MaxInst,      \* bound on created instances
    MaxRetries,   \* eager retry attempts after a failed start
    None

ASSUME Cardinality(Owned) = 1 /\ Owned \subseteq Classes \ LateClasses

Inst == 1..MaxInst
OwnedClass == CHOOSE c \in Owned : TRUE

VARIABLES
    types,      \* serviceTypes.get(key): the registered classes
    byClass,    \* serviceInstancesByClass
    starting,   \* startingServiceClasses has the class
    failed,     \* failedServiceClasses
    sc,         \* sc[c]: phase of the class's in-flight runServiceStart
    att,        \* att[c]: number of starts begun for the class
    scInst,     \* scInst[c]: instance a late start is stopping
    published,  \* runtime.services.get(key)
    status,     \* serviceRegistrationStatus.get(key)
    nextInst,   \* next instance id
    cls,        \* cls[i]: class of instance i
    late,       \* late[i]: start() resolved after stop was requested
    stopCalls,  \* stopCalls[i]: times instance.stop() was invoked
    stopOp,     \* stopOperations.get(i): none | running | done
    epc,        \* epc[e]: where caller e is
    tries,      \* tries[e]: eager retries used
    ewait,      \* ewait[e][c]: start attempt of c that e awaits (0 = none)
    stopReq,    \* stopRequested
    stopped,    \* stopped (set first in _stopServices)
    rpc,        \* runtime stop phase
    rcur,       \* instance the runtime stop is awaiting
    rvisited,   \* instances the runtime stop already handled
    lastEnsure, \* the caller whose start set is in startingServices, or None
    upc,        \* plugin unload phase
    ucur,       \* instance the unload is awaiting
    uwait       \* uwait[c]: start attempt of c the unload awaits (0 = none)

vars == <<types, byClass, starting, failed, sc, att, scInst, published, status,
          nextInst, cls, late, stopCalls, stopOp, epc, tries, ewait,
          lastEnsure, stopReq, stopped, rpc, rcur, rvisited, upc, ucur, uwait>>

startVars == <<byClass, starting, failed, sc, att, scInst, nextInst, cls, late>>
callerVars == <<epc, tries, ewait, lastEnsure>>
stopVars == <<stopReq, stopped, rpc, rcur, rvisited>>
unloadVars == <<upc, ucur, uwait>>

Created == 1..(nextInst - 1)
InFlight == {"awaitStart", "event", "lateStop"}

TypeOK ==
    /\ types \subseteq Classes
    /\ byClass \in [Classes -> Inst \cup {None}]
    /\ starting \in [Classes -> BOOLEAN]
    /\ failed \in [Classes -> BOOLEAN]
    /\ sc \in [Classes -> {"idle"} \cup InFlight]
    /\ att \in [Classes -> Nat]
    /\ scInst \in [Classes -> Inst \cup {None}]
    /\ published \subseteq Inst
    /\ status \in {"pending", "registering", "registered", "failed", "unknown"}
    /\ nextInst \in 1..(MaxInst + 1)
    /\ cls \in [Inst -> Classes \cup {None}]
    /\ late \in [Inst -> BOOLEAN]
    /\ stopCalls \in [Inst -> Nat]
    /\ stopOp \in [Inst -> {"none", "running", "done"}]
    /\ epc \in [Callers -> {"idle", "ensure", "wait", "delay", "done"}]
    /\ ewait \in [Callers -> [Classes -> Nat]]
    /\ stopReq \in BOOLEAN /\ stopped \in BOOLEAN
    /\ rpc \in {"idle", "services", "stopping", "stopInst", "done"}
    /\ lastEnsure \in Callers \cup {None}
    /\ upc \in {"idle", "wait", "drain", "stop", "done"}
    /\ uwait \in [Classes -> Nat]

Init ==
    /\ types = Classes \ LateClasses
    /\ byClass = [c \in Classes |-> None]
    /\ starting = [c \in Classes |-> FALSE]
    /\ failed = [c \in Classes |-> FALSE]
    /\ sc = [c \in Classes |-> "idle"]
    /\ att = [c \in Classes |-> 0]
    /\ scInst = [c \in Classes |-> None]
    /\ published = {}
    /\ status = "pending"
    /\ nextInst = 1
    /\ cls = [i \in Inst |-> None]
    /\ late = [i \in Inst |-> FALSE]
    /\ stopCalls = [i \in Inst |-> 0]
    /\ stopOp = [i \in Inst |-> "none"]
    /\ epc = [e \in Callers |-> "idle"]
    /\ tries = [e \in Callers |-> 0]
    /\ ewait = [e \in Callers |-> [c \in Classes |-> 0]]
    /\ stopReq = FALSE
    /\ stopped = FALSE
    /\ rpc = "idle"
    /\ rcur = None
    /\ rvisited = {}
    /\ lastEnsure = None
    /\ upc = "idle"
    /\ ucur = None
    /\ uwait = [c \in Classes |-> 0]

(* runServiceStart rebuilds services[key] from serviceTypes order. *)
Rebuild(bc, ts) == {bc[x] : x \in {y \in ts : bc[y] # None}}

(* _stopServiceInstance: stop() runs only when no operation is published. *)
StopOnce(i) ==
    IF stopOp[i] = "none"
    THEN /\ stopOp' = [stopOp EXCEPT ![i] = "running"]
         /\ stopCalls' = [stopCalls EXCEPT ![i] = @ + 1]
    ELSE UNCHANGED <<stopOp, stopCalls>>

---------------------------------------------------------------------------
(* Callers: startServiceEagerly / getServiceLoadPromise -> _ensureServiceStarted. *)

(* The synchronous stopRequested check, then `await initPromise`. *)
EBegin(e) ==
    /\ epc[e] = "idle"
    /\ ~stopReq
    /\ epc' = [epc EXCEPT ![e] = "ensure"]
    /\ UNCHANGED <<types, startVars, published, status, stopCalls, stopOp, tries,
                   ewait, lastEnsure, stopVars, unloadVars>>

(* After initPromise: snapshot the classes; reuse a started instance, join a  *)
(* pending start, skip a failed sibling when another started, else begin     *)
(* _runServiceStart, which runs synchronously up to `await start()`; the     *)
(* caller's start set becomes the startingServices entry.                   *)
EEnsure(e) ==
    /\ epc[e] = "ensure"
    /\ IF stopReq \/ types = {}
       THEN /\ epc' = [epc EXCEPT ![e] = "done"]
            /\ UNCHANGED <<starting, sc, att, status, ewait, lastEnsure>>
       ELSE LET startedImpl == \E c \in types : byClass[c] # None
                spawn == {c \in types : byClass[c] = None /\ ~starting[c]
                                        /\ ~(startedImpl /\ failed[c])}
                join == {c \in types : byClass[c] = None /\ starting[c]}
            IN /\ starting' = [c \in Classes |-> starting[c] \/ c \in spawn]
               /\ sc' = [c \in Classes |-> IF c \in spawn THEN "awaitStart" ELSE sc[c]]
               /\ att' = [c \in Classes |-> IF c \in spawn THEN att[c] + 1 ELSE att[c]]
               /\ ewait' = [ewait EXCEPT ![e] =
                    [c \in Classes |-> IF c \in spawn THEN att[c] + 1
                                       ELSE IF c \in join THEN att[c] ELSE 0]]
               /\ status' = IF spawn # {} /\ published = {} THEN "registering" ELSE status
               /\ lastEnsure' = e
               /\ epc' = [epc EXCEPT ![e] = "wait"]
    /\ UNCHANGED <<types, byClass, failed, scInst, published, nextInst, cls, late,
                   stopCalls, stopOp, tries, stopVars, unloadVars>>

Settled(e) ==
    \A c \in Classes : ewait[e][c] > 0 => (att[c] > ewait[e][c] \/ sc[c] = "idle")

(* `await Promise.allSettled(starts)`: the type resolves to the first        *)
(* published instance or fails; a failed eager start may retry.             *)
ESettle(e) ==
    /\ epc[e] = "wait"
    /\ Settled(e)
    /\ ewait' = [ewait EXCEPT ![e] = [c \in Classes |-> 0]]
    /\ IF published # {}
       THEN /\ status' = "registered"
            /\ epc' = [epc EXCEPT ![e] = "done"]
            /\ UNCHANGED tries
       ELSE /\ status' = IF types = {} THEN "unknown" ELSE "failed"
            /\ IF tries[e] < MaxRetries /\ ~stopReq /\ ~stopped
               THEN /\ epc' = [epc EXCEPT ![e] = "delay"]
                    /\ tries' = [tries EXCEPT ![e] = @ + 1]
               ELSE /\ epc' = [epc EXCEPT ![e] = "done"]
                    /\ UNCHANGED tries
    /\ UNCHANGED <<types, startVars, published, stopCalls, stopOp, lastEnsure,
                   stopVars, unloadVars>>

(* The retry delay; shutdown ends the retries. *)
EDelay(e) ==
    /\ epc[e] = "delay"
    /\ epc' = [epc EXCEPT ![e] = IF stopReq \/ stopped THEN "done" ELSE "ensure"]
    /\ UNCHANGED <<types, startVars, published, status, stopCalls, stopOp, tries,
                   ewait, lastEnsure, stopVars, unloadVars>>

---------------------------------------------------------------------------
(* _runServiceStart after `await start()`. *)

StartFail(c) ==
    /\ sc[c] = "awaitStart"
    /\ sc' = [sc EXCEPT ![c] = "idle"]
    /\ starting' = [starting EXCEPT ![c] = FALSE]
    /\ failed' = [failed EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<types, byClass, att, scInst, published, status, nextInst, cls, late,
                   stopCalls, stopOp, callerVars, stopVars, unloadVars>>

(* A start that resolves after stop was requested, or after plugin unload   *)
(* withdrew its class, is stopped and never published; otherwise the        *)
(* instance is published and the type registered.                           *)
StartOk(c) ==
    /\ sc[c] = "awaitStart"
    /\ nextInst <= MaxInst
    /\ LET i == nextInst IN
       /\ nextInst' = nextInst + 1
       /\ cls' = [cls EXCEPT ![i] = c]
       /\ IF stopped \/ stopReq \/ c \notin types
          THEN /\ late' = [late EXCEPT ![i] = stopped \/ stopReq]
               /\ StopOnce(i)
               /\ scInst' = [scInst EXCEPT ![c] = i]
               /\ sc' = [sc EXCEPT ![c] = "lateStop"]
               /\ UNCHANGED <<byClass, published, status>>
          ELSE /\ byClass' = [byClass EXCEPT ![c] = i]
               /\ published' = Rebuild(byClass', types)
               /\ status' = "registered"
               /\ sc' = [sc EXCEPT ![c] = "event"]
               /\ UNCHANGED <<late, stopOp, stopCalls, scInst>>
    /\ UNCHANGED <<types, starting, failed, att, callerVars, stopVars, unloadVars>>

(* `await emitEvent(SERVICE_STARTED)` returns. *)
StartEvent(c) ==
    /\ sc[c] = "event"
    /\ sc' = [sc EXCEPT ![c] = "idle"]
    /\ starting' = [starting EXCEPT ![c] = FALSE]
    /\ failed' = [failed EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<types, byClass, att, scInst, published, status, nextInst, cls, late,
                   stopCalls, stopOp, callerVars, stopVars, unloadVars>>

(* The late instance's stop settles; the start throws. *)
StartLateStopped(c) ==
    /\ sc[c] = "lateStop"
    /\ stopOp[scInst[c]] = "done"
    /\ sc' = [sc EXCEPT ![c] = "idle"]
    /\ scInst' = [scInst EXCEPT ![c] = None]
    /\ starting' = [starting EXCEPT ![c] = FALSE]
    /\ failed' = [failed EXCEPT ![c] = TRUE]
    /\ UNCHANGED <<types, byClass, att, published, status, nextInst, cls, late,
                   stopCalls, stopOp, callerVars, stopVars, unloadVars>>

StopOpDone(i) ==
    /\ stopOp[i] = "running"
    /\ stopOp' = [stopOp EXCEPT ![i] = "done"]
    /\ UNCHANGED <<types, startVars, published, status, stopCalls, callerVars,
                   stopVars, unloadVars>>

(* registerService / registerPlugin: a sibling class joins the type. *)
RegisterLate(c) ==
    /\ c \in LateClasses \ types
    /\ ~stopReq
    /\ types' = types \cup {c}
    /\ status' = "pending"
    /\ UNCHANGED <<startVars, published, stopCalls, stopOp, callerVars, stopVars,
                   unloadVars>>

---------------------------------------------------------------------------
(* Runtime stop. stopRequested is set before the first await. _stopServices  *)
(* waits for in-flight starts only up to a timeout, so a start may still be  *)
(* in flight; it then stops each published instance and clears the caches.  *)

RRequest ==
    /\ rpc = "idle"
    /\ stopReq' = TRUE
    /\ rpc' = "services"
    /\ UNCHANGED <<types, startVars, published, status, stopCalls, stopOp, callerVars,
                   stopped, rcur, rvisited, unloadVars>>

RServices ==
    /\ rpc = "services"
    /\ stopped' = TRUE
    /\ rpc' = "stopping"
    /\ UNCHANGED <<types, startVars, published, status, stopCalls, stopOp, callerVars,
                   stopReq, rcur, rvisited, unloadVars>>

RStopNext ==
    /\ rpc = "stopping"
    /\ \E i \in published \ rvisited :
        /\ StopOnce(i)
        /\ rcur' = i
        /\ rvisited' = rvisited \cup {i}
        /\ rpc' = "stopInst"
    /\ UNCHANGED <<types, startVars, published, status, callerVars, stopReq, stopped,
                   unloadVars>>

RStopWait ==
    /\ rpc = "stopInst"
    /\ stopOp[rcur] = "done"
    /\ rpc' = "stopping"
    /\ rcur' = None
    /\ UNCHANGED <<types, startVars, published, status, stopCalls, stopOp, callerVars,
                   stopReq, stopped, rvisited, unloadVars>>

RClear ==
    /\ rpc = "stopping"
    /\ published \subseteq rvisited
    /\ rpc' = "done"
    /\ byClass' = [c \in Classes |-> None]
    /\ starting' = [c \in Classes |-> FALSE]
    /\ failed' = [c \in Classes |-> FALSE]
    /\ published' = {}
    /\ UNCHANGED <<types, sc, att, scInst, status, nextInst, cls, late, stopCalls,
                   stopOp, callerVars, stopReq, stopped, rcur, rvisited, unloadVars>>

---------------------------------------------------------------------------
(* stopOwnedServices for the owned class. *)

(* The single-flight stop of the instance the unload took; with none, the   *)
(* class leaves failedServiceClasses and the unload is done.                *)
UStopTaken(i) ==
    IF i # None
    THEN /\ StopOnce(i)
         /\ upc' = "stop"
         /\ UNCHANGED failed
    ELSE /\ failed' = [failed EXCEPT ![OwnedClass] = FALSE]
         /\ upc' = "done"
         /\ UNCHANGED <<stopCalls, stopOp>>

(* The status from the current services and serviceTypes; "unknown" is the  *)
(* deleted entry, with servicePromises and servicePromiseHandlers deleted.  *)
UStatus(p, ts) ==
    IF p # {} THEN "registered" ELSE IF ts # {} THEN "pending" ELSE "unknown"

(* Before the first await: withdraw the class from serviceTypes, take its    *)
(* instance out of serviceInstancesByClass and services, and read the       *)
(* startingServices entry and the owned class's startingServiceClasses      *)
(* entry. With either in flight, await both; otherwise go straight on to    *)
(* UDrain. The entries can already be gone while a caller whose      *)
(* starts settled has not run ESettle: a startingServiceClasses entry       *)
(* leaves when its start settles, and the startingServices entry can be a   *)
(* later caller's that has already left.                                    *)
UStart ==
    LET entry == lastEnsure # None /\ epc[lastEnsure] = "wait"
        inflight == entry \/ starting[OwnedClass]
        awaited == [c \in Classes |->
                      IF c = OwnedClass /\ starting[c] THEN att[c]
                      ELSE IF entry THEN ewait[lastEnsure][c] ELSE 0]
        ts == types \ Owned
        i == byClass[OwnedClass]
        kept == published \ {i}
    IN /\ upc = "idle"
       /\ IF types = {}
          THEN /\ upc' = "done"
               /\ UNCHANGED <<types, byClass, failed, published, status,
                              stopCalls, stopOp, ucur, uwait>>
          ELSE /\ types' = ts
               /\ byClass' = [byClass EXCEPT ![OwnedClass] = None]
               /\ published' = kept
               /\ ucur' = i
               /\ IF inflight
                  THEN /\ uwait' = awaited
                       /\ upc' = "wait"
                       /\ UNCHANGED <<failed, stopCalls, stopOp, status>>
                  ELSE /\ upc' = "drain"
                       /\ UNCHANGED <<failed, stopCalls, stopOp, status, uwait>>
       /\ UNCHANGED <<starting, sc, att, scInst, nextInst, cls, late, callerVars,
                      stopVars>>

(* `await Promise.allSettled(inFlightStarts)` returns: every awaited start  *)
(* settled. No order against the callers is assumed.                        *)
UAwaited ==
    /\ upc = "wait"
    /\ \A c \in Classes : uwait[c] > 0 => (att[c] > uwait[c] \/ sc[c] = "idle")
    /\ upc' = "drain"
    /\ UNCHANGED <<types, startVars, published, status, stopCalls, stopOp,
                   callerVars, stopVars, ucur, uwait>>

(* The status is set and the stop of the taken instance begins. The code   *)
(* runs this in the same segment as UStart or UAwaited; a separate step     *)
(* only adds interleavings, so every invariant checked here holds for it.   *)
UDrain ==
    /\ upc = "drain"
    /\ status' = UStatus(published, types)
    /\ UStopTaken(ucur)
    /\ UNCHANGED <<types, byClass, starting, sc, att, scInst, published,
                   nextInst, cls, late, callerVars, stopVars, ucur, uwait>>

(* `await runtime._stopServiceOnce` returns; the class leaves                *)
(* failedServiceClasses.                                                    *)
UStopped ==
    /\ upc = "stop"
    /\ stopOp[ucur] = "done"
    /\ failed' = [failed EXCEPT ![OwnedClass] = FALSE]
    /\ upc' = "done"
    /\ UNCHANGED <<types, byClass, starting, sc, att, scInst, published, status,
                   nextInst, cls, late, stopCalls, stopOp, callerVars, stopVars,
                   ucur, uwait>>

---------------------------------------------------------------------------
Finished ==
    /\ \A e \in Callers : epc[e] \in {"idle", "done"}
    /\ rpc \in {"idle", "done"}
    /\ upc \in {"idle", "done"}
    /\ \A c \in Classes : sc[c] = "idle"
    /\ \A i \in Inst : stopOp[i] # "running"

Next ==
    \/ \E e \in Callers : EBegin(e) \/ EEnsure(e) \/ ESettle(e) \/ EDelay(e)
    \/ \E c \in Classes : RegisterLate(c) \/ StartFail(c) \/ StartOk(c)
                         \/ StartEvent(c) \/ StartLateStopped(c)
    \/ \E i \in Inst : StopOpDone(i)
    \/ RRequest \/ RServices \/ RStopNext \/ RStopWait \/ RClear
    \/ UStart \/ UAwaited \/ UDrain \/ UStopped
    \/ (Finished /\ UNCHANGED vars)

(* Starts, stops, events and the drains all settle; callers, stop requests,  *)
(* unloads and registrations may never happen.                              *)
Fairness ==
    /\ \A e \in Callers : WF_vars(EEnsure(e)) /\ WF_vars(ESettle(e)) /\ WF_vars(EDelay(e))
    /\ \A c \in Classes : WF_vars(StartFail(c) \/ StartOk(c)) /\ WF_vars(StartEvent(c))
                          /\ WF_vars(StartLateStopped(c))
    /\ \A i \in Inst : WF_vars(StopOpDone(i))
    /\ WF_vars(RServices) /\ WF_vars(RStopNext) /\ WF_vars(RStopWait) /\ WF_vars(RClear)
    /\ WF_vars(UAwaited) /\ WF_vars(UDrain) /\ WF_vars(UStopped)

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* At most one instance per class is running (created and not yet stopped). *)
OneLivePerClass ==
    \A c \in Classes : Cardinality({i \in Created : cls[i] = c /\ stopCalls[i] = 0}) <= 1

(* stop() is invoked at most once per instance, whoever asks. *)
StopAtMostOnce == \A i \in Inst : stopCalls[i] <= 1

(* An instance whose start resolved after stop was requested is never published. *)
NoLatePublish == \A i \in published : ~late[i]

(* Every running instance is reachable through getService, so runtime stop  *)
(* will stop it, or is the one a plugin unload took and will stop.          *)
NoOrphan ==
    \A i \in Created : stopCalls[i] = 0 => (i \in published \/ (upc \in {"wait", "drain"} /\ i = ucur))

(* The type reads "failed" only while nothing of it is published. *)
StatusConsistent == status = "failed" => published = {}

(* Once the unload finished, a type with no registered classes has no      *)
(* registration status: no start that settled with its class gone leaves a *)
(* phantom "failed" entry. A runtime stop clears startingServices and        *)
(* startingServiceClasses but no status, so this holds while the runtime    *)
(* has not stopped.                                                         *)
NoStatusWithoutClasses ==
    (upc = "done" /\ types = {} /\ ~stopped) => status = "unknown"

(* After runtime stop, getService returns no stopped instance. *)
StoppedNotReachable == rpc = "done" => published = {}

---------------------------------------------------------------------------
(* Liveness *)

(* After a stop request every instance ever created is stopped. *)
StopReachesAll ==
    stopReq ~> (\A c \in Classes : sc[c] = "idle") /\ (\A i \in Created : stopCalls[i] >= 1)

(* Every _ensureServiceStarted call settles. *)
CallersReturn == \A e \in Callers : epc[e] = "ensure" ~> epc[e] = "done"
=============================================================================
