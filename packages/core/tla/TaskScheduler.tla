---------------------------- MODULE TaskScheduler ----------------------------
(***************************************************************************)
(* src/services/task-scheduler.ts: the process-wide task scheduler daemon, *)
(* for one agent whose TaskService may be replaced.                        *)
(*                                                                         *)
(* The interval timer starts a tick when an adapter is set and no tick is  *)
(* active. A tick snapshots the dirty agent and its registration id,       *)
(* clears the dirty mark, awaits adapter.getTasks, drops the result if the *)
(* scheduler generation changed, checks the registration again and, when  *)
(* rows came back for the agent, awaits taskService.runTick(tasks);        *)
(* afterwards a still-current agent is marked dirty again. An agent whose  *)
(* query returned no rows gets no runTick and stays quiet until it is      *)
(* marked dirty. startTaskScheduler with another adapter and                *)
(* stopTaskScheduler bump the generation and detach activeTick, so the old *)
(* tick may still be inside runTick when a new tick starts.                *)
(* registerTaskSchedulerRuntime (TaskService.startTimer) gives each        *)
(* registration a new id; prepareStop unregisters only its own entry.      *)
(*                                                                         *)
(* A tick does not take an agent whose service is still inside a          *)
(* scheduler runTick (busyServices); that agent stays dirty.               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Services,     \* TaskService instances of the agent (a replacement may register)
    Adapters,
    Ticks,        \* tick slots (each tick() call in flight)
    MaxRestarts,  \* startTaskScheduler / stopTaskScheduler calls
    MaxRegs,      \* registerTaskSchedulerRuntime calls
    QueryCanFail,
    None

MaxGen == MaxRestarts + 1

VARIABLES
    registry,    \* the agent's entry: [svc, id], or None
    nextId,      \* nextRegistrationId
    dirty,       \* the agent is in dirtyAgents
    timer,       \* the interval timer runs
    adapter,     \* the adapter, or None
    activeTick,  \* the attached tick, or None
    gen,         \* schedulerGeneration
    tk,          \* tk[k]: tick k's place, generation, registration id and service
    inRun,       \* inRun[s]: runTick calls of service s in flight
    stopped,     \* stopped[s]: service s ran prepareStop
    busy,        \* busyServices: services inside a scheduler runTick
    stale,       \* a runTick was dispatched for a stale generation or registration
    restarts,
    regs,
    taken        \* history: the service a Fire snapshot took since the last dirty
                 \* mark, or None when the latest mark is not yet taken

vars == <<registry, nextId, dirty, timer, adapter, activeTick, gen, tk, inRun,
          stopped, busy, stale, restarts, regs, taken>>

TickPcs == {"free", "query", "run", "after"}
Entries == [svc : Services, id : 1..MaxRegs]

TypeOK ==
    /\ registry \in Entries \cup {None}
    /\ nextId \in 0..MaxRegs
    /\ dirty \in BOOLEAN
    /\ timer \in BOOLEAN
    /\ adapter \in Adapters \cup {None}
    /\ activeTick \in Ticks \cup {None}
    /\ gen \in 0..MaxGen
    /\ tk \in [Ticks -> [pc : TickPcs, gen : 0..MaxGen, id : 0..MaxRegs,
                         svc : Services \cup {None}]]
    /\ inRun \in [Services -> 0..Cardinality(Ticks)]
    /\ stopped \in [Services -> BOOLEAN]
    /\ busy \subseteq Services
    /\ stale \in BOOLEAN
    /\ restarts \in 0..MaxRestarts
    /\ regs \in 0..MaxRegs
    /\ taken \in Services \cup {None}

FreeTick == [pc |-> "free", gen |-> 0, id |-> 0, svc |-> None]

Init ==
    /\ registry = None
    /\ nextId = 0
    /\ dirty = FALSE
    /\ timer = FALSE
    /\ adapter = None
    /\ activeTick = None
    /\ gen = 0
    /\ tk = [k \in Ticks |-> FreeTick]
    /\ inRun = [s \in Services |-> 0]
    /\ stopped = [s \in Services |-> FALSE]
    /\ busy = {}
    /\ stale = FALSE
    /\ restarts = 0
    /\ regs = 0
    /\ taken = None

(* A step that sets the dirty mark is a new mark that no snapshot has taken. *)
Marks == taken' = IF dirty' THEN None ELSE taken

(* currentRegistration(agentId, registrationId, generation). *)
Current(k) == tk[k].gen = gen /\ registry # None /\ registry.id = tk[k].id

(* The tick settles: its finally clears activeTick if it is still attached. *)
Settle(k) ==
    /\ tk' = [tk EXCEPT ![k] = FreeTick]
    /\ activeTick' = IF activeTick = k THEN None ELSE activeTick

(* The interval callback (ensureTimer) and tick() up to its first await. *)
Fire(k) ==
    /\ timer /\ adapter # None /\ activeTick = None
    /\ tk[k].pc = "free"
    /\ LET take == dirty /\ registry # None /\ registry.svc \notin busy IN
       /\ dirty' = IF registry # None /\ ~take THEN dirty ELSE FALSE
       /\ IF take
          THEN /\ tk' = [tk EXCEPT ![k] = [pc |-> "query", gen |-> gen,
                                           id |-> registry.id, svc |-> registry.svc]]
               /\ activeTick' = k
          ELSE UNCHANGED <<tk, activeTick>>
       /\ taken' = IF take THEN registry.svc ELSE taken
    /\ UNCHANGED <<registry, nextId, timer, adapter, gen, inRun, stopped, busy, stale,
                   restarts, regs>>

