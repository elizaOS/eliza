---------------------------- MODULE TaskService ----------------------------
(***************************************************************************)
(* src/services/task.ts: TaskService, for one queue task row.             *)
(*                                                                         *)
(* Runs come from four places. The local timer (onTimer, checkTasks) and   *)
(* runDueTasks() share activeTick: a timer that fires during a tick defers *)
(* (activeTick.then(armTimer)), runDueTasks waits for it. The daemon       *)
(* dispatches runTick(tasks) with a snapshot it read, without activeTick.  *)
(* executeTaskById() reads the row and calls executeTask.                  *)
(*                                                                         *)
(* A scheduled run reads a snapshot (getTasks), then after the awaits of  *)
(* validateTasks selects it in runTick: a paused snapshot, a repeat task   *)
(* not due by repeatDueAt, or a blocking repeat already in executingTasks  *)
(* is skipped. executeTaskInternal adds the id to the executingTasks Set,  *)
(* runs the worker, then writes: a one-shot is deleted; a repeat records   *)
(* its run (and on success acknowledges the wake revision it observed,     *)
(* optionally requesting a new wake); finally the id leaves the Set.       *)
(*                                                                         *)
(* Wake store (plugins/plugin-sql/src/stores/task-wake.ts): a request sets *)
(* rev := rev + 1 and keeps the earliest wakeAt; consume(r) clears wakeAt  *)
(* only when rev = r. Every task write calls markDirty(), which arms the   *)
(* local timer.                                                            *)
(*                                                                         *)
(* executeTaskInternal returns at once when a one-shot or blocking id is  *)
(* already in executingTasks, and a one-shot re-reads its row (getTask)   *)
(* after claiming the id, so a stale snapshot does not run a deleted      *)
(* one-shot. That read sits outside the failure path: a missing row or a  *)
(* failed read releases the id and returns (or throws) with no write.     *)
(*                                                                         *)
(* A worker that returns preserveTask makes executeTaskInternal return    *)
(* before any write: the row stays as it is and a later run executes it   *)
(* again. Such a run is not counted as a one-shot's run.                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Mode,           \* "local" (startTimer armed a local timer) or "daemon"
    Kind,           \* "oneshot" or "repeat"
    Blocking,       \* metadata.blocking !== false (repeat tasks)
    Tm,             \* the local timer's tick (cyclic)
    DueRunners,     \* host runDueTasks() calls
    DaemonRunners,  \* runTick(tasks) dispatched by the task-scheduler daemon
    ByIdRunners,    \* executeTaskById() calls
    MaxRequests,    \* wake requests (patchTaskMetadata requestAt or nextWakeAt)
    MaxPauses,      \* pauseTask / resumeTask writes
    None

Timers == IF Mode = "local" THEN {Tm} ELSE {}
Scheduled == Timers \cup DueRunners \cup DaemonRunners
Runners == Scheduled \cup ByIdRunners
Repeat == Kind = "repeat"
(* One-shots and blocking repeats are claimed exclusively. *)
Guarded == ~Repeat \/ Blocking
MaxRev == MaxRequests + Cardinality(Runners)

Rows == [exists : BOOLEAN, paused : BOOLEAN, due : BOOLEAN, failing : BOOLEAN,
         wake : BOOLEAN, wakeDue : BOOLEAN, rev : 0..MaxRev]
(* What a run keeps of the row it read: paused, due by repeatDueAt, *)
(* whether it saw a wakeAt, and the wakeRevision it saw.             *)
Snaps == [paused : BOOLEAN, due : BOOLEAN, wake : BOOLEAN, rev : 0..MaxRev]

VARIABLES
    row,        \* the stored task row
    snap,       \* snap[r]: the row as runner r read it, or None
    pc,         \* pc[r]: where runner r is
    outcome,    \* outcome[r]: what the worker returned
    activeTick, \* TaskService.activeTick: the runner that holds it, or None
    inSet,      \* the id is in executingTasks (a Set, not a counter)
    armed,      \* hasTimer
    deferred,   \* a fired timer waits on activeTick.then(armTimer)
    unseen,     \* a task write (markDirty) no tick has read since
    starts,     \* worker.execute calls not returning preserveTask, saturating at 2
    unserved,   \* wake revisions no run has observed yet
    requests,   \* wake requests made
    pauses      \* pause/resume writes made

vars == <<row, snap, pc, outcome, activeTick, inSet, armed, deferred, unseen,
          starts, unserved, requests, pauses>>

States == {"idle", "read", "select", "recheck", "exec", "write", "release", "done"}
Executing == {r \in Runners : pc[r] \in {"exec", "write", "release"}}

(* repeatDueAt: the interval elapsed, or a due wake while failureCount = 0. *)
DueRow(s) == s.due \/ (s.wake /\ s.wakeDue /\ ~s.failing)
SnapOf(s) == [paused |-> s.paused, due |-> DueRow(s), wake |-> s.wake, rev |-> s.rev]

TypeOK ==
    /\ row \in Rows
    /\ snap \in [Runners -> Snaps \cup {None}]
    /\ pc \in [Runners -> States]
    /\ outcome \in [Runners -> {"ok", "fail", "okWake", "preserve", None}]
    /\ activeTick \in Runners \cup {None}
    /\ inSet \in BOOLEAN
    /\ armed \in BOOLEAN
    /\ deferred \in BOOLEAN
    /\ unseen \in BOOLEAN
    /\ starts \in 0..2
    /\ unserved \subseteq 1..MaxRev
    /\ requests \in 0..MaxRev
    /\ pauses \in 0..MaxPauses

Init ==
    /\ row = [exists |-> TRUE, paused |-> FALSE, due |-> TRUE, failing |-> FALSE,
              wake |-> FALSE, wakeDue |-> FALSE, rev |-> 0]
    /\ snap = [r \in Runners |-> None]
    /\ pc = [r \in Runners |-> "idle"]
    /\ outcome = [r \in Runners |-> None]
    /\ activeTick = None
    /\ inSet = FALSE
    /\ armed = (Mode = "local")    \* startTimer(): armTimer(now + MIN_TICK_MS)
    /\ deferred = FALSE
    /\ unseen = FALSE
    /\ starts = 0
    /\ unserved = {}
    /\ requests = 0
    /\ pauses = 0

(* The run returns. Its activeTick (if any) settles, which runs a deferred *)
(* armTimer; the timer tick re-arms for wake.at unless the queue was empty.*)
End(r, rearm) ==
    /\ activeTick' = IF activeTick = r THEN None ELSE activeTick
    /\ deferred' = IF activeTick = r THEN FALSE ELSE deferred
    /\ armed' = (armed \/ (activeTick = r /\ deferred) \/ (r \in Timers /\ rearm))
    /\ pc' = [pc EXCEPT ![r] = IF r \in Timers THEN "idle" ELSE "done"]
    /\ snap' = [snap EXCEPT ![r] = None]

(* markDirty() after a committed task write. *)
MarkDirty ==
    /\ unseen' = TRUE
    /\ armed' = (armed \/ Mode = "local")

(* onTimer, the start of runDueTasks, a daemon dispatch, executeTaskById. *)
Begin(r) ==
    /\ pc[r] = "idle"
    /\ \/ /\ r \in Timers
          /\ armed
          /\ armed' = FALSE
          /\ IF activeTick # None
             THEN /\ deferred' = TRUE
                  /\ UNCHANGED <<pc, activeTick>>
             ELSE /\ activeTick' = r
                  /\ pc' = [pc EXCEPT ![r] = "read"]
                  /\ UNCHANGED deferred
       \/ /\ r \in DueRunners
          /\ activeTick = None
          /\ activeTick' = r
          /\ pc' = [pc EXCEPT ![r] = "read"]
          /\ UNCHANGED <<armed, deferred>>
       \/ /\ r \in DaemonRunners \cup ByIdRunners
          /\ pc' = [pc EXCEPT ![r] = "read"]
          /\ UNCHANGED <<armed, deferred, activeTick>>
    /\ UNCHANGED <<row, snap, outcome, inSet, unseen, starts, unserved, requests, pauses>>

(* getTasks / getTask resolves. An empty queue sets wake.at = null; a    *)
(* missing row makes executeTaskById throw.                              *)
Read(r) ==
    /\ pc[r] = "read"
    /\ unseen' = IF r \in Timers \cup DueRunners THEN FALSE ELSE unseen
    /\ IF row.exists
       THEN /\ snap' = [snap EXCEPT ![r] = SnapOf(row)]
            /\ pc' = [pc EXCEPT ![r] = "select"]
            /\ UNCHANGED <<activeTick, deferred, armed>>
       ELSE /\ End(r, FALSE)
    /\ UNCHANGED <<row, outcome, inSet, starts, unserved, requests, pauses>>

StartWorker(r) ==
    /\ pc' = [pc EXCEPT ![r] = "exec"]
    /\ starts' = IF starts < 2 THEN starts + 1 ELSE 2
    /\ unserved' = {k \in unserved : k > snap[r].rev}

(* validateTasks' paused skip, runTick's due and executingTasks checks,   *)
(* and the synchronous start of executeTaskInternal.                     *)
Select(r) ==
    /\ pc[r] = "select"
    /\ LET s == snap[r] IN
       IF r \in Scheduled /\ (s.paused \/ (Repeat /\ ~s.due)
                               \/ (Repeat /\ Blocking /\ inSet))
       THEN /\ End(r, TRUE)
            /\ UNCHANGED <<inSet, starts, unserved>>
       ELSE IF Guarded /\ inSet
       THEN /\ End(r, TRUE)
            /\ UNCHANGED <<inSet, starts, unserved>>
       ELSE /\ inSet' = TRUE
            /\ IF ~Repeat
               THEN /\ pc' = [pc EXCEPT ![r] = "recheck"]
                    /\ UNCHANGED <<starts, unserved>>
               ELSE StartWorker(r)
            /\ UNCHANGED <<activeTick, deferred, armed, snap>>
    /\ UNCHANGED <<row, outcome, unseen, requests, pauses>>

(* The claimed one-shot re-reads its row (getTask). A row another run    *)
(* already deleted is not run again; a failed read releases the id and   *)
(* throws, leaving the row.                                              *)
Recheck(r) ==
    /\ pc[r] = "recheck"
    /\ \/ /\ row.exists
          /\ StartWorker(r)
       \/ /\ pc' = [pc EXCEPT ![r] = "release"]   \* missing row, or the read failed
          /\ UNCHANGED <<starts, unserved>>
    /\ UNCHANGED <<row, snap, outcome, activeTick, inSet, armed, deferred, unseen,
                   requests, pauses>>

(* worker.execute settles. A one-shot's failure takes the same delete as *)
(* its success. preserveTask returns before any write.                   *)
Work(r) ==
    /\ pc[r] = "exec"
    /\ \E o \in {"preserve"} \cup
              IF Repeat
              THEN {"ok", "fail"} \cup (IF requests < MaxRequests THEN {"okWake"} ELSE {})
              ELSE {"ok"} :
         /\ outcome' = [outcome EXCEPT ![r] = o]
         /\ IF o = "preserve"
            THEN /\ pc' = [pc EXCEPT ![r] = "release"]
                 /\ starts' = IF Repeat THEN starts ELSE starts - 1
            ELSE /\ pc' = [pc EXCEPT ![r] = "write"]
                 /\ UNCHANGED starts
    /\ UNCHANGED <<row, snap, activeTick, inSet, armed, deferred, unseen,
                   unserved, requests, pauses>>

(* The bookkeeping write of executeTaskInternal (success and catch):     *)
(* deleteTask for a one-shot; for a repeat an atomic patch that records  *)
(* the run, and on success consumes the observed revision when the run   *)
(* saw a wake or requests a new one.                                     *)
Write(r) ==
    /\ pc[r] = "write"
    /\ LET s == snap[r]
           o == outcome[r]
           consume == s.wake \/ o = "okWake"
           retained == row.wake /\ row.rev # s.rev
       IN
       IF ~Repeat
       THEN /\ row' = [row EXCEPT !.exists = FALSE]
            /\ UNCHANGED <<unserved, requests>>
       ELSE IF o = "fail"
       THEN /\ row' = [row EXCEPT !.due = FALSE, !.failing = TRUE]
            /\ UNCHANGED <<unserved, requests>>
       ELSE IF o = "okWake"
       THEN /\ \E d \in BOOLEAN :
                 row' = [row EXCEPT !.due = FALSE, !.failing = FALSE, !.wake = TRUE,
                                    !.wakeDue = (retained /\ row.wakeDue) \/ d,
                                    !.rev = row.rev + 1]
            /\ unserved' = unserved \cup {row.rev + 1}
            /\ requests' = requests + 1
       ELSE /\ row' = [row EXCEPT !.due = FALSE, !.failing = FALSE,
                                  !.wake = IF consume THEN retained ELSE row.wake,
                                  !.wakeDue = IF consume THEN retained /\ row.wakeDue
                                              ELSE row.wakeDue]
            /\ UNCHANGED <<unserved, requests>>
    /\ MarkDirty
    /\ pc' = [pc EXCEPT ![r] = "release"]
    /\ UNCHANGED <<snap, outcome, activeTick, inSet, deferred, starts, pauses>>

