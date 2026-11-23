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
The model also sees the turn's clock, and a current-time answer the clock
did not observe is replaced by the clock's own reading before the reply
is stored.

Every model call of a turn sends no output cap ([binding](../models/binding.md)).
The shell (`conversation/planning.vibe`) hands this library the facts it
reads: which actions are registered and allowed, each step's outcome and
operation key, the shape of the model's text, and the shape of the tool
text. The operation key of a step with effect receipts is its action, the
receipt's operation and its resource; without receipts it is the action
and its canonical parameters. A refusal before dispatch (a malformed or
unexpected argument, or an action whose own check declines the message,
`executionStatus: "not_started"`) is `Rejected`.

## Story: Ask the agent to do something and hear what happened

> As the owner, I want the agent to use the actions my product gave it and
> tell me truthfully what each one did, so that I never hear success for an
> action that failed, nor a failure the agent already fixed.

### A turn offers the model only registered actions the launch allows, and plans at most eight steps

The message service's own `REPLY`, `IGNORE` and `NONE` are never offered
as tools; a `REPLY` call the model makes anyway ends planning with its
text, and an owner turn always ends with one reply. A step whose model
call returns no tool call ends planning with that text.

Every other registered action the launch allows is offered whatever the
message says or carries, unless it has no tool form for the turn (below).
An action's own check of the message (its `validate`) never decides what
is offered: it runs when the model calls the action, and a call it
declines, or that fails to check, is refused before the action runs. The
model reads in that call's result that the action did not run, so it may
answer without it or call another offered action, and the refusal stays
reported as any other refusal before dispatch. The owner hears a call the
action's own check declined as `unavailableNotice`, which names no action,
never as the action's internal name.

Each call runs under the turn's one active context, the catch-all
`general`. Core's action gate refuses a call before it runs unless the
action's contexts (core's catalog when it declares none, and `general` when
the catalog names none) include an active one, so an offered action runs
only when its contexts include `general`. Each app's actions therefore
declare `general` beside the app's own context: Calendar's `CALENDAR`,
Browser's `BROWSER` and the assistant's `OWNER_REMINDERS` do, and their
calls run on the owner's turn, where core's catalog alone gave them only
their own contexts (`calendar` and `automation`, `browser`, `tasks` and
`automation`) and every call of them was refused.

```quint
type StepOutcome = Applied | Proposed | Failed | Rejected | NoEffect
type StepIdentity = RequestAttempt({ key: str }) | ReceiptOperation({ key: str })
type PlanStep = { outcome: StepOutcome, identity: StepIdentity }
pure val maxPlanSteps = 8
pure val messageServiceActions = Set("REPLY", "IGNORE", "NONE")
pure val unavailableNotice = "I can't do that from here, so it wasn't done."
pure def offered(registered: Set[str], allowed: Set[str], formless: Set[str]): Set[str] =
  registered.intersect(allowed).exclude(messageServiceActions).exclude(formless)
pure def keepsPlanning(taken: int, calls: int, terminal: bool): bool = calls > 0 and not(terminal) and taken < maxPlanSteps
pure val registeredValues = Set(Set("REPLY", "CALCULATE"), Set("REPLY", "CALCULATE", "PRODUCT_ACTION"), Set())
pure val allowedValues = Set(Set("REPLY"), Set("REPLY", "CALCULATE"), Set())
pure val formlessValues = Set(Set(), Set("CALCULATE"))
pure val takenValues = Set(0, 1, 7, 8, 9)
pure def lawOnlyAllowedRegisteredActionsAreOffered(registered: Set[str], allowed: Set[str], formless: Set[str]): bool =
  offered(registered, allowed, formless).subseteq(allowed) and offered(registered, allowed, formless).subseteq(registered) and not(offered(registered, allowed, formless).contains("REPLY"))
pure def lawEveryAllowedRegisteredActionWithAFormIsOffered(registered: Set[str], allowed: Set[str], formless: Set[str]): bool =
  registered.intersect(allowed).exclude(messageServiceActions).exclude(formless).subseteq(offered(registered, allowed, formless))
pure def lawPlanningStopsAtTheBound(taken: int, calls: int, terminal: bool): bool =
  taken >= maxPlanSteps implies not(keepsPlanning(taken, calls, terminal))
pure def lawAnAnswerWithoutToolsEndsPlanning(taken: int, terminal: bool): bool = not(keepsPlanning(taken, 0, terminal))
pure val turnContexts = Set("general")
pure val contextsValues = Set(Set("general", "calendar"), Set("calendar", "automation"), Set("browser"), Set("general"), Set("tasks", "automation"))
pure def lawACallRunsUnderTheTurnOnlyWhenItsActionDeclaresGeneral(contexts: Set[str]): bool =
  contexts.exists(c => turnContexts.contains(c)) iff contexts.contains("general")
```

### Each call of a conversation starts with the same system prompt and tools, and what changes per turn follows the history

