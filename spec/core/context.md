# Complete source-bound model context

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/runtime/completion-context.ts`, `provider-context.ts`, `context-object.ts`, `context-hash.ts`, `context-renderer.ts`, and their consumers. A source identity represents the actual stable hash of the turn, room, message, source metadata, complete text and historical evidence. The model uses a monotonically changing revision to represent identity equality. Hashing, tokenization and model judgment remain external boundaries and do not gain correctness merely from this abstraction.

## Story: Select relevant history while retaining complete evidence

> As an agent, I want to trim history only after a complete review of its
> sources, so that a reply never loses the request, instructions or
> evidence it depends on.

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

> As an agent, I want each historical receipt kept with the request it
> answered, so that old evidence is never read as an answer to a new
> request.

As an agent, I can defer a historical navigation receipt only with its unambiguous original request. Historical read observations require canonical validated receipt shapes. Historical mutations remain inline by default. An explicitly reviewed historical-effect projection may defer validated mutations. Its settled-only mode requires a committed outcome or an owner-scoped terminal proof establishing done, rejected or expired state; uncertain outcomes stay inline in that mode. The broader reviewed mode may also defer unsettled historical effects. Current effects remain inline.

### A historical evidence projection requires exact validated source binding

```quint
pure def historicalEvidenceMayFollowRequest(knownRequest: bool, uniqueBinding: bool, canonicalReceipt: bool, isMutation: bool, explicitlyReviewed: bool, settledOnly: bool, committedOutcome: bool, trustedTerminal: bool): bool =
  knownRequest and uniqueBinding and canonicalReceipt and (not(isMutation) or (explicitlyReviewed and (not(settledOnly) or committedOutcome or trustedTerminal)))
pure def lawUnknownReceiptStaysInline(uniqueBinding: bool, canonicalReceipt: bool, isMutation: bool, explicitlyReviewed: bool, settledOnly: bool, committedOutcome: bool, trustedTerminal: bool): bool =
  not(historicalEvidenceMayFollowRequest(false, uniqueBinding, canonicalReceipt, isMutation, explicitlyReviewed, settledOnly, committedOutcome, trustedTerminal))
pure def lawMutationDefaultsToInline(knownRequest: bool, uniqueBinding: bool, canonicalReceipt: bool, settledOnly: bool, committedOutcome: bool, trustedTerminal: bool): bool =
  not(historicalEvidenceMayFollowRequest(knownRequest, uniqueBinding, canonicalReceipt, true, false, settledOnly, committedOutcome, trustedTerminal))
```

### A recorded outcome is printed with only the fields a later step reads, under a legend fixed by its record kind

Only an exact canonical record the runtime wrote (historical navigation,
effects or observations, with a normalized receipt) is reprinted; anything
else stays as it is. An effect receipt keeps what was done (operation,
outcome, a no-op's reason, a failure, a commit's kind and its id when it
differs from the resource's) and what it was done to (the resource's kind
and id, each artifact's kind and id). Retry keys, observation times, store
versions and receipt identities bound proof inside the turn that made them,
so they are dropped, except that a request holding a rollback keeps its
receipt ids, which the rollback names. A navigation receipt drops its effect
name, step and handoff identities. A receipt in one of four fixed shapes
(the base, or the base with a reason, a commit kind or a failure) is printed
as `[shape, values]`; any other receipt is printed as an object. Each record
kind has one legend, which depends only on the kind, its columns and its
scope, never on which records are shown, and says each rule once: a row
depends only on its record and the label of its request, so the same input
gives the same bytes. A request inside the current dialogue window is named
`history:hN`, the label the request already carries, as are its
interruption and read-continuation notes. A later proposal state takes the
place of the one preview it supersedes, in that preview's own row. Since that
row drops the ending's own scope, the proposal legend also says that a reason
saying a request never ran means the owner declined it or it expired, which
answers whether the request ran, not what the resource holds now.

```quint
type ProposalEnding = OwnerDeclinedEnding | ExpiredEnding
pure def endingSaysTheRequestRan(ending: ProposalEnding): bool = false
pure def endingSaysWhatTheResourceHolds(ending: ProposalEnding): bool = false
pure val endingValues = Set(OwnerDeclinedEnding, ExpiredEnding)
pure def lawAnEndingAnswersOnlyWhetherTheRequestRan(ending: ProposalEnding): bool =
  not(endingSaysTheRequestRan(ending)) and not(endingSaysWhatTheResourceHolds(ending))
