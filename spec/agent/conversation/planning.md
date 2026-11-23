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
unexpected argument, `executionStatus: "not_started"`) is `Rejected`.

## Story: Ask the agent to do something and hear what happened

> As the owner, I want the agent to use the actions my product gave it and
> tell me truthfully what each one did, so that I never hear success for an
> action that failed, nor a failure the agent already fixed.

### A turn offers the model only registered actions the launch allows, and plans at most eight steps

The message service's own `REPLY`, `IGNORE` and `NONE` are never offered
as tools; a `REPLY` call the model makes anyway ends planning with its
text, and an owner turn always ends with one reply. A step whose model
call returns no tool call ends planning with that text.

```quint
type StepOutcome = Applied | Proposed | Failed | Rejected | NoEffect
type PlanStep = { actionName: str, outcome: StepOutcome, operation: str }
pure val maxPlanSteps = 8
pure val messageServiceActions = Set("REPLY", "IGNORE", "NONE")
pure def offered(registered: Set[str], allowed: Set[str]): Set[str] = registered.intersect(allowed).exclude(messageServiceActions)
pure def keepsPlanning(taken: int, calls: int, terminal: bool): bool = calls > 0 and not(terminal) and taken < maxPlanSteps
pure val registeredValues = Set(Set("REPLY", "CALCULATE"), Set("REPLY", "CALCULATE", "PRODUCT_ACTION"), Set())
pure val allowedValues = Set(Set("REPLY"), Set("REPLY", "CALCULATE"), Set())
pure val takenValues = Set(0, 1, 7, 8, 9)
pure def lawOnlyAllowedRegisteredActionsAreOffered(registered: Set[str], allowed: Set[str]): bool =
  offered(registered, allowed).subseteq(allowed) and offered(registered, allowed).subseteq(registered) and not(offered(registered, allowed).contains("REPLY"))
pure def lawPlanningStopsAtTheBound(taken: int, calls: int, terminal: bool): bool =
  taken >= maxPlanSteps implies not(keepsPlanning(taken, calls, terminal))
pure def lawAnAnswerWithoutToolsEndsPlanning(taken: int, terminal: bool): bool = not(keepsPlanning(taken, 0, terminal))
```

### Each call of a conversation starts with the same system prompt and tools, and what changes per turn follows the history

The system prompt is the character's alone: its system text, bio, style
and message examples. The offered tools are sent in the order of their
names, each in the form the turn gives it (below), so they change only
when what the turn offers does. The history follows, then the person's
latest message, and only after it what this turn adds: the screen
context, the device outcomes of this conversation's earlier requests, the
task the turn runs for and the note that older history is not shown,
each labelled as a note from the agent host. A provider reuses a
request's prompt cache up to its first changed byte, and the cached prefix
is the tools, then the system prompt, then the messages, so a part that
changes with the turn placed before the history costs every message after
it.

```quint
type PromptPart = CharacterPrompt | OfferedTools | PriorHistory | LatestMessage | ScreenNote | DeviceNote | TaskNote | WindowNotice
pure def promptPosition(p: PromptPart): int = match p {
  | OfferedTools => 0 | CharacterPrompt => 1 | PriorHistory => 2 | LatestMessage => 3 | ScreenNote => 4 | DeviceNote => 5 | TaskNote => 6 | WindowNotice => 7
}
pure def changesPerTurn(p: PromptPart): bool = p == LatestMessage or p == ScreenNote or p == DeviceNote or p == TaskNote or p == WindowNotice
pure val pValues = Set(CharacterPrompt, OfferedTools, PriorHistory, LatestMessage, ScreenNote, DeviceNote, TaskNote, WindowNotice)
pure def lawNothingPerTurnPrecedesTheHistory(p: PromptPart): bool = changesPerTurn(p) implies promptPosition(p) > promptPosition(PriorHistory)
pure def lawTheConstantPartsLead(p: PromptPart): bool = not(changesPerTurn(p)) implies promptPosition(p) <= promptPosition(PriorHistory)
```

### An action may narrow its tool to the turn, never beyond its registered form

