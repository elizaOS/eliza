---------------------------- MODULE RoomHandlerQueue ----------------------------
(***************************************************************************)
(* src/runtime/room-handler-queue.ts: RoomHandlerQueue.                    *)
(*                                                                         *)
(* A turn asks for a set of rooms (withLeases) and takes them one at a     *)
(* time in ascending order. Each room has a FIFO of waiters and at most one*)
(* active owner. Admission is refused when admissions are closed, when the *)
(* room is new and MaxRooms rooms are in use, when MaxTotal items are      *)
(* admitted, or when the room holds MaxPerRoom items. A waiter can cancel  *)
(* only while it waits. A turn that is refused or cancelled releases the   *)
(* rooms it already holds, in reverse order, like the `finally` block of   *)
(* withLeases.                                                             *)
(*                                                                         *)
(* This models the default async-context mode: the owner's callback, and  *)
(* every nested call it makes, runs under ambient ownership of every room  *)
(* the turn holds (withLease, and withLeases since it runs its callback    *)
(* under all of its leases). A nested withLease or withLeases call (Nest)  *)
(* on a held room reuses the live lease; one on any other room is refused  *)
(* with ROOM_HANDLER_CROSS_ROOM_REENTRY, and the error settles the         *)
(* callback. An ambient store whose leases are all released (async work   *)
(* that outlived its turn) counts as no ownership: such work starts a new  *)
(* turn. With asyncContext "explicit" (ownershipStorage = null) there is   *)
(* no ambient ownership; a nested call is a Nest only when the caller      *)
(* passes options.lease, and one that omits it is a new turn.              *)
(*                                                                         *)
(* Each lease admits its own writes (withLeaseWrite; withLeaseWrites is    *)
(* one per-room write per lease) while it accepts them, and the owner's    *)
(* callback and its detached work may write until that lease stops. When   *)
(* the callback settles, the `finally` of withLeases calls release() one   *)
(* lease at a time, newest first: release() stops that lease's writes      *)
(* (accepting := false), waits for its writerTail, and frees its room.     *)
(* The other leases keep accepting writes in the meantime.                 *)
(*                                                                         *)
(* Modeled: runWith (admission checks, enqueue), RoomQueue.enqueue, drain  *)
(* and the abort listener, acquire, the lease's release(), withLease,      *)
(* withLeases, withLeaseWrite, runInLease, closeAdmissions.                *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Turns, NumRooms, MaxPerRoom, MaxTotal, MaxRooms, MaxWrites, None

Rooms == 1..NumRooms

VARIABLES
    queue,   \* queue[r]: the waiters of room r, oldest first
    active,  \* active[r]: the turn that owns room r, or None
    want,    \* want[t]: the rooms turn t asked for
    held,    \* held[t]: the rooms turn t owns
    pc,      \* pc[t]: where turn t is
    accepting, \* accepting[t]: the rooms whose lease of turn t admits writes
    writes,  \* writes[t][r]: admitted writes on turn t's lease of room r
    closed   \* closeAdmissions() was called

vars == <<queue, active, want, held, pc, accepting, writes, closed>>

States == {"idle", "acquiring", "waiting", "owner", "releasing", "unwinding",
           "done", "refused", "cancelled"}

Pending(r) == Len(queue[r]) + (IF active[r] = None THEN 0 ELSE 1)
InUse == {r \in Rooms : Pending(r) > 0}
Total == LET Sum[S \in SUBSET Rooms] ==
                IF S = {} THEN 0
                ELSE LET r == CHOOSE x \in S : TRUE IN Pending(r) + Sum[S \ {r}]
         IN Sum[Rooms]
Min(S) == CHOOSE x \in S : \A y \in S : x <= y
Max(S) == CHOOSE x \in S : \A y \in S : x >= y
Waits(t, r) == \E i \in 1..Len(queue[r]) : queue[r][i] = t
Remove(s, t) == SelectSeq(s, LAMBDA x : x # t)

TypeOK ==
    /\ queue \in [Rooms -> Seq(Turns)]
    /\ active \in [Rooms -> Turns \cup {None}]
    /\ want \in [Turns -> SUBSET Rooms]
    /\ held \in [Turns -> SUBSET Rooms]
    /\ pc \in [Turns -> States]
    /\ accepting \in [Turns -> SUBSET Rooms]
    /\ writes \in [Turns -> [Rooms -> 0..MaxWrites]]
    /\ closed \in BOOLEAN

Init ==
    /\ queue = [r \in Rooms |-> <<>>]
    /\ active = [r \in Rooms |-> None]
    /\ want = [t \in Turns |-> {}]
    /\ held = [t \in Turns |-> {}]
    /\ pc = [t \in Turns |-> "idle"]
    /\ accepting = [t \in Turns |-> {}]
    /\ writes = [t \in Turns |-> [r \in Rooms |-> 0]]
    /\ closed = FALSE

(* withLeases(roomIds): an empty set returns at once, so W is not empty. *)
Start(t, W) ==
    /\ pc[t] = "idle"
    /\ W # {}
    /\ want' = [want EXCEPT ![t] = W]
    /\ pc' = [pc EXCEPT ![t] = "acquiring"]
    /\ UNCHANGED <<queue, active, held, accepting, writes, closed>>

(* runQueued: the checks and the push run in one synchronous step. *)
Admit(t) ==
    LET r == Min(want[t] \ held[t]) IN
    /\ pc[t] = "acquiring"
    /\ IF \/ closed
          \/ (r \notin InUse /\ Cardinality(InUse) >= MaxRooms)
          \/ Total >= MaxTotal
          \/ Pending(r) >= MaxPerRoom
       THEN /\ pc' = [pc EXCEPT ![t] = IF held[t] = {} THEN "refused" ELSE "unwinding"]
            /\ UNCHANGED queue
       ELSE /\ queue' = [queue EXCEPT ![r] = Append(@, t)]
            /\ pc' = [pc EXCEPT ![t] = "waiting"]
    /\ UNCHANGED <<active, want, held, accepting, writes, closed>>

(* RoomQueue.drain: the head of an idle room becomes its owner, and       *)
(* acquire() returns a lease that accepts writes.                        *)
Grant(r) ==
    /\ active[r] = None
    /\ queue[r] # <<>>
    /\ LET t == Head(queue[r]) IN
       /\ active' = [active EXCEPT ![r] = t]
       /\ queue' = [queue EXCEPT ![r] = Tail(@)]
       /\ held' = [held EXCEPT ![t] = @ \cup {r}]
       /\ accepting' = [accepting EXCEPT ![t] = @ \cup {r}]
       /\ pc' = [pc EXCEPT ![t] =
                    IF held[t] \cup {r} = want[t] THEN "owner" ELSE "acquiring"]
    /\ UNCHANGED <<want, writes, closed>>

(* The abort listener: only a queued waiter can cancel. *)
Cancel(t) ==
    /\ pc[t] = "waiting"
    /\ \E r \in Rooms :
        /\ Waits(t, r)
        /\ queue' = [queue EXCEPT ![r] = Remove(@, t)]
    /\ pc' = [pc EXCEPT ![t] = IF held[t] = {} THEN "cancelled" ELSE "unwinding"]
    /\ UNCHANGED <<active, want, held, accepting, writes, closed>>

(* A nested withLease/withLeases call inside the owner's callback, found  *)
(* through ambient ownership (default mode) or options.lease (explicit     *)
(* mode, where the caller must pass it): a held room reuses the lease and  *)
(* changes nothing, so it is not a step; another room throws, and the      *)
(* callback settles (rejected) like StartRelease.                          *)
Nest(t, r) ==
    /\ pc[t] = "owner"
    /\ r \notin held[t]
    /\ pc' = [pc EXCEPT ![t] = "releasing"]
    /\ UNCHANGED <<queue, active, want, held, accepting, writes, closed>>

(* withLeaseWrite: only a live, accepting lease admits a write. The       *)
(* callback writes while it runs; its detached work may still write after *)
(* it settles. A turn whose acquisition failed never ran its callback.    *)
BeginWrite(t, r) ==
    /\ pc[t] \in {"owner", "releasing"}
    /\ r \in accepting[t]
    /\ writes[t][r] < MaxWrites
    /\ writes' = [writes EXCEPT ![t][r] = @ + 1]
    /\ UNCHANGED <<queue, active, want, held, pc, accepting, closed>>

(* The write settles and writerTail moves past it. *)
EndWrite(t, r) ==
    /\ writes[t][r] > 0
    /\ writes' = [writes EXCEPT ![t][r] = @ - 1]
    /\ UNCHANGED <<queue, active, want, held, pc, accepting, closed>>

(* The owner's callback returns; the `finally` of withLeases starts. *)
StartRelease(t) ==
    /\ pc[t] = "owner"
    /\ pc' = [pc EXCEPT ![t] = "releasing"]
    /\ UNCHANGED <<queue, active, want, held, accepting, writes, closed>>

(* The `finally` calls release() on the newest lease it holds: its        *)
(* synchronous part sets accepting := false for that lease only.          *)
StopWrites(t) ==
    /\ pc[t] \in {"releasing", "unwinding"}
    /\ held[t] # {}
    /\ LET r == Max(held[t]) IN
       /\ r \in accepting[t]
       /\ accepting' = [accepting EXCEPT ![t] = @ \ {r}]
    /\ UNCHANGED <<queue, active, want, held, pc, writes, closed>>

(* After that lease's writerTail settles, its room is freed. The loop     *)
(* then awaits the freed turn before it stops the next lease.             *)
Release(t) ==
    /\ pc[t] \in {"releasing", "unwinding"}
    /\ held[t] # {}
    /\ LET r == Max(held[t]) IN
       /\ r \notin accepting[t]
       /\ writes[t][r] = 0
       /\ active' = [active EXCEPT ![r] = None]
       /\ held' = [held EXCEPT ![t] = @ \ {r}]
       /\ pc' = [pc EXCEPT ![t] =
                    IF held[t] = {r}
                    THEN IF pc[t] = "releasing" THEN "done" ELSE "refused"
                    ELSE pc[t]]
    /\ UNCHANGED <<queue, want, accepting, writes, closed>>

Close ==
    /\ ~closed
    /\ closed' = TRUE
    /\ UNCHANGED <<queue, active, want, held, pc, accepting, writes>>

Finished == \A t \in Turns : pc[t] \in {"done", "refused", "cancelled"}

Next ==
    \/ \E t \in Turns, W \in SUBSET Rooms : Start(t, W)
    \/ \E t \in Turns : \/ Admit(t) \/ Cancel(t) \/ StartRelease(t)
                        \/ StopWrites(t) \/ Release(t)
    \/ \E t \in Turns, r \in Rooms : \/ Nest(t, r)
                                    \/ BeginWrite(t, r) \/ EndWrite(t, r)
    \/ \E r \in Rooms : Grant(r)
    \/ Close
    \/ (Finished /\ closed /\ UNCHANGED vars)

Fairness ==
    /\ \A r \in Rooms : WF_vars(Grant(r))
    /\ \A t \in Turns : /\ WF_vars(Admit(t)) /\ WF_vars(StartRelease(t))
                        /\ WF_vars(StopWrites(t)) /\ WF_vars(Release(t))
    /\ \A t \in Turns, r \in Rooms : WF_vars(EndWrite(t, r))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* One owner per room, and the owner is the one that holds it. *)
MutualExclusion ==
    /\ \A r \in Rooms : active[r] # None => r \in held[active[r]]
    /\ \A t \in Turns : \A r \in held[t] : active[r] = t

(* A turn waits in exactly one queue, and only while its pc says so. *)
WaitersQueued ==
    \A t \in Turns :
        /\ (pc[t] = "waiting") <=> (\E r \in Rooms : Waits(t, r))
        /\ \A r \in Rooms : Len(SelectSeq(queue[r], LAMBDA x : x = t)) <= 1

(* Rooms are taken in ascending order: everything held is below what is next. *)
OrderedAcquisition ==
    \A t \in Turns : pc[t] \in {"acquiring", "waiting"} =>
        \A h \in held[t] : h < Min(want[t] \ held[t])

Bounded ==
    /\ \A r \in Rooms : Pending(r) <= MaxPerRoom
    /\ Total <= MaxTotal
    /\ Cardinality(InUse) <= MaxRooms

(* A lease accepts writes only while it owns its room, a write runs only  *)
(* under the lease of its own room, and a finished turn has no write.     *)
WritesUnderLease ==
    \A t \in Turns :
        /\ accepting[t] \subseteq held[t]
        /\ \A r \in Rooms : writes[t][r] > 0 => r \in held[t]
        /\ pc[t] \in {"done", "refused", "cancelled", "idle"} =>
               \A r \in Rooms : writes[t][r] = 0

(* A finished turn holds nothing and waits nowhere. *)
NoLeakedOwnership ==
    \A t \in Turns : pc[t] \in {"done", "refused", "cancelled"} =>
        /\ held[t] = {}
        /\ \A r \in Rooms : ~Waits(t, r)

(* After closeAdmissions() no queue grows. *)
NoAdmissionAfterClose ==
    [][closed => \A r \in Rooms : Len(queue'[r]) <= Len(queue[r])]_vars

(* Only the owner's release frees a room, and only once that room's lease *)
(* stopped admitting writes and its writes ended.                         *)
FreedByOwner ==
    [][\A r \in Rooms : active[r] # None /\ active'[r] # active[r] =>
           /\ pc[active[r]] \in {"releasing", "unwinding"}
           /\ r \notin accepting[active[r]]
           /\ writes[active[r]][r] = 0]_vars

---------------------------------------------------------------------------
(* Liveness: ordered acquisition cannot deadlock, so every waiter is served *)
(* or cancels, and every started turn finishes.                            *)

WaiterServed == \A t \in Turns : pc[t] = "waiting" ~> pc[t] # "waiting"
TurnFinishes == \A t \in Turns : pc[t] = "acquiring" ~>
                    pc[t] \in {"done", "refused", "cancelled"}
=============================================================================