(* finally: executingTasks.delete(id); the run returns. *)
Release(r) ==
    /\ pc[r] = "release"
    /\ inSet' = FALSE
    /\ End(r, TRUE)
    /\ UNCHANGED <<row, outcome, unseen, starts, unserved, requests, pauses>>

(* Time passes: the interval elapses, or a requested wakeAt is reached. *)
Elapse ==
    /\ Repeat /\ row.exists /\ ~row.due
    /\ row' = [row EXCEPT !.due = TRUE]
    /\ UNCHANGED <<snap, pc, outcome, activeTick, inSet, armed, deferred, unseen,
                   starts, unserved, requests, pauses>>

WakeElapse ==
    /\ Repeat /\ row.wake /\ ~row.wakeDue
    /\ row' = [row EXCEPT !.wakeDue = TRUE]
    /\ UNCHANGED <<snap, pc, outcome, activeTick, inSet, armed, deferred, unseen,
                   starts, unserved, requests, pauses>>

(* patchTaskMetadata({wake: {requestAt}}) for a future time. *)
Request ==
    /\ Repeat /\ row.exists /\ requests < MaxRequests
    /\ row' = [row EXCEPT !.wake = TRUE, !.wakeDue = row.wake /\ row.wakeDue,
                          !.rev = row.rev + 1]
    /\ unserved' = unserved \cup {row.rev + 1}
    /\ requests' = requests + 1
    /\ MarkDirty
    /\ UNCHANGED <<snap, pc, outcome, activeTick, inSet, deferred, starts, pauses>>