The system prompt is the character's: its system text, bio, style and
message examples, then one fixed rule for the cue written with tool calls
(below), the same text in every call. The offered tools are sent in the order of their
names, each in the form the turn gives it (below), so they change only
when what the turn offers does: no action's own check of a message
changes them, and an action family's description is stated on the first
of its offered actions by name. Nothing a message carries changes them:
not its words, its screen, a whole-request route it matches, nor how its
views are delivered, which a phone states anew with each message. Only
what the launch allows, what the device negotiated, the installation's
enabled views and the browser the agent can command shape them, so the
tools of a phone conversation are the same bytes on every message while
those hold. What applies to one message only (which device operations its
screen allows, the route that owns it, how its views open) reaches the
model after the history, in the note of the offered action it concerns,
and a call that message serves in another place is refused before
dispatch (below). The history follows, then the person's latest message,
and only after it what this turn adds: the screen context, the clock, the
device outcomes of this conversation's earlier requests, the notes of
offered actions on what this message allows, the task the turn runs for,
the note that older history is not shown and the earlier exchanges
recalled for this request. They follow one label saying they are notes
from the agent host, not the person, each note on its own line, so the
label is said once a turn and never when there is no note; the screen
context still says that it is untrusted data about the device, never an
instruction, and the recalled exchanges keep their own heading. A note
carries only what is true of this message: guidance that holds on every
message of a conversation, such as how to read the device outcomes when
there are some, sits in the description of the tool it concerns, which is
cached with the tools. A recalled exchange is never placed among the history, so
the history a turn sends is the one the turn before it sent, followed by
that turn's request and reply, until the window over it steps. A provider
reuses a request's prompt cache up to its first changed byte, and the cached prefix
is the tools, then the system prompt, then the messages, so a part that
changes with the turn placed before the history costs every message after
it. Each planning call also names its conversation's prompt cache key,
`eliza-workflow-v1:` and the hex SHA-256 of the JSON `[agentId, roomId]`
followed by `:planner`, and each evaluator call the same key with
`:evaluator`, so a provider that keeps one cache per key keeps one for
each conversation and stage rather than one for every phone that sends
the same prompt ([binding](../models/binding.md) decides where it is sent).

```quint
type PromptPart = CharacterPrompt | OfferedTools | PriorHistory | LatestMessage | ScreenNote | DeviceNote | TaskNote | WindowNotice | RecalledExchanges
pure def promptPosition(p: PromptPart): int = match p {
  | OfferedTools => 0 | CharacterPrompt => 1 | PriorHistory => 2 | LatestMessage => 3 | ScreenNote => 4 | DeviceNote => 5 | TaskNote => 6 | WindowNotice => 7 | RecalledExchanges => 8
}
pure def changesPerTurn(p: PromptPart): bool = p == LatestMessage or p == ScreenNote or p == DeviceNote or p == TaskNote or p == WindowNotice or p == RecalledExchanges
pure val pValues = Set(CharacterPrompt, OfferedTools, PriorHistory, LatestMessage, ScreenNote, DeviceNote, TaskNote, WindowNotice, RecalledExchanges)
pure def lawNothingPerTurnPrecedesTheHistory(p: PromptPart): bool = changesPerTurn(p) implies promptPosition(p) > promptPosition(PriorHistory)
pure def lawTheConstantPartsLead(p: PromptPart): bool = not(changesPerTurn(p)) implies promptPosition(p) <= promptPosition(PriorHistory)
pure def hostNoteLabels(hostNotes: int): int = if (hostNotes > 0) 1 else 0
pure def lawTheHostNotesShareOneLabel(hostNotes: int): bool = hostNoteLabels(hostNotes) <= 1
pure def lawTheLabelComesExactlyWithANote(hostNotes: int): bool = (hostNoteLabels(hostNotes) == 1) == (hostNotes > 0)
type ToolFact = LaunchAllowed | DeviceNegotiation | InstallationViews | BrowserCommanded | MessageWords | ScreenShown | ViewDelivery | WholeRequestRoute
pure def shapesTools(f: ToolFact): bool = f == LaunchAllowed or f == DeviceNegotiation or f == InstallationViews or f == BrowserCommanded
pure def carriedByMessage(f: ToolFact): bool = f == MessageWords or f == ScreenShown or f == ViewDelivery or f == WholeRequestRoute
pure def lawNothingAMessageCarriesShapesTheTools(f: ToolFact): bool = carriedByMessage(f) implies not(shapesTools(f))
```

### An action may narrow its tool to the turn, never beyond its registered form