type ReceiptField = OperationField | ResourceField | ArtifactsField | OutcomeField | ReasonField | CommitField | FailureField | RollbackField | ReceiptIdField | IdempotencyField | ObservedAtField
pure def slimKeeps(part: ReceiptField, rolledBack: bool): bool =
  if (part == IdempotencyField or part == ObservedAtField) false
  else if (part == ReceiptIdField) rolledBack
  else true
pure val partValues = Set(OperationField, ResourceField, ArtifactsField, OutcomeField, ReasonField, CommitField, FailureField, RollbackField, ReceiptIdField, IdempotencyField, ObservedAtField)
pure def lawRetryKeysAndTimesNeverReachTheWire(rolledBack: bool): bool = not(slimKeeps(IdempotencyField, rolledBack)) and not(slimKeeps(ObservedAtField, rolledBack))
pure def lawAReceiptIdStaysOnlyBesideARollback(rolledBack: bool): bool = slimKeeps(ReceiptIdField, rolledBack) iff rolledBack
pure def lawWhatWasDoneAndToWhatIsKept(part: ReceiptField, rolledBack: bool): bool =
  (part != ReceiptIdField and part != IdempotencyField and part != ObservedAtField) implies slimKeeps(part, rolledBack)
```

### Provider discovery preserves originals and requires source-bound review before selection

Only providers which explicitly publish an index may use discovery text. A restored source body can then participate in review. Discovery availability and selected relevance do not claim that an external operation ran.

```quint
pure def providerSelectionAllowed(hasIndex: bool, bodyLoaded: bool, uniqueSources: bool, currentIdentity: bool, reviewComplete: bool): bool =
  hasIndex and bodyLoaded and uniqueSources and currentIdentity and reviewComplete
pure def lawUnloadedProviderCannotBeReviewed(hasIndex: bool, uniqueSources: bool, currentIdentity: bool, reviewComplete: bool): bool =
  not(providerSelectionAllowed(hasIndex, false, uniqueSources, currentIdentity, reviewComplete))
```

## Story: Keep a long conversation within reach on a host with no reviewer

> As the owner, I want to continue a task after a long conversation without
> unrelated old messages crowding out what this request needs, so that every
> turn stays fast and still sees the facts and instructions it depends on.

A host where no history reviewer runs, such as the phone, still bounds the history each model call carries. Once more than `maxSources` originals follow the reviewed boundary, the boundary moves to the first user message at or after the newest multiple of `maxSources - keepSources` that leaves `keepSources` originals after it. It depends only on how many messages the conversation stores and where the user messages are among them, counting the older messages a turn does not read as reviewed and counting every stored message, even a notice or an empty failed reply the history never shows, so it moves only in steps as the conversation grows, never with each turn's read or with which messages that read leaves out. While the latest exchange and the most recent originals lie past it, the history shown starts at the boundary, so between two moves it only grows at its end and a provider can reuse the prompt prefix. The boundary starts on a user message, so a reply is never shown without its request. It is a deferral by position, never a review: the deferred originals keep every byte, stay readable through the history references, and the model is told how many are not shown. User messages worded as standing instructions stay in the history. Up to three earlier exchanges that share distinctive words with the current request are recalled for that turn alone: they follow the latest message, after the notice, labelled as recalled and in their original order, the notice tells the model to answer from them as from the messages shown, and they never enter the history, so what a request says never changes the history before it. Word and wording matches are external judgments of the shell.

### A host with no reviewer defers old history by position, in fixed steps from a user message

```quint
pure def windowBoundary(count: int, userPositions: List[int], reviewed: int, maxSources: int, keepSources: int): int = {
  val stride = maxSources - keepSources
  val stepped = if (stride < 1 or count < keepSources) 0 else ((count - keepSources) / stride) * stride
  val boundary = userPositions.foldl(count, (found, position) => if (position >= stepped and position < found) position else found)
  if (count - reviewed <= maxSources or boundary <= reviewed) reviewed else boundary
}
pure def shownFrom(count: int, boundary: int, exchangeStart: int, maxSources: int, continuitySources: int): int = {
  val bounded = if (exchangeStart < count - maxSources) count - maxSources else exchangeStart
  val continuityStart = if (count < continuitySources) 0 else count - continuitySources
  val start = if (bounded < continuityStart) bounded else continuityStart
  if (start < boundary) start else boundary
}
pure val userPositionsValues = Set(List(), List(0), List(0, 2), List(1, 3, 5), List(0, 2, 4, 6))
pure val maxSourcesValues = Set(4)
pure val keepSourcesValues = Set(2)
pure val continuitySourcesValues = Set(0, 2)
pure def lawShortHistoryIsNotWindowed(count: int, userPositions: List[int], reviewed: int, maxSources: int, keepSources: int): bool =
  count - reviewed <= maxSources implies windowBoundary(count, userPositions, reviewed, maxSources, keepSources) == reviewed