(* pauseTask / resumeTask: a key-level patch of metadata.paused. *)
TogglePause ==
    /\ row.exists /\ pauses < MaxPauses
    /\ row' = [row EXCEPT !.paused = ~row.paused]
    /\ pauses' = pauses + 1
    /\ MarkDirty
    /\ UNCHANGED <<snap, pc, outcome, activeTick, inSet, deferred, starts, unserved,
                   requests>>

Finished == \A r \in Runners \ Timers : pc[r] = "done"

RunnerStep(r) == Read(r) \/ Select(r) \/ Recheck(r) \/ Work(r) \/ Write(r) \/ Release(r)

Next ==
    \/ \E r \in Runners : Begin(r) \/ RunnerStep(r)
    \/ Elapse \/ WakeElapse \/ Request \/ TogglePause
    \/ (Finished /\ UNCHANGED vars)

Fairness ==
    /\ \A r \in Runners : WF_vars(RunnerStep(r))
    /\ \A r \in Timers \cup DaemonRunners \cup ByIdRunners : WF_vars(Begin(r))
    /\ \A r \in DueRunners : SF_vars(Begin(r))
    /\ WF_vars(Elapse) /\ WF_vars(WakeElapse)

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* A one-shot's worker runs at most once, not counting runs that      *)
(* returned preserveTask.                                              *)
OneShotAtMostOnce == ~Repeat => starts <= 1

