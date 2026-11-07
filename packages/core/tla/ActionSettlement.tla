---------------------------- MODULE ActionSettlement ----------------------------
(***************************************************************************)
(* src/runtime/action-handler-settlement.ts: settleActionHandler and its   *)
(* actionCallback / deliverSafely.                                         *)
(*                                                                         *)
(* Admission may deny the action. The handler then emits InHandler        *)
(* callbacks while it runs and returns ok, a replyFailure, an invalid      *)
(* result, or throws. Background work it started may emit Late more        *)
(* callbacks at any time after it returns. While the phase is pending a    *)
(* callback is buffered; a failed phase drops it; a settled phase delivers *)
(* it unless the result carries a replyFailure.                            *)
(*                                                                         *)
(* This models the code with the TLA+ review fix applied: every delivery   *)
(* after settlement goes through one promise chain (deliveryTail). The     *)
(* drain puts the buffered callbacks on the chain in the same synchronous  *)
(* run that sets phase = "settled", then awaits the chain, so a late       *)
(* callback queues behind them. The transport callback may take any time   *)
(* to settle; the chain starts the next delivery only after it does.       *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    InHandler,  \* callbacks emitted while the handler runs
    Late,       \* callbacks emitted after the handler returned
    Outcomes,   \* subset of {"ok", "replyFailure", "invalid", "throw"}
    MayDeny     \* a processing policy may deny admission

N == InHandler + Late
Ids == 1..N

VARIABLES
    spc,       \* settleActionHandler: "admit", "wait", "drain", "done"
    hpc,       \* the handler: "idle", "running", "returned"
    phase,     \* "pending", "settled", "failed"
    outcome,   \* what the handler returned
    emitted,   \* callbacks emitted so far (ids are emission order)
    buffer,    \* bufferedCallbacks
    chain,     \* deliveries queued on deliveryTail, oldest first
    busy,      \* a transport callback has not settled yet
    delivered, \* ids handed to options.callback, in invocation order
    target     \* Len(delivered) the drain awaits

vars == <<spc, hpc, phase, outcome, emitted, buffer, chain, busy, delivered,
          target>>

Init ==
    /\ spc = "admit"
    /\ hpc = "idle"
    /\ phase = "pending"
    /\ outcome = "none"
    /\ emitted = 0
    /\ buffer = <<>>
    /\ chain = <<>>
    /\ busy = FALSE
    /\ delivered = <<>>
    /\ target = 0

(* actionCallback(id) *)
Receive(id) ==
    CASE phase = "pending" -> buffer' = Append(buffer, id) /\ UNCHANGED chain
      [] phase = "failed" -> UNCHANGED <<buffer, chain>>
      [] outcome = "replyFailure" -> UNCHANGED <<buffer, chain>>
      [] OTHER -> chain' = Append(chain, id) /\ UNCHANGED buffer

(* await admitProcessing(): a denial fails before the handler runs. *)
Admit ==
    /\ spc = "admit"
    /\ \/ MayDeny /\ phase' = "failed" /\ spc' = "done" /\ UNCHANGED hpc
       \/ spc' = "wait" /\ hpc' = "running" /\ UNCHANGED phase
    /\ UNCHANGED <<outcome, emitted, buffer, chain, busy, delivered, target>>

HandlerEmit ==
    /\ hpc = "running" /\ emitted < InHandler
    /\ emitted' = emitted + 1
    /\ Receive(emitted + 1)
    /\ UNCHANGED <<spc, hpc, phase, outcome, busy, delivered, target>>

HandlerReturn ==
    /\ hpc = "running" /\ emitted = InHandler
    /\ \E o \in Outcomes : outcome' = o
    /\ hpc' = "returned"
    /\ UNCHANGED <<spc, phase, emitted, buffer, chain, busy, delivered, target>>

LateEmit ==
    /\ hpc = "returned" /\ emitted < N
    /\ emitted' = emitted + 1
    /\ Receive(emitted + 1)
    /\ UNCHANGED <<spc, hpc, phase, outcome, busy, delivered, target>>

(* The continuation after `await invoke()`: normalize, set the phase,
   beforeCallbacks, and put the buffered callbacks on the chain. *)
Settle ==
    /\ spc = "wait" /\ hpc = "returned"
    /\ IF outcome \in {"invalid", "throw"}
       THEN /\ phase' = "failed" /\ buffer' = <<>> /\ spc' = "done"
            /\ UNCHANGED <<chain, target>>
       ELSE /\ phase' = "settled"
            /\ IF outcome = "replyFailure"
               THEN buffer' = <<>> /\ spc' = "done" /\ UNCHANGED <<chain, target>>
               ELSE /\ chain' = chain \o buffer
                    /\ target' = Len(delivered) + Len(chain) + Len(buffer)
                    /\ spc' = "drain"
                    /\ UNCHANGED buffer
    /\ UNCHANGED <<hpc, outcome, emitted, busy, delivered>>

(* The chain invokes options.callback for its oldest delivery ... *)
Deliver ==
    /\ ~busy /\ chain # <<>>
    /\ delivered' = Append(delivered, Head(chain))
    /\ chain' = Tail(chain)
    /\ busy' = TRUE
    /\ UNCHANGED <<spc, hpc, phase, outcome, emitted, buffer, target>>

(* ... and the next one waits until the transport settles. *)
TransportSettle ==
    /\ busy
    /\ busy' = FALSE
    /\ UNCHANGED <<spc, hpc, phase, outcome, emitted, buffer, chain, delivered,
                   target>>

(* `await deliveryTail`: the last buffered delivery has settled. *)
Drained ==
    /\ spc = "drain"
    /\ \/ Len(delivered) > target
       \/ Len(delivered) = target /\ ~busy
    /\ spc' = "done"
    /\ UNCHANGED <<hpc, phase, outcome, emitted, buffer, chain, busy, delivered,
                   target>>

Finished ==
    /\ spc = "done" /\ ~busy /\ chain = <<>>
    /\ (hpc = "idle" \/ emitted = N)

Next ==
    \/ Admit \/ HandlerEmit \/ HandlerReturn \/ LateEmit \/ Settle
    \/ Deliver \/ TransportSettle \/ Drained
    \/ (Finished /\ UNCHANGED vars)

(* The handler, its background work and the transport all settle. *)
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)
    /\ WF_vars(HandlerEmit) /\ WF_vars(HandlerReturn) /\ WF_vars(LateEmit)
    /\ WF_vars(Settle) /\ WF_vars(Deliver) /\ WF_vars(TransportSettle)
    /\ WF_vars(Drained)

