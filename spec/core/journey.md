# A turn from initialization through retirement

This composition exercises the public runtime workflow across the existing
state owners. It uses the runtime, context, model-dispatch and receipt
machines directly. Host authentication, request serialization, provider
responses and durable adapter acknowledgements enter through their typed
boundaries. A successful model answer alone provides no effect receipt.


Discovered by the proof: each embedded machine must retain its complete safety
invariant before the composition can rely on that machine's transition lemmas.

## Story: Complete or cancel a turn and retire its runtime

As a host author, I initialize the kernel, load complete authorized context,
dispatch through registered models, settle an action receipt, acknowledge
its reply, and drain the turn before closing the kernel.

### A turn composes the existing machines without a second state store

The composition builds the model request envelope directly from the complete visible context and mandatory evidence. Tool definitions and schemas enter as complete declared values. The provider adapter binds `token` to the serialization of that envelope and must verify that correspondence before implementation acceptance. The model preserves the structural evidence and byte string throughout dispatch.

```quint
import runtime as R from "./runtime"
import context as C from "./context"
import models as M from "./models"
import receipts as D from "./receipts"

type ActionFailure = NoActionFailure | InvalidActionReceipt | ActionHandlerFailure | ActionAdmissionDenied
type JourneyPhase = Booting | AwaitingTurn | Preparing | Inferring | Acting | Replying | Completed | Retired
type Journey = { phase: JourneyPhase, kernel: R::Runtime, prompt: C::Context, model: M::Dispatch, reply: D::Delivery, actionFailure: ActionFailure }
pure val initial: Journey = { phase: Booting, kernel: R::initial, prompt: C::initial, model: M::initial, reply: D::initial, actionFailure: NoActionFailure }
pure def canBeginInitialization(j: Journey): bool = R::canBeginInitialization(j.kernel)
pure def beginInitialization(j: Journey): Journey = { ...j, kernel: R::beginInitialization(j.kernel) }
pure def canCompleteInitialization(j: Journey, ok: bool): bool = R::canCompleteInitialization(j.kernel, ok)
pure def completeInitialization(j: Journey, ok: bool): Journey = { ...j, kernel: R::completeInitialization(j.kernel, ok), phase: if (ok) AwaitingTurn else Retired }
pure def canBeginTurn(j: Journey, originals: List[C::Source], mandatory: List[str]): bool = j.phase == AwaitingTurn and R::canAdmitTurn(j.kernel)
pure def beginTurn(j: Journey, originals: List[C::Source], mandatory: List[str]): Journey = { ...j, phase: Preparing, kernel: R::admitTurn(j.kernel), prompt: C::load(C::initial, originals, mandatory), model: M::initial, reply: D::initial, actionFailure: NoActionFailure }
pure val originalsValues = C::originalsValues
pure val mandatoryValues = C::mandatoryValues
pure def canRestoreContext(j: Journey): bool = j.phase == Preparing and j.model.phase == M::Unconfigured
pure def restoreContext(j: Journey): Journey = { ...j, prompt: C::restore(j.prompt) }
```

### Model invocation retains the admitted request through fallback and failure

Only an initialized, admitted turn configures model dispatch. A budget or
capability rejection completes the turn without running an action. Model
failover uses the ordered registrations and failure policy of its owner.

```quint
pure def requestEvidence(prompt: C::Context, tools: List[str], schemas: List[str]): M::RequestEvidence = {sourceIds: prompt.visible.listMap(source => source.id), sourceTexts: prompt.visible.listMap(source => source.text), sourceAuthors: prompt.visible.listMap(source => source.author), mandatory: prompt.renderedMandatory, tools: tools, schemas: schemas}
pure val toolsValues = Set(List(), List("READ"))
pure val schemasValues = Set(List(), List("READ schema"))
pure def canConfigureModel(j: Journey, token: str, registrations: List[M::Registration], available: bool, budget: bool, pinned: bool, speech: bool, tools: List[str], schemas: List[str]): bool =
  j.phase == Preparing and j.kernel.admissionOpen and M::canConfigure(j.model, token, registrations, available, budget, pinned, speech, true, false, requestEvidence(j.prompt, tools, schemas))
pure def configureModel(j: Journey, token: str, registrations: List[M::Registration], available: bool, budget: bool, pinned: bool, speech: bool, tools: List[str], schemas: List[str]): Journey =
  { ...j, model: M::configure(j.model, token, registrations, available, budget, pinned, speech, true, false, requestEvidence(j.prompt, tools, schemas)) }
pure val tokenValues = M::tokenValues
pure val registrationsValues = M::registrationsValues
pure def canAdmitModel(j: Journey): bool = j.phase == Preparing and M::canAdmitRequest(j.model)
pure def admitModel(j: Journey): Journey = { ...j, phase: Inferring, model: M::admitRequest(j.model) }
pure def canRejectModel(j: Journey): bool = j.phase == Preparing and M::canRejectRequest(j.model)
pure def rejectModel(j: Journey): Journey = { ...j, phase: Completed, model: M::rejectRequest(j.model) }
pure def canInvokeModel(j: Journey): bool = j.phase == Inferring and M::canInvokeModel(j.model)
pure def invokeModel(j: Journey): Journey = { ...j, model: M::invokeModel(j.model) }
pure def canObserveModel(j: Journey, resultKind: M::Outcome): bool = j.phase == Inferring and M::canObserveOutcome(j.model, resultKind)
pure def observeModel(j: Journey, resultKind: M::Outcome): Journey = {
  val nextModel = M::observeOutcome(j.model, resultKind)
  { ...j, model: nextModel, phase: if (nextModel.phase == M::Answered) Acting else if (nextModel.phase == M::DispatchFailed or nextModel.phase == M::Cancelled) Completed else Inferring }
}
pure def canCancelTurn(j: Journey): bool = j.phase == Preparing or j.phase == Inferring
pure def cancelTurn(j: Journey): Journey = {
  val abortedModel = M::abortRoot(j.model)
  { ...j, phase: Completed, model: if (M::canCancelDispatch(abortedModel)) M::cancelDispatch(abortedModel) else abortedModel }
}
```