An action may give the turn its own description and, for parameters it
registered, a narrower schema: the device proposal tool offers only the
operation forms the device negotiated. A narrowed schema for a
parameter the action never registered is dropped, and the action's handler
still checks its arguments against everything its registered form allows.
An action that narrows its tool may have no form for a turn, as the device
proposal tool has none off an owner turn of the enrolled device, under a
refused negotiation, or when no operation form is offered; it is then not
offered that turn, since a tool with nothing it could be called with is
never sent. An action whose job has another home under some negotiations
has no form there, so each job is offered in one place: the native
`BROWSER` command has none unless it is the home of a history move
([browser control](../../browser/control.md)). A tool's form follows only
what shapes the tools (above), never what a message carries: a job whose
home changes from one message to the next, as a phone view opens with
`VIEWS` on a message whose views are delivered as completed actions and
with the device tool's `open_view` on any other
([device surfaces](../deviceActions/surfaces.md)), keeps both tools, and
the call the message serves in the other is refused before dispatch
(below).

```quint
pure def turnNarrowed(params: Set[str], narrowed: Set[str]): Set[str] = params.intersect(narrowed)
pure val paramsValues = Set(Set(), Set("operation"), Set("operation", "reason"))
pure val narrowedValues = Set(Set(), Set("operation"), Set("operation", "extra"), Set("extra"))
pure def lawAnActionWithNoFormForTheTurnIsNotOffered(registered: Set[str], allowed: Set[str], formless: Set[str]): bool =
  offered(registered, allowed, formless).forall(name => not(formless.contains(name)))
pure def lawANarrowedSchemaForAnUnregisteredParameterIsDropped(params: Set[str], narrowed: Set[str]): bool =
  narrowed.forall(p => not(params.contains(p)) implies not(turnNarrowed(params, narrowed).contains(p)))
pure def lawARegisteredParameterTheTurnNamesIsNarrowed(params: Set[str], narrowed: Set[str]): bool =
  params.forall(p => narrowed.contains(p) implies turnNarrowed(params, narrowed).contains(p))
pure def lawAParameterTheTurnDoesNotNameKeepsItsRegisteredSchema(params: Set[str], narrowed: Set[str]): bool =
  params.forall(p => not(narrowed.contains(p)) implies not(turnNarrowed(params, narrowed).contains(p)))
```

### A call my whole message asked for outright runs first, without waiting on the model's choice

An offered action may name, for this turn, the one call the person's whole
message is a strict command for, such as the device tool's open of the
address in "open example.com". When exactly one offered action names one,
the turn runs that call as its first step, before the model is asked, with
the person's authority as any planned call; the model then sees the call
and its result in the turn and answers or plans on, under the same tools
and step bound. With no such call, or more than one, the model plans as it
always does.

```quint
pure def callRunsFirst(askedCalls: int): bool = askedCalls == 1
pure val askedCallsValues = Set(0, 1, 2, 3)
pure def lawOnlyOneAskedCallRunsFirst(askedCalls: int): bool = callRunsFirst(askedCalls) implies askedCalls == 1
pure def lawTwoAskedCallsLeaveTheChoiceToTheModel(askedCalls: int): bool = askedCalls > 1 implies not(callRunsFirst(askedCalls))
```

### A route that owns the whole request refuses the actions it replaces while its own actions are offered

A plugin may register a direct route ([routing registries](../../core/registries.md))
that owns the whole request. When the turn's message matches such a route
and every action it routes to is offered this turn, a call of an action it
names as replaced is refused before it runs, so the model cannot plan that
request another way, such as opening the Camera view for "take a picture"
([device surfaces](../deviceActions/surfaces.md)). The route is something
the message carries, so the tools stay as they are (above). The refused
call runs nothing, not even its action's own check; the model reads in its
result that the whole request is routed elsewhere and that the action did
not run. It is no step of the turn, since the person never asked for it,
so the reply reports no failure for it. A route that does not own the
whole request, does not match, or routes to an action this turn does not
offer refuses nothing, and no route refuses an action it does not name.

```quint
pure def refusedByRoute(ownsWholeRequest: bool, matched: bool, routedOffered: bool, replaced: bool): bool =
  ownsWholeRequest and matched and routedOffered and replaced
pure def lawARouteWhoseActionsAreNotOfferedRefusesNothing(ownsWholeRequest: bool, matched: bool, replaced: bool): bool =
  not(refusedByRoute(ownsWholeRequest, matched, false, replaced))
pure def lawARouteRefusesOnlyWhatItReplaces(ownsWholeRequest: bool, matched: bool, routedOffered: bool): bool =
  not(refusedByRoute(ownsWholeRequest, matched, routedOffered, false))
pure def lawARouteThatDoesNotOwnTheRequestRefusesNothing(matched: bool, routedOffered: bool, replaced: bool): bool =
  not(refusedByRoute(false, matched, routedOffered, replaced))
```

### A call this message serves in another place is refused before it runs, and is no step of the turn

