# Grace observed website answers and retained results

Grace `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` uses `website-goal-contract.ts`, `website-goal-evidence.ts`, `website-observed-answer.ts`, and `website-result-store.ts` through the release's generic website guide, task routes and Tasks board. The native release enables the agent-actions path that interprets a goal before planning. Eliza `7743504b7c936a764b3938a44cad918808b621df` supplies `InteractiveTaskRuntime.complete` in `packages/agent/src/services/interactive-task-runtime.ts`. [Website guidance](websiteGuide.md) owns authorized task actions. [Payment guidance](paymentGuidance.md) owns payment evidence. This result is an observation of what a website says.

## Story: Show a website answer for the entire request with the supporting words

### The goal contract keeps the user's entire request and names each requested outcome

Goal interpretation receives the complete redacted original request with no website observations. The model's segments reproduce that request, including whitespace and punctuation. The decoder accepts a whitespace repair only where the supplied segment's trimmed text matches the corresponding original span exactly. It uses one through 64 segments and assigns `g1`, `g2`, and so on in source order. The goal is nonblank and at most 12,000 UTF-16 units. Each segment has exactly text, role, kind and condition. Text is nonempty. Condition is nonblank and at most 2,000 units. A requirement has one of read, navigate, authenticate, change, payment or unknown. A constraint or context segment has kind none. At least one requirement is required. The canonical answer redecodes the segment fields and derives the IDs again. Structural admission is separate from the semantic correctness of those classifications.

```quint
type GoalEntry = { exactKeys: bool, textNonempty: bool, conditionNonblank: bool, conditionUnits: int, role: str, kind: str }
type GoalShape = { exactKeys: bool, goalNonblank: bool, goalUnits: int, exactSourceText: bool, segments: List[GoalEntry] }
pure def validGoalEntry(segment: GoalEntry): bool =
  segment.exactKeys and segment.textNonempty and segment.conditionNonblank and segment.conditionUnits >= 1 and segment.conditionUnits <= 2000 and
  (if (segment.role == "requirement") Set("read", "navigate", "authenticate", "change", "payment", "unknown").contains(segment.kind)
   else Set("constraint", "context").contains(segment.role) and segment.kind == "none")
pure def validGoalShape(goalShape: GoalShape): bool =
  goalShape.exactKeys and goalShape.goalNonblank and goalShape.goalUnits >= 1 and goalShape.goalUnits <= 12000 and
  goalShape.exactSourceText and goalShape.segments.length() >= 1 and goalShape.segments.length() <= 64 and
  goalShape.segments.every(validGoalEntry) and goalShape.segments.some(segment => segment.role == "requirement")
pure def lawGoalCannotOmitRequestText(goalShape: GoalShape): bool =
  validGoalShape(goalShape) implies goalShape.exactSourceText and goalShape.segments.some(segment => segment.role == "requirement")
pure def lawConstraintCannotBecomeActionKind(segment: GoalEntry): bool =
  validGoalEntry(segment) and segment.role == "constraint" implies segment.kind == "none"
pure val goalRead: GoalEntry = { exactKeys: true, textNonempty: true, conditionNonblank: true, conditionUnits: 8, role: "requirement", kind: "read" }
pure val goalConstraint: GoalEntry = { ...goalRead, role: "constraint", kind: "none" }
pure val goalValid: GoalShape = { exactKeys: true, goalNonblank: true, goalUnits: 20, exactSourceText: true, segments: List(goalRead, goalConstraint) }
pure val segmentValues = Set(goalRead, goalConstraint, { ...goalRead, kind: "unknown" }, { ...goalRead, exactKeys: false }, { ...goalConstraint, kind: "payment" }, { ...goalRead, conditionUnits: 2001 })
pure val goalShapeValues = Set(goalValid, { ...goalValid, exactSourceText: false }, { ...goalValid, goalUnits: 12001 }, { ...goalValid, segments: List(goalConstraint) }, { ...goalValid, segments: List() })
```

### A separate completion review cites exact quotes under every requirement ID

