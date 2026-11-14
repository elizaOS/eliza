# Response-handler evaluator execution

The [response evaluator registry](./responseEvaluators.md) retains each
registered object. The runner in
[response-handler-evaluators.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/response-handler-evaluators.ts)
snapshots the explicit evaluators followed by registered evaluators. Each
candidate observes the plan and runtime-owned scope left by its predecessors.
Normalization supplies trimmed context IDs, canonical comparison keys for
names, the JavaScript locale order of candidate names, and syntax validity for
extension-field names. The model retains complete values from that boundary.

## Story: Apply response evaluator decisions in priority order

As a host I run the selected evaluators serially, keep their active names and
patch traces, and distinguish turn cancellation from an individual evaluator
failure.

### Each candidate checks eligibility before evaluating its patch

Priorities ascend, with absent priority mapped to 100. Equal priorities use
the locale order of names. A stable tie retains explicit-before-registered
snapshot order. Distinct positions can hold the same evaluator object.
Evaluators registered or removed during a run affect the
next snapshot. A false eligibility result or an absent patch advances to the
next candidate. A cancellation from either await is terminal. Other errors
are recorded for that evaluator and allow the next candidate to run.

```quint
type EvaluatorCandidate = { slot: int, name: str, reference: int, priority: int, localeOrder: int, declaredTools: Set[str] }
type EvaluationPhase = RunIdle | AwaitEligibility | AwaitEvaluation | RunFinished | RunCancelled
type EvaluatorOutcome = CallbackReturned | CallbackFailed | CallbackCancelled
type Decision = { outcome: EvaluatorOutcome, eligible: bool, errorText: str }
type NamedValue = { key: str, value: str }
type PatchChange = { operation: str, fieldName: str }
type PatchTrace = { name: str, changed: List[PatchChange], debug: List[NamedValue] }
type EvaluationError = { name: str, message: str }
type ResponsePlan = { process: str, requiresTool: bool, replyStatus: str, contexts: List[str], candidates: List[NamedValue], candidateField: bool, parentHints: List[NamedValue], parentField: bool, slices: List[NamedValue], reply: str, replyField: bool, intents: List[str], extensions: List[NamedValue], toolName: str, toolParams: str, evidencePresent: bool, requiredEvidence: str, budgetPresent: bool, missBudget: str, sourceContext: str, priorReceipts: List[str] }
type ScopeField = { name: str, key: str, validSyntax: bool }
type ResponsePatch = { provided: bool, replaceScope: bool, intents: List[str], intentShapeValid: bool, invalidations: List[ScopeField], owner: int, process: str, changeRequiresTool: bool, requiresTool: bool, nonAppliedReply: bool, setContexts: bool, contexts: List[str], addContexts: bool, contextAdditions: List[str], clearCandidates: bool, addCandidates: bool, candidates: List[NamedValue], clearParents: bool, addParents: bool, parents: List[NamedValue], addSlices: bool, slices: List[NamedValue], toolName: str, toolKey: str, toolParams: str, clearReply: bool, setReply: bool, reply: str, contextSources: List[str], debug: List[NamedValue] }
type PatchReceipt = { outcome: EvaluatorOutcome, patch: ResponsePatch, errorText: str }
type ResponseEvaluation = { phase: EvaluationPhase, remaining: List[EvaluatorCandidate], plan: ResponsePlan, available: Set[str], active: List[str], traces: List[PatchTrace], candidateAdditions: List[NamedValue], candidatesCleared: bool, contextualSources: List[str], invalidatedFields: List[str], scopeOwner: int, errors: List[EvaluationError], cancellation: str }
pure val emptyPlan: ResponsePlan = {process: "", requiresTool: false, replyStatus: "", contexts: List(), candidates: List(), candidateField: false, parentHints: List(), parentField: false, slices: List(), reply: "", replyField: false, intents: List(), extensions: List(), toolName: "", toolParams: "", evidencePresent: false, requiredEvidence: "", budgetPresent: false, missBudget: "", sourceContext: "", priorReceipts: List()}
pure val initial: ResponseEvaluation = {phase: RunIdle, remaining: List(), plan: emptyPlan, available: Set(), active: List(), traces: List(), candidateAdditions: List(), candidatesCleared: false, contextualSources: List(), invalidatedFields: List(), scopeOwner: 0, errors: List(), cancellation: ""}
pure val noEvaluator: EvaluatorCandidate = {slot: 0, name: "", reference: 0, priority: 0, localeOrder: 0, declaredTools: Set()}
pure val firstEvaluator: EvaluatorCandidate = {slot: 1, name: "context", reference: 1, priority: 10, localeOrder: 1, declaredTools: Set("read")}
pure val secondEvaluator: EvaluatorCandidate = {slot: 2, name: "scope", reference: 2, priority: 20, localeOrder: 2, declaredTools: Set("write")}
pure val availableValues = Set(Set(), Set("world"), Set("world", "private"))
pure val snapshotValues = Set(List(), List(firstEvaluator), List(secondEvaluator, firstEvaluator), List(firstEvaluator, { ...firstEvaluator, slot: 2 }))
pure val planValues = Set(emptyPlan, { ...emptyPlan, reply: "original", replyField: true, toolName: "OLD", toolParams: "old-parameters", evidencePresent: true, requiredEvidence: "old-evidence", budgetPresent: true, missBudget: "old-budget", sourceContext: "complete-source", priorReceipts: List("prior-receipt"), extensions: List({key: "scopeHint", value: "old-hint"}) })
pure val callbackReturned: EvaluatorOutcome = CallbackReturned
pure val callbackFailed: EvaluatorOutcome = CallbackFailed
pure val callbackCancelled: EvaluatorOutcome = CallbackCancelled
pure val decisionValues: Set[Decision] = Set({outcome: callbackReturned, eligible: true, errorText: ""}, {outcome: callbackReturned, eligible: false, errorText: ""}, {outcome: callbackFailed, eligible: false, errorText: "eligibility-error"}, {outcome: callbackCancelled, eligible: false, errorText: "cancelled"})
pure def precedes(left: EvaluatorCandidate, right: EvaluatorCandidate): bool = left.priority < right.priority or (left.priority == right.priority and left.localeOrder < right.localeOrder)
pure def currentCandidate(s: ResponseEvaluation): EvaluatorCandidate = s.remaining.foldl(s.remaining.nthOr(0, noEvaluator), (best, entry) => if (precedes(entry, best)) entry else best)
pure def nextPhase(remaining: List[EvaluatorCandidate]): EvaluationPhase = if (remaining.length() == 0) RunFinished else AwaitEligibility
pure def nextCandidate(slot: int, s: ResponseEvaluation): ResponseEvaluation = {
  val remaining = s.remaining.select(entry => entry.slot != slot)
  { ...s, remaining: remaining, phase: nextPhase(remaining) }
}
pure def canStart(s: ResponseEvaluation, snapshot: List[EvaluatorCandidate]): bool = s.phase == RunIdle and snapshot.every(entry => entry.reference > 0 and entry.slot > 0 and snapshot.select(other => other.slot == entry.slot).length() == 1)
pure def start(s: ResponseEvaluation, snapshot: List[EvaluatorCandidate], plan: ResponsePlan, available: Set[str]): ResponseEvaluation = { ...s, remaining: snapshot, phase: nextPhase(snapshot), plan: plan, available: available }
pure def canSettleEligibility(s: ResponseEvaluation): bool = s.phase == AwaitEligibility
pure def recordEvaluationError(errorText: str, s: ResponseEvaluation): ResponseEvaluation = {
  val selected = currentCandidate(s)
  nextCandidate(selected.slot, { ...s, errors: s.errors.append({name: selected.name, message: errorText}) })
}
pure def settleEligibility(s: ResponseEvaluation, decision: Decision): ResponseEvaluation =
  if (decision.outcome == callbackCancelled) { ...s, phase: RunCancelled, cancellation: decision.errorText }
  else if (decision.outcome == callbackFailed) recordEvaluationError(decision.errorText, s)
  else if (decision.eligible) { ...s, phase: AwaitEvaluation, active: s.active.append(currentCandidate(s).name) }
  else nextCandidate(currentCandidate(s).slot, s)
pure def alwaysAwaitOwnsCandidate(s: ResponseEvaluation): bool = (s.phase == AwaitEligibility or s.phase == AwaitEvaluation) implies s.remaining.length() > 0
pure def stepCancellationIsTerminal(before: ResponseEvaluation, after: ResponseEvaluation): bool = before.phase == RunCancelled implies after.phase == RunCancelled and after.cancellation == before.cancellation
pure def sometimesFailureAllowsNextCandidate(s: ResponseEvaluation): bool = s.errors.length() > 0 and s.phase == AwaitEligibility
```