An action whose tool is the same on every message may say, from what a
message carries, that a call of it has another home on that message:
`VIEWS` on a device message whose views are not delivered as completed
actions, where the device tool's `open_view` serves it
([device surfaces](../deviceActions/surfaces.md)), and a device operation
the message does not allow or that a whole-message route does not own
([proposals](../deviceActions/index.md)). The planner asks before it
dispatches each call, after the route (above). Such a call runs nothing,
not even its action's own check, and the model reads in its result where
the message is served and that nothing ran, so it may take that way, ask
or answer. Like a call a route refuses, it is no step of the turn: the
person's request was not refused, only one way of serving it, which the
tool offers on other messages, so the reply never reports a failure for
it. A call the action itself refuses (one matching none of its forms, one
its own check declines, one its handler refuses) is a step as before.
An action may also give the turn a note on what this message allows of
it, such as the device tool's route lead; it is sent after the person's
latest message only while that action is offered, so it never tells the
model of a tool, a route or a refusal the turn does not have.

```quint
type CallAdmission = Dispatched | RefusedByItsRoute | ServedElsewhere
pure def callAdmission(routeRefuses: bool, servedElsewhere: bool): CallAdmission =
  if (routeRefuses) RefusedByItsRoute else if (servedElsewhere) ServedElsewhere else Dispatched
pure def isTurnStep(a: CallAdmission): bool = a == Dispatched
pure def lawACallRefusedBeforeDispatchIsNoStep(routeRefuses: bool, servedElsewhere: bool): bool =
  (routeRefuses or servedElsewhere) implies not(isTurnStep(callAdmission(routeRefuses, servedElsewhere)))
pure def lawACallNothingRefusesIsDispatched(routeRefuses: bool, servedElsewhere: bool): bool =
  not(routeRefuses or servedElsewhere) implies callAdmission(routeRefuses, servedElsewhere) == Dispatched
pure def actionNoteSent(actionOffered: bool, noted: bool): bool = actionOffered and noted
pure def lawOnlyAnOfferedActionNotesTheMessage(noted: bool): bool = not(actionNoteSent(false, noted))
```

### The model reads what was said in the conversation, in a window taken once for the whole turn

A host notice the agent process stored in the conversation (a message of
the agent carrying `systemNotice`, such as "Eliza needs attention") was
never said by the agent and is left out of the model's history: read back
as its own reply it would tell the model it cannot act. The window over
history is taken when the turn starts and holds for every step of it, so a
message or an outcome that lands while the turn runs changes neither the
window nor what the next step sends.

```quint
type HistoryRow = { fromAgent: bool, hostNotice: bool }
pure def readByTheModel(row: HistoryRow): bool = not(row.fromAgent and row.hostNotice)
pure val rowValues = Set({ fromAgent: true, hostNotice: true }, { fromAgent: true, hostNotice: false }, { fromAgent: false, hostNotice: false })
pure def lawAHostNoticeIsNeverTheAgentsWords(row: HistoryRow): bool = (row.fromAgent and row.hostNotice) implies not(readByTheModel(row))
pure def lawWhatWasSaidIsRead(row: HistoryRow): bool = not(row.hostNotice) implies readByTheModel(row)
```

### A model call is sent again at most once, after a temporary rate limit or a tool call the provider could not parse

A step's model call refused with a temporary rate limit waits for the time
the refusal names, at most five seconds and five seconds when it names
none, and is sent once more; a call the provider refused because it could
not parse the model's tool call is sent once more at once. The wait ends
with the turn's cancellation. A second refusal, spent credit, a used-up
allowance and every other failure end the call as they are. A call that
stopped at the model's own output limit is never sent again: it ran to the
model's whole maximum, and a second try would stop the same way at the
same cost.

```quint
type CallFailure = RateLimitedFor({ hintMs: int }) | RateLimitedWithoutHint | ToolCallUnparsed | OutputLimitReached | OtherFailure
pure val resendWaitMaxMs = 5000
pure def resendWait(failure: CallFailure, resent: bool): int = if (resent) -1 else match failure {
  | RateLimitedFor(x) => if (x.hintMs < 0) 0 else if (x.hintMs > resendWaitMaxMs) resendWaitMaxMs else x.hintMs
  | RateLimitedWithoutHint => resendWaitMaxMs
  | ToolCallUnparsed => 0
  | _ => -1
}
pure def resends(failure: CallFailure, resent: bool): bool = resendWait(failure, resent) >= 0
pure val failureValues = Set(RateLimitedFor({ hintMs: 1200 }), RateLimitedFor({ hintMs: 59000 }), RateLimitedFor({ hintMs: -5 }), RateLimitedWithoutHint, ToolCallUnparsed, OutputLimitReached, OtherFailure)
pure def lawACallIsSentAgainAtMostOnce(failure: CallFailure): bool = not(resends(failure, true))
pure def lawAResendWaitsAtMostFiveSeconds(failure: CallFailure, resent: bool): bool = resendWait(failure, resent) <= resendWaitMaxMs
pure def lawAnOutputLimitOrAnotherFailureIsNeverSentAgain(resent: bool): bool = not(resends(OutputLimitReached, resent)) and not(resends(OtherFailure, resent))
```

### A call that stopped at the model's own output limit ends planning

When the step's own call stops there, the turn answers that the reply was
cut off, with every failure it still holds open. When an action's own model
call stops there, the action is not called again in this turn and planning
ends with what the turn holds.