A proposed done step with a goal contract is reviewed against redacted sources identified as earlier pages `p0`, `p1` and so on, the present page `current`, and runtime readbacks `a0`, `a1` and so on. Page sources include the path or URL with search and fragment removed, titles, headings, text, control labels and control facts without hrefs. A fill readback without explicit exact-value verification carries the requested public value as a command, with changed nonempty input as its evidence. An earlier readback cannot establish a later effect. This inference gives advisory semantic coverage of requirements and gives no authority or constraint audit.

The response has only a requirements object with exactly the original requirement IDs. Each entry has only status and quotes. Status is supported, not-shown or contradicted. A supported entry has one or more quotes and its goal kind is known. A not-shown entry has zero quotes. The decoder accepts a contradicted entry with zero quotes, even though the model instruction asks for a supporting conflict quote. Every entry has at most eight quotes. A quote has only source ID and text. Its ID names a supplied source. Its text is a nonblank exact substring of at most 2,000 units. Accepted entries are returned in goal order. The host retries structurally invalid reviews twice, using the original sources each time. An accepted review with any unsupported outcome gives needs-help. Three invalid replies give a 502 in the planner. A visible blocker that takes the prior handover path prevents the review.

```quint
type ReviewQuote = { exactKeys: bool, sourceKnown: bool, textNonblank: bool, textUnits: int, exactSubstring: bool }
type RequirementReview = { exactKeys: bool, requirementKind: str, status: str, quotes: List[ReviewQuote] }
type EvidenceReview = { exactTopKeys: bool, exactRequirementIds: bool, entries: List[RequirementReview] }
pure def validReviewQuote(quote: ReviewQuote): bool =
  quote.exactKeys and quote.sourceKnown and quote.textNonblank and quote.textUnits >= 1 and quote.textUnits <= 2000 and quote.exactSubstring
pure def validRequirementReview(review: RequirementReview): bool =
  review.exactKeys and Set("supported", "not-shown", "contradicted").contains(review.status) and
  review.quotes.length() <= 8 and review.quotes.every(validReviewQuote) and
  (review.status == "supported" implies review.quotes.length() >= 1 and review.requirementKind != "unknown") and
  (review.status == "not-shown" implies review.quotes.length() == 0)
pure def reviewVerdict(evidence: EvidenceReview): str =
  if (not(evidence.exactTopKeys and evidence.exactRequirementIds and evidence.entries.every(validRequirementReview))) "invalid"
  else if (evidence.entries.every(review => review.status == "supported")) "supported"
  else "needs-help"
pure def reviewAfterAttempt(verdict: str, attempt: int): str =
  if (verdict != "invalid") verdict else if (attempt < 3) "retry" else "planner-502"
pure def lawUnknownRequirementCannotBeSupported(review: RequirementReview): bool =
  review.requirementKind == "unknown" and review.status == "supported" implies not(validRequirementReview(review))
pure def lawMissingRequirementCannotPass(evidence: EvidenceReview): bool =
  not(evidence.exactRequirementIds) implies reviewVerdict(evidence) == "invalid"
pure def lawThirdInvalidReplyIsFinal(attempt: int): bool =
  attempt >= 3 implies reviewAfterAttempt("invalid", attempt) == "planner-502"
pure val goodQuote: ReviewQuote = { exactKeys: true, sourceKnown: true, textNonblank: true, textUnits: 7, exactSubstring: true }
pure val supportedReview: RequirementReview = { exactKeys: true, requirementKind: "read", status: "supported", quotes: List(goodQuote) }
pure val reviewValues = Set(supportedReview, { ...supportedReview, requirementKind: "unknown" }, { ...supportedReview, quotes: List() }, { ...supportedReview, status: "contradicted", quotes: List() }, { ...supportedReview, status: "not-shown" }, { ...supportedReview, quotes: List({ ...goodQuote, exactSubstring: false }) })
pure val evidenceValues = Set(
  { exactTopKeys: true, exactRequirementIds: true, entries: List(supportedReview) },
  { exactTopKeys: true, exactRequirementIds: false, entries: List(supportedReview) },
  { exactTopKeys: false, exactRequirementIds: true, entries: List(supportedReview) },
  { exactTopKeys: true, exactRequirementIds: true, entries: List({ ...supportedReview, status: "not-shown", quotes: List() }) })
pure val quoteValues = Set(goodQuote, { ...goodQuote, exactSubstring: false }, { ...goodQuote, sourceKnown: false }, { ...goodQuote, textUnits: 2001 })
pure val attemptValues = Set(1, 2, 3)
pure val verdictValues = Set("invalid", "supported", "needs-help")
```