---------------------------------------------------------------------------
(* Safety *)

TypeOK ==
    /\ spc \in {"admit", "wait", "drain", "done"}
    /\ hpc \in {"idle", "running", "returned"}
    /\ phase \in {"pending", "settled", "failed"}
    /\ outcome \in Outcomes \cup {"none"}
    /\ emitted \in 0..N
    /\ buffer \in Seq(Ids) /\ chain \in Seq(Ids) /\ delivered \in Seq(Ids)
    /\ busy \in BOOLEAN

(* Strictly increasing: delivered in emission order, each at most once. *)
DeliveredInEmissionOrder ==
    \A i, j \in 1..Len(delivered) : i < j => delivered[i] < delivered[j]

DeliveredOnlyEmitted == \A i \in 1..Len(delivered) : delivered[i] <= emitted

(* A failed boundary delivers nothing, before or after the failure. *)
NoneAfterFailure == phase = "failed" => delivered = <<>>

(* A replyFailure result substitutes system status for every callback. *)
NoneOnReplyFailure == outcome = "replyFailure" => delivered = <<>>

(* The pending phase delivers nothing. *)
NoneWhilePending == phase = "pending" => delivered = <<>>

---------------------------------------------------------------------------
(* Liveness *)

SettleReturns == <>(spc = "done")

(* Every callback of a settled ok result is delivered, late ones included. *)
AllDelivered ==
    <>[](phase = "settled" /\ outcome = "ok" => Len(delivered) = N)
=============================================================================
