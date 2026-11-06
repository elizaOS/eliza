---------------------------- MODULE RoomHandlerQueue ----------------------------
(***************************************************************************)
(* src/runtime/room-handler-queue.ts: RoomHandlerQueue.                     *)
(*                                                                         *)
(* A turn asks for a set of rooms (withLeases) and takes them one at a      *)
(* time in ascending order. Each room has a FIFO of waiters and at most one *)
(* active owner. Admission is refused when admissions are closed, when the  *)
(* room is new and MaxRooms rooms are in use, when MaxTotal items are       *)
(* admitted, or when the room holds MaxPerRoom items. A waiter can cancel   *)
(* only while it waits. A turn that is refused or cancelled releases the    *)
(* rooms it already holds, in reverse order, like the `finally` block of    *)
(* withLeases.                                                             *)
(*                                                                         *)
(* An owner may call withLease or withLeases again (Nest). A room it holds  *)
(* reuses the live lease; any other room is refused with                   *)
(* ROOM_HANDLER_CROSS_ROOM_REENTRY, and the error unwinds the turn. An      *)
(* owner may run lease writes (withLeaseWrite). release() first stops new   *)
(* writes, then waits for the running writes, then frees the rooms.         *)
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
    writes,  \* writes[t]: lease writes of turn t that are running
    closed   \* closeAdmissions() was called

vars == <<queue, active, want, held, pc, writes, closed>>

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
    /\ writes \in [Turns -> 0..MaxWrites]
    /\ closed \in BOOLEAN

Init ==
    /\ queue = [r \in Rooms |-> <<>>]
    /\ active = [r \in Rooms |-> None]
    /\ want = [t \in Turns |-> {}]
    /\ held = [t \in Turns |-> {}]
    /\ pc = [t \in Turns |-> "idle"]
    /\ writes = [t \in Turns |-> 0]
    /\ closed = FALSE

(* withLeases(roomIds): an empty set returns at once, so W is not empty. *)
Start(t, W) ==
    /\ pc[t] = "idle"
    /\ W # {}
    /\ want' = [want EXCEPT ![t] = W]
    /\ pc' = [pc EXCEPT ![t] = "acquiring"]
    /\ UNCHANGED <<queue, active, held, writes, closed>>

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
    /\ UNCHANGED <<active, want, held, writes, closed>>

(* RoomQueue.drain: the head of an idle room becomes its owner. *)
Grant(r) ==
    /\ active[r] = None
    /\ queue[r] # <<>>
    /\ LET t == Head(queue[r]) IN
       /\ active' = [active EXCEPT ![r] = t]
       /\ queue' = [queue EXCEPT ![r] = Tail(@)]
       /\ held' = [held EXCEPT ![t] = @ \cup {r}]
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
    /\ UNCHANGED <<active, want, held, writes, closed>>

(* A nested withLease/withLeases call inside the owner's callback: a held  *)
(* room reuses the lease and changes nothing; another room throws, and the *)
(* error unwinds the turn.                                                  *)
Nest(t, r) ==
    /\ pc[t] = "owner"
    /\ r \notin held[t]
    /\ writes[t] = 0
    /\ pc' = [pc EXCEPT ![t] = "unwinding"]
    /\ UNCHANGED <<queue, active, want, held, writes, closed>>

(* withLeaseWrite: only a live lease admits a write. *)
BeginWrite(t) ==
    /\ pc[t] = "owner"
    /\ writes[t] < MaxWrites
    /\ writes' = [writes EXCEPT ![t] = @ + 1]
    /\ UNCHANGED <<queue, active, want, held, pc, closed>>

EndWrite(t) ==
    /\ writes[t] > 0
    /\ writes' = [writes EXCEPT ![t] = @ - 1]
    /\ UNCHANGED <<queue, active, want, held, pc, closed>>

(* release(): accepting := false. *)
StartRelease(t) ==
    /\ pc[t] = "owner"
    /\ pc' = [pc EXCEPT ![t] = "releasing"]
    /\ UNCHANGED <<queue, active, want, held, writes, closed>>

(* After writerTail settles, the rooms are freed, newest first. *)
Release(t) ==
    /\ pc[t] \in {"releasing", "unwinding"}
    /\ writes[t] = 0
    /\ held[t] # {}
    /\ LET r == Max(held[t]) IN
       /\ active' = [active EXCEPT ![r] = None]
       /\ held' = [held EXCEPT ![t] = @ \ {r}]
       /\ pc' = [pc EXCEPT ![t] =
                    IF held[t] = {r}
                    THEN IF pc[t] = "releasing" THEN "done" ELSE "refused"
                    ELSE pc[t]]
    /\ UNCHANGED <<queue, want, writes, closed>>

Close ==
    /\ ~closed
    /\ closed' = TRUE
    /\ UNCHANGED <<queue, active, want, held, pc, writes>>

Finished == \A t \in Turns : pc[t] \in {"done", "refused", "cancelled"}

Next ==
    \/ \E t \in Turns, W \in SUBSET Rooms : Start(t, W)
    \/ \E t \in Turns : \/ Admit(t) \/ Cancel(t) \/ BeginWrite(t) \/ EndWrite(t)
                        \/ StartRelease(t) \/ Release(t)
    \/ \E t \in Turns, r \in Rooms : Nest(t, r)
    \/ \E r \in Rooms : Grant(r)
    \/ Close
    \/ (Finished /\ closed /\ UNCHANGED vars)

Fairness ==
    /\ \A r \in Rooms : WF_vars(Grant(r))
    /\ \A t \in Turns : /\ WF_vars(Admit(t)) /\ WF_vars(EndWrite(t))
                        /\ WF_vars(StartRelease(t)) /\ WF_vars(Release(t))

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

(* Writes run only under a lease that still owns its rooms, and a released *)
(* lease has no running write.                                             *)
WritesUnderLease ==
    \A t \in Turns :
        /\ writes[t] > 0 => pc[t] \in {"owner", "releasing", "unwinding"} /\ held[t] # {}
        /\ pc[t] \in {"done", "refused", "cancelled", "idle"} => writes[t] = 0

(* A finished turn holds nothing and waits nowhere. *)
NoLeakedOwnership ==
    \A t \in Turns : pc[t] \in {"done", "refused", "cancelled"} =>
        /\ held[t] = {}
        /\ \A r \in Rooms : ~Waits(t, r)

(* After closeAdmissions() no queue grows. *)
NoAdmissionAfterClose ==
    [][closed => \A r \in Rooms : Len(queue'[r]) <= Len(queue[r])]_vars

(* Only the owner's release frees a room, and only once its writes ended. *)
FreedByOwner ==
    [][\A r \in Rooms : active[r] # None /\ active'[r] # active[r] =>
           pc[active[r]] \in {"releasing", "unwinding"} /\ writes[active[r]] = 0]_vars

---------------------------------------------------------------------------
(* Liveness: ordered acquisition cannot deadlock, so every waiter is served *)
(* or cancels, and every started turn finishes.                            *)

WaiterServed == \A t \in Turns : pc[t] = "waiting" ~> pc[t] # "waiting"
TurnFinishes == \A t \in Turns : pc[t] = "acquiring" ~>
                    pc[t] \in {"done", "refused", "cancelled"}
=============================================================================
