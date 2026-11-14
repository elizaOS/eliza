# Complete source-bound model context

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/runtime/completion-context.ts`, `provider-context.ts`, `context-object.ts`, `context-hash.ts`, `context-renderer.ts`, and their consumers. A source identity represents the actual stable hash of the turn, room, message, source metadata, complete text and historical evidence. The model uses a monotonically changing revision to represent identity equality. Hashing, tokenization and model judgment remain external boundaries and do not gain correctness merely from this abstraction.

## Story: Select relevant history while retaining complete evidence

As an agent, I can select exact relevant prior dialogue only after a complete source-bound review. Current requests, instructions, provider constraints, runtime feedback and current tool evidence remain present. Original source bodies and attribution remain available for restoration. An invalid, stale or incomplete selector retains full history.

### Context starts with complete original sources and mandatory evidence

```quint
type Source = { id: str, text: str, author: str }
type Context = { originals: List[Source], visible: List[Source], mandatory: List[str], renderedMandatory: List[str], revision: int, selected: bool, restored: bool }
pure val initial: Context = { originals: List(), visible: List(), mandatory: List(), renderedMandatory: List(), revision: 0, selected: false, restored: false }
pure def load(s: Context, originals: List[Source], mandatory: List[str]): Context =
  { originals: originals, visible: originals, mandatory: mandatory, renderedMandatory: mandatory, revision: s.revision + 1, selected: false, restored: false }
pure val originalsValues = Set(List(), List({ id: "h1", text: "original request", author: "user" }, { id: "h2", text: "original response", author: "agent" }))
pure val mandatoryValues = Set(List(), List("current request", "standing instructions", "current tool evidence"))
pure def alwaysMandatoryEvidenceIsComplete(s: Context): bool = s.renderedMandatory == s.mandatory
pure def alwaysVisibleSourcesAreExactOriginals(s: Context): bool = s.visible.every(source => s.originals.includes(source))
pure def alwaysFullModeContainsAllSources(s: Context): bool = not(s.selected) implies s.visible == s.originals
pure def alwaysSourceIdentityIsValid(s: Context): bool = s.revision >= 0
```

### Only complete current-source selections project prior dialogue

Each selected source retains all its bytes and original author. Empty selections are valid after review. The selector cannot remove mandatory evidence. Source IDs outside the current source set invalidate the entire selector. A valid selector retaining every source returns the complete context with no applied projection.

```quint
pure def selectionValid(s: Context, keep: Set[str], expectedRevision: int, complete: bool, shapeValid: bool): bool =
  complete and shapeValid and expectedRevision == s.revision and s.originals.length() > 0 and s.originals.every(source => s.originals.select(other => other.id == source.id).length() == 1) and keep.forall(id => s.originals.some(source => source.id == id))
pure def selectHistory(s: Context, keep: Set[str], expectedRevision: int, complete: bool, shapeValid: bool): Context = {
  val retained = s.originals.select(source => keep.contains(source.id))
  if (selectionValid(s, keep, expectedRevision, complete, shapeValid) and retained.length() < s.originals.length()) { ...s, visible: retained, selected: true, restored: false }
  else { ...s, visible: s.originals, selected: false, restored: false }
}
pure def alwaysSelectedHistoryKeepsOrder(s: Context): bool = s.selected implies (s.visible.length() < s.originals.length() and s.originals.every(source => s.originals.select(other => other.id == source.id).length() == 1) and s.visible == s.originals.select(source => s.visible.some(retained => retained.id == source.id)))
pure def lawKeepingEverySourceDoesNotApply(s: Context, keep: Set[str], expectedRevision: int, complete: bool, shapeValid: bool): bool = s.originals.every(source => keep.contains(source.id)) implies not(selectHistory(s, keep, expectedRevision, complete, shapeValid).selected)
pure val keepValues = Set(Set(), Set("h1"), Set("h2"), Set("h1", "h2"), Set("unknown"))
pure val expectedRevisionValues = Set(-1, 0, 1, 2)
pure def stepInvalidSelectionRetainsFullContext(before: Context, via: str, after: Context): bool =
  via != "selectHistory" or after.selected or after.visible == after.originals
pure def sometimesReviewedEmptySelection(s: Context): bool = s.selected and s.visible.length() == 0
```

### Loading a source set invalidates the old selection and restoring returns exact originals

The runtime never rewrites the original source bodies as summaries. Loading a complete source set advances its identity and returns to full context until a new review binds that identity.

```quint
pure def restore(s: Context): Context = { ...s, visible: s.originals, selected: false, restored: true }
pure def alwaysRestorationIsExact(s: Context): bool = s.restored implies s.visible == s.originals
pure def sometimesRestoreAfterSelection(s: Context): bool = s.restored and s.visible.length() == 2
```

## Story: Keep historical evidence bound to its own request

As an agent, I can defer a historical navigation receipt only with its unambiguous original request. Historical read observations require canonical validated receipt shapes. Historical mutations remain inline by default. A reviewed explicit projection may defer settled effects, and an owner-scoped terminal proof may establish done, rejected or expired state. Current effects and uncertain outcomes remain inline.

### A historical evidence projection requires exact validated source binding

```quint
pure def historicalEvidenceMayFollowRequest(knownRequest: bool, uniqueBinding: bool, canonicalReceipt: bool, isMutation: bool, explicitlyReviewed: bool, settledOnly: bool, committedOutcome: bool, trustedTerminal: bool): bool =
  knownRequest and uniqueBinding and canonicalReceipt and (not(isMutation) or (explicitlyReviewed and (not(settledOnly) or committedOutcome or trustedTerminal)))
pure def lawUnknownReceiptStaysInline(uniqueBinding: bool, canonicalReceipt: bool, isMutation: bool, explicitlyReviewed: bool, settledOnly: bool, committedOutcome: bool, trustedTerminal: bool): bool =
  not(historicalEvidenceMayFollowRequest(false, uniqueBinding, canonicalReceipt, isMutation, explicitlyReviewed, settledOnly, committedOutcome, trustedTerminal))
pure def lawMutationDefaultsToInline(knownRequest: bool, uniqueBinding: bool, canonicalReceipt: bool, settledOnly: bool, committedOutcome: bool, trustedTerminal: bool): bool =
  not(historicalEvidenceMayFollowRequest(knownRequest, uniqueBinding, canonicalReceipt, true, false, settledOnly, committedOutcome, trustedTerminal))
```

### Provider discovery preserves originals and requires source-bound review before selection

Only providers which explicitly publish an index may use discovery text. A restored source body can then participate in review. Discovery availability and selected relevance do not claim that an external operation ran.

```quint
pure def providerSelectionAllowed(hasIndex: bool, bodyLoaded: bool, uniqueSources: bool, currentIdentity: bool, reviewComplete: bool): bool =
  hasIndex and bodyLoaded and uniqueSources and currentIdentity and reviewComplete
pure def lawUnloadedProviderCannotBeReviewed(hasIndex: bool, uniqueSources: bool, currentIdentity: bool, reviewComplete: bool): bool =
  not(providerSelectionAllowed(hasIndex, false, uniqueSources, currentIdentity, reviewComplete))
```
