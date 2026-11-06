--------------------------- MODULE EmbeddingDimension ---------------------------
(***************************************************************************)
(* src/runtime/embeddings.ts RuntimeEmbeddings: ensureEmbeddingDimension   *)
(* (single flight), initializeEmbeddingDimension (probe, space guard,      *)
(* adapter resize, adapter space, pin, stale-dimension clear) and          *)
(* validateProviderOutput. The adapter side is the shared contract of      *)
(* plugin-sql base.ts and plugin-sqlite adapter-base.ts: a named space     *)
(* refuses a dimension change, ensureEmbeddingSpace refuses a second space, *)
(* and a write whose vector width differs from the column is skipped. No   *)
(* adapter checks a written vector's space.                                *)
(*                                                                         *)
(* Three providers: `named` emits space S at width 2, `plain` emits no     *)
(* space at width 2 and `wide` no space at width 3. Which provider a probe *)
(* pins is free: plugin waves, priorities and settings change between the  *)
(* boot probe and the deferred re-probes (runtime.ts initialize,           *)
(* packages/agent eliza.ts). A probe that throws leaves the pin as it was. *)
(* An embedding call picks the pinned provider and is validated after its *)
(* await, against the pin at that point.                                  *)
(*                                                                         *)
(* The null probe itself goes through validateProviderOutput: once a space *)
(* is pinned, a probe answer in another space or width is refused there,  *)
(* and initializeEmbeddingDimension skips that provider. That check, not   *)
(* the line 493 guard, is what keeps a named pin from becoming unnamed.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Embedders, MaxProbes

Providers == {"named", "plain", "wide"}
None == "none"
Space == [p \in Providers |-> IF p = "named" THEN "S" ELSE None]
Dim == [p \in Providers |-> IF p = "wide" THEN 3 ELSE 2]
Vectors == [space : {"S", None}, dim : {2, 3}]

VARIABLES
    col,       \* adapter embedding column width
    aspace,    \* adapter's active named space, or none
    stored,    \* vectors the adapter holds (space, width)
    pinProv,   \* pinnedEmbeddingProvider, or none
    pinSpace,  \* pinnedEmbeddingSpace, or none
    pinDim,    \* pinnedEmbeddingDimension, or 0
    ppc,       \* probe: idle | called | resized | spaced
    pprov,     \* provider the running probe answered from
    probes,    \* probes started
    epc,       \* epc[e]: idle | called | valid | done
    eprov,     \* eprov[e]: provider that produced e's vector
    dropped    \* vectors the adapter skipped on a width mismatch

vars == <<col, aspace, stored, pinProv, pinSpace, pinDim, ppc, pprov, probes,
          epc, eprov, dropped>>

TypeOK ==
    /\ col \in {2, 3}
    /\ aspace \in {"S", None}
    /\ stored \subseteq Vectors
    /\ pinProv \in Providers \cup {None}
    /\ pinSpace \in {"S", None}
    /\ pinDim \in {0, 2, 3}
    /\ ppc \in {"idle", "called", "resized", "spaced"}
    /\ pprov \in Providers \cup {None}
    /\ probes \in 0..MaxProbes
    /\ epc \in [Embedders -> {"idle", "called", "valid", "done"}]
    /\ eprov \in [Embedders -> Providers \cup {None}]
    /\ dropped \in Nat

Init ==
    /\ col = 2
    /\ aspace = None
    /\ stored = {}
    /\ pinProv = None
    /\ pinSpace = None
    /\ pinDim = 0
    /\ ppc = "idle"
    /\ pprov = None
    /\ probes = 0
    /\ epc = [e \in Embedders |-> "idle"]
    /\ eprov = [e \in Embedders |-> None]
    /\ dropped = 0

ProbeVars == <<ppc, pprov, probes>>
PinVars == <<pinProv, pinSpace, pinDim>>
EmbedVars == <<epc, eprov, dropped>>

ProbeFails ==
    /\ ppc' = "idle"
    /\ pprov' = None

(* ensureEmbeddingDimension: one probe at a time; the null probe answers. *)
ProbeStart(p) ==
    /\ ppc = "idle"
    /\ probes < MaxProbes
    /\ ppc' = "called"
    /\ pprov' = p
    /\ probes' = probes + 1
    /\ UNCHANGED <<col, aspace, stored, PinVars, EmbedVars>>

(* validateProviderOutput on the null probe (params === null, so it never *)
(* waits), the line 493 space guard, then await adapter.ensureEmbeddingDimension. *)
ProbeResize ==
    /\ ppc = "called"
    /\ LET p == pprov
           expected == IF pinSpace # None THEN pinSpace ELSE Space[p]
           refused == expected # None /\
                        (Space[p] # expected \/ (pinDim # 0 /\ Dim[p] # pinDim))
           guard == Space[p] # None /\ pinProv # None /\ pinSpace # Space[p]
       IN IF refused \/ guard \/ (aspace # None /\ Dim[p] # col)
          THEN /\ ProbeFails /\ UNCHANGED <<col, probes>>
          ELSE /\ col' = Dim[p]
               /\ ppc' = "resized"
               /\ UNCHANGED <<pprov, probes>>
    /\ UNCHANGED <<aspace, stored, PinVars, EmbedVars>>

(* await adapter.ensureEmbeddingSpace (named only), or the store-identity *)
(* guard (unnamed); both awaits sit before the pin fields are written.    *)
ProbeSpace ==
    /\ ppc = "resized"
    /\ LET s == Space[pprov] IN
       IF s # None /\ aspace # None /\ aspace # s
       THEN /\ ProbeFails /\ UNCHANGED <<aspace, probes>>
       ELSE /\ aspace' = IF s # None THEN s ELSE aspace
            /\ ppc' = "spaced"
            /\ UNCHANGED <<pprov, probes>>
    /\ UNCHANGED <<col, stored, PinVars, EmbedVars>>

(* Lines 525-527 pin; then clearEmbeddingsOutsideActiveDimension. *)
ProbePin ==
    /\ ppc = "spaced"
    /\ pinProv' = pprov
    /\ pinSpace' = Space[pprov]
    /\ pinDim' = Dim[pprov]
    /\ stored' = {v \in stored : v.dim = col}
    /\ ppc' = "idle"
    /\ pprov' = None
    /\ UNCHANGED <<col, aspace, probes, EmbedVars>>

(* useModel(TEXT_EMBEDDING): the pinned provider; before the first pin the *)
(* default resolution, which is the registration the probe is answering    *)
(* from (both take the first registration in priority order).              *)
EmbedCall(e, p) ==
    /\ epc[e] = "idle"
    /\ IF pinProv # None THEN p = pinProv ELSE ppc # "idle" /\ p = pprov
    /\ epc' = [epc EXCEPT ![e] = "called"]
    /\ eprov' = [eprov EXCEPT ![e] = p]
    /\ UNCHANGED <<col, aspace, stored, PinVars, ProbeVars, dropped>>

(* validateProviderOutput after the provider's await. A named vector with  *)
(* no pinned space waits for the in-flight probe and is refused if none is *)
(* pinned once it settles.                                                 *)
EmbedValidate(e) ==
    /\ epc[e] = "called"
    /\ LET named == Space[eprov[e]]
           expected == IF pinSpace # None THEN pinSpace ELSE named
       IN /\ named # None /\ pinSpace = None => ppc = "idle"
          /\ epc' = [epc EXCEPT ![e] =
                IF expected = None THEN "valid"
                ELSE IF pinSpace = None THEN "done"           \* NOT_INITIALIZED
                ELSE IF named = expected /\ Dim[eprov[e]] = pinDim THEN "valid"
                ELSE "done"]                                  \* SPACE_MISMATCH
    /\ UNCHANGED <<col, aspace, stored, PinVars, ProbeVars, eprov, dropped>>

(* The memory write: the adapter skips a vector whose width is not the column's. *)
EmbedWrite(e) ==
    /\ epc[e] = "valid"
    /\ LET v == [space |-> Space[eprov[e]], dim |-> Dim[eprov[e]]] IN
       IF v.dim = col
       THEN /\ stored' = stored \cup {v} /\ UNCHANGED dropped
       ELSE /\ dropped' = dropped + 1 /\ UNCHANGED stored
    /\ epc' = [epc EXCEPT ![e] = "done"]
    /\ UNCHANGED <<col, aspace, PinVars, ProbeVars, eprov>>

Finished == ppc = "idle" /\ \A e \in Embedders : epc[e] = "done"

Next ==
    \/ \E p \in Providers : ProbeStart(p)
    \/ ProbeResize \/ ProbeSpace \/ ProbePin
    \/ \E e \in Embedders : \/ \E p \in Providers : EmbedCall(e, p)
                            \/ EmbedValidate(e) \/ EmbedWrite(e)
    \/ (Finished /\ UNCHANGED vars)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Safety *)

(* The store never mixes a named space with vectors of another space. *)
StoredOneSpace == aspace # None => \A v \in stored : v.space = aspace

(* Once pinned, the pinned space never changes (restart to change it). *)
PinSpaceStable == [][pinProv # None => pinSpace' = pinSpace]_vars

(* Between probes the pin agrees with the adapter: its width is the column *)
(* width and a named pin is the adapter's space.                           *)
PinMatchesStore ==
    ppc = "idle" /\ pinProv # None =>
        /\ pinDim = col
        /\ pinSpace # None => aspace = pinSpace

(* Every stored vector has the column width once a probe has finished. *)
StoredInColumn == ppc = "idle" => \A v \in stored : v.dim = col
=============================================================================