```quint
pure val cutOffReply = "That answer got cut off before I could finish it. Please try again with a shorter request or ask for a narrower format."
pure def plansOn(cutOff: bool, taken: int, calls: int, terminal: bool): bool = not(cutOff) and keepsPlanning(taken, calls, terminal)
pure def lawACutOffEndsPlanning(taken: int, calls: int, terminal: bool): bool = not(plansOn(true, taken, calls, terminal))
pure def lawWithoutACutOffPlanningGoesOn(taken: int, calls: int, terminal: bool): bool = plansOn(false, taken, calls, terminal) == keepsPlanning(taken, calls, terminal)
```

### A failure or proposal the turn made stays reported unless a later success of the same operation supersedes it

A later `Applied` receipt for the same operation and resource closes an
earlier failure or proposal of that operation. Open outcomes for the same
operation or receiptless request replace earlier ones of the same identity.
Pre-dispatch refusals are recorded separately from dispatched failures. A
later call to the same action can be for another request. The reply reports
an unlinked refusal as a call that did not start, even if the action later
runs. It reports an open failure as that action's failure and an open proposal
as awaiting the owner, whatever the model's prose claims.

```quint
pure def isReceiptOperation(identity: StepIdentity): bool = match identity { | ReceiptOperation(_) => true | _ => false }
pure def supersedes(later: PlanStep, earlier: PlanStep): bool =
  later.outcome == Applied and earlier.outcome != Rejected and later.identity == earlier.identity and isReceiptOperation(later.identity)
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

### A pending-work cue is spoken only before work runs and is never the reply, and an answer is delivered whole

The system prompt's cue rule asks the model to write, with its first tool
calls, only a brief cue that it heard the request: `Let me check.` or
`Let me check your calendar.` for a question or a lookup, a request asked
as a question (`Can you text Sam?`) included; `Sure.`, `Sure, one sec.` or
`Yeah, one sec.` for a plain command (`Text Sam I'm late`, `Set an alarm
for seven`); `On it.` or `One sec.` for any other action. It never names
the people, items, times or outcome, never says the work is done or under
way, never repeats the request, and is left empty, with the work still
done, when the person asked for silence; later tool calls come with no
text.

The shell reads the model's text as a `Cue` only when the whole of it is
one to three sentences of the closed acknowledgment grammar (`On it`,
`One sec`, `Just a moment`, a lead such as `Let me` with a look-up verb and
an owner container such as `your calendar`, or a lead with an intent such
as `open Maps`), at most 120 characters, with no digits, clock times,
counts, names other than one after `check with`, or question mark. The
grammar has no past-tense verb, negation or completion word, so a cue never
claims that an effect happened or that the owner's tracked work is empty.
A wait cue followed by more text that is not progress (`One second is
1,000 milliseconds.`, `Just a second, your dentist is Thursday.`) is an
`Answer`. A cue that comes with the turn's first tool calls is the turn's
acknowledgment (below); whatever text streamed with tool calls is
restarted to empty before they run, so a cue is never part of the reply's
text. A cue with no
tool call is not an answer: the model is asked once more to answer with
what the turn holds, and if steps run out the turn's failure fallback is
the reply.

```quint
type Draft = Cue | Answer | Silent
type PlanMove = RunTools | Deliver | AskAgain | GiveUp
pure def acknowledges(draft: Draft, calls: int, earlierCalls: int): bool = draft == Cue and calls > 0 and earlierCalls == 0
pure def nextMove(draft: Draft, calls: int, stepsLeft: int): PlanMove =
  if (calls > 0) RunTools
  else if (draft == Answer) Deliver
  else if (stepsLeft > 0) AskAgain
  else GiveUp
pure val stepsLeftValues = Set(0, 1, 3)
pure def lawAnAnswerIsDeliveredWhole(stepsLeft: int): bool = nextMove(Answer, 0, stepsLeft) == Deliver
pure def lawACueIsNeverTheReply(calls: int, stepsLeft: int): bool = nextMove(Cue, calls, stepsLeft) != Deliver
pure val earlierCallsValues = Set(0, 1, 2)
pure def lawACueIsSpokenOnlyBeforeWork(draft: Draft, calls: int, earlierCalls: int): bool =
  acknowledges(draft, calls, earlierCalls) implies (calls > 0 and draft == Cue and earlierCalls == 0)