### Action evidence and transport acknowledgement remain distinct

Receipt evidence enters after the action has settled. The existing receipt
guard checks the outcome's evidence. A hook may invalidate the exact reply
binding before dispatch. Transport failure retains the committed receipt
and withholds a delivered confirmation.

Discovered by simulation: consecutive model, action and reply steps need
enough samples to exercise their complete path before early cancellation
or rejection. The sampler gives those steps more weight. It still includes
the refusal and cancellation paths.

```quint
pure val weight_beginInitialization = 4
pure val weight_completeInitialization = 4
pure val weight_beginTurn = 8
pure val weight_configureModel = 12
pure val weight_admitModel = 12
pure val weight_invokeModel = 12
pure val weight_observeModel = 16
pure val weight_recordAction = 16
pure val weight_bindReply = 12
pure val weight_sendReply = 12
pure val weight_acknowledgeReply = 12
pure val weight_finishTurn = 10
pure val weight_requestStop = 5
pure val weight_finishStop = 10
pure val weight_confirmRetirement = 10
pure def canRejectAction(j: Journey, failure: ActionFailure): bool = j.phase == Acting and failure != NoActionFailure
pure def rejectAction(j: Journey, failure: ActionFailure): Journey = { ...j, phase: Completed, actionFailure: failure }
pure def canRecordAction(j: Journey, receiptOutcome: D::ReceiptOutcome, durable: bool, providerAccepted: bool, hasKey: bool, replayed: bool): bool =
  j.phase == Acting and D::canRecordOutcome(j.reply, receiptOutcome, durable, providerAccepted, hasKey, replayed)
pure def recordAction(j: Journey, receiptOutcome: D::ReceiptOutcome, durable: bool, providerAccepted: bool, hasKey: bool, replayed: bool): Journey =
  { ...j, phase: Replying, reply: D::recordOutcome(j.reply, receiptOutcome, durable, providerAccepted, hasKey, replayed) }
pure def canBindReply(j: Journey): bool = j.phase == Replying and D::canBind(j.reply)
pure def bindReply(j: Journey): Journey = { ...j, reply: D::bind(j.reply) }
pure def canTransformReply(j: Journey): bool = j.phase == Replying and D::canTransform(j.reply)
pure def transformReply(j: Journey): Journey = { ...j, reply: D::transform(j.reply) }
pure def canSendReply(j: Journey): bool = j.phase == Replying and D::canDeliver(j.reply)
pure def sendReply(j: Journey): Journey = { ...j, reply: D::deliver(j.reply) }
pure def canAcknowledgeReply(j: Journey, accepted: bool): bool = j.phase == Replying and D::canSettleDelivery(j.reply, accepted)
pure def acknowledgeReply(j: Journey, accepted: bool): Journey = { ...j, phase: Completed, reply: D::settleDelivery(j.reply, accepted) }
pure def canFinishTurn(j: Journey): bool = j.phase == Completed and not(j.reply.inFlight) and R::canFinishTurn(j.kernel, true)
pure def finishTurn(j: Journey): Journey = { ...j, phase: AwaitingTurn, kernel: R::finishTurn(j.kernel, true) }
```

### Retirement waits for the admitted turn and its pending reply

Stopping closes future admission. An already admitted action retains its
original settlement path, and its pending transport cannot disappear from
the drain accounting. The host can cancel a pre-action turn and then drain.

Discovered by the proof: an active turn follows successful initialization.
Preparation and inference carry no prior action outcome or receipt into the
action phase.
An in-flight reply remains in the replying phase of its admitted turn until
acknowledgement. These facts exclude an initialization completion that
drops a live turn and a retirement that strands an in-flight reply.

