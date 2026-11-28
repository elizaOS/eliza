# Identity resolution, recipient confirmation, and legacy schema audit

Deterministic authority rules for auto-merging observed identities, confirming
email recipients without ambiguity or silent overwrites, and failing closed when
the retired `app_relationships` schema still holds unmigrated rows.

## Story: Resolve identity observations and confirmed recipients without guessing

> As an owner, I want high-confidence single identity matches to merge cleanly,
> low-confidence or multi-entity matches to surface as conflicts, confirmed
> email recipients to reject ambiguity or stale reviews, and unmigrated legacy
> schemas to fail closed.

### Identity observation auto-merges only a single match at or above 85% confidence

Given the set of existing entities matching an account-bound `(platform,
connectorAccountId, handle)` tuple, zero matches create a new entity; a single
match auto-merges only when observation confidence is at least 85% (850 basis
points); a single match below 85% or two or more matching entities surfaces a
conflict for owner review instead of guessing.

```quint
pure val autoMergeThresholdBps = 850
type IdentityDecision = DecisionCreate | DecisionAutoMerge | DecisionConflictLowConfidence | DecisionConflictMultiple
pure def decideObservation(candidateCount: int, confidenceBps: int): IdentityDecision =
  if (candidateCount <= 0) DecisionCreate
  else if (candidateCount == 1 and confidenceBps >= autoMergeThresholdBps) DecisionAutoMerge
  else if (candidateCount == 1) DecisionConflictLowConfidence
  else DecisionConflictMultiple
pure val candidateCountValues = Set(0, 1, 2, 3)
pure val confidenceBpsValues = Set(0, 500, 849, 850, 1000)
pure def lawZeroCandidatesCreatesEntity(confidenceBps: int): bool =
  decideObservation(0, confidenceBps) == DecisionCreate
pure def lawLowConfidenceNeverAutoMerges(candidateCount: int, confidenceBps: int): bool =
  confidenceBps < autoMergeThresholdBps implies decideObservation(candidateCount, confidenceBps) != DecisionAutoMerge
pure def lawMultipleCandidatesNeverAutoMerge(candidateCount: int, confidenceBps: int): bool =
  candidateCount > 1 implies decideObservation(candidateCount, confidenceBps) == DecisionConflictMultiple
```

### Recipient confirmation rejects ambiguity, cross-contact conflicts, and stale reviews

Confirming an owner-reviewed email recipient fails closed if the input is
invalid, if more than one existing contact owns that email address, if an
explicitly requested contact conflicts with the address's existing owner, if the
requested contact disappeared, or if its reviewed name or type changed.

```quint
type RecipientVerdict = RecipientConfirmed | RecipientInvalid | RecipientAmbiguous | RecipientConflict | RecipientNotFound | RecipientReviewStale
type RecipientCheck = {
  inputValid: bool,
  addressMatches: int,
  requestedMatchesExistingOwner: bool,
  requestedMissing: bool,
  reviewMatchesCurrent: bool
}
pure def evaluateRecipientConfirmation(c: RecipientCheck): RecipientVerdict =
  if (not(c.inputValid)) RecipientInvalid
  else if (c.addressMatches > 1) RecipientAmbiguous
  else if (not(c.requestedMatchesExistingOwner)) RecipientConflict
  else if (c.requestedMissing) RecipientNotFound
  else if (not(c.reviewMatchesCurrent)) RecipientReviewStale
  else RecipientConfirmed
pure val baseCheck: RecipientCheck = {
  inputValid: true,
  addressMatches: 1,
  requestedMatchesExistingOwner: true,
  requestedMissing: false,
  reviewMatchesCurrent: true
}
pure val cValues = Set(
  baseCheck,
  { ...baseCheck, inputValid: false },
  { ...baseCheck, addressMatches: 2 },
  { ...baseCheck, requestedMatchesExistingOwner: false },
  { ...baseCheck, requestedMissing: true },
  { ...baseCheck, reviewMatchesCurrent: false }
)
pure def lawAmbiguousEmailRecipientIsRefused(c: RecipientCheck): bool =
  (c.inputValid and c.addressMatches > 1) implies evaluateRecipientConfirmation(c) == RecipientAmbiguous
pure def lawStaleReviewNeverConfirms(c: RecipientCheck): bool =
  not(c.reviewMatchesCurrent) implies evaluateRecipientConfirmation(c) != RecipientConfirmed
```

### Retired app_relationships data blocks startup until operator-approved import

The legacy-schema audit service inspects `app_relationships.entities` and
`app_relationships.relationships` without creating, altering, or deleting them.
Startup succeeds only when both tables are absent or empty.

```quint
pure def legacyAuditPasses(entityRows: int, relationshipRows: int): bool =
  entityRows == 0 and relationshipRows == 0
pure val entityRowsValues = Set(0, 1, 5)
pure val relationshipRowsValues = Set(0, 1, 5)
pure def lawNonEmptyLegacySchemaFailsClosed(entityRows: int, relationshipRows: int): bool =
  (entityRows > 0 or relationshipRows > 0) implies not(legacyAuditPasses(entityRows, relationshipRows))
```