### The displayed answer binds to the current cleaned address and page body

The creator requires a qualifying review for every requirement ID exactly once. Read and authenticate each require a quote from the present redacted body. A navigate requirement can rely on an older source, while the finished answer still needs at least one current excerpt. Only read, navigate and authenticate are eligible for this answer format. The creator keeps only current-source quotes found in the redacted body and deduplicates identical text in requirement and quote order. It stores the canonical goal contract and `origin + pathname` of the current address without query or fragment. It subjects the created value to the same read check before handing it on.

The read check requires version 1, a matching canonical goal, the same cleaned address, and one through 16 nonblank exact excerpts of the current redacted body. It reconstructs `The website says: ` followed by all excerpts joined with ` · `. The complete message must fit 400 UTF-16 units. The browser-side planner path repeats the check before showing a done answer and shows a check-again prompt on mismatch. A stored result is read against its retained excerpts rather than against a fresh live page. The codec's exact text, key, redaction and address comparisons are supplied as boundary facts to the model.

```quint
type AnswerQuote = { sourceIsCurrent: bool, inRedactedBody: bool, exactTextId: int }
type AnswerCoverage = { requirementKind: str, onceSupported: bool, quotes: List[AnswerQuote] }
type AnswerInput = { goalRevalidated: bool, reportsAllSupported: bool, requirementCountMatches: bool, coverage: List[AnswerCoverage] }
type AnswerShape = { versionOne: bool, canonicalGoal: bool, addressMatches: bool, observationOnly: bool, excerptsArray: bool, excerptsTotal: int, excerptsAllCurrent: bool, messageUnits: int }
pure def observationKind(kind: str): bool = Set("read", "navigate", "authenticate").contains(kind)
pure def currentAnswerQuote(answerQuote: AnswerQuote): bool = answerQuote.sourceIsCurrent and answerQuote.inRedactedBody
pure def coversCurrentAnswer(coverageEntry: AnswerCoverage): bool =
  observationKind(coverageEntry.requirementKind) and coverageEntry.onceSupported and
  (coverageEntry.requirementKind == "navigate" or coverageEntry.quotes.some(currentAnswerQuote))
pure def appendAnswerQuote(excerpts: List[int], answerQuote: AnswerQuote): List[int] =
  if (currentAnswerQuote(answerQuote) and not(excerpts.includes(answerQuote.exactTextId))) excerpts.append(answerQuote.exactTextId)
  else excerpts
pure def answerQuoteIds(answers: List[AnswerCoverage]): List[int] =
  answers.foldl(List(), (excerpts, coverageEntry) => coverageEntry.quotes.foldl(excerpts, appendAnswerQuote))
pure def observedAnswerCoverageValid(answerInput: AnswerInput): bool =
  answerInput.goalRevalidated and answerInput.reportsAllSupported and answerInput.requirementCountMatches and answerInput.coverage.every(coversCurrentAnswer)
pure def observedAnswerReadable(answerShape: AnswerShape): bool =
  answerShape.versionOne and answerShape.canonicalGoal and answerShape.addressMatches and answerShape.observationOnly and answerShape.excerptsArray and
  answerShape.excerptsTotal >= 1 and answerShape.excerptsTotal <= 16 and answerShape.excerptsAllCurrent and answerShape.messageUnits >= 1 and answerShape.messageUnits <= 400
pure def lawObservedAnswerCannotShowPreviousSource(coverageEntry: AnswerCoverage): bool =
  coversCurrentAnswer(coverageEntry) and coverageEntry.requirementKind != "navigate" implies coverageEntry.quotes.some(currentAnswerQuote)
pure def lawDisplayKeepsWholeAnswer(answerShape: AnswerShape): bool =
  observedAnswerReadable(answerShape) implies answerShape.addressMatches and answerShape.excerptsAllCurrent and answerShape.messageUnits <= 400
pure def lawOnlyCurrentQuotesEnterExcerpts(excerpts: List[int], answerQuote: AnswerQuote): bool =
  not(currentAnswerQuote(answerQuote)) implies appendAnswerQuote(excerpts, answerQuote) == excerpts
pure val bodyQuote: AnswerQuote = { sourceIsCurrent: true, inRedactedBody: true, exactTextId: 1 }
pure val pastQuote: AnswerQuote = { ...bodyQuote, sourceIsCurrent: false, exactTextId: 2 }
pure val readCoverage: AnswerCoverage = { requirementKind: "read", onceSupported: true, quotes: List(bodyQuote) }
pure val navCoverage: AnswerCoverage = { requirementKind: "navigate", onceSupported: true, quotes: List(pastQuote) }
pure val coverageEntryValues = Set(readCoverage, navCoverage, { ...readCoverage, quotes: List(pastQuote) }, { ...readCoverage, requirementKind: "payment" }, { ...readCoverage, onceSupported: false })
pure val answerQuoteValues = Set(bodyQuote, pastQuote, { ...bodyQuote, inRedactedBody: false }, { ...bodyQuote, exactTextId: 2 })
pure val excerptsValues = Set(List(), List(1), List(1, 2))
pure val answersValues = Set(List(), List(readCoverage), List(navCoverage, readCoverage), List(readCoverage, readCoverage))
pure val answerInputValues = Set(
  { goalRevalidated: true, reportsAllSupported: true, requirementCountMatches: true, coverage: List(readCoverage) },
  { goalRevalidated: true, reportsAllSupported: true, requirementCountMatches: false, coverage: List(readCoverage) },
  { goalRevalidated: true, reportsAllSupported: true, requirementCountMatches: true, coverage: List({ ...readCoverage, quotes: List(pastQuote) }) })
pure val readableAnswer: AnswerShape = { versionOne: true, canonicalGoal: true, addressMatches: true, observationOnly: true, excerptsArray: true, excerptsTotal: 1, excerptsAllCurrent: true, messageUnits: 37 }
pure val answerShapeValues = Set(readableAnswer, { ...readableAnswer, addressMatches: false }, { ...readableAnswer, canonicalGoal: false }, { ...readableAnswer, observationOnly: false }, { ...readableAnswer, excerptsTotal: 0 }, { ...readableAnswer, excerptsTotal: 17 }, { ...readableAnswer, messageUnits: 400 }, { ...readableAnswer, messageUnits: 401 })
```