```

### A turn acknowledges at most once, with a cue that comes with its first tool calls, and bare assent is a cue only with work after an instruction

`Sure` or `Yeah`, alone or followed by a comma, dash, colon, semicolon or
sentence break and one or two sentences of the grammar (`Sure, one sec.`,
`Yeah. Let me check your calendar.`), says yes, so it is a cue only when it
comes with tool calls and the owner's message is an instruction: after
fillers (`hey`, `ok`, `so`, `please`, …), a name and comma, or a greeting
and a wake name, it opens with a command verb (`text`, `set`, `call`, `remind`, …), it has no
question mark, and no sentence or comma clause opens with a question word
or an auxiliary (`am`, `is`, `can`, `what`, …). `Can you text Sam`, `Am I
free Friday` and `Any meetings today` are not instructions, so a bare
`Sure.` after them is an answer. With no tool call, assent is the answer
after any message: `Sure.` to `Call me Bob` or `Remember that I like tea`
is delivered, never asked again. `Sure!` before a lead form (`Sure! Let me
check your calendar.`) is a cue after any message. The acknowledgment is
delivered at most once per turn, as the [reply stream](./replyStream.md)'s
`acknowledgment` frame, and only while no tool of the turn has run, a call
the whole message asked for outright included; a cue at a later step is
dropped with the rest of that step's text.

```quint
type DraftShape = Blank | GrammarCue | AssentCue | OtherText
pure def readDraft(shape: DraftShape, instruction: bool, calls: int): Draft = match shape {
  | Blank => Silent | GrammarCue => Cue | AssentCue => if (instruction and calls > 0) Cue else Answer | OtherText => Answer
}
pure def lawBareAssentIsACueOnlyWithWorkAfterAnInstruction(instruction: bool, calls: int): bool =
  (readDraft(AssentCue, instruction, calls) == Cue) iff (instruction and calls > 0)
pure def lawBareAssentWithoutWorkIsDelivered(instruction: bool, stepsLeft: int): bool =
  nextMove(readDraft(AssentCue, instruction, 0), 0, stepsLeft) == Deliver
pure def lawTheGrammarIsACueAfterAnyMessage(instruction: bool, calls: int): bool = readDraft(GrammarCue, instruction, calls) == Cue
pure def lawATurnAcknowledgesAtMostOnce(draft: Draft, calls: int, earlierCalls: int, laterDraft: Draft, laterCalls: int): bool =
  acknowledges(draft, calls, earlierCalls) implies not(acknowledges(laterDraft, laterCalls, earlierCalls + calls))
```

### A tool's progress names its app only when one labelled app applies, and never its arguments or results

When a tool call starts, its progress carries the action's name and a
label for the owner: `Using <label>` when, among the contexts the call
reaches other than the catch-all `general` and `simple` and any `system`
context, exactly one applies and the runtime's context registry gives it a
label, and `Working` otherwise. A call reaches the action's declared
contexts (core's catalog when it declares none), unless the action names
them for each call from its arguments: a device call reaches the app its
operation's proposal family declares, and no app when that family declares
none, so a device call is named only by its family's app and the arguments
never appear in the label. Contexts with the same label count once; an
unlabelled context counts by its id, so an action that may also reach an
unnamed app is `Working`. The registry starts empty: an app is named only
once it registers its own labelled context when it loads and its actions,
and its proposal family, declare that context. Maps registers `Maps`,
Calendar `Calendar`, Browser `Browser`, Files `Files`, Inbox `Inbox`,
Workflows `Workflows`, Notes `Notes`, and the assistant `Reminders` for its
reminders. An action that declares no context, or only contexts nobody
labelled, is `Working`: the views tool, which opens any app, the
assistant's goals, to-dos, routines and briefings, the phone's call,
message and surface operations, the reminders family's operations, which
reach both Reminders and Clock, and a helper such as `CALCULATE`. The label
is status text only, never part of the tools, the system prompt or the
history.

```quint
type ToolActivity = UsingApp | Working
pure def toolActivity(applicable: int, labelled: int): ToolActivity = if (applicable == 1 and labelled == 1) UsingApp else Working
pure val applicableValues = Set(0, 1, 2)
pure val labelledValues = Set(0, 1, 2)
pure def lawAnAppIsNamedOnlyWhenItIsTheOnlyOneThatApplies(applicable: int, labelled: int): bool =
  toolActivity(applicable, labelled) == UsingApp implies (applicable == 1 and labelled == 1)
type DeviceFamilyApp = FamilyApp({ app: str }) | NoFamilyApp
pure def deviceCallReach(deviceFamily: DeviceFamilyApp): Set[str] = match deviceFamily { | FamilyApp(f) => Set(f.app) | NoFamilyApp => Set() }
pure val deviceFamilyValues = Set(FamilyApp({ app: "calendar" }), FamilyApp({ app: "notes" }), NoFamilyApp)
pure def lawADeviceCallReachesAtMostItsFamilysApp(deviceFamily: DeviceFamilyApp): bool = match deviceFamily {
  | FamilyApp(f) => deviceCallReach(deviceFamily) == Set(f.app) | NoFamilyApp => deviceCallReach(deviceFamily) == Set() }
pure def lawADeviceCallIsNamedOnlyByItsFamilysApp(deviceFamily: DeviceFamilyApp, labelled: int): bool =
  toolActivity(deviceCallReach(deviceFamily).size(), labelled) == UsingApp implies deviceFamily != NoFamilyApp
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

## Story: Ask what time it is and hear my own clock

> As the owner, I want the agent to know the date and time where I am, so
> that it answers "what time is it" and resolves today and tomorrow from my
> clock, and never tells me a date or time it made up.

