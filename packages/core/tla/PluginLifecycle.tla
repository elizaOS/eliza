---------------------------- MODULE PluginLifecycle ----------------------------
(***************************************************************************)
(* src/plugin-lifecycle.ts: the registerPlugin, unloadPlugin, reloadPlugin *)
(* and _runServiceStart wrappers, teardownPluginOwnership,                 *)
(* stopOwnedServices and claimConnector; src/runtime.ts: _registerPlugin   *)
(* and _stopServices; src/runtime/service-lifecycle.ts:                    *)
(* _ensureServiceStarted, _runServiceStart and _stopServiceInstance.       *)
(*                                                                         *)
(* Plugin A owns NumClasses service classes of one serviceType; each      *)
(* started instance registers A's connector key (registerSendHandlers).    *)
(* Concurrent actors: unloadPlugin("A") calls, getServiceLoadPromise()     *)
(* calls, a runtime.stop(), a plugin B that registers the same connector   *)
(* key, and registerPlugin(A) calls whose init() may fail. Everything      *)
(* between two awaits is one action; `running` holds the actor inside a    *)
(* synchronous run, so nothing else interleaves there.                     *)
(*                                                                         *)
(* This models the code with the fixes from the TLA+ review applied:       *)
(*  - unloadPlugin joins a teardown already in flight for the same plugin; *)
(*  - registerPlugin joins a registration in flight for the same name;     *)
(*  - stopOwnedServices withdraws the classes from serviceTypes and takes  *)
(*    the instances out of every lookup before its first await, then stops *)
(*    every one of them through the runtime's single-flight stop, even     *)
(*    after a stop() rejects, and rethrows the failures afterwards;        *)
(*  - every start, eager or lazy, goes through the host's runServiceStart, *)
(*    which plugin-lifecycle wraps, so start() and registerSendHandlers    *)
(*    run in the plugin's service-start context and claim A's key for A;   *)
(*  - _runServiceStart stops and discards an instance whose class left     *)
(*    serviceTypes while start() ran, as it does after runtime stop.       *)
(* reloadPlugin is unloadPlugin followed by registerPlugin. A start that   *)
(* fails leaves its class to a later load; startServiceEagerly's retries   *)
(* are such loads.                                                         *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    NumClasses,     \* A's service classes (one serviceType)
    Unloaders,      \* concurrent unloadPlugin("A") calls
    Loaders,        \* concurrent getServiceLoadPromise(type) calls
    Registrars,     \* concurrent registerPlugin(A) calls; A starts unregistered when nonempty
    Stoppers,       \* {} or one runtime.stop()
    Rivals,         \* {} or plugin B, which registers A's connector key
    StartsInFlight, \* A's eager service starts are still running at the start
    InitMayFail,    \* A's init() can throw
    StopMayFail,    \* a service stop() can reject
    StartMayFail,   \* a service start() can reject
    None

Classes == 1..NumClasses
Actors == Unloaders \cup Loaders \cup Registrars \cup Stoppers \cup Rivals
MaxInst == NumClasses * (1 + Cardinality(Loaders))
Insts == 1..MaxInst
Owners == {"A", "B", "none"}

VARIABLES
    pc, running,
    cur,          \* cur[a]: the instance actor a is stopping
    waitSet,      \* waitSet[u]: class starts unload u awaits
    queue,        \* queue[u]: instances unload u still has to stop
    visited,      \* instances runtime.stop() already handled
    joinOf,       \* joinOf[a]: the registration or teardown a joined
    stopFailed,   \* a stop() awaited by the teardown rejected
    owned,        \* A's ownership is in the ownership store
    pluginsA,     \* A is in runtime.plugins
    tdActive,     \* the unload whose teardown is in flight, or None
    regActive,    \* the registration of A in flight, or None
    disposeCalls, \* dispose() invocations
    types,        \* serviceTypes.get(key)
    byClass,      \* serviceInstancesByClass (0 = none)
    starting,     \* starting[c]: the instance class c is starting (0 = none)
    failedC,      \* failedServiceClasses
    services,     \* runtime.services.get(key)
    live,         \* started instances not yet stopped
    stopCalls,    \* stop() invocations per instance
    stopOps,      \* instances with a single-flight stop operation
    nextInst,
    stopRequested,
    registry,     \* the connector registry entry for A's key
    ownsA, ownsB, \* the key is in A's / B's ownership list
    lastReg       \* the last plugin that registered the key

ctl == <<cur, waitSet, queue, visited, joinOf, stopFailed>>
plug == <<owned, pluginsA, tdActive, regActive, disposeCalls>>
svc == <<types, byClass, starting, failedC, services, live, stopCalls, stopOps,
         nextInst, stopRequested>>
conn == <<registry, ownsA, ownsB, lastReg>>
vars == <<pc, running, ctl, plug, svc, conn>>

Free(a) == running \in {None, a}
Go(a, s) == pc' = [pc EXCEPT ![a] = s]
Rest == {"idle", "done", "ok", "err"}

Init ==
    /\ pc = [a \in Actors |-> "idle"]
    /\ running = None
    /\ cur = [a \in Actors |-> 0]
    /\ waitSet = [u \in Unloaders |-> {}]
    /\ queue = [u \in Unloaders |-> {}]
    /\ visited = {}
    /\ joinOf = [a \in Registrars \cup Unloaders |-> None]
    /\ stopFailed = FALSE
    /\ owned = (Registrars = {})
    /\ pluginsA = (Registrars = {})
    /\ tdActive = None
    /\ regActive = None
    /\ disposeCalls = 0
    /\ types = IF Registrars = {} THEN Classes ELSE {}
    /\ byClass = [c \in Classes |-> IF StartsInFlight THEN 0 ELSE c]
    /\ starting = [c \in Classes |-> IF StartsInFlight THEN c ELSE 0]
    /\ failedC = {}
    /\ services = IF StartsInFlight THEN {} ELSE Classes
    /\ live = services
    /\ stopCalls = [i \in Insts |-> 0]
    /\ stopOps = {}
    /\ nextInst = NumClasses + 1
    /\ stopRequested = FALSE
    /\ registry = IF StartsInFlight \/ NumClasses = 0 THEN "none" ELSE "A"
    /\ ownsA = (registry = "A")
    /\ ownsB = FALSE
    /\ lastReg = registry

---------------------------------------------------------------------------
(* unloadPlugin("A") *)

(* Join a teardown in flight; otherwise read the store and call dispose(). *)
UCall(u) ==
    /\ pc[u] = "idle" /\ Free(u)
    /\ running' = None
    /\ IF ~owned THEN Go(u, "done") /\ UNCHANGED <<tdActive, disposeCalls, joinOf>>
       ELSE IF tdActive # None
       THEN Go(u, "join") /\ joinOf' = [joinOf EXCEPT ![u] = tdActive]
            /\ UNCHANGED <<tdActive, disposeCalls>>
       ELSE /\ Go(u, "dispose")
            /\ tdActive' = u
            /\ disposeCalls' = disposeCalls + 1
            /\ UNCHANGED joinOf
    /\ UNCHANGED <<cur, waitSet, queue, visited, stopFailed, owned, pluginsA,
                   regActive, svc, conn>>

(* A joined unload settles as the teardown it joined. *)
UJoin(u) ==
    /\ pc[u] = "join" /\ Free(u)
    /\ pc[joinOf[u]] \in {"done", "err"}
    /\ Go(u, pc[joinOf[u]])
    /\ UNCHANGED <<running, ctl, plug, svc, conn>>

(* After dispose(): removeOwnedConnectors, then stopOwnedServices withdraws
   the classes, takes the owned instances out of serviceInstancesByClass and
   services, and reads the starts in flight, all before the next await. *)
UDispose(u) ==
    LET inflight == {c \in Classes : starting[c] # 0}
        I == {byClass[c] : c \in Classes} \ {0}
    IN
    /\ pc[u] = "dispose" /\ Free(u)
    /\ registry' = IF ownsA THEN "none" ELSE registry
    /\ types' = {}
    /\ byClass' = [c \in Classes |-> 0]
    /\ services' = services \ I
    /\ queue' = [queue EXCEPT ![u] = I]
    /\ waitSet' = [waitSet EXCEPT ![u] = inflight]
    /\ Go(u, "inflight") /\ running' = None
    /\ UNCHANGED <<cur, visited, joinOf, stopFailed, plug, starting, failedC,
                   live, stopCalls, stopOps, nextInst, stopRequested, ownsA,
                   ownsB, lastReg>>

(* `await Promise.allSettled(inFlightStarts)`, skipped with none, before the
   status and the stops. Taking this step even with nothing in flight only
   adds an interleaving point, so the invariants still hold for the code. *)
UInflight(u) ==
    /\ pc[u] = "inflight" /\ Free(u)
    /\ \A c \in waitSet[u] : starting[c] = 0
    /\ Go(u, "stop") /\ running' = u
    /\ UNCHANGED <<ctl, plug, svc, conn>>

(* Await the single-flight stop of each taken instance; then the owned
   classes leave failedServiceClasses. *)
UStop(u) ==
    /\ pc[u] = "stop" /\ running = u
    /\ IF queue[u] = {}
       THEN /\ failedC' = {}
            /\ Go(u, "finish") /\ UNCHANGED <<running, cur, stopCalls, stopOps>>
       ELSE LET i == CHOOSE x \in queue[u] : TRUE IN
            /\ stopCalls' = IF i \in stopOps THEN stopCalls
                            ELSE [stopCalls EXCEPT ![i] = @ + 1]
            /\ stopOps' = stopOps \cup {i}
            /\ cur' = [cur EXCEPT ![u] = i]
            /\ Go(u, "stopwait") /\ running' = None
            /\ UNCHANGED failedC
    /\ UNCHANGED <<waitSet, queue, visited, joinOf, stopFailed, plug, types,
                   byClass, starting, services, live, nextInst, stopRequested,
                   conn>>

(* The stop settles. A rejection is recorded and the loop goes on to the
   next instance: nothing else can stop the instances already taken out of
   the lookups, and the single-flight stop never calls a rejected stop()
   again, so the instance is done with either way. *)
UStopWait(u) ==
    /\ pc[u] = "stopwait" /\ Free(u)
    /\ live' = live \ {cur[u]}
    /\ queue' = [queue EXCEPT ![u] = @ \ {cur[u]}]
    /\ \/ UNCHANGED stopFailed
       \/ StopMayFail /\ stopFailed' = TRUE
    /\ Go(u, "stop") /\ running' = u
    /\ UNCHANGED <<cur, waitSet, visited, joinOf, plug, types, byClass, starting,
                   failedC, services, stopCalls, stopOps, nextInst,
                   stopRequested, conn>>

(* stopOwnedServices rethrows the stop failures; teardownPluginOwnership
   catches them, finishes synchronously, drops the store entry last and
   rejects with the aggregate. *)
UFinish(u) ==
    /\ pc[u] = "finish" /\ running = u
    /\ owned' = FALSE /\ pluginsA' = FALSE /\ tdActive' = None
    /\ Go(u, IF stopFailed THEN "err" ELSE "done") /\ running' = None
    /\ UNCHANGED <<ctl, regActive, disposeCalls, svc, conn>>

---------------------------------------------------------------------------
(* getServiceLoadPromise(type) -> _ensureServiceStarted *)

LCall(l) ==
    /\ pc[l] = "idle" /\ Free(l)
    /\ Go(l, IF stopRequested THEN "done" ELSE "init") /\ running' = None
    /\ UNCHANGED <<ctl, plug, svc, conn>>

(* After `await initPromise`: start every class with no instance and no start.
   A class whose last start failed is retried only while no class of the
   type has an instance. *)
LBegin(l) ==
    LET S == {c \in types : /\ byClass[c] = 0 /\ starting[c] = 0
                            /\ (c \in failedC => \A x \in types : byClass[x] = 0)}
    IN
    /\ pc[l] = "init" /\ Free(l)
    /\ IF stopRequested \/ types = {}
       THEN UNCHANGED <<starting, nextInst>>
       ELSE /\ starting' = [c \in Classes |->
                               IF c \in S THEN nextInst + c - 1 ELSE starting[c]]
            /\ nextInst' = nextInst + NumClasses
    /\ Go(l, "done") /\ running' = None
    /\ UNCHANGED <<ctl, plug, types, byClass, failedC, services, live, stopCalls,
                   stopOps, stopRequested, conn>>

(* runServiceStart after `await serviceDef.start()`, inside the host's
   runServiceStart, which runs eager and lazy starts alike in A's
   service-start context. A rejected start() publishes nothing and marks the
   class failed. A start that outlived the runtime or its class is stopped and
   discarded, and _runServiceStart throws, so the class is marked failed too;
   otherwise it is published and registerSendHandlers claims the
   key for A, releasing it from B. *)
SDone(c) ==
    LET i == starting[c] IN
    /\ i # 0 /\ Free(c)
    /\ starting' = [starting EXCEPT ![c] = 0]
    /\ running' = None
    /\ \/ /\ StartMayFail
          /\ failedC' = failedC \cup {c}
          /\ UNCHANGED <<byClass, services, live, stopCalls, stopOps, conn>>
       \/ /\ IF stopRequested \/ c \notin types
             THEN /\ failedC' = failedC \cup {c}
                  /\ stopCalls' = [stopCalls EXCEPT ![i] = @ + 1]
                  /\ stopOps' = stopOps \cup {i}
                  /\ UNCHANGED <<byClass, services, live, conn>>
             ELSE /\ failedC' = failedC \ {c}
                  /\ byClass' = [byClass EXCEPT ![c] = i]
                  /\ services' = {byClass'[x] : x \in types} \ {0}
                  /\ live' = live \cup {i}
                  /\ registry' = "A" /\ lastReg' = "A"
                  /\ ownsA' = owned /\ ownsB' = FALSE
                  /\ UNCHANGED <<stopCalls, stopOps>>
    /\ UNCHANGED <<pc, ctl, plug, types, nextInst, stopRequested>>

---------------------------------------------------------------------------
(* runtime.stop() -> _stopServices *)

TReq(t) ==
    /\ pc[t] = "idle" /\ Free(t)
    /\ stopRequested' = TRUE
    /\ Go(t, "drain") /\ running' = None
    /\ UNCHANGED <<ctl, plug, types, byClass, starting, failedC, services, live,
                   stopCalls, stopOps, nextInst, conn>>

(* Waits for the service starts in flight. *)
TDrain(t) ==
    /\ pc[t] = "drain" /\ Free(t)
    /\ \A c \in Classes : starting[c] = 0
    /\ Go(t, "svc") /\ running' = t
    /\ UNCHANGED <<ctl, plug, svc, conn>>

(* Each published instance through _stopServiceInstance; then the lookups clear. *)
TSvc(t) ==
    /\ pc[t] = "svc" /\ running = t
    /\ IF services \ visited = {}
       THEN /\ byClass' = [c \in Classes |-> 0]
            /\ Go(t, "done") /\ running' = None
            /\ UNCHANGED <<visited, stopCalls, stopOps, cur>>
       ELSE LET i == CHOOSE x \in services \ visited : TRUE IN
            /\ visited' = visited \cup {i}
            /\ stopCalls' = IF i \in stopOps THEN stopCalls
                            ELSE [stopCalls EXCEPT ![i] = @ + 1]
            /\ stopOps' = stopOps \cup {i}
            /\ cur' = [cur EXCEPT ![t] = i]
            /\ Go(t, "svcwait") /\ running' = None
            /\ UNCHANGED byClass
    /\ UNCHANGED <<waitSet, queue, joinOf, stopFailed, plug, types, starting,
                   failedC, services, live, nextInst, stopRequested, conn>>

(* _stopServiceInstance logs a rejected stop() and goes on. *)
TSvcWait(t) ==
    /\ pc[t] = "svcwait" /\ Free(t)
    /\ live' = live \ {cur[t]}
    /\ Go(t, "svc") /\ running' = t
    /\ UNCHANGED <<ctl, plug, types, byClass, starting, failedC, services,
                   stopCalls, stopOps, nextInst, stopRequested, conn>>

---------------------------------------------------------------------------
(* Plugin B registers A's key: claimConnector releases it from A's list. *)
BReg(b) ==
    /\ pc[b] = "idle" /\ Free(b)
    /\ registry' = "B" /\ lastReg' = "B" /\ ownsA' = FALSE /\ ownsB' = TRUE
    /\ Go(b, "done")
    /\ UNCHANGED <<running, ctl, plug, svc>>

---------------------------------------------------------------------------
(* registerPlugin(A): join a registration in flight; a registered duplicate
   is skipped as success; otherwise push to plugins and await init(). *)
RCall(r) ==
    /\ pc[r] = "idle" /\ Free(r)
    /\ running' = None
    /\ IF stopRequested THEN Go(r, "err") /\ UNCHANGED <<pluginsA, regActive, joinOf>>
       ELSE IF regActive # None
       THEN Go(r, "join") /\ joinOf' = [joinOf EXCEPT ![r] = regActive]
            /\ UNCHANGED <<pluginsA, regActive>>
       ELSE IF pluginsA THEN Go(r, "ok") /\ UNCHANGED <<pluginsA, regActive, joinOf>>
       ELSE Go(r, "init") /\ pluginsA' = TRUE /\ regActive' = r /\ UNCHANGED joinOf
    /\ UNCHANGED <<cur, waitSet, queue, visited, stopFailed, owned, tdActive,
                   disposeCalls, svc, conn>>

(* A failed init() withdraws A from plugins and rolls back; success stores
   the ownership. *)
RInit(r) ==
    /\ pc[r] = "init" /\ Free(r)
    /\ \/ InitMayFail /\ pluginsA' = FALSE /\ Go(r, "err") /\ UNCHANGED owned
       \/ owned' = TRUE /\ Go(r, "ok") /\ UNCHANGED pluginsA
    /\ regActive' = None /\ running' = None
    /\ UNCHANGED <<ctl, tdActive, disposeCalls, svc, conn>>

RJoin(r) ==
    /\ pc[r] = "join" /\ Free(r)
    /\ pc[joinOf[r]] \in {"ok", "err"}
    /\ Go(r, pc[joinOf[r]])
    /\ UNCHANGED <<running, ctl, plug, svc, conn>>

---------------------------------------------------------------------------
Quiescent ==
    /\ running = None
    /\ \A a \in Actors : pc[a] \in Rest
    /\ \A c \in Classes : starting[c] = 0

Finished == Quiescent /\ \A a \in Actors : pc[a] # "idle"

Unload(u) == UCall(u) \/ UJoin(u) \/ UDispose(u) \/ UInflight(u) \/ UStop(u)
             \/ UStopWait(u) \/ UFinish(u)
Load(l) == LCall(l) \/ LBegin(l)
Stop(t) == TReq(t) \/ TDrain(t) \/ TSvc(t) \/ TSvcWait(t)
Register(r) == RCall(r) \/ RInit(r) \/ RJoin(r)

Next ==
    \/ \E u \in Unloaders : Unload(u)
    \/ \E l \in Loaders : Load(l)
    \/ \E c \in Classes : SDone(c)
    \/ \E t \in Stoppers : Stop(t)
    \/ \E b \in Rivals : BReg(b)
    \/ \E r \in Registrars : Register(r)
    \/ (Finished /\ UNCHANGED vars)

(* Every awaited operation settles: start(), stop(), dispose() and init(). *)
Fairness ==
    /\ \A u \in Unloaders : WF_vars(Unload(u))
    /\ \A l \in Loaders : WF_vars(Load(l))
    /\ \A c \in Classes : WF_vars(SDone(c))
    /\ \A t \in Stoppers : WF_vars(Stop(t))
    /\ \A b \in Rivals : WF_vars(BReg(b))
    /\ \A r \in Registrars : WF_vars(Register(r))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

TypeOK ==
    /\ running \in Actors \cup Classes \cup {None}
    /\ stopFailed \in BOOLEAN
    /\ owned \in BOOLEAN /\ pluginsA \in BOOLEAN
    /\ types \subseteq Classes
    /\ byClass \in [Classes -> 0..MaxInst]
    /\ starting \in [Classes -> 0..MaxInst]
    /\ failedC \subseteq Classes
    /\ services \subseteq Insts /\ live \subseteq Insts
    /\ stopCalls \in [Insts -> Nat] /\ stopOps \subseteq Insts
    /\ registry \in Owners /\ lastReg \in Owners
    /\ ownsA \in BOOLEAN /\ ownsB \in BOOLEAN

TeardownStates == {"dispose", "inflight", "stop", "stopwait", "finish"}

(* At most one teardown of A runs, and dispose() runs once. *)
TeardownExclusive ==
    /\ Cardinality({u \in Unloaders : pc[u] \in TeardownStates}) <= 1
    /\ disposeCalls <= 1

(* No instance's stop() is called twice. *)
StopAtMostOnce == \A i \in Insts : stopCalls[i] <= 1

(* At rest, every live instance is published for a registered class, so
   getService finds it and runtime.stop() stops it. *)
NoOrphanInstance ==
    Quiescent => \A i \in live : i \in services /\ \E c \in types : byClass[c] = i

StopStopsAll ==
    (Quiescent /\ \E t \in Stoppers : pc[t] = "done") => live = {}

(* A key is in an ownership list only for its last registrant, and a later
   registrant's entry survives the earlier owner's unload. *)
ConnectorOwnedByLast ==
    /\ (owned /\ ownsA /\ tdActive = None) => registry = "A"
    /\ ownsB => registry = "B"
    /\ lastReg = "B" => registry = "B"

(* At rest, A's connector is registered only while A is. *)
NoOrphanConnector == (Quiescent /\ registry = "A") => owned

(* registerPlugin resolves only for a plugin that is registered. *)
RegisterHonest ==
    Unloaders = {} => \A r \in Registrars : pc[r] = "ok" => pluginsA

---------------------------------------------------------------------------
(* Liveness: every call returns and every start settles. *)
Terminates == <>Finished
=============================================================================
