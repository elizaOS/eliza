# Website guidance and bounded browser authority

The pinned `GuidedWebsiteWorkflow` owns the offer, its page fingerprint and
acknowledged answer. The native binding and interactive-task kernel own
dispatch. Grace assembles the policy in `apps/app/host/website-guide-helper.ts`,
using only validated page structure and granted actions. `GuideConsent.tla`,
`GuideStopFence.tla`, and `ControlOracleCheck.tla` describe related policy and
actuator boundaries in the product checkout.

## Story: Grant one step on the website while keeping control of the page

### A planned step is tied to the observed page and trusted policy

The policy receives a projected page, not arbitrary private field contents.
The projection preserves the distinction between a populated sensitive
field and its value. The host resolves one control reference and verifies a
fresh snapshot before dispatch. A click that commits payment or another
protected irreversible effect is refused by policy. Manual actions belong
to the person. A sensitive fill takes a one-use host value reference; this
model holds only the offer predicate and no field value.

```quint
type GuidePhase = GuideLive | GuidePaused | GuideEnded
type PageAction = RoutineStep | AskedStep | ManualStep | CommitStep
type Offer = { actionClass: PageAction, snapshotId: int, exactTarget: bool, policyAuthorized: bool }
type GuideEffect = NoGuideEffect | AwaitReadback | ConfirmedEffect | BrowserRefused | UnknownEffect
type Guide = { phase: GuidePhase, epoch: int, snapshotId: int, hasOffer: bool, offer: Offer, given: bool, effect: GuideEffect }

pure val livePhase: GuidePhase = GuideLive
pure val pausedPhase: GuidePhase = GuidePaused
pure val endedPhase: GuidePhase = GuideEnded
pure val noGuideEffect: GuideEffect = NoGuideEffect
pure val awaitingEffect: GuideEffect = AwaitReadback
pure val confirmedEffect: GuideEffect = ConfirmedEffect
pure val refusedEffect: GuideEffect = BrowserRefused
pure val unknownEffect: GuideEffect = UnknownEffect
pure val blankOffer: Offer = { actionClass: ManualStep, snapshotId: 0, exactTarget: false, policyAuthorized: false }
pure val initial: Guide = { phase: livePhase, epoch: 1, snapshotId: 1, hasOffer: false, offer: blankOffer, given: false, effect: noGuideEffect }

pure def hostMayPrepare(actionClass: PageAction): bool = actionClass == RoutineStep or actionClass == AskedStep
pure def canOfferStep(g: Guide, proposal: Offer): bool =
  g.phase == livePhase and g.effect != awaitingEffect and g.effect != unknownEffect and
  proposal.snapshotId == g.snapshotId and proposal.exactTarget and
  proposal.policyAuthorized and hostMayPrepare(proposal.actionClass)
pure def offerStep(g: Guide, proposal: Offer): Guide =
  { ...g, hasOffer: true, offer: proposal, given: false }
pure def canAnswerStep(g: Guide): bool =
  g.phase == livePhase and g.hasOffer and g.offer.actionClass == AskedStep
pure def answerStep(g: Guide): Guide = { ...g, given: true }
pure def canDispatchStep(g: Guide, freshTarget: bool, freshApproval: bool): bool =
  g.phase == livePhase and g.hasOffer and g.effect != awaitingEffect and g.effect != unknownEffect and
  g.offer.snapshotId == g.snapshotId and g.offer.exactTarget and freshTarget and
  g.offer.policyAuthorized and freshApproval and hostMayPrepare(g.offer.actionClass) and
  (g.offer.actionClass != AskedStep or g.given)
pure def dispatchStep(g: Guide, freshTarget: bool, freshApproval: bool): Guide =
  { ...g, hasOffer: false, given: false, effect: awaitingEffect }
pure def changePage(g: Guide, snapshotId: int): Guide =
  { ...g, snapshotId: snapshotId, hasOffer: false, given: false }
pure def alwaysOfferKeepsPageBinding(g: Guide): bool =
  g.hasOffer implies g.phase == livePhase and g.offer.snapshotId == g.snapshotId and
  g.offer.exactTarget and g.offer.policyAuthorized and hostMayPrepare(g.offer.actionClass)
pure def alwaysAnswerBelongsToOffer(g: Guide): bool =
  g.given implies g.hasOffer and g.offer.actionClass == AskedStep
pure def lawCommitCannotBeOffered(g: Guide, proposal: Offer): bool =
  (proposal.actionClass == CommitStep or proposal.actionClass == ManualStep) implies not(canOfferStep(g, proposal))
pure def stepDispatchRequiresFreshConsent(before: Guide, via: str, after: Guide): bool =
  via == "dispatchStep" implies canDispatchStep(before, true, true) and not(after.hasOffer) and not(after.given)
pure def sometimesAskedStepAccepted(g: Guide): bool = g.given
```