## Story: Preserve a checked answer while honoring the task's completion and ownership fences

### An active current task can save an answer and only an eligible answer can request completion

The host rebuilds the answer from reviewed evidence on the planned page. The planner's returned prose supplies no saved words. Before retaining a plan, the host checks the current active epoch, captured goal and goal revision, abort and helper lifetime. The result method hands the route a record only for done, with a held answer in the current active epoch and unchanged goal revision. It binds the current task revision and records the host clock when producing that result. The route rechecks authorization before save. Saving requires the exact active revision and epoch, record version 1, an already-redacted string goal, safe nonnegative revision and epoch, and a positive safe observation time. Durable validation requires a credential-free HTTPS URL without query or fragment and the answer codec against retained excerpts. The row is refused at or beyond the retention boundary.

The storage key is task ID and revision. Reads filter by owner and choose the highest revision. A competing foreign owner at the same durable key cannot be overwritten. A repeat with exactly the same serialized document apart from observation time retains the first record. A different result at that revision conflicts. An owned marker for that revision is removed before inserting a fresh valid reading. A write or reread can fail, and the route projects unavailable. The measurement clock is not extended by a repeated save.

A successfully saved observation is eligible only when its canonical goal has no constraint segment. The route requests completion only after saving and then reloads. The trusted Eliza runtime reads the exact active revision, checks authorization, applies the complete control and settles. The shared core rejects completion with an unresolved operation. The retained view marks the result completed only when the durable task is completed with both revision and epoch one greater than the saved values. A saved answer that does not complete the task is presented as request unfinished. The save and task completion are separate operations, so a completion error can leave the answer stored.

