# Household agreements and account handoff reviews

## Story: Fence agreement confirmations and account handoff execution to their reviewed revision

> As the device owner, I want household agreements to require explicit owner confirmation on the current revision before becoming accepted, and account handoff execution to run only against an immutable review derived for the exact current choices revision.

### Agreements and handoffs enforce monotonic revisions and owner-reviewed fencing

Agreements progress from `Draft` to `Proposed` (incrementing `agreementRevision`), then to `Accepted` only when `confirmAgreement` matches the active `agreementRevision`, or to `Fenced`/`Deleted`. Account handoffs save choices (incrementing `handoffRevision`), derive an immutable review pinning `reviewedRevision == handoffRevision`, execute only while `reviewedRevision == handoffRevision`, advance `completedCheckpoints` up to `totalCheckpoints == 3`, and mark `HandoffComplete` only once every checkpoint has finished; neither revision ever rewinds.

```quint
type AgreementPhase = Draft | Proposed | Accepted | Fenced | Deleted
type HandoffPhase = HandoffIdle | ChoicesSaved | ReviewReady | Executing | HandoffComplete | HandoffAborted

type AgreementHandoffState = {
  agreementPhase: AgreementPhase,
  agreementRevision: int,
  confirmedByOwner: bool,
  handoffPhase: HandoffPhase,
  handoffRevision: int,
  reviewedRevision: int,
  completedCheckpoints: int,
  totalCheckpoints: int
}

pure val initial: AgreementHandoffState = {
  agreementPhase: Draft,
  agreementRevision: 0,
  confirmedByOwner: false,
  handoffPhase: HandoffIdle,
  handoffRevision: 0,
  reviewedRevision: 0,
  completedCheckpoints: 0,
  totalCheckpoints: 3
}

pure def canProposeAgreement(s: AgreementHandoffState): bool =
  s.agreementPhase == Draft or s.agreementPhase == Proposed or s.agreementPhase == Accepted

pure def proposeAgreement(s: AgreementHandoffState): AgreementHandoffState =
  { ...s, agreementPhase: Proposed, agreementRevision: s.agreementRevision + 1, confirmedByOwner: false }

pure def canConfirmAgreement(s: AgreementHandoffState, rev: int): bool =
  s.agreementPhase == Proposed and rev == s.agreementRevision and s.agreementRevision > 0

pure def confirmAgreement(s: AgreementHandoffState, rev: int): AgreementHandoffState =
  { ...s, agreementPhase: Accepted, confirmedByOwner: true }

pure def canFenceAgreement(s: AgreementHandoffState): bool =
  s.agreementPhase == Proposed or s.agreementPhase == Accepted

pure def fenceAgreement(s: AgreementHandoffState): AgreementHandoffState =
  { ...s, agreementPhase: Fenced, confirmedByOwner: false }

pure def canDeleteAgreement(s: AgreementHandoffState): bool =
  s.agreementPhase != Deleted

pure def deleteAgreement(s: AgreementHandoffState): AgreementHandoffState =
  { ...s, agreementPhase: Deleted, confirmedByOwner: false }

pure def canSaveHandoffChoices(s: AgreementHandoffState): bool =
  s.handoffPhase == HandoffIdle or s.handoffPhase == ChoicesSaved or s.handoffPhase == ReviewReady or s.handoffPhase == HandoffAborted

pure def saveHandoffChoices(s: AgreementHandoffState): AgreementHandoffState =
  {
    ...s,
    handoffPhase: ChoicesSaved,
    handoffRevision: s.handoffRevision + 1,
    completedCheckpoints: 0
  }

pure def canDeriveHandoffReview(s: AgreementHandoffState, rev: int): bool =
  s.handoffPhase == ChoicesSaved and rev == s.handoffRevision and s.handoffRevision > 0

pure def deriveHandoffReview(s: AgreementHandoffState, rev: int): AgreementHandoffState =
  { ...s, handoffPhase: ReviewReady, reviewedRevision: rev, completedCheckpoints: 0 }

pure def canBeginHandoffExecution(s: AgreementHandoffState, rev: int): bool =
  s.handoffPhase == ReviewReady and rev == s.handoffRevision and s.reviewedRevision == s.handoffRevision and rev > 0

pure def beginHandoffExecution(s: AgreementHandoffState, rev: int): AgreementHandoffState =
  { ...s, handoffPhase: Executing, completedCheckpoints: 0 }

pure def canAdvanceHandoffCheckpoint(s: AgreementHandoffState): bool =
  s.handoffPhase == Executing and s.completedCheckpoints < s.totalCheckpoints

pure def advanceHandoffCheckpoint(s: AgreementHandoffState): AgreementHandoffState =
  { ...s, completedCheckpoints: s.completedCheckpoints + 1 }

pure def canCompleteHandoff(s: AgreementHandoffState): bool =
  s.handoffPhase == Executing and s.completedCheckpoints == s.totalCheckpoints

pure def completeHandoff(s: AgreementHandoffState): AgreementHandoffState =
  { ...s, handoffPhase: HandoffComplete }

pure def canAbortHandoff(s: AgreementHandoffState): bool =
  s.handoffPhase == ChoicesSaved or s.handoffPhase == ReviewReady or s.handoffPhase == Executing

pure def abortHandoff(s: AgreementHandoffState): AgreementHandoffState =
  { ...s, handoffPhase: HandoffAborted, completedCheckpoints: 0 }

pure def alwaysAgreementAndHandoffSafety(s: AgreementHandoffState): bool =
  s.totalCheckpoints == 3 and
  s.agreementRevision >= 0 and
  s.handoffRevision >= 0 and
  s.reviewedRevision >= 0 and
  s.reviewedRevision <= s.handoffRevision and
  s.completedCheckpoints >= 0 and s.completedCheckpoints <= s.totalCheckpoints and
  (s.agreementPhase == Accepted implies s.confirmedByOwner and s.agreementRevision > 0) and
  ((s.handoffPhase == Executing or s.handoffPhase == HandoffComplete) implies s.reviewedRevision == s.handoffRevision and s.handoffRevision > 0) and
  (s.handoffPhase == HandoffComplete implies s.completedCheckpoints == s.totalCheckpoints)

pure def stepRevisionsNeverRewind(before: AgreementHandoffState, via: str, after: AgreementHandoffState): bool =
  after.agreementRevision >= before.agreementRevision and after.handoffRevision >= before.handoffRevision

pure val revValues = Set(0, 1, 2)

pure def sometimesAgreementAccepted(s: AgreementHandoffState): bool =
  s.agreementPhase == Accepted and s.confirmedByOwner

pure def sometimesHandoffCompleted(s: AgreementHandoffState): bool =
  s.handoffPhase == HandoffComplete

pure val eval_witness_sometimesHandoffCompleted = (
  ("saveHandoffChoices"),
  ("deriveHandoffReview", 1),
  ("beginHandoffExecution", 1),
  ("advanceHandoffCheckpoint"),
  ("advanceHandoffCheckpoint"),
  ("advanceHandoffCheckpoint"),
  ("completeHandoff")
)
```