### Invalid tool choices and scope replacements reject the entire patch

A nonempty deterministic action must be declared by that evaluator under its
canonical name. A replacement must contain at least one valid intent. Each
invalidation must be a valid extension field and may not name a protected
routing, source, receipt, or prototype field. The runner validates this
before mutating the plan, adding context sources, or recording a patch trace.
A successful replacement retains the supplied routing owner for later
callbacks, records every exact invalidation and clears the previous
deterministic choice, required evidence and miss budget.

```quint
pure val scopeProtectedKeys = Set("contexts", "reply", "replyeffectstatus", "requirestool", "contextslices", "completioncontext", "candidateactions", "intents", "parentactionhints", "requiredtoolmissbudget", "requiredtoolevidence", "deterministictoolcall", "simple", "metadata", "data", "state", "messages", "originalmessages", "originalrequest", "history", "receipts", "effectreceipts", "source", "sources", "sourcecontext", "sourcesetid", "sourceselection", "currentsourcerevisions", "invalidatedscopefields", "constructor", "prototype", "__proto__")
pure val noPatch: ResponsePatch = {provided: false, replaceScope: false, intents: List(), intentShapeValid: true, invalidations: List(), owner: 0, process: "", changeRequiresTool: false, requiresTool: false, nonAppliedReply: false, setContexts: false, contexts: List(), addContexts: false, contextAdditions: List(), clearCandidates: false, addCandidates: false, candidates: List(), clearParents: false, addParents: false, parents: List(), addSlices: false, slices: List(), toolName: "", toolKey: "", toolParams: "", clearReply: false, setReply: false, reply: "", contextSources: List(), debug: List()}
pure val scopedPatch: ResponsePatch = { ...noPatch, provided: true, replaceScope: true, intents: List("observe"), invalidations: List({name: "scopeHint", key: "scopehint", validSyntax: true}), owner: 2, contextSources: List("new-complete-source"), clearCandidates: true }
pure val callPatch: ResponsePatch = { ...noPatch, provided: true, toolName: "READ", toolKey: "read", toolParams: "complete-params", setContexts: true, contexts: List("world", "private", "world"), addCandidates: true, candidates: List({key: "read", value: "READ"}), setReply: true, reply: "" }
pure val receiptValues: Set[PatchReceipt] = Set({outcome: callbackReturned, patch: noPatch, errorText: ""}, {outcome: callbackReturned, patch: scopedPatch, errorText: ""}, {outcome: callbackReturned, patch: callPatch, errorText: ""}, {outcome: callbackReturned, patch: { ...scopedPatch, invalidations: List({name: "sourceContext", key: "sourcecontext", validSyntax: true}) }, errorText: ""}, {outcome: callbackFailed, patch: noPatch, errorText: "evaluate-error"}, {outcome: callbackCancelled, patch: noPatch, errorText: "cancelled"})
pure def validIntentReplacement(patch: ResponsePatch): bool = not(patch.replaceScope) or (patch.intentShapeValid and patch.intents.length() > 0 and patch.invalidations.every(fieldName => fieldName.validSyntax and not(scopeProtectedKeys.contains(fieldName.key))))
pure def declaredTool(evaluator: EvaluatorCandidate, patch: ResponsePatch): bool = patch.toolName == "" or evaluator.declaredTools.contains(patch.toolKey)
type ReceiptOrderCheck = {index: int, matched: bool}
pure val initialReceiptOrderCheck: ReceiptOrderCheck = {index: 0, matched: true}
pure def sameReceipts(left: List[str], right: List[str]): bool = {
  val checked = left.foldl(initialReceiptOrderCheck, (at, value) => {index: at.index + 1, matched: at.matched and value == right.nthOr(at.index, "")})
  left.length() == right.length() and checked.matched
}
pure def dedupExact(values: List[str]): List[str] = values.foldl(List(), (items, value) => if (items.includes(value)) items else items.append(value))
pure def mergeNamed(before: List[NamedValue], addition: List[NamedValue]): List[NamedValue] = before.concat(addition).foldl(List(), (items, value) => if (value.key == "" or items.some(entry => entry.key == value.key)) items else items.append(value))
pure def filteredContexts(values: List[str], available: Set[str]): List[str] = dedupExact(values.select(value => value != "" and (available.size() == 0 or available.contains(value))))
pure def applyResponsePatch(plan: ResponsePlan, patch: ResponsePatch, available: Set[str]): ResponsePlan = {
  val afterSet = if (patch.setContexts) filteredContexts(patch.contexts, available) else plan.contexts
  val candidates = if (patch.clearCandidates) List() else plan.candidates
  val parents = if (patch.clearParents) List() else plan.parentHints
  { ...plan,
    process: if (patch.process != "") patch.process else plan.process,
    requiresTool: if (patch.changeRequiresTool) patch.requiresTool else plan.requiresTool,
    replyStatus: if (patch.nonAppliedReply) "non_applied" else plan.replyStatus,
    contexts: if (patch.addContexts) filteredContexts(afterSet.concat(patch.contextAdditions), available) else afterSet,
    candidates: if (patch.addCandidates) mergeNamed(candidates, patch.candidates) else candidates,
    candidateField: patch.addCandidates or (not(patch.clearCandidates) and plan.candidateField),
    parentHints: if (patch.addParents) mergeNamed(parents, patch.parents) else parents,
    parentField: patch.addParents or (not(patch.clearParents) and plan.parentField),
    slices: if (patch.addSlices) mergeNamed(plan.slices, patch.slices) else plan.slices,
    reply: if (patch.setReply) patch.reply else if (patch.clearReply) "" else plan.reply,
    replyField: patch.setReply or (not(patch.clearReply) and plan.replyField),
    intents: if (patch.replaceScope) patch.intents else plan.intents,
    extensions: if (patch.replaceScope) plan.extensions.select(fieldName => not(patch.invalidations.some(entry => entry.name == fieldName.key))) else plan.extensions,
    toolName: if (patch.toolName != "") patch.toolName else if (patch.replaceScope) "" else plan.toolName,
    toolParams: if (patch.toolName != "") patch.toolParams else if (patch.replaceScope) "" else plan.toolParams,
    evidencePresent: plan.evidencePresent and not(patch.replaceScope),
    requiredEvidence: if (patch.replaceScope) "" else plan.requiredEvidence,
    budgetPresent: plan.budgetPresent and not(patch.replaceScope),
    missBudget: if (patch.replaceScope) "" else plan.missBudget }
}
```