```quint
type HostResult = { done: bool, heldAnswer: bool, taskActive: bool, sameEpoch: bool, sameGoalRevision: bool }
pure def hostMayProduce(resultFacts: HostResult): bool =
  resultFacts.done and resultFacts.heldAnswer and resultFacts.taskActive and resultFacts.sameEpoch and resultFacts.sameGoalRevision
type ResultTaskShape = { taskStatus: str, taskRevision: int, taskEpoch: int }
type SavedAnswerShape = { versionOne: bool, redactedGoal: bool, cleanHttps: bool, answerValid: bool, observedAt: int, revision: int, epoch: int, hasConstraint: bool }
type SaveAttempt = { task: ResultTaskShape, record: SavedAnswerShape, clock: int, previous: str, equalExceptTime: bool }
pure val retentionMs = 1209600000
pure def safeNonnegative(number: int): bool = number >= 0 and number <= 9007199254740991
pure def elapsedRetention(observedAt: int, clock: int): bool = observedAt <= clock - retentionMs
pure def storedAnswerValid(record: SavedAnswerShape): bool =
  record.versionOne and record.redactedGoal and record.cleanHttps and record.answerValid and safeNonnegative(record.revision) and
  safeNonnegative(record.epoch) and safeNonnegative(record.observedAt) and record.observedAt > 0
pure def saveAnswer(attemptSave: SaveAttempt): str =
  if (attemptSave.task.taskStatus != "active" or attemptSave.task.taskRevision != attemptSave.record.revision or attemptSave.task.taskEpoch != attemptSave.record.epoch) "task-conflict"
  else if (not(storedAnswerValid(attemptSave.record))) "invalid-record"
  else if (elapsedRetention(attemptSave.record.observedAt, attemptSave.clock)) "already-expired"
  else if (attemptSave.previous == "own-answer") (if (attemptSave.equalExceptTime) "keep-first" else "review-conflict")
  else if (attemptSave.previous == "foreign-key") "key-conflict"
  else "write"
pure def matchingCompletion(taskShape: ResultTaskShape, eligible: bool, revision: int, epoch: int): bool =
  eligible and taskShape.taskStatus == "completed" and taskShape.taskRevision == revision + 1 and taskShape.taskEpoch == epoch + 1
pure def routeAfterSave(stored: bool, completed: bool): str =
  if (not(stored)) "guide-decision"
  else if (completed) "finished" else "request-unfinished"
pure def completionAdmission(taskShape: ResultTaskShape, expectedRevision: int, ownerCurrent: bool, unresolved: bool): str =
  if (taskShape.taskStatus != "active" or taskShape.taskRevision != expectedRevision) "TASK_CONFLICT"
  else if (not(ownerCurrent)) "TASK_UNAUTHORIZED"
  else if (unresolved) "TASK_UNKNOWN_OUTCOME"
  else "complete"
pure def lawSavedResultNeedsExactActiveScope(attemptSave: SaveAttempt): bool =
  Set("write", "keep-first").contains(saveAnswer(attemptSave)) implies
  attemptSave.task.taskStatus == "active" and attemptSave.task.taskRevision == attemptSave.record.revision and attemptSave.task.taskEpoch == attemptSave.record.epoch and
  storedAnswerValid(attemptSave.record) and not(elapsedRetention(attemptSave.record.observedAt, attemptSave.clock))
pure def lawCompletionMatchesBothSuccessors(taskShape: ResultTaskShape, eligible: bool, revision: int, epoch: int): bool =
  matchingCompletion(taskShape, eligible, revision, epoch) implies eligible and taskShape.taskStatus == "completed" and taskShape.taskRevision == revision + 1 and taskShape.taskEpoch == epoch + 1
pure val hostResult: HostResult = { done: true, heldAnswer: true, taskActive: true, sameEpoch: true, sameGoalRevision: true }
pure val resultFactsValues = Set(hostResult, { ...hostResult, sameGoalRevision: false }, { ...hostResult, sameEpoch: false }, { ...hostResult, done: false })
pure val activeTaskShape: ResultTaskShape = { taskStatus: "active", taskRevision: 3, taskEpoch: 2 }
pure val completedTaskShape: ResultTaskShape = { taskStatus: "completed", taskRevision: 4, taskEpoch: 3 }
pure val freshAnswer: SavedAnswerShape = { versionOne: true, redactedGoal: true, cleanHttps: true, answerValid: true, observedAt: retentionMs * 2, revision: 3, epoch: 2, hasConstraint: false }
pure val recordValues = Set(freshAnswer, { ...freshAnswer, cleanHttps: false }, { ...freshAnswer, observedAt: 0 }, { ...freshAnswer, answerValid: false }, { ...freshAnswer, revision: -1 })
pure val saving: SaveAttempt = { task: activeTaskShape, record: freshAnswer, clock: retentionMs * 2, previous: "none", equalExceptTime: false }
pure val attemptSaveValues = Set(saving, { ...saving, task: completedTaskShape }, { ...saving, clock: retentionMs * 3 }, { ...saving, previous: "foreign-key" }, { ...saving, previous: "own-marker" }, { ...saving, previous: "own-answer" }, { ...saving, previous: "own-answer", equalExceptTime: true })
pure val taskShapeValues = Set(activeTaskShape, completedTaskShape, { ...completedTaskShape, taskEpoch: 4 }, { ...completedTaskShape, taskRevision: 5 })
pure val revisionValues = Set(0, 3, 4)
pure val expectedRevisionValues = Set(0, 3, 4)
pure val epochValues = Set(0, 2, 3)
pure val clockValues = Set(retentionMs * 2, retentionMs * 3 - 1, retentionMs * 3)
```

