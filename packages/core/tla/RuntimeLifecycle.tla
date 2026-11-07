---------------------------- MODULE RuntimeLifecycle ----------------------------
(***************************************************************************)
(* Runtime initialize / stop / strict stop, with the turns and the eager     *)
(* service start that take part in it.                                      *)
(*                                                                         *)
(* src/runtime.ts: initialize, _initializeCore (initResolver), stop,         *)
(*   _stopAndDrain (strict, requireQuiescence), _stopBestEffort (single-     *)
(*   flight stopPromise, stopRequested, prepareStop), _stopAfterAdmissionCordon *)
(*   (closeAdmissions, turn abort, bounded fast room drain), _stopServices,  *)
(*   getLifecycleState.                                                     *)
(* src/runtime/service-lifecycle.ts: _ensureServiceStarted after             *)
(*   `await initPromise`, runServiceStart's stop re-check.                  *)
(* src/runtime/room-handler-queue.ts: runWith admission and FIFO grant.      *)
(* src/runtime/turn-controller.ts: runWith (fresh controller), abortAllTurns. *)
(*                                                                         *)
(* A turn takes the room lease, then (after RUN_STARTED and other awaits in  *)
(* the message service) enters turnControllers.runWith, which creates its   *)
(* AbortController.                                                         *)
(*                                                                         *)
(* This models the code WITH the fixes from the TLA+ review applied:        *)
(*   - runtime stop closes the turn registry (closeTurns) instead of only    *)
(*     aborting the turns active at that instant, so a turn that enters      *)
(*     runWith later starts aborted;                                        *)
(*   - _ensureServiceStarted returns null after initPromise when the        *)
(*     initialization failed.                                               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Turns,        \* inbound turns for one room
    Stoppers,     \* concurrent stop() callers, each fast or not, strict or not
    MaxAttempts,  \* bound on best-effort stop attempts
    None

Attempts == 1..MaxAttempts

VARIABLES
    ipc, initResolved, initFailed,
    svc, svcLate,
    queue, owner, tpc, aborted,
    stopReq, stopped, stopPromise, prepareCalls, closed, turnsClosed, failures,
    apc, aid, afast, outcome,
    spc, sfast, sstrict, sjoined, strictP

vars == <<ipc, initResolved, initFailed, svc, svcLate, queue, owner, tpc, aborted,
          stopReq, stopped, stopPromise, prepareCalls, closed, turnsClosed, failures,
          apc, aid, afast, outcome, spc, sfast, sstrict, sjoined, strictP>>

initVars == <<ipc, initResolved, initFailed>>
svcVars == <<svc, svcLate>>
turnVars == <<queue, owner, tpc, aborted>>
stopVars == <<stopReq, stopped, stopPromise, prepareCalls, closed, turnsClosed, failures>>
attVars == <<apc, aid, afast, outcome>>
callVars == <<spc, sfast, sstrict, sjoined, strictP>>

Pending == {t \in Turns : tpc[t] \in {"queued", "lease", "turn"}}

Init ==
    /\ ipc = "idle" /\ initResolved = FALSE /\ initFailed = FALSE
    /\ svc = "none" /\ svcLate = FALSE
    /\ queue = <<>> /\ owner = None
    /\ tpc = [t \in Turns |-> "idle"]
    /\ aborted = [t \in Turns |-> FALSE]
    /\ stopReq = FALSE /\ stopped = FALSE /\ stopPromise = FALSE
    /\ prepareCalls = 0 /\ closed = FALSE /\ turnsClosed = FALSE /\ failures = FALSE
    /\ apc = "none" /\ aid = 0 /\ afast = FALSE
    /\ outcome = [a \in Attempts |-> "pending"]
    /\ spc = [s \in Stoppers |-> "idle"]
    /\ sfast = [s \in Stoppers |-> FALSE]
    /\ sstrict = [s \in Stoppers |-> FALSE]
    /\ sjoined = [s \in Stoppers |-> 0]
    /\ strictP = "none"

---------------------------------------------------------------------------
(* initialize(): plugin registration fires the eager start, which awaits    *)
(* initPromise; _initializeCore then succeeds or throws, and both paths      *)
(* resolve initPromise.                                                     *)

IRegister ==
    /\ ipc = "idle"
    /\ IF stopReq
       THEN /\ ipc' = "failed" /\ initResolved' = TRUE /\ initFailed' = TRUE
            /\ UNCHANGED svcVars
       ELSE /\ ipc' = "core" /\ svc' = "waitInit"
            /\ UNCHANGED <<initResolved, initFailed, svcLate>>
    /\ UNCHANGED <<turnVars, stopVars, attVars, callVars>>

ICore ==
    /\ ipc = "core"
    /\ \E ok \in BOOLEAN :
        /\ ipc' = IF ok THEN "ok" ELSE "failed"
        /\ initFailed' = ~ok
    /\ initResolved' = TRUE
    /\ UNCHANGED <<svcVars, turnVars, stopVars, attVars, callVars>>

(* _ensureServiceStarted after `await initPromise`, then runServiceStart. *)
SvcResume ==
    /\ svc = "waitInit"
    /\ initResolved
    /\ svc' = IF stopReq \/ initFailed THEN "skipped" ELSE "starting"
    /\ UNCHANGED <<svcLate, initVars, turnVars, stopVars, attVars, callVars>>

(* start() resolves; a start that resolves after stop is stopped, unpublished. *)
SvcStarted ==
    /\ svc = "starting"
    /\ IF stopped \/ stopReq
       THEN svc' = "stopping" /\ svcLate' = TRUE
       ELSE svc' = "live" /\ UNCHANGED svcLate
    /\ UNCHANGED <<initVars, turnVars, stopVars, attVars, callVars>>

SvcStopDone ==
    /\ svc = "stopping"
    /\ svc' = "stopped"
    /\ UNCHANGED <<svcLate, initVars, turnVars, stopVars, attVars, callVars>>

---------------------------------------------------------------------------
(* One room. A turn is admitted to the room queue, is granted the lease,    *)
(* then (after RUN_STARTED and other awaits) enters turnControllers.runWith. *)

TAdmit(t) ==
    /\ tpc[t] = "idle"
    /\ IF closed
       THEN tpc' = [tpc EXCEPT ![t] = "refused"] /\ UNCHANGED queue
       ELSE /\ queue' = Append(queue, t)
            /\ tpc' = [tpc EXCEPT ![t] = "queued"]
    /\ UNCHANGED <<owner, aborted, initVars, svcVars, stopVars, attVars, callVars>>

TGrant ==
    /\ owner = None
    /\ queue # <<>>
    /\ owner' = Head(queue)
    /\ queue' = Tail(queue)
    /\ tpc' = [tpc EXCEPT ![Head(queue)] = "lease"]
    /\ UNCHANGED <<aborted, initVars, svcVars, stopVars, attVars, callVars>>

(* runWith creates a fresh AbortController for the turn. *)
TRun(t) ==
    /\ tpc[t] = "lease"
    /\ tpc' = [tpc EXCEPT ![t] = "turn"]
    /\ aborted' = [aborted EXCEPT ![t] = turnsClosed]
    /\ UNCHANGED <<queue, owner, initVars, svcVars, stopVars, attVars, callVars>>

TFinish(t) ==
    /\ tpc[t] = "turn"
    /\ tpc' = [tpc EXCEPT ![t] = "done"]
    /\ owner' = None
    /\ UNCHANGED <<queue, aborted, initVars, svcVars, stopVars, attVars, callVars>>

---------------------------------------------------------------------------
(* stop(): _stopBestEffort publishes one attempt; the first request sets    *)
(* stopRequested and calls prepareStop; _stopAfterAdmissionCordon closes    *)
(* admissions and aborts every turn before its first await.                 *)

BeginAttempt(s) ==
    /\ stopPromise' = TRUE
    /\ aid' = aid + 1
    /\ afast' = sfast'[s]
    /\ apc' = "drain"
    /\ sjoined' = [sjoined EXCEPT ![s] = aid + 1]
    /\ prepareCalls' = IF stopReq THEN prepareCalls ELSE prepareCalls + 1
    /\ stopReq' = TRUE
    /\ closed' = TRUE
    /\ turnsClosed' = TRUE
    /\ aborted' = [t \in Turns |-> aborted[t] \/ tpc[t] = "turn"]

(* _stopBestEffort entry: join, return if stopped, or begin an attempt. *)
EnterBestEffort(s) ==
    IF stopPromise
    THEN /\ sjoined' = [sjoined EXCEPT ![s] = aid]
         /\ spc' = [spc EXCEPT ![s] = "be"]
         /\ UNCHANGED <<stopVars, attVars, aborted>>
    ELSE IF stopped
    THEN /\ spc' = [spc EXCEPT ![s] = IF sstrict'[s] THEN "drain" ELSE "done"]
         /\ UNCHANGED <<stopVars, attVars, aborted, sjoined>>
    ELSE /\ BeginAttempt(s)
         /\ spc' = [spc EXCEPT ![s] = "be"]
         /\ UNCHANGED <<stopped, failures>>
         /\ outcome' = outcome

SCall(s) ==
    /\ spc[s] = "idle"
    /\ (aid < MaxAttempts \/ stopPromise \/ stopped)
    /\ \E fast \in BOOLEAN, strict \in BOOLEAN :
        /\ sfast' = [sfast EXCEPT ![s] = fast]
        /\ sstrict' = [sstrict EXCEPT ![s] = strict]
        /\ IF strict /\ strictP # "none"
           THEN /\ spc' = [spc EXCEPT ![s] = "awaitStrict"]
                /\ UNCHANGED <<stopVars, attVars, aborted, sjoined, strictP>>
           ELSE /\ strictP' = IF strict THEN "running" ELSE strictP
                /\ EnterBestEffort(s)
    /\ UNCHANGED <<initVars, svcVars, queue, owner, tpc>>

(* quiesceAll settles; post-delivery and diagnostics drains follow. *)
ADrained ==
    /\ apc = "drain"
    /\ Pending = {}
    /\ apc' = "services"
    /\ UNCHANGED <<aid, afast, outcome, initVars, svcVars, turnVars, stopVars, callVars>>

(* Fast mode: the bounded room drain times out and the attempt throws. *)
ATimeout ==
    /\ apc = "drain"
    /\ afast
    /\ Pending # {}
    /\ apc' = "none"
    /\ outcome' = [outcome EXCEPT ![aid] = "err"]
    /\ failures' = TRUE
    /\ stopPromise' = FALSE
    /\ UNCHANGED <<aid, afast, initVars, svcVars, turnVars, stopReq, stopped,
                   prepareCalls, closed, turnsClosed, callVars>>

(* _stopServices: stopped = true, then stop each published instance. An     *)
(* in-flight start is waited for only up to a timeout, so it may still run.  *)
AServices ==
    /\ apc = "services"
    /\ stopped' = TRUE
    /\ svc' = IF svc = "live" THEN "stopping" ELSE svc
    /\ apc' = "svcwait"
    /\ UNCHANGED <<svcLate, aid, afast, outcome, initVars, turnVars, stopReq, stopPromise,
                   prepareCalls, closed, turnsClosed, failures, callVars>>

(* A strict attempt awaits each published service's stop(). A fast one    *)
(* waits for them only up to the service-stop timeout                     *)
(* (settleBeforeTimeout), so its stop() may still run when it resolves.    *)
ASvcDone ==
    /\ apc = "svcwait"
    /\ (svc # "stopping" \/ svcLate \/ afast)
    /\ apc' = "none"
    /\ outcome' = [outcome EXCEPT ![aid] = "ok"]
    /\ stopPromise' = FALSE
    /\ UNCHANGED <<aid, afast, initVars, svcVars, turnVars, stopReq, stopped,
                   prepareCalls, closed, turnsClosed, failures, callVars>>

(* A best-effort caller resumes with the result of the attempt it joined. *)
SBestEffortDone(s) ==
    /\ spc[s] = "be"
    /\ outcome[sjoined[s]] # "pending"
    /\ IF outcome[sjoined[s]] = "err"
       THEN /\ spc' = [spc EXCEPT ![s] = "done"]
            /\ strictP' = IF sstrict[s] THEN "err" ELSE strictP
       ELSE /\ spc' = [spc EXCEPT ![s] = IF sstrict[s] THEN "drain" ELSE "done"]
            /\ UNCHANGED strictP
    /\ UNCHANGED <<sfast, sstrict, sjoined, initVars, svcVars, turnVars, stopVars, attVars>>

(* _stopAndDrain: quiesceAll, drainPostDeliveryTasks and retirement.drain   *)
(* repeat until nothing is pending; recorded failures reject the drain.     *)
SStrictDrain(s) ==
    /\ spc[s] = "drain"
    /\ Pending = {}
    /\ svc \notin {"starting", "stopping"}
    /\ spc' = [spc EXCEPT ![s] = "done"]
    /\ strictP' = IF failures THEN "err" ELSE "ok"
    /\ UNCHANGED <<sfast, sstrict, sjoined, initVars, svcVars, turnVars, stopVars, attVars>>

SAwaitStrict(s) ==
    /\ spc[s] = "awaitStrict"
    /\ strictP \in {"ok", "err"}
    /\ spc' = [spc EXCEPT ![s] = "done"]
    /\ UNCHANGED <<sfast, sstrict, sjoined, strictP, initVars, svcVars, turnVars,
                   stopVars, attVars>>

Finished ==
    /\ ipc \in {"idle", "ok", "failed"}
    /\ svc \notin {"waitInit", "starting", "stopping"}
    /\ Pending = {}
    /\ apc = "none"
    /\ \A s \in Stoppers : spc[s] \in {"idle", "done"}

Next ==
    \/ IRegister \/ ICore \/ SvcResume \/ SvcStarted \/ SvcStopDone
    \/ \E t \in Turns : TAdmit(t) \/ TRun(t) \/ TFinish(t)
    \/ TGrant
    \/ \E s \in Stoppers : SCall(s) \/ SBestEffortDone(s) \/ SStrictDrain(s) \/ SAwaitStrict(s)
    \/ ADrained \/ ATimeout \/ AServices \/ ASvcDone
    \/ (Finished /\ UNCHANGED vars)

Fairness ==
    /\ WF_vars(ICore) /\ WF_vars(SvcResume) /\ WF_vars(SvcStarted) /\ WF_vars(SvcStopDone)
    /\ WF_vars(TGrant)
    /\ \A t \in Turns : WF_vars(TRun(t)) /\ WF_vars(TFinish(t))
    /\ WF_vars(ADrained) /\ WF_vars(AServices) /\ WF_vars(ASvcDone)
    /\ \A s \in Stoppers : WF_vars(SBestEffortDone(s)) /\ WF_vars(SStrictDrain(s))
                           /\ WF_vars(SAwaitStrict(s))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
LifecycleState ==
    IF stopReq THEN IF stopped /\ ~stopPromise THEN "stopped" ELSE "stopping"
    ELSE IF initFailed THEN "failed"
    ELSE IF ~initResolved THEN "initializing" ELSE "running"

TypeOK ==
    /\ ipc \in {"idle", "core", "ok", "failed"}
    /\ svc \in {"none", "waitInit", "skipped", "starting", "live", "stopping", "stopped"}
    /\ tpc \in [Turns -> {"idle", "queued", "lease", "turn", "done", "refused"}]
    /\ owner \in Turns \cup {None}
    /\ apc \in {"none", "drain", "services", "svcwait"}
    /\ aid \in 0..MaxAttempts
    /\ outcome \in [Attempts -> {"pending", "ok", "err"}]
    /\ spc \in [Stoppers -> {"idle", "be", "drain", "awaitStrict", "done"}]
    /\ strictP \in {"none", "running", "ok", "err"}

(* prepareStop runs once, at the first stop request. *)
PrepareStopOnce == prepareCalls <= 1 /\ (stopReq => prepareCalls = 1)

(* stopPromise is the single in-flight attempt. *)
SingleAttempt == stopPromise <=> apc # "none"

(* Once stop is requested every turn that runs has an aborted signal. *)
TurnsAbortedAfterStop == \A t \in Turns : tpc[t] = "turn" /\ stopReq => aborted[t]

(* A service never starts against a runtime whose initialization failed. *)
NoStartOnFailedInit == svc \in {"starting", "live"} => ~initFailed

(* A start that resolves after stop never becomes live. *)
NoLiveAfterStopped == stopped => (svc # "live" \/ apc = "services")

(* "stopped" means admissions are closed and no published service is live. *)
(* A published service's stop() may still run only after a fast stop     *)
(* (service-stop timeout); only a strict drain waits for it to settle.    *)
StoppedIsQuiet ==
    LifecycleState = "stopped" =>
        /\ closed
        /\ svc # "live"
        /\ (svc = "stopping" => svcLate \/ afast)

(* A strict stop resolves only when nothing is pending and nothing failed. *)
StrictMeansQuiescent ==
    strictP = "ok" =>
        /\ Pending = {} /\ ~failures
        /\ svc \notin {"starting", "live", "stopping"}

NoAdmissionAfterClose == [][closed => Len(queue') <= Len(queue)]_vars

StopperReturns == \A s \in Stoppers : spc[s] \in {"be", "drain", "awaitStrict"} ~> spc[s] = "done"
TurnsFinish == \A t \in Turns : tpc[t] \in {"queued", "lease", "turn"} ~> tpc[t] = "done"
EagerStartSettles == svc = "waitInit" ~> svc \in {"skipped", "live", "stopped"}
=============================================================================