(* adapter.getTasks settles in tick(). A failure re-marks              *)
(* a current agent dirty; a result for a stale generation or registration  *)
(* is dropped; no rows for the agent end the tick with no runTick and no   *)
(* re-dirty; otherwise runTick is called, synchronously after the fence.   *)
Query(k) ==
    /\ tk[k].pc = "query"
    /\ LET s == tk[k].svc IN
       \/ /\ QueryCanFail
          /\ dirty' = (dirty \/ Current(k))
          /\ Settle(k)
          /\ UNCHANGED <<inRun, busy, stale>>
       \/ /\ ~Current(k)
          /\ Settle(k)
          /\ UNCHANGED <<dirty, inRun, busy, stale>>
       \/ /\ Current(k)            \* no rows for the agent
          /\ Settle(k)
          /\ UNCHANGED <<dirty, inRun, busy, stale>>
       \/ /\ Current(k)
          /\ stale' = (stale \/ tk[k].gen # gen \/ registry.id # tk[k].id)
          /\ tk' = [tk EXCEPT ![k].pc = IF stopped[s] THEN "after" ELSE "run"]
          /\ inRun' = IF stopped[s] THEN inRun ELSE [inRun EXCEPT ![s] = @ + 1]
          /\ busy' = busy \cup {s}
          /\ UNCHANGED <<dirty, activeTick>>
    /\ Marks
    /\ UNCHANGED <<registry, nextId, timer, adapter, gen, stopped, restarts, regs>>

(* runTick returns; a still-current agent is marked dirty again. *)
RunDone(k) ==
    /\ tk[k].pc \in {"run", "after"}
    /\ LET s == tk[k].svc IN
       /\ inRun' = IF tk[k].pc = "run" THEN [inRun EXCEPT ![s] = @ - 1] ELSE inRun
       /\ busy' = busy \ {s}
    /\ dirty' = (dirty \/ Current(k))
    /\ Settle(k)
    /\ Marks
    /\ UNCHANGED <<registry, nextId, timer, adapter, gen, stopped, stale, restarts, regs>>

(* startTaskScheduler(adapter): a new adapter starts a new generation. *)
Start(a) ==
    /\ restarts < MaxRestarts
    /\ ~(timer /\ adapter = a)
    /\ gen' = gen + 1
    /\ adapter' = a
    /\ activeTick' = None
    /\ IF timer
       THEN /\ dirty' = (dirty \/ registry # None)
            /\ UNCHANGED timer
       ELSE /\ timer' = TRUE
            /\ UNCHANGED dirty
    /\ restarts' = restarts + 1
    /\ Marks
    /\ UNCHANGED <<registry, nextId, tk, inRun, stopped, busy, stale, regs>>

