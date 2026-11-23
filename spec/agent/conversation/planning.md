# Turn planning

What the owner message service does between the person's message and the
one reply a [turn](./turns.md) stores. The model sees the conversation and
the actions this turn may use as tools; each tool call it makes runs
through core's planned tool execution with the launch's action gate
([action planning](../../core/actionPlanning.md)), and its result goes
back to the model, until the model answers without a tool call, calls
`REPLY`, or the step bound is reached. The last step offers no tools. An
action's own callback text is the action's verified presentation and is
held for the reply, never delivered as a second message. After the reply
is stored, the evaluators plugins registered run on the finished turn.

The shell (`conversation/planning.vibe`) hands this library the facts it
reads: which actions are registered and allowed, each step's outcome and
identity, the shape of the model's text, and the shape of the tool text.
An effect receipt identifies an operation by the action, operation and
resource. A step without a receipt has an attempt key from its action
and canonical parameters. A refusal before dispatch (a malformed or
unexpected argument, `executionStatus: "not_started"`) is `Rejected`.

## Story: Ask the agent to do something and hear what happened

> As the owner, I want the agent to use the actions my product gave it and
> tell me truthfully what each one did, so that I never hear success for an
> action that failed, nor a failure the agent already fixed.

### A turn offers the model only registered actions the launch allows, and plans at most eight steps

The message service's own `REPLY`, `IGNORE` and `NONE` are never offered
as tools; a `REPLY` call the model makes anyway normally ends planning with its
text, and an owner turn always ends with one reply. A step whose model
call returns no tool call ends planning with that text.

```quint
type StepOutcome = Applied | Proposed | Failed | Rejected | NoEffect | Coaching | Uncertain
type StepIdentity = RequestAttempt({ key: str }) | ReceiptOperation({ key: str })
type PlanStep = { outcome: StepOutcome, identity: StepIdentity }
pure val maxPlanSteps = 8
pure val messageServiceActions = Set("REPLY", "IGNORE", "NONE")
pure def offered(registered: Set[str], allowed: Set[str]): Set[str] = registered.intersect(allowed).exclude(messageServiceActions)
pure def keepsPlanning(taken: int, calls: int, terminal: bool): bool = calls > 0 and not(terminal) and taken < maxPlanSteps
pure def acceptsPlannedReply(reply: bool, coaching: bool): bool = reply and not(coaching)
pure val registeredValues = Set(Set("REPLY", "CALCULATE"), Set("REPLY", "CALCULATE", "PRODUCT_ACTION"), Set())
pure val allowedValues = Set(Set("REPLY"), Set("REPLY", "CALCULATE"), Set())
pure val takenValues = Set(0, 1, 7, 8, 9)
pure def lawOnlyAllowedRegisteredActionsAreOffered(registered: Set[str], allowed: Set[str]): bool =
  offered(registered, allowed).subseteq(allowed) and offered(registered, allowed).subseteq(registered) and not(offered(registered, allowed).contains("REPLY"))
pure def lawPlanningStopsAtTheBound(taken: int, calls: int, terminal: bool): bool =
  taken >= maxPlanSteps implies not(keepsPlanning(taken, calls, terminal))
pure def lawAReplyAlongsideACoachingRefusalDoesNotEndPlanning(taken: int): bool =
  (taken < maxPlanSteps implies keepsPlanning(taken, 1, acceptsPlannedReply(true, true))) and not(acceptsPlannedReply(true, true))
pure def lawAnAnswerWithoutToolsEndsPlanning(taken: int, terminal: bool): bool = not(keepsPlanning(taken, 0, terminal))
```

### The live owner turn classifies a Notes write from its original conversation before dispatch

A planned, registered Notes write may trigger the Notes response field once
in the live owner's turn. The field sees the original owner message and
the shown dialogue. Tool arguments, tool output, attachments and device
metadata do not supply the classification. The action receives the
classification only through the live request binding checked by the
executor. An unavailable or invalid classification leaves the request
unresolved. Notes reads need no classification and use the Notes context
only through an admitted Notes action.

```quint
pure def classifiesNotesWrite(owner: bool, offeredNotesWrite: bool, hasWords: bool): bool =
  owner and offeredNotesWrite and hasWords
pure def lawAWriteClassificationNeedsOwnerWords(owner: bool, offeredNotesWrite: bool): bool =
  not(classifiesNotesWrite(owner, offeredNotesWrite, false))
pure def lawOtherActionsDoNotTriggerNotesClassification(owner: bool, hasWords: bool): bool =
  not(classifiesNotesWrite(owner, false, hasWords))
```

### A failure or proposal the turn made stays reported unless a later success of the same operation supersedes it