### Each turn's model sees the clock of the phone's zone, else the launch zone, else the host's, and it is the owner's local time only from the phone or, for the owner, the launch

The shell reads the phone's zone from the turn's voice view context
(`uiTimeZone`), else its observation (`timeZone`); the launch document's
`timeZone`; and the host's own zone, or `UTC`. A zone counts only when the
host's zone database knows it. The turn's host notes, after the history,
carry one line, to the minute, so every turn inside one minute sees the same
text and the system prompt stays the same for the whole conversation. The owner's
local clock reads `Local date: <YYYY-MM-DD> (<zone>). <full date and
time>. Resolve today/tomorrow from this local date, not the UTC date. UTC
instant: <YYYY-MM-DDTHH:MM>Z`. Any other clock reads `Agent time` for the
launch zone or `Server time` for the host's, then the full date and time,
the zone and the UTC instant, and says the user's timezone is unknown.

```quint
type ZoneOrigin = PhoneZone | LaunchZone | HostZone
type ClockSource = { clockZone: str, origin: ZoneOrigin, ownersLocal: bool }
pure def clockSource(phoneZone: str, launchZone: str, hostZone: str, owner: bool): ClockSource =
  if (phoneZone != "") { clockZone: phoneZone, origin: PhoneZone, ownersLocal: true }
  else if (launchZone != "") { clockZone: launchZone, origin: LaunchZone, ownersLocal: owner }
  else { clockZone: hostZone, origin: HostZone, ownersLocal: false }
pure val phoneZoneValues = Set("", "Asia/Tokyo")
pure val launchZoneValues = Set("", "America/New_York")
pure val hostZoneValues = Set("UTC", "America/Los_Angeles")
pure def lawThePhoneZoneWins(phoneZone: str, launchZone: str, hostZone: str, owner: bool): bool =
  phoneZone != "" implies clockSource(phoneZone, launchZone, hostZone, owner) == { clockZone: phoneZone, origin: PhoneZone, ownersLocal: true }
pure def lawTheLaunchZoneIsLocalOnlyForTheOwner(launchZone: str, hostZone: str, owner: bool): bool =
  launchZone != "" implies clockSource("", launchZone, hostZone, owner) == { clockZone: launchZone, origin: LaunchZone, ownersLocal: owner }
pure def lawTheHostClockIsNeverTheOwnersLocalTime(hostZone: str, owner: bool): bool =
  clockSource("", "", hostZone, owner) == { clockZone: hostZone, origin: HostZone, ownersLocal: false }
```

### A standalone answer to a current-time question that names a date, weekday or clock the clock did not observe is replaced by the clock's own reading

The question is the whole message: `what time is it`, `what's the time`,
`what is the current`, `local` or `today's` `time`, `day` or `date`, or
`what day of the week is it`, followed only by `right now`, `now`,
`today`, `for me` or `please` and closing punctuation. "What time is it now
that the meeting has ended?" is not one. The answer is standalone when
nothing is left after removing its month-day dates, weekdays and clock
times (minutes optional, so `5 PM` is one), the fillers `it's`, `it is`,
`today is`, `currently`, `right now`, `about`, `at`, `for you`, `in your
local time` and `your local time`, `AM` and `PM`, every zone label the
clock renders (`EST`, `EDT`, `CST`, `CDT`, `MST`, `MDT`, `PST`, `PDT`,
`AKST`, `AKDT`, `HST`, `HAST`, `HADT`, `AST`, `ADT`, and `UTC` or `GMT`
alone or with an offset such as `GMT+9` or `GMT+5:30`), and spaces and
`,.!():`. A stated date disagrees when its month or day, or a year it
states, is not the local date's; a weekday when it is not today's; a clock
when it is more than ten minutes from the local time, counted the short
way around midnight. The reply is then `It's <full date and time to the
second, with its zone>.`, with no further model call. Any other reply is
kept as it is.