(* stopTaskScheduler(): no process tasks are registered here. *)
Stop ==
    /\ restarts < MaxRestarts
    /\ gen' = gen + 1
    /\ timer' = FALSE
    /\ registry' = None
    /\ dirty' = FALSE
    /\ adapter' = None
    /\ activeTick' = None
    /\ restarts' = restarts + 1
    /\ UNCHANGED <<nextId, tk, inRun, stopped, busy, stale, regs, taken>>

(* TaskService.startTimer() while an adapter is set. *)
Register(s) ==
    /\ ~stopped[s] /\ adapter # None /\ regs < MaxRegs
    /\ nextId' = nextId + 1
    /\ registry' = [svc |-> s, id |-> nextId + 1]
    /\ dirty' = TRUE
    /\ regs' = regs + 1
    /\ taken' = None
    /\ UNCHANGED <<timer, adapter, activeTick, gen, tk, inRun, stopped, busy, stale,
                   restarts>>

(* TaskService.prepareStop(): unregister only this service's entry. *)
StopService(s) ==
    /\ ~stopped[s]
    /\ stopped' = [stopped EXCEPT ![s] = TRUE]
    /\ IF registry # None /\ registry.svc = s
       THEN /\ registry' = None
            /\ dirty' = FALSE
       ELSE UNCHANGED <<registry, dirty>>
    /\ UNCHANGED <<nextId, timer, adapter, activeTick, gen, tk, inRun, busy, stale,
                   restarts, regs, taken>>

(* markTaskSchedulerDirty after a task write. *)
MarkDirty ==
    /\ ~dirty
    /\ dirty' = TRUE
    /\ taken' = None
    /\ UNCHANGED <<registry, nextId, timer, adapter, activeTick, gen, tk, inRun,
                   stopped, busy, stale, restarts, regs>>

(* Quiet: no tick is in flight. Every other state has a next step. *)
Finished == \A k \in Ticks : tk[k].pc = "free"

Next ==
    \/ \E k \in Ticks : Fire(k) \/ Query(k) \/ RunDone(k)
    \/ \E a \in Adapters : Start(a)
    \/ Stop
    \/ \E s \in Services : Register(s) \/ StopService(s)
    \/ MarkDirty
    \/ (Finished /\ UNCHANGED vars)

Fairness ==
    /\ WF_vars(\E k \in Ticks : Fire(k))
    /\ \A k \in Ticks : WF_vars(Query(k)) /\ WF_vars(RunDone(k))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* runTick is dispatched only for the current generation and registration. *)
NoStaleDispatch == ~stale

(* A service never runs two scheduler runTick calls at once. *)
OneRunTickPerService == \A s \in Services : inRun[s] <= 1

(* The attached tick belongs to the current generation. *)
AttachedTickCurrent == activeTick # None => tk[activeTick].gen = gen

(* The history variable: a taken mark means the agent is no longer dirty. *)
TakenClearsDirty == taken # None => ~dirty

---------------------------------------------------------------------------
(* Liveness *)

(* Every dirty mark of a registered, running service is taken by a Fire   *)
(* whose snapshot of s comes after that mark, unless the scheduler or the *)
(* registration changes first. A query that started before the mark      *)
(* does not count: a mark set during an in-flight query or runTick gets   *)
(* its own tick. Whether that tick then runs runTick depends on the rows  *)
(* its query returns.                                                     *)
DirtyServed ==
    \A s \in Services :
        (dirty /\ timer /\ adapter # None /\ registry # None /\ registry.svc = s
           /\ ~stopped[s])
        ~> \/ taken = s
           \/ registry = None \/ registry.svc # s \/ adapter = None \/ stopped[s]

(* Every tick that queried finishes. *)
TickSettles == \A k \in Ticks : tk[k].pc = "query" ~> tk[k].pc = "free"
=============================================================================