An active commit with the same receipt, effect identity or idempotency key
closes an open failure, uncertainty or proposal. The reply reports unknown
provider acceptance as uncertainty. An unrelated failure stays reportable
after other commits. A replayed commit qualifies, and rollback removes
that qualification. Open outcomes for the same
operation or receiptless request replace earlier ones of the same identity.
Pre-dispatch refusals are recorded separately from dispatched failures. A
later call to the same action can be for another request. The reply reports
an unlinked refusal as a call that did not start, even if the action later
runs. It reports an open failure as that action's failure and an open proposal
as awaiting the owner, whatever the model's prose claims.

A failed action may explicitly return a coaching refusal when it did
no work and issued no effect receipt. The instruction goes back to the
planner, and a reply bundled with it cannot end planning. The owner hears
the eventual answer, or a generic failure if the planner has no answer.
Failures with receipts remain reportable.

```quint
pure def isReceiptOperation(identity: StepIdentity): bool = match identity { | ReceiptOperation(_) => true | _ => false }
pure def supersedes(later: PlanStep, earlier: PlanStep): bool =
  later.outcome == Applied and earlier.outcome != Rejected and later.identity == earlier.identity and isReceiptOperation(later.identity)
pure def receiptlessFailure(hasReceipts: bool, coaching: bool, rejected: bool): StepOutcome =
  if (not(hasReceipts) and coaching) Coaching else if (rejected) Rejected else Failed
pure def opens(o: StepOutcome): bool = o == Failed or o == Rejected or o == Proposed
pure def settleStep(held: List[PlanStep], entry: PlanStep): List[PlanStep] =
  if (opens(entry.outcome))
    held.select(p => p.identity != entry.identity or (p.outcome == Rejected) != (entry.outcome == Rejected)).append(entry)
  else held.select(p => not(supersedes(entry, p)))
pure def openOutcomes(steps: List[PlanStep]): List[PlanStep] = steps.foldl(List(), (held, entry) => settleStep(held, entry))
pure def failedOpen(steps: List[PlanStep]): List[PlanStep] = openOutcomes(steps).select(p => p.outcome == Failed or p.outcome == Rejected)
pure val earlierValues = Set(
  { outcome: Failed, identity: ReceiptOperation({ key: "send:a" }) },
  { outcome: Rejected, identity: RequestAttempt({ key: "send:a" }) },
  { outcome: Proposed, identity: ReceiptOperation({ key: "send:a" }) },
)
pure val laterValues = Set(
  { outcome: Applied, identity: ReceiptOperation({ key: "send:a" }) },
  { outcome: Applied, identity: ReceiptOperation({ key: "send:b" }) },
  { outcome: NoEffect, identity: RequestAttempt({ key: "send:a" }) },
  { outcome: NoEffect, identity: ReceiptOperation({ key: "send:a" }) },
  { outcome: Failed, identity: RequestAttempt({ key: "send:a" }) },
  { outcome: Rejected, identity: RequestAttempt({ key: "send:a" }) },
)
pure val stepsValues = Set(List(), List({ outcome: Failed, identity: ReceiptOperation({ key: "note:a" }) }))
pure def lawCoachingIsNotAnOpenFailure(rejected: bool): bool =
  not(opens(receiptlessFailure(false, true, rejected))) and opens(receiptlessFailure(true, true, rejected))
pure def lawTheLatestFailureIsReported(steps: List[PlanStep], earlier: PlanStep): bool =
  earlier.outcome == Failed implies failedOpen(steps.append(earlier)).includes(earlier)
pure def lawASuccessOfTheSameOperationSupersedes(steps: List[PlanStep], earlier: PlanStep, later: PlanStep): bool =
  (later.outcome == Applied and earlier.outcome != Rejected and later.identity == earlier.identity and isReceiptOperation(later.identity)) implies
    not(openOutcomes(steps.append(earlier).append(later)).includes(earlier))
pure def lawASuccessOfAnotherOperationKeepsTheFailure(steps: List[PlanStep], earlier: PlanStep, later: PlanStep): bool =
  (earlier.outcome == Failed and later.identity != earlier.identity) implies failedOpen(steps.append(earlier).append(later)).includes(earlier)
pure def lawARefusalBeforeDispatchStaysReported(steps: List[PlanStep], earlier: PlanStep, later: PlanStep): bool =
  earlier.outcome == Rejected implies failedOpen(steps.append(earlier).append(later)).includes(earlier)
```

### Recovered prose cites this turn's evidence before it is shown