### Expiry deletes the answer for every owner and preserves only a matching completion marker

Store startup, list, load and save sweep elapsed documents across all owners. A fresh row ages from its original observed time. At the cutoff the answer, goal and address are removed. An existing marker stays. A sweep-eligible document can leave a marker only with a positive safe observation time, safe revision and epoch, and a readable constraint scan. The marker contains only version, expired, revision, epoch and completion eligibility. A row selected for expiry without the required marker fields is deleted. The pinned SQL uses `json_extract` when selecting rows, so malformed JSON can fail the sweep before per-row handling. A valid JSON row rejected by read validation is handled per row on list after the sweep. The model takes selection and parsing facts at this boundary.

An expired marker renders a completed historical response only if eligibility, task status, revision and epoch all match the completion. That response has null URL and time, saved false, and a fixed deletion message. An unmatched marker looks absent. A missing result on a completed task still produces the route's finished response and does not restart guidance. Details and mutations other than check and show-guidance conflict in those finished branches. A retained but non-completing answer takes the ordinary route branch, even when the task status itself is completed.

The board reads up to 24 candidate task IDs ordered by newest row insertion, loads the latest revision of each owned task, and shows only saved completed answers after filtering hidden tasks. An expired marker does not consume a displayed row, but can consume one of the candidate slots. A malformed selected document with a successful sweep is expired or deleted and skipped. An error fetching a selected task can fail the list; the route rechecks ownership before sending results. The renderer revalidates the list and its task IDs, timestamps, safe addresses and message bounds; stale account-generation results are dropped, and failed refresh leaves the previous list in place.

