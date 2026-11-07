------------------------------- MODULE Semaphore -------------------------------
(***************************************************************************)
(* src/utils/task-scheduling.ts: Semaphore (acquire, release).              *)
(*                                                                         *)
(* acquire(signal) runs synchronously up to its one await: a caller whose  *)
(* signal is already aborted throws; a free permit is taken at once;       *)
(* otherwise the caller's `admitted` callback joins the FIFO `waiters` and *)
(* an abort listener is attached. release() adds a permit and hands it to  *)
(* the oldest waiter; a waiter whose signal is already aborted (its own    *)
(* listener has not run yet, because an earlier listener on the same       *)
(* abort called release) is rejected and the permit goes to the next one.  *)
(*                                                                         *)
(* Aborting a signal sets `signal.aborted` first and then runs listeners   *)
(* in order, so between the two any other code (an earlier listener's      *)
(* release, another acquire) can run: Abort and CancelListener are two     *)
(* steps. Each caller acquires at most once and a holder releases once.    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Callers, N

VARIABLES
    permits,   \* this.permits
    waiters,   \* this.waiters, oldest first
    pc,        \* pc[c]: idle | waiting | holding | done | rejected
    aborted,   \* aborted[c]: c's signal.aborted
    listener,  \* listener[c]: c's abort listener is due but has not run
    queuedAbort, \* queuedAbort[c]: c's signal aborted while c was queued
    ticket,    \* ticket[c]: position at which c was queued (0 = fast path)
    next       \* next ticket

vars == <<permits, waiters, pc, aborted, listener, queuedAbort, ticket, next>>

Queued(c) == \E i \in 1..Len(waiters) : waiters[i] = c
Remove(s, c) == SelectSeq(s, LAMBDA x : x # c)
Holders == {c \in Callers : pc[c] = "holding"}

TypeOK ==
    /\ permits \in 0..N
    /\ waiters \in Seq(Callers)
    /\ pc \in [Callers -> {"idle", "waiting", "holding", "done", "rejected"}]
    /\ aborted \in [Callers -> BOOLEAN]
    /\ listener \in [Callers -> BOOLEAN]
    /\ queuedAbort \in [Callers -> BOOLEAN]
    /\ ticket \in [Callers -> Nat]
    /\ next \in Nat

Init ==
    /\ permits = N
    /\ waiters = <<>>
    /\ pc = [c \in Callers |-> "idle"]
    /\ aborted = [c \in Callers |-> FALSE]
    /\ listener = [c \in Callers |-> FALSE]
    /\ queuedAbort = [c \in Callers |-> FALSE]
    /\ ticket = [c \in Callers |-> 0]
    /\ next = 1

(* acquire: one synchronous step up to the await. *)
Acquire(c) ==
    /\ pc[c] = "idle"
    /\ IF aborted[c]
       THEN /\ pc' = [pc EXCEPT ![c] = "rejected"]          \* throwIfAborted
            /\ UNCHANGED <<permits, waiters, ticket, next>>
       ELSE IF permits > 0
       THEN /\ permits' = permits - 1
            /\ pc' = [pc EXCEPT ![c] = "holding"]
            /\ UNCHANGED <<waiters, ticket, next>>
       ELSE /\ waiters' = Append(waiters, c)
            /\ pc' = [pc EXCEPT ![c] = "waiting"]
            /\ ticket' = [ticket EXCEPT ![c] = next]
            /\ next' = next + 1
            /\ UNCHANGED permits
    /\ UNCHANGED <<aborted, listener, queuedAbort>>

(* controller.abort(): signal.aborted becomes true; c's listener is due. *)
Abort(c) ==
    /\ ~aborted[c]
    /\ aborted' = [aborted EXCEPT ![c] = TRUE]
    /\ listener' = [listener EXCEPT ![c] = pc[c] = "waiting"]
    /\ queuedAbort' = [queuedAbort EXCEPT ![c] = pc[c] = "waiting"]
    /\ UNCHANGED <<permits, waiters, pc, ticket, next>>

(* acquire's `cancelled` abort listener: a no-op when release already *)
(* shifted c out.                                                      *)
CancelListener(c) ==
    /\ listener[c]
    /\ listener' = [listener EXCEPT ![c] = FALSE]
    /\ IF Queued(c)
       THEN /\ waiters' = Remove(waiters, c)
            /\ pc' = [pc EXCEPT ![c] = "rejected"]
       ELSE UNCHANGED <<waiters, pc>>
    /\ UNCHANGED <<permits, aborted, queuedAbort, ticket, next>>

(* release: the loop skips aborted waiters (each `admitted`               *)
(* call rejects it and removes its listener) and grants the first live one. *)
Skipped(s) == LET F[i \in 0..Len(s)] ==
                    IF i = 0 THEN 0
                    ELSE IF F[i - 1] = i - 1 /\ aborted[s[i]] THEN i ELSE F[i - 1]
              IN F[Len(s)]

Release(c) ==
    /\ pc[c] = "holding"
    /\ LET k == Skipped(waiters)
           dead == {waiters[i] : i \in 1..k}
           rest == SubSeq(waiters, k + 1, Len(waiters))
       IN IF rest = <<>>
          THEN /\ permits' = permits + 1
               /\ waiters' = <<>>
               /\ pc' = [x \in Callers |->
                           IF x = c THEN "done"
                           ELSE IF x \in dead THEN "rejected" ELSE pc[x]]
               /\ listener' = [x \in Callers |-> IF x \in dead THEN FALSE ELSE listener[x]]
          ELSE /\ UNCHANGED permits
               /\ waiters' = Tail(rest)
               /\ pc' = [x \in Callers |->
                           IF x = c THEN "done"
                           ELSE IF x = Head(rest) THEN "holding"
                           ELSE IF x \in dead THEN "rejected" ELSE pc[x]]
               /\ listener' = [x \in Callers |-> IF x \in dead THEN FALSE ELSE listener[x]]
    /\ UNCHANGED <<aborted, queuedAbort, ticket, next>>

Finished == \A c \in Callers : pc[c] \in {"done", "rejected"} /\ ~listener[c]

Next ==
    \/ \E c \in Callers : Acquire(c) \/ Abort(c) \/ CancelListener(c) \/ Release(c)
    \/ (Finished /\ UNCHANGED vars)

(* Holders release and due listeners run; nobody is forced to acquire or abort. *)
Fairness == \A c \in Callers : WF_vars(Release(c)) /\ WF_vars(CancelListener(c))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* Every permit is either available or held: none is lost or duplicated. *)
PermitConservation == permits + Cardinality(Holders) = N

(* A free permit never sits beside a queued waiter (no stranded waiter, no barging). *)
NoIdlePermitWithWaiters == permits > 0 => waiters = <<>>

(* A caller is queued exactly once and only while it waits. *)
WaitersQueued ==
    \A c \in Callers :
        /\ (pc[c] = "waiting") <=> Queued(c)
        /\ Len(SelectSeq(waiters, LAMBDA x : x = c)) <= 1

(* Grants from the queue follow queue order. *)
FIFOGrants ==
    \A w, h \in Callers :
        pc[w] = "waiting" /\ pc[h] \in {"holding", "done"} /\ ticket[h] # 0
            => ticket[h] < ticket[w]

(* A waiter cancelled while queued never holds a permit. *)
CancelledNeverHolds ==
    \A c \in Callers : queuedAbort[c] => pc[c] \notin {"holding", "done"}

---------------------------------------------------------------------------
(* Liveness: every waiter is granted or rejected. *)
WaiterServed == \A c \in Callers : pc[c] = "waiting" ~> pc[c] # "waiting"
=============================================================================