The planner holds a draft made after an effect or a recorded failure for
review. Action-authored outcome text can still be used when its evidence
is active. The review identifies claims by exact quotes in the draft.
An assistant completion requires an active committed receipt for the
claimed effect. An assistant failure requires a cited result with an
unapplied outcome and no matching commit, including a replay under the
same key. Unknown acceptance supports only uncertainty. A receiptless
failure can support an account of that particular attempt. The reviewer
uses the ordered results and original dialogue to attribute each claim.
The shell checks the cited receipts and attempt positions against the
unchanged evidence. If any claim is unsupported, it can revise the draft
once and review it again. A missing or failed review leaves action-owned
text and the settled outcome notices available to the reply.

```quint
type RecoveredChange = None | Occurred | DidNotOccur
pure val changeValues = Set(None, Occurred, DidNotOccur)
pure def allowsRecoveredClaim(change: RecoveredChange, supported: bool, quotesDraft: bool, committed: bool, unapplied: bool): bool =
  supported and quotesDraft and (if (change == Occurred) committed else if (change == DidNotOccur) unapplied else true)
pure def lawAReviewCannotAuthorizeAnUnquotedClaim(change: RecoveredChange, supported: bool, committed: bool, unapplied: bool): bool =
  not(allowsRecoveredClaim(change, supported, false, committed, unapplied))
pure def lawARecoveredCompletionRequiresAnActiveCommit(supported: bool, quotesDraft: bool, unapplied: bool): bool =
  not(allowsRecoveredClaim(Occurred, supported, quotesDraft, false, unapplied))
pure def lawARecoveredFailureRequiresAnUnappliedResult(supported: bool, quotesDraft: bool, committed: bool): bool =
  not(allowsRecoveredClaim(DidNotOccur, supported, quotesDraft, committed, false))
```

### A pending-work cue is spoken only before work runs and is never the reply, and an answer is delivered whole

The shell reads the model's text as a `Cue` only when the whole of it is
one to three sentences of the closed acknowledgment grammar (`On it`,
`One sec`, `Just a moment`, a lead such as `Let me` with a look-up verb and
an owner container such as `your calendar`, or a lead with an intent such
as `open Maps`), at most 120 characters, with no digits, clock times,
counts, names other than one after `check with`, or question mark. A wait
cue followed by more text that is not progress (`One second is 1,000
milliseconds.`, `Just a second, your dentist is Thursday.`) is an `Answer`.
A cue that comes with a tool call is shown and spoken before the tools
run, and the stream restarts with the reply. A cue with no tool call is
not an answer: the model is asked once more to answer with what the turn
holds, and if steps run out the turn's failure fallback is the reply.

```quint
type Draft = Cue | Answer | Silent
type PlanMove = RunTools | Deliver | AskAgain | GiveUp
pure def acknowledges(draft: Draft, calls: int): bool = draft == Cue and calls > 0
pure def nextMove(draft: Draft, calls: int, stepsLeft: int): PlanMove =
  if (calls > 0) RunTools
  else if (draft == Answer) Deliver
  else if (stepsLeft > 0) AskAgain
  else GiveUp
pure val stepsLeftValues = Set(0, 1, 3)
pure def lawAnAnswerIsDeliveredWhole(stepsLeft: int): bool = nextMove(Answer, 0, stepsLeft) == Deliver
pure def lawACueIsNeverTheReply(calls: int, stepsLeft: int): bool = nextMove(Cue, calls, stepsLeft) != Deliver
pure def lawACueIsSpokenOnlyBeforeWork(draft: Draft, calls: int): bool = acknowledges(draft, calls) implies (calls > 0 and draft == Cue)
```

### A recognized card is delivered unfenced, other multi-line tool output is fenced, and grounded prose follows unless one already holds the other

A recognized card is a `[MAPSCARD]`, `[CHECKLIST]` or `[WORKFLOW]` open
marker on its own line, one JSON object on the next and its close marker;
any other bracketed text is ordinary output. Tool text the action marked
verified for the owner is kept verbatim; prose that holds it is the whole
reply, and prose it already holds adds nothing. Prose carrying a tool-call
or reasoning marker is never shown. An open confirmation proposal or an
interaction block (`[CHOICE]`, `[FORM]`) is the action's own copy and is
delivered alone.