```quint
type ExpiryDocument = { marker: bool, selectedBySweep: bool, fieldsReadable: bool, observedAt: int, revision: int, epoch: int, constraintScanReadable: bool, hasConstraint: bool }
pure def safeSigned(number: int): bool = number >= -9007199254740991 and number <= 9007199254740991
pure def expireDocument(doc: ExpiryDocument): str =
  if (doc.marker or not(doc.selectedBySweep)) "keep"
  else if (doc.fieldsReadable and doc.observedAt > 0 and safeSigned(doc.observedAt) and safeSigned(doc.revision) and safeSigned(doc.epoch) and doc.constraintScanReadable) "marker"
  else "delete"
type ResultProjection = { present: bool, saved: bool, expired: bool, completed: bool, hasAnswerFields: bool }
pure val absentView: ResultProjection = { present: false, saved: false, expired: false, completed: false, hasAnswerFields: false }
pure def projectRetained(taskShape: ResultTaskShape, rowKind: str, validAnswer: bool, eligible: bool, revision: int, epoch: int): ResultProjection = {
  val completeNow = matchingCompletion(taskShape, eligible, revision, epoch)
  if (rowKind == "answer" and validAnswer) { ...absentView, present: true, saved: true, completed: completeNow, hasAnswerFields: true }
  else if (rowKind == "marker" and completeNow) { ...absentView, present: true, expired: true, completed: true }
  else absentView
}
pure def resultRoute(taskShape: ResultTaskShape, view: ResultProjection, method: str, routeAction: str): str =
  if (view.completed or (not(view.present) and taskShape.taskStatus == "completed"))
    (if (method == "details" or (method == "POST" and routeAction != "check" and routeAction != "show-guidance")) "TASK_CONFLICT"
     else if (view.completed) "retained-finished" else "finished-without-answer")
  else "guide"
pure def boardIncludes(view: ResultProjection, ownerMatches: bool, hidden: bool, candidate: bool): bool =
  ownerMatches and not(hidden) and candidate and view.completed and view.saved
pure def lawExpiredResponseHidesAnswer(taskShape: ResultTaskShape, validAnswer: bool, eligible: bool, revision: int, epoch: int): bool = {
  val projected = projectRetained(taskShape, "marker", validAnswer, eligible, revision, epoch)
  projected.expired implies not(projected.saved or projected.hasAnswerFields) and projected.completed
}
pure def lawCompletedTaskWithoutAnswerCannotReguide(taskShape: ResultTaskShape, method: str, routeAction: str): bool =
  taskShape.taskStatus == "completed" implies resultRoute(taskShape, absentView, method, routeAction) != "guide"
pure def lawHiddenOrForeignAnswerIsNeverListed(view: ResultProjection, ownerMatches: bool, hidden: bool, candidate: bool): bool =
  hidden or not(ownerMatches) implies not(boardIncludes(view, ownerMatches, hidden, candidate))
pure val expiryCandidate: ExpiryDocument = { marker: false, selectedBySweep: true, fieldsReadable: true, observedAt: retentionMs * 2, revision: 3, epoch: 2, constraintScanReadable: true, hasConstraint: false }
pure val docValues = Set(expiryCandidate, { ...expiryCandidate, marker: true }, { ...expiryCandidate, selectedBySweep: false }, { ...expiryCandidate, fieldsReadable: false }, { ...expiryCandidate, observedAt: 0 }, { ...expiryCandidate, constraintScanReadable: false })
pure val rowKindValues = Set("answer", "marker", "absent")
pure val viewValues = Set(absentView, { ...absentView, present: true, completed: true, expired: true }, { ...absentView, present: true, saved: true, completed: true, hasAnswerFields: true }, { ...absentView, present: true, saved: true, hasAnswerFields: true })
pure val routeActionValues = Set("start", "check", "show-guidance", "fill")
pure val methodValues = Set("GET", "POST", "details")
```

### A completed saved result loses its answer at expiry and keeps the task finished

The retention state follows one active task and its latest owned row. A successful save creates a full answer. Only a saved eligible result can request the modeled complete transition. That control advances the revision and epoch together. An expiry sweep removes all answer fields from the row while retaining the binding facts needed for a completed view. A constrained result can remain active with a saved answer and can age into a marker that gives no completed view. This model isolates the result-driven completion route. It leaves failed writes, route admission, multiple task IDs and externally completed tasks to the rules above.