pure def lawWindowNeverMovesBack(count: int, userPositions: List[int], reviewed: int, maxSources: int, keepSources: int): bool =
  windowBoundary(count, userPositions, reviewed, maxSources, keepSources) >= reviewed
pure def lawEverythingPastTheBoundaryIsShown(count: int, boundary: int, exchangeStart: int, maxSources: int, continuitySources: int): bool =
  shownFrom(count, boundary, exchangeStart, maxSources, continuitySources) <= boundary
pure def lawRecentContinuityIsShown(count: int, boundary: int, exchangeStart: int, maxSources: int, continuitySources: int): bool =
  shownFrom(count, boundary, exchangeStart, maxSources, continuitySources) <= (if (count < continuitySources) 0 else count - continuitySources)
pure def lawTheShownHistoryStartsAtTheBoundary(count: int, boundary: int, exchangeStart: int, maxSources: int, continuitySources: int): bool =
  (exchangeStart >= boundary and count >= continuitySources and count - continuitySources >= boundary) implies shownFrom(count, boundary, exchangeStart, maxSources, continuitySources) == boundary
```

### A note about one request leaves the view with that request

An interruption note or a read-continuation record describes one request. When that request is a known original and neither it nor the interrupted reply is shown, the note is not shown either; a note bound to no known request stays inline.

```quint
pure def noteShown(requestKnown: bool, requestShown: bool, replyShown: bool): bool =
  not(requestKnown) or requestShown or replyShown
pure def lawNoteLeavesWithItsRequest(requestShown: bool, replyShown: bool): bool =
  (not(requestShown) and not(replyShown)) implies not(noteShown(true, requestShown, replyShown))
pure def lawUnboundNoteStaysInline(requestShown: bool, replyShown: bool): bool =
  noteShown(false, requestShown, replyShown)
```

## Story: Know when each earlier message was said

> As the owner, I want the agent to know when each earlier message was
> said, so that it can answer "what did I ask this morning" and order what
> was said against the clock.

### A message's stamp is its local date and minute, with the year only when it is not the newest year and an offset only when the minute alone names no one instant

A historical message reaches the model as `[message_at=MM-DD HH:MM] `
followed by its own text: the date and minute it was recorded, in the
display zone its host names. Position already orders the messages within
a minute, and the clock line states the zone, so the stamp carries no
seconds, milliseconds or offset. `YYYY-` leads the date when the
message's local year is not the year of the newest event shown with it: a
recalled exchange can be older than that. With no usable display zone the
stamp is the UTC date and minute followed by `Z`. In the hour a zone sets
its clocks back the same minute is shown twice, and only there the stamp
ends with its `+HH:MM` or `-HH:MM` offset; the hour skipped in spring is
shown by no clock and needs none. A message with no recorded time, or one
that is not a positive whole number of milliseconds, carries no stamp.
Nothing parses a stamp back, and the stored text is never changed.
Reading the zone's calendar is the shell's.

```quint
type StampOffset = OffsetOmitted | UtcMarked | OffsetNamed
pure def stampNamesYear(messageYear: str, newestYear: str): bool = messageYear != newestYear
pure def stampOffset(zoneUsable: bool, minuteRepeats: bool): StampOffset =
  if (not(zoneUsable)) UtcMarked else if (minuteRepeats) OffsetNamed else OffsetOmitted
pure val messageYearValues = Set("2025", "2026")
pure val newestYearValues = Set("", "2025", "2026")
pure def lawAMessageOfTheNewestYearOmitsIt(messageYear: str): bool = not(stampNamesYear(messageYear, messageYear))
pure def lawAnyOtherYearIsNamed(messageYear: str, newestYear: str): bool = messageYear != newestYear implies stampNamesYear(messageYear, newestYear)
pure def lawWithoutAUsableZoneTheStampIsMarkedUtc(minuteRepeats: bool): bool = stampOffset(false, minuteRepeats) == UtcMarked
pure def lawOnlyARepeatedLocalMinuteNamesItsOffset(zoneUsable: bool, minuteRepeats: bool): bool =
  (stampOffset(zoneUsable, minuteRepeats) == OffsetNamed) iff (zoneUsable and minuteRepeats)
```