```quint
type Composition = NoText | ToolOnly | ProseOnly | ToolThenProse | FencedToolThenProse
type ToolTextShape = { present: bool, card: bool, multiline: bool, fenced: bool, ownCopy: bool }
pure def compose(tool: ToolTextShape, prose: bool, proseHoldsTool: bool, toolHoldsProse: bool): Composition =
  if (not(tool.present)) (if (prose) ProseOnly else NoText)
  else if (not(prose) or tool.ownCopy or toolHoldsProse) ToolOnly
  else if (proseHoldsTool) ProseOnly
  else if (tool.multiline and not(tool.card) and not(tool.fenced)) FencedToolThenProse
  else ToolThenProse
pure val toolValues = Set(
  { present: true, card: true, multiline: true, fenced: false, ownCopy: false },
  { present: true, card: false, multiline: true, fenced: false, ownCopy: false },
  { present: true, card: false, multiline: false, fenced: false, ownCopy: true },
  { present: false, card: false, multiline: false, fenced: false, ownCopy: false })
pure def lawACardIsNeverFenced(tool: ToolTextShape, prose: bool, proseHoldsTool: bool, toolHoldsProse: bool): bool =
  tool.card implies compose(tool, prose, proseHoldsTool, toolHoldsProse) != FencedToolThenProse
pure def lawGroundedProseIsKept(tool: ToolTextShape, proseHoldsTool: bool): bool =
  (tool.present and not(tool.ownCopy)) implies compose(tool, true, proseHoldsTool, false) != ToolOnly
pure def lawToolTextIsNeverDropped(tool: ToolTextShape, prose: bool, toolHoldsProse: bool): bool =
  tool.present implies compose(tool, prose, false, toolHoldsProse) != ProseOnly and compose(tool, prose, false, toolHoldsProse) != NoText
```

### A voice turn that ran an action answers with that action's label: its kind, whether the reply is a validated card, and whether the owner asked for exact wording

The answer and the stream's `done` frame of a `VOICE_DM` turn that ran at
least one action carry `action: {kind, validatedCard, verbatimAsked}`,
from which a voice client chooses a short spoken line while the written
reply stays whole. `kind` is the name of the last action the turn ran;
`validatedCard` holds when the stored reply carries a recognized card
block; `verbatimAsked` holds when the owner's words ask for literal
wording (verbatim, word for word, as written, read it back, spell it out)
or for a field to be read out (an ID, address, number, code, subject,
body, draft, email or message). A text turn, or a voice turn that ran no
action, carries no label.

```quint
type VoiceAction = { kind: str, validatedCard: bool, verbatimAsked: bool }
type ActionLabel = NoActionLabel | Labelled({ label: VoiceAction })
pure def actionLabel(voice: bool, ran: List[str], card: bool, verbatim: bool): ActionLabel =
  if (voice and ran.length() > 0) Labelled({ label: { kind: ran.nthOr(ran.length() - 1, ""), validatedCard: card, verbatimAsked: verbatim } })
  else NoActionLabel
pure val ranValues = Set(List(), List("CALCULATE"), List("MAPS_SEARCH", "CALCULATE"))
pure def lawOnlyAVoiceTurnThatRanAnActionIsLabelled(voice: bool, ran: List[str], card: bool, verbatim: bool): bool =
  (actionLabel(voice, ran, card, verbatim) != NoActionLabel) iff (voice and ran.length() > 0)
pure def lawTheLabelNamesTheLastAction(ran: List[str], card: bool, verbatim: bool): bool =
  ran.length() > 0 implies actionLabel(true, ran, card, verbatim) == Labelled({ label: { kind: ran.nthOr(ran.length() - 1, ""), validatedCard: card, verbatimAsked: verbatim } })
```

## Story: Let my plugins learn from a finished turn

> As the maker of a product, I want the evaluators my plugins register to
> see each finished turn, so that what they record follows the
> conversation without delaying or changing the reply.

### After the reply is stored, each evaluator that opts in runs in priority order, and one evaluator's failure stops neither its peers nor the turn

Evaluators run by ascending priority (100 when unset), then name. One whose
`shouldRun` declines is skipped. An evaluator with a local resolver that
applies uses its output; otherwise one model call with its prompt and
schema produces the output its `parse` admits. Its processors then run in
their priority order. A failure in a gate, the model, a parse or a
processor ends that evaluator only. Background and incremental evaluators
belong to the assistant's [evaluator runner](../../assistant/evaluatorRunner.md)
and are not run here.

```quint
type EvaluatorRun = Ran | Declined | Broke
pure def runsNext(done: int, total: int, previous: EvaluatorRun): bool = done < total
pure val totalValues = Set(0, 1, 2)
pure val doneValues = Set(0, 1, 2)
pure def lawABrokenEvaluatorDoesNotStopItsPeers(done: int, total: int): bool = runsNext(done, total, Broke) == runsNext(done, total, Ran)
pure def lawEveryOptedInEvaluatorRuns(done: int, total: int, previous: EvaluatorRun): bool = done < total implies runsNext(done, total, previous)
```