An action may give the turn its own description and, for parameters it
registered, a narrower schema: the device proposal tool offers only the
operation forms this turn's device negotiated. A narrowed schema for a
parameter the action never registered is dropped, and the action's handler
still checks its arguments against everything its registered form allows.

```quint
pure def turnNarrowed(params: Set[str], narrowed: Set[str]): Set[str] = params.intersect(narrowed)
pure val paramsValues = Set(Set(), Set("operation"), Set("operation", "reason"))
pure val narrowedValues = Set(Set(), Set("operation"), Set("operation", "extra"), Set("extra"))
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

A later `Applied` step with the same operation key closes an earlier
failure or proposal of it. A pre-dispatch refusal had no effect, so any
later `Applied`, `NoEffect` or `Proposed` step of the same action closes it:
a refused proposal the model corrects is reported only as the proposal. A later
failure of an operation replaces its earlier open outcome. What stays open
is what the reply must report: each open failure as that action's failure,
each open proposal as awaiting the owner, whatever the model's prose
claims.

```quint
pure def supersedes(later: PlanStep, earlier: PlanStep): bool =
  (later.outcome == Applied and later.operation == earlier.operation) or
  (earlier.outcome == Rejected and later.actionName == earlier.actionName and (later.outcome == Applied or later.outcome == NoEffect or later.outcome == Proposed))
pure def opens(o: StepOutcome): bool = o == Failed or o == Rejected or o == Proposed
pure def settleStep(held: List[PlanStep], entry: PlanStep): List[PlanStep] =
  if (opens(entry.outcome)) held.select(p => p.operation != entry.operation and not(supersedes(entry, p))).append(entry)
  else held.select(p => not(supersedes(entry, p)))
pure def openOutcomes(steps: List[PlanStep]): List[PlanStep] = steps.foldl(List(), (held, entry) => settleStep(held, entry))
pure def failedOpen(steps: List[PlanStep]): List[PlanStep] = openOutcomes(steps).select(p => p.outcome == Failed or p.outcome == Rejected)
pure val earlierValues = Set({ actionName: "SEND", outcome: Failed, operation: "send:a" }, { actionName: "SEND", outcome: Rejected, operation: "send:x" }, { actionName: "SEND", outcome: Proposed, operation: "send:a" })
pure val laterValues = Set({ actionName: "SEND", outcome: Applied, operation: "send:a" }, { actionName: "SEND", outcome: Applied, operation: "send:b" }, { actionName: "NOTE", outcome: Applied, operation: "note:a" }, { actionName: "SEND", outcome: NoEffect, operation: "send:y" }, { actionName: "SEND", outcome: Proposed, operation: "send:z" })
pure val stepsValues = Set(List(), List({ actionName: "NOTE", outcome: Failed, operation: "note:a" }))
pure def lawTheLatestFailureIsReported(steps: List[PlanStep], earlier: PlanStep): bool =
  earlier.outcome == Failed implies failedOpen(steps.append(earlier)).includes(earlier)
pure def lawASuccessOfTheSameOperationSupersedes(steps: List[PlanStep], earlier: PlanStep, later: PlanStep): bool =
  (later.outcome == Applied and later.operation == earlier.operation) implies not(openOutcomes(steps.append(earlier).append(later)).includes(earlier))
pure def lawASuccessOfAnotherOperationKeepsTheFailure(steps: List[PlanStep], earlier: PlanStep, later: PlanStep): bool =
  (earlier.outcome == Failed and later.operation != earlier.operation) implies failedOpen(steps.append(earlier).append(later)).includes(earlier)
pure def lawARefusalBeforeDispatchIsClosedByTheSameActionSucceeding(steps: List[PlanStep], earlier: PlanStep, later: PlanStep): bool =
  (earlier.outcome == Rejected and later.actionName == earlier.actionName and later.outcome == Applied) implies not(failedOpen(steps.append(earlier).append(later)).includes(earlier))
pure def lawALaterProposalOfTheSameActionClosesARefusal(steps: List[PlanStep], earlier: PlanStep, later: PlanStep): bool =
  (earlier.outcome == Rejected and later.actionName == earlier.actionName and later.outcome == Proposed) implies not(openOutcomes(steps.append(earlier).append(later)).includes(earlier))
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
