---------------------------- MODULE SingleFlightMemo ----------------------------
(***************************************************************************)
(* src/runtime/single-flight-memo.ts: SingleFlightMemo (peek, put,          *)
(* invalidate, the rejected-entry eviction), as used by AgentRuntime.getRoom *)
(* and the room messages-scan in getMemories (src/runtime.ts), and the      *)
(* writers that await the adapter and then invalidate the key              *)
(* (createRooms, upsertRooms, updateRooms, deleteRooms, createMemory and    *)
(* the other wrappers in src/runtime/data-mutations.ts).                   *)
(*                                                                         *)
(* One key. A reader's peek and put run in one synchronous step with the   *)
(* creation of the fetch; the fetch reads the store at some later point.   *)
(* A writer commits (the awaited adapter call) and then invalidates. Expire *)
(* covers the TTL, maxEntries eviction and invalidate() of every key. A    *)
(* reader may replace a live entry (the messages-scan does when the cached *)
(* window is smaller than it needs).                                       *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS Readers, Writers

Fetches == 1..Cardinality(Readers)

VARIABLES
    db,        \* the store's version: one increment per committed write
    entry,     \* the memo entry's fetch, or 0
    nfetch,    \* fetches created
    fval,      \* fval[f]: the version f read, or -1 before it reads
    fstate,    \* fstate[f]: pending | resolved | rejected
    rpc,       \* rpc[r]: idle | waiting | served | failed
    rf,        \* rf[r]: the fetch r awaits
    floor,     \* floor[r]: newest write completed when r started
    wpc,       \* wpc[w]: idle | committed | done
    wver,      \* wver[w]: the version w committed
    completed  \* newest version whose writer has invalidated

vars == <<db, entry, nfetch, fval, fstate, rpc, rf, floor, wpc, wver, completed>>

Max(a, b) == IF a > b THEN a ELSE b

TypeOK ==
    /\ db \in Nat
    /\ entry \in Fetches \cup {0}
    /\ nfetch \in 0..Cardinality(Readers)
    /\ fval \in [Fetches -> Nat \cup {-1}]
    /\ fstate \in [Fetches -> {"pending", "resolved", "rejected"}]
    /\ rpc \in [Readers -> {"idle", "waiting", "served", "failed"}]
    /\ rf \in [Readers -> Fetches \cup {0}]
    /\ floor \in [Readers -> Nat]
    /\ wpc \in [Writers -> {"idle", "committed", "done"}]
    /\ wver \in [Writers -> Nat]
    /\ completed \in Nat

Init ==
    /\ db = 0
    /\ entry = 0
    /\ nfetch = 0
    /\ fval = [f \in Fetches |-> -1]
    /\ fstate = [f \in Fetches |-> "pending"]
    /\ rpc = [r \in Readers |-> "idle"]
    /\ rf = [r \in Readers |-> 0]
    /\ floor = [r \in Readers |-> 0]
    /\ wpc = [w \in Writers |-> "idle"]
    /\ wver = [w \in Writers |-> 0]
    /\ completed = 0

Start(r, f) ==
    /\ rpc' = [rpc EXCEPT ![r] = "waiting"]
    /\ rf' = [rf EXCEPT ![r] = f]
    /\ floor' = [floor EXCEPT ![r] = completed]

(* peek hit: share the resident promise. *)
ReadShared(r) ==
    /\ rpc[r] = "idle"
    /\ entry # 0
    /\ Start(r, entry)
    /\ UNCHANGED <<db, entry, nfetch, fval, fstate, wpc, wver, completed>>

(* peek miss (or a too-small window): create the fetch and put it. *)
ReadFetch(r) ==
    /\ rpc[r] = "idle"
    /\ LET f == nfetch + 1 IN
       /\ entry' = f
       /\ nfetch' = f
       /\ Start(r, f)
    /\ UNCHANGED <<db, fval, fstate, wpc, wver, completed>>

(* The adapter query executes against the store. *)
FetchRead(f) ==
    /\ f <= nfetch
    /\ fval[f] = -1
    /\ fval' = [fval EXCEPT ![f] = db]
    /\ UNCHANGED <<db, entry, nfetch, fstate, rpc, rf, floor, wpc, wver, completed>>

FetchResolve(f) ==
    /\ fstate[f] = "pending"
    /\ fval[f] # -1
    /\ fstate' = [fstate EXCEPT ![f] = "resolved"]
    /\ UNCHANGED <<db, entry, nfetch, fval, rpc, rf, floor, wpc, wver, completed>>

(* A rejected fetch evicts itself only while it is still the resident entry. *)
FetchReject(f) ==
    /\ f <= nfetch
    /\ fstate[f] = "pending"
    /\ fstate' = [fstate EXCEPT ![f] = "rejected"]
    /\ entry' = IF entry = f THEN 0 ELSE entry
    /\ UNCHANGED <<db, nfetch, fval, rpc, rf, floor, wpc, wver, completed>>

Serve(r) ==
    /\ rpc[r] = "waiting"
    /\ fstate[rf[r]] # "pending"
    /\ rpc' = [rpc EXCEPT ![r] = IF fstate[rf[r]] = "resolved" THEN "served" ELSE "failed"]
    /\ UNCHANGED <<db, entry, nfetch, fval, fstate, rf, floor, wpc, wver, completed>>

Expire ==
    /\ entry # 0
    /\ entry' = 0
    /\ UNCHANGED <<db, nfetch, fval, fstate, rpc, rf, floor, wpc, wver, completed>>

(* await this.adapter.<write>(...) *)
Commit(w) ==
    /\ wpc[w] = "idle"
    /\ db' = db + 1
    /\ wver' = [wver EXCEPT ![w] = db + 1]
    /\ wpc' = [wpc EXCEPT ![w] = "committed"]
    /\ UNCHANGED <<entry, nfetch, fval, fstate, rpc, rf, floor, completed>>

(* memo.invalidate(key), synchronously after the await; the write returns. *)
Invalidate(w) ==
    /\ wpc[w] = "committed"
    /\ entry' = 0
    /\ completed' = Max(completed, wver[w])
    /\ wpc' = [wpc EXCEPT ![w] = "done"]
    /\ UNCHANGED <<db, nfetch, fval, fstate, rpc, rf, floor, wver>>

Finished ==
    /\ \A r \in Readers : rpc[r] \in {"served", "failed"}
    /\ \A w \in Writers : wpc[w] = "done"

Next ==
    \/ \E r \in Readers : ReadShared(r) \/ ReadFetch(r) \/ Serve(r)
    \/ \E f \in Fetches : FetchRead(f) \/ FetchResolve(f) \/ FetchReject(f)
    \/ \E w \in Writers : Commit(w) \/ Invalidate(w)
    \/ Expire
    \/ (Finished /\ UNCHANGED vars)

Fairness ==
    /\ \A f \in Fetches : WF_vars(FetchRead(f)) /\ WF_vars(FetchResolve(f))
    /\ \A r \in Readers : WF_vars(Serve(r))
    /\ \A w \in Writers : WF_vars(Invalidate(w))

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Safety *)

(* No reader is served a value read before a write that completed before *)
(* the reader started.                                                   *)
NoStaleAfterInvalidate ==
    \A r \in Readers : rpc[r] = "served" => fval[rf[r]] >= floor[r]

(* A rejected fetch is never resident, so failures are retried. *)
RejectedNotCached == entry # 0 => fstate[entry] # "rejected"

---------------------------------------------------------------------------
(* Readers and writers are interchangeable (safety configs only). *)
Symmetry == Permutations(Readers) \cup Permutations(Writers)

ReaderFinishes == \A r \in Readers : rpc[r] = "waiting" ~> rpc[r] \in {"served", "failed"}
=============================================================================