```quint
type StatedTime = StatedDay({ month: int, day: int, year: int }) | StatedWeekday({ weekday: int }) | StatedClock({ minuteOfDay: int })
type LocalClock = { month: int, day: int, year: int, weekday: int, minuteOfDay: int }
pure val clockToleranceMinutes = 10
pure val minutesPerDay = 1440
pure def clockDrift(statedMinute: int, observedMinute: int): int = {
  val apart = if (statedMinute > observedMinute) statedMinute - observedMinute else observedMinute - statedMinute
  if (apart < minutesPerDay - apart) apart else minutesPerDay - apart
}
pure def statementDisagrees(statement: StatedTime, localClock: LocalClock): bool = match statement {
  | StatedDay(d) => d.month != localClock.month or d.day != localClock.day or (d.year != 0 and d.year != localClock.year)
  | StatedWeekday(w) => w.weekday != localClock.weekday
  | StatedClock(c) => clockDrift(c.minuteOfDay, localClock.minuteOfDay) > clockToleranceMinutes
}
pure def statedTimeIsUngrounded(asksTime: bool, standalone: bool, statedTimes: List[StatedTime], localClock: LocalClock): bool =
  asksTime and standalone and statedTimes.some(s => statementDisagrees(s, localClock))
pure val localClockValues = Set({ month: 9, day: 11, year: 2026, weekday: 5, minuteOfDay: 678 }, { month: 9, day: 12, year: 2026, weekday: 6, minuteOfDay: 5 })
pure val statementValues = Set(StatedDay({ month: 9, day: 11, year: 0 }), StatedDay({ month: 11, day: 22, year: 2026 }), StatedWeekday({ weekday: 0 }), StatedClock({ minuteOfDay: 1435 }), StatedClock({ minuteOfDay: 1021 }))
pure val statedTimesValues = Set(List(), List(StatedWeekday({ weekday: 5 }), StatedClock({ minuteOfDay: 680 })), List(StatedDay({ month: 11, day: 22, year: 2026 })))
pure val statedMinuteValues = Set(0, 5, 668, 689, 1435)
pure val observedMinuteValues = Set(0, 678, 1439)
pure def lawOnlyAStandaloneAnswerToATimeQuestionIsJudged(asksTime: bool, standalone: bool, statedTimes: List[StatedTime], localClock: LocalClock): bool =
  statedTimeIsUngrounded(asksTime, standalone, statedTimes, localClock) implies (asksTime and standalone)
pure def lawTheObservedClockIsGrounded(localClock: LocalClock): bool =
  not(statementDisagrees(StatedDay({ month: localClock.month, day: localClock.day, year: localClock.year }), localClock))
  and not(statementDisagrees(StatedWeekday({ weekday: localClock.weekday }), localClock))
  and not(statementDisagrees(StatedClock({ minuteOfDay: localClock.minuteOfDay }), localClock))
pure def lawAClockIsWrongOnlyBeyondTenMinutes(statedMinute: int, observedMinute: int, localClock: LocalClock): bool =
  statementDisagrees(StatedClock({ minuteOfDay: statedMinute }), { ...localClock, minuteOfDay: observedMinute }) iff clockDrift(statedMinute, observedMinute) > clockToleranceMinutes
pure def lawAWrongStatementIsReplaced(statement: StatedTime, localClock: LocalClock): bool =
  statementDisagrees(statement, localClock) implies statedTimeIsUngrounded(true, true, List(statement), localClock)
```

### A reply that gives a just-changed calendar event a time range other than the one it got is replaced by the change's own words

When a turn's actions applied exactly one timed calendar event, through a
successful result that carries the event (its id, start, end, zone and
version, and a title naming no clock time) and its own applied create or
update receipt for that event at that version, a reply that states one
clock range, a start and an end such as "3–4 PM", is read on the event's
own clock. When its start or end is not the event's, the reply is
replaced by that action's own words, with no further model call. A reply
to a current-time question, one that states a single clock time, a zone
or an offset, and a turn that changed no event or more than one, are kept
as they are; identical copies of one result count as one event.

```quint
pure def eventRangeIsUngrounded(asksTime: bool, oneRange: bool, zoneStated: bool, changedEvents: int, rangeMatches: bool): bool =
  not(asksTime) and oneRange and not(zoneStated) and changedEvents == 1 and not(rangeMatches)
pure def lawTheAppliedRangeIsKept(asksTime: bool, oneRange: bool, zoneStated: bool, changedEvents: int): bool =
  not(eventRangeIsUngrounded(asksTime, oneRange, zoneStated, changedEvents, true))
pure def lawOnlyOneChangedEventJudgesARange(asksTime: bool, oneRange: bool, zoneStated: bool, changedEvents: int, rangeMatches: bool): bool =
  eventRangeIsUngrounded(asksTime, oneRange, zoneStated, changedEvents, rangeMatches) implies changedEvents == 1
pure def lawAZoneOrASingleClockIsLeftToTheReply(asksTime: bool, changedEvents: int, rangeMatches: bool): bool =
  not(eventRangeIsUngrounded(asksTime, true, true, changedEvents, rangeMatches)) and not(eventRangeIsUngrounded(asksTime, false, false, changedEvents, rangeMatches))
pure val changedEventsValues = Set(0, 1, 2)
```

## Story: Let my plugins learn from a finished turn

> As the maker of a product, I want the evaluators my plugins register to
> see each finished turn, so that what they record follows the
> conversation without delaying or changing the reply.

### After the reply is stored, each evaluator that opts in runs in priority order, and one evaluator's failure stops neither its peers nor the turn

Evaluators run by ascending priority (100 when unset), then name. One whose
`shouldRun` declines is skipped. An evaluator with a local resolver that
applies uses its output; otherwise one model call with its prompt and
schema produces the output its `parse` admits. That call carries the
evaluator's own response schema, the same on every turn, and nothing the
planner was told about choosing tools; it sends no output cap, and a
temporary rate limit sends it once more as a planning call is. Its processors then run in
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
