---------------------------- MODULE FactWriteDedupe ----------------------------
(***************************************************************************)
(* src/runtime/data-mutations.ts RuntimeDataMutations.createMemory, facts *)
(* branch, and serialiseFactWrite, with src/runtime/fact-write-dedupe.ts   *)
(* findEquivalentFact and mergeStrongerFactMetadata.                       *)
(*                                                                         *)
(* Every writer carries the same fact (same trimmed text, room and entity) *)
(* and its own evidence id. Check is `await findEquivalentFact` (one       *)
(* getMemories read); a hit merges the evidence ids of the row it read with *)
(* its own and writes them back with `await updateMemory`; a miss inserts  *)
(* with `await adapter.createMemories`. Each await is a step. Prefilled     *)
(* says whether the row already exists before the writers start.           *)
(*                                                                         *)
(* Serialised = TRUE is the code as written: serialiseFactWrite runs the   *)
(* check and its update or insert one at a time per room (the model lets   *)
(* any waiter go next; the code's chain is FIFO). Serialised = FALSE is    *)
(* the original unserialised code, which can insert duplicate facts and    *)
(* lose evidence; both cfgs check TRUE.                                    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS Writers, Prefilled, Serialised, Seed

VARIABLES
    rows,   \* rows[i]: the evidence ids of the i-th equivalent fact row
    pc,     \* pc[w]: idle | hit | miss | done
    seen,   \* seen[w]: evidence ids of the row w read on a hit
    owner   \* the writer inside the per-room section (fix only), or Seed

vars == <<rows, pc, seen, owner>>

TypeOK ==
    /\ rows \in Seq(SUBSET (Writers \cup {Seed}))
    /\ pc \in [Writers -> {"idle", "hit", "miss", "done"}]
    /\ seen \in [Writers -> SUBSET (Writers \cup {Seed})]
    /\ owner \in Writers \cup {Seed}

Init ==
    /\ rows = IF Prefilled THEN <<{Seed}>> ELSE <<>>
    /\ pc = [w \in Writers |-> "idle"]
    /\ seen = [w \in Writers |-> {}]
    /\ owner = Seed

(* await findEquivalentFact: the read returns the first equivalent row. *)
Check(w) ==
    /\ pc[w] = "idle"
    /\ Serialised => owner = Seed
    /\ owner' = IF Serialised THEN w ELSE owner
    /\ IF rows = <<>>
       THEN /\ pc' = [pc EXCEPT ![w] = "miss"]
            /\ UNCHANGED seen
       ELSE /\ pc' = [pc EXCEPT ![w] = "hit"]
            /\ seen' = [seen EXCEPT ![w] = rows[1]]
    /\ UNCHANGED rows

(* await updateMemory({ id, metadata: { ...existing.metadata, ...upgrades } }): *)
(* the merged ids replace whatever the row holds now.                          *)
Update(w) ==
    /\ pc[w] = "hit"
    /\ rows' = [rows EXCEPT ![1] = seen[w] \cup {w}]
    /\ pc' = [pc EXCEPT ![w] = "done"]
    /\ owner' = IF Serialised THEN Seed ELSE owner
    /\ UNCHANGED seen

(* await adapter.createMemories([...]) *)
Insert(w) ==
    /\ pc[w] = "miss"
    /\ rows' = Append(rows, {w})
    /\ pc' = [pc EXCEPT ![w] = "done"]
    /\ owner' = IF Serialised THEN Seed ELSE owner
    /\ UNCHANGED seen

Finished == \A w \in Writers : pc[w] = "done"

Next ==
    \/ \E w \in Writers : Check(w) \/ Update(w) \/ Insert(w)
    \/ (Finished /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars /\ \A w \in Writers : WF_vars(Check(w) \/ Update(w) \/ Insert(w))

---------------------------------------------------------------------------
(* Safety *)

(* Identical fact writes leave at most one row. *)
NoDuplicateFact == Len(rows) <= 1

(* A deduped occurrence never drops another occurrence's evidence id. *)
NoLostEvidence ==
    \A w \in Writers : pc[w] = "done" => \E i \in 1..Len(rows) : w \in rows[i]

(* Liveness: every write returns. *)
WriteReturns == \A w \in Writers : <>(pc[w] = "done")
=============================================================================