## Story: Stop quickly and reconcile an action whose result was lost

### Pause clears authority while keeping unknown results visible

A Stop or Close cancels offers and their acknowledgements. A stopped task
does not run a second step because an old policy decision returned late.
If the boundary had already dispatched a step, Stop leaves its outcome
unknown until the host can determine what happened. Explicit Resume moves
to a new authority epoch and cannot reauthorize an unresolved effect.
The runtime's own rebind may preserve a Yes while its same step is
performed, so a host rebind is not represented as a user Resume.

```quint
pure def canResolveStep(g: Guide): bool = g.effect == awaitingEffect
pure def resolveStep(g: Guide, resultKind: GuideEffect): Guide =
  { ...g, effect: if (resultKind == confirmedEffect) confirmedEffect
    else if (resultKind == refusedEffect) refusedEffect
    else unknownEffect }
pure def canReconcileStep(g: Guide, checkedByOwner: bool): bool =
  g.effect == unknownEffect and checkedByOwner
pure def reconcileStep(g: Guide, checkedByOwner: bool, effectWasObserved: bool): Guide =
  { ...g, effect: if (effectWasObserved) confirmedEffect else refusedEffect }
pure def canPauseGuide(g: Guide): bool = g.phase == livePhase
pure def pauseGuide(g: Guide): Guide =
  { ...g, phase: pausedPhase, hasOffer: false, given: false, epoch: g.epoch + 1,
    effect: if (g.effect == awaitingEffect) unknownEffect else g.effect }
pure def canResumeGuide(g: Guide): bool =
  g.phase == pausedPhase and g.effect != unknownEffect
pure def resumeGuide(g: Guide): Guide =
  { ...g, phase: livePhase, epoch: g.epoch + 1 }
pure def canCloseGuide(g: Guide): bool = g.phase != endedPhase
pure def closeGuide(g: Guide): Guide =
  { ...g, phase: endedPhase, hasOffer: false, given: false, epoch: g.epoch + 1,
    effect: if (g.effect == awaitingEffect) unknownEffect else g.effect }
pure def alwaysNoOfferDuringReconciliation(g: Guide): bool =
  (g.effect == unknownEffect or g.effect == awaitingEffect) implies not(g.hasOffer)
pure def stepEndedGuideNeverResumes(before: Guide, after: Guide): bool =
  before.phase == endedPhase implies after.phase == endedPhase
pure def sometimesStepReadbackConfirmed(g: Guide): bool = g.effect == confirmedEffect
pure def sometimesStopLeavesUncertainEffect(g: Guide): bool =
  g.phase == pausedPhase and g.effect == unknownEffect
pure val proposalValues = Set(
  { actionClass: RoutineStep, snapshotId: 1, exactTarget: true, policyAuthorized: true },
  { actionClass: AskedStep, snapshotId: 1, exactTarget: true, policyAuthorized: true },
  { actionClass: RoutineStep, snapshotId: 2, exactTarget: true, policyAuthorized: true },
  { actionClass: ManualStep, snapshotId: 1, exactTarget: true, policyAuthorized: true },
  { actionClass: CommitStep, snapshotId: 1, exactTarget: true, policyAuthorized: true },
  { actionClass: AskedStep, snapshotId: 1, exactTarget: false, policyAuthorized: true })
pure val snapshotIdValues = Set(1, 2)
pure val resultKindValues = Set(confirmedEffect, refusedEffect, unknownEffect)
pure val gValues = Set(initial)
pure val weight_offerStep = 5
pure val weight_answerStep = 4
pure val weight_dispatchStep = 5
```