### Applied patches retain exact ordering and context evidence

Context changes deduplicate exact IDs and respect the available-context set.
An empty available-context list applies no context allowlist. Candidate
actions, parent hints, and context slices deduplicate canonical names and
retain the first spelling. Clear precedes add or set within the same patch.
The applied trace records field changes in source order. It stores the raw
extension field separately from the trace operation. Serialization formats
them as the existing trace strings. The run retains all
reported context sources. A debug-only patch records a trace. A
context-sources-only patch retains its sources without adding a patch trace.
Original source context and prior effect receipts stay in the plan.

```quint
pure def tagged(includeChange: bool, tagName: str): List[PatchChange] = if (includeChange) List({operation: tagName, fieldName: ""}) else List()
pure def patchChanges(plan: ResponsePlan, patch: ResponsePatch): List[PatchChange] =
  tagged(patch.replaceScope, "intents:replace")
    .concat(if (patch.replaceScope) dedupExact(patch.invalidations.listMap(fieldName => fieldName.name)).listMap(name => {operation: "intentField:invalidate", fieldName: name}) else List())
    .concat(tagged(patch.replaceScope and plan.toolName != "", "deterministicToolCall:clear"))
    .concat(tagged(patch.replaceScope and plan.evidencePresent, "requiredToolEvidence:clear"))
    .concat(tagged(patch.replaceScope and plan.budgetPresent, "requiredToolMissBudget:clear"))
    .concat(tagged(patch.process != "", "processMessage"))
    .concat(tagged(patch.changeRequiresTool, "requiresTool"))
    .concat(tagged(patch.nonAppliedReply, "replyEffectStatus:non_applied"))
    .concat(tagged(patch.setContexts, "contexts:set"))
    .concat(tagged(patch.addContexts, "contexts:add"))
    .concat(tagged(patch.clearCandidates, "candidateActions:clear"))
    .concat(tagged(patch.addCandidates, "candidateActions:add"))
    .concat(tagged(patch.clearParents, "parentActionHints:clear"))
    .concat(tagged(patch.addParents, "parentActionHints:add"))
    .concat(tagged(patch.addSlices, "contextSlices:add"))
    .concat(tagged(patch.toolName != "", "deterministicToolCall:set"))
    .concat(tagged(patch.clearReply, "reply:clear"))
    .concat(tagged(patch.setReply, "reply:set"))
pure def applyValidPatch(patch: ResponsePatch, s: ResponseEvaluation): ResponseEvaluation = {
  val changed = patchChanges(s.plan, patch)
  val debug = mergeNamed(List(), patch.debug)
  val trace = {name: currentCandidate(s).name, changed: changed, debug: debug}
  { ...s, plan: applyResponsePatch(s.plan, patch, s.available),
    traces: if (changed.length() > 0 or debug.length() > 0) s.traces.append(trace) else s.traces,
    candidateAdditions: if (patch.addCandidates) mergeNamed(s.candidateAdditions, patch.candidates) else s.candidateAdditions,
    candidatesCleared: s.candidatesCleared or patch.clearCandidates,
    contextualSources: s.contextualSources.concat(patch.contextSources),
    invalidatedFields: if (patch.replaceScope) dedupExact(s.invalidatedFields.concat(patch.invalidations.listMap(fieldName => fieldName.name))) else s.invalidatedFields,
    scopeOwner: if (patch.replaceScope) patch.owner else s.scopeOwner }
}
pure def canSettleEvaluation(s: ResponseEvaluation): bool = s.phase == AwaitEvaluation
pure def settleEvaluation(s: ResponseEvaluation, receipt: PatchReceipt): ResponseEvaluation =
  if (receipt.outcome == callbackCancelled) { ...s, phase: RunCancelled, cancellation: receipt.errorText }
  else if (receipt.outcome == callbackFailed) recordEvaluationError(receipt.errorText, s)
  else if (not(receipt.patch.provided)) nextCandidate(currentCandidate(s).slot, s)
  else if (not(declaredTool(currentCandidate(s), receipt.patch))) recordEvaluationError("RESPONSE_HANDLER_DETERMINISTIC_ACTION_DENIED", s)
  else if (not(validIntentReplacement(receipt.patch))) recordEvaluationError("RESPONSE_HANDLER_INTENT_SCOPE_INVALID", s)
  else nextCandidate(currentCandidate(s).slot, applyValidPatch(receipt.patch, s))
pure def stepOriginalSourceContextSurvives(before: ResponseEvaluation, via: str, after: ResponseEvaluation): bool = via != "start" implies after.plan.sourceContext == before.plan.sourceContext and sameReceipts(after.plan.priorReceipts, before.plan.priorReceipts)
pure def sometimesScopeReplacementApplied(s: ResponseEvaluation): bool = s.scopeOwner > 0 and s.invalidatedFields.includes("scopeHint") and s.contextualSources.includes("new-complete-source")
pure def sometimesUnauthorizedToolRejected(s: ResponseEvaluation): bool = s.errors.some(error => error.message == "RESPONSE_HANDLER_DETERMINISTIC_ACTION_DENIED")
```