```quint
pure def canRequestStop(j: Journey): bool = R::canRequestStop(j.kernel, false)
pure def requestStop(j: Journey): Journey = { ...j, kernel: R::requestStop(j.kernel, false) }
pure def canFinishStop(j: Journey): bool = R::canFinishStop(j.kernel)
pure def finishStop(j: Journey): Journey = { ...j, phase: Retired, kernel: R::finishStop(j.kernel) }
pure def canConfirmRetirement(j: Journey): bool = R::canConfirmQuiescence(j.kernel)
pure def confirmRetirement(j: Journey): Journey = { ...j, kernel: R::confirmQuiescence(j.kernel) }
pure def canCloseAdapter(j: Journey): bool = R::canCloseAdapter(j.kernel)
pure def closeAdapter(j: Journey): Journey = { ...j, kernel: R::closeAdapter(j.kernel) }
pure def alwaysTurnAccounting(j: Journey): bool = j.kernel.activeTurns == (if (j.phase == Preparing or j.phase == Inferring or j.phase == Acting or j.phase == Replying or j.phase == Completed) 1 else 0)
pure def alwaysActiveTurnAfterInitialization(j: Journey): bool = j.kernel.activeTurns > 0 implies j.kernel.initPhase == R::Ready
pure def alwaysBeforeSettlementHasNoActionOutcome(j: Journey): bool = (j.phase == Preparing or j.phase == Inferring or j.phase == Acting) implies j.actionFailure == NoActionFailure and not(j.reply.handlerSettled) and not(j.reply.confirmsApplied)
pure def alwaysReplyInFlightBelongsToTurn(j: Journey): bool = j.reply.inFlight implies j.phase == Replying
pure def alwaysRuntimeRules(j: Journey): bool = R::alwaysInitializationHonest(j.kernel) and R::alwaysWorkCounts(j.kernel) and R::alwaysStopPreparesOnce(j.kernel) and R::alwaysStrictSuccessHasNoPendingWork(j.kernel) and R::alwaysCloseRespectsWork(j.kernel) and R::alwaysRuntimeDeadlockFree(j.kernel)
pure def alwaysPreservedContext(j: Journey): bool = C::alwaysMandatoryEvidenceIsComplete(j.prompt) and C::alwaysVisibleSourcesAreExactOriginals(j.prompt) and C::alwaysFullModeContainsAllSources(j.prompt) and C::alwaysSourceIdentityIsValid(j.prompt) and C::alwaysSelectedHistoryKeepsOrder(j.prompt) and C::alwaysRestorationIsExact(j.prompt)
pure def alwaysRequestContextMatches(j: Journey): bool = j.model.phase != M::Unconfigured implies j.model.evidence.sourceIds == j.prompt.visible.listMap(source => source.id) and j.model.evidence.sourceTexts == j.prompt.visible.listMap(source => source.text) and j.model.evidence.sourceAuthors == j.prompt.visible.listMap(source => source.author) and j.model.evidence.mandatory == j.prompt.renderedMandatory
pure def alwaysActionFailureHasNoReceipt(j: Journey): bool = j.actionFailure != NoActionFailure implies not(j.reply.handlerSettled) and not(j.reply.confirmsApplied)
pure def alwaysHonestRequest(j: Journey): bool = M::alwaysAdmittedRequestComplete(j.model) and M::alwaysExhaustedProvidersSkipped(j.model) and M::alwaysRegistrationAttemptedOnce(j.model) and M::alwaysTerminalOutcomeEndsChain(j.model) and M::alwaysAnswerNamesProvider(j.model) and M::alwaysDispatchDeadlockFree(j.model) and M::alwaysActiveDispatchHasRegistration(j.model) and M::alwaysConfiguredHasNoAttempts(j.model) and M::alwaysRemainingRegistrationsFresh(j.model)
pure def alwaysHonestConfirmation(j: Journey): bool = D::alwaysConfirmationHasProof(j.reply) and D::alwaysOneDelivery(j.reply) and D::alwaysCallbackAccounting(j.reply) and D::alwaysAttemptHasSettledBoundHandler(j.reply)
pure def alwaysDrainedRetirement(j: Journey): bool = j.kernel.strictSuccess implies j.kernel.activeTurns == 0 and not(j.reply.inFlight)
pure def sometimesConfirmedAndRetired(j: Journey): bool = j.kernel.strictSuccess and j.reply.confirmsApplied
pure def sometimesRejectedActionRetired(j: Journey): bool = j.kernel.strictSuccess and j.actionFailure != NoActionFailure and not(j.reply.confirmsApplied)
pure def sometimesCancelledAndRetired(j: Journey): bool = j.kernel.strictSuccess and j.model.rootAborted and not(j.reply.confirmsApplied)
pure def sometimesFailedTransportKeepsCommit(j: Journey): bool = j.phase == Completed and j.reply.transportFailed and D::committedReceipt(j.reply.receipt)
```