```quint
type WebsiteResult = { task: ResultTaskShape, rowKind: str, answerFields: bool, eligible: bool, revision: int, epoch: int, observedAt: int }
pure val initial: WebsiteResult = { task: activeTaskShape, rowKind: "absent", answerFields: false, eligible: false, revision: 0, epoch: 0, observedAt: 0 }
pure def canSaveReading(resultState: WebsiteResult, reading: SavedAnswerShape, clock: int, ownerCurrent: bool): bool =
  ownerCurrent and (resultState.rowKind == "absent" or resultState.rowKind == "marker") and
  saveAnswer({ task: resultState.task, record: reading, clock: clock, previous: "none", equalExceptTime: false }) == "write"
pure def saveReading(resultState: WebsiteResult, reading: SavedAnswerShape, clock: int, ownerCurrent: bool): WebsiteResult =
  { ...resultState, rowKind: "answer", answerFields: true, eligible: not(reading.hasConstraint), revision: reading.revision, epoch: reading.epoch, observedAt: reading.observedAt }
pure def canCompleteReading(resultState: WebsiteResult, ownerCurrent: bool, unresolved: bool): bool =
  resultState.rowKind == "answer" and resultState.eligible and resultState.task.taskEpoch == resultState.epoch and
  completionAdmission(resultState.task, resultState.revision, ownerCurrent, unresolved) == "complete"
pure def completeReading(resultState: WebsiteResult, ownerCurrent: bool, unresolved: bool): WebsiteResult =
  { ...resultState, task: { taskStatus: "completed", taskRevision: resultState.revision + 1, taskEpoch: resultState.epoch + 1 } }
pure def canSweepReading(resultState: WebsiteResult, clock: int): bool =
  resultState.rowKind == "answer" and elapsedRetention(resultState.observedAt, clock)
pure def sweepReading(resultState: WebsiteResult, clock: int): WebsiteResult =
  { ...resultState, rowKind: "marker", answerFields: false, observedAt: 0 }
pure def alwaysOnlyAnswerKeepsPrivateFields(resultState: WebsiteResult): bool =
  resultState.answerFields == (resultState.rowKind == "answer")
pure def alwaysCompletedHasEligibleBinding(resultState: WebsiteResult): bool =
  resultState.task.taskStatus == "completed" implies resultState.rowKind != "absent" and
  matchingCompletion(resultState.task, resultState.eligible, resultState.revision, resultState.epoch)
pure def stepCompletionIsMonotone(before: WebsiteResult, after: WebsiteResult): bool =
  before.task.taskStatus == "completed" implies after.task == before.task
pure def stepSweepErasesPageFields(before: WebsiteResult, via: str, after: WebsiteResult): bool =
  via == "sweepReading" implies not(after.answerFields) and after.observedAt == 0 and after.task == before.task
pure def sometimesAnswerSaved(resultState: WebsiteResult): bool = resultState.rowKind == "answer" and resultState.task.taskStatus == "active"
pure def sometimesConstrainedSaved(resultState: WebsiteResult): bool = resultState.rowKind == "answer" and not(resultState.eligible)
pure def sometimesCompletedAnswer(resultState: WebsiteResult): bool = resultState.rowKind == "answer" and resultState.task.taskStatus == "completed"
pure def sometimesCompletedMarker(resultState: WebsiteResult): bool = resultState.rowKind == "marker" and resultState.task.taskStatus == "completed"
pure def sometimesUnfinishedMarker(resultState: WebsiteResult): bool = resultState.rowKind == "marker" and resultState.task.taskStatus == "active"
pure val readingValues = Set(freshAnswer, { ...freshAnswer, hasConstraint: true }, { ...freshAnswer, observedAt: retentionMs * 3 }, { ...freshAnswer, epoch: 1 }, { ...freshAnswer, answerValid: false })
```

The proof covers the stated projection and state-transition rules. Original fixtures cover source text, model-response shapes, SQLite retention and desktop rendering. Live website truth and exact semantic understanding of every request depend on the observations and model decision. The store's expiry runs when invoked by its startup and entry points.