(* A one-shot's row is deleted only by a run whose worker ran. *)
OneShotDeletedAfterRun == ~Repeat /\ ~row.exists => starts = 1

(* A blocking task never runs while another run of it is in progress. *)
BlockingNoOverlap == Guarded => Cardinality(Executing) <= 1

(* While a blocking run is in progress its id is in executingTasks. *)
ClaimHeld == Guarded /\ Executing # {} => inSet

(* A wake revision no run has observed is still stored in wakeAt. *)
NoLostWake == Repeat /\ unserved # {} => row.wake

(* A scheduled run never starts from a snapshot that shows the pause. *)
PausedNotSelected ==
    \A r \in Scheduled : pc[r] \in {"recheck", "exec", "write", "release"} =>
        ~snap[r].paused

(* A task write is read by a later tick, or the timer is armed for one. *)
DirtyArmed ==
    Mode = "local" /\ unseen => armed \/ deferred \/ pc[Tm] = "read"

---------------------------------------------------------------------------
(* Liveness *)

(* Every runDueTasks, daemon and executeTaskById run returns. *)
RunnerFinishes == \A r \in Runners \ Timers : pc[r] # "idle" ~> pc[r] = "done"

(* With the local timer, every task write is read by a later tick. *)
WriteSeen == Mode = "local" => (unseen ~> ~unseen)

(* With the local timer, a requested wake is served unless the task is paused. *)
WakeServed == Mode = "local" /\ Repeat =>
    \A k \in 1..MaxRev : (k \in unserved) ~> (k \notin unserved \/ row.paused)
=============================================================================
