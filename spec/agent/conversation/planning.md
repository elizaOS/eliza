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
The model also sees the turn's clock. A reply that leaves a failure
unreported, or states a time the clock or a calendar change did not
observe, goes back to the model once with those facts before it is stored,
and fixed words take its place only when that second answer fails too.

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

```quint
type StepOutcome = Applied | Proposed | Failed | Rejected | NoEffect
type StepIdentity = RequestAttempt({ key: str }) | ReceiptOperation({ key: str })
type PlanStep = { outcome: StepOutcome, identity: StepIdentity }
pure val maxPlanSteps = 8
pure val messageServiceActions = Set("REPLY", "IGNORE", "NONE", "RESTORE_CONTEXT")
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
```

### Each call of a conversation starts with the same system prompt and tools, and what changes per turn follows the history

The system prompt is the character's: its system text, bio, style and
message examples, then one fixed rule for the cue written with tool calls
(below), the same text in every call. The offered tools are sent in the order of their
names, each in the form the turn gives it (below), so they change only
when what the turn offers does: no action's own check of a message
changes them, and an action family's description is stated on the first
of its offered actions by name. Nothing a message carries changes them:
not its words, its screen, nor how its
views are delivered, which a phone states anew with each message. Only
what the launch allows, what the device negotiated, the installation's
enabled views and the browser the agent can command shape them, so the
tools of a phone conversation are the same bytes on every message while
those hold. What applies to one message only (which device operations its
screen allows, how its views open) reaches the
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
it. Each planning call also names its agent's prompt cache key,
`eliza-workflow-v1:` and the hex SHA-256 of the JSON `[agentId]`
followed by `:planner`, and each evaluator call the same key with
`:evaluator`, so a provider that keeps one cache per key keeps one for
each phone and stage rather than one for every phone that sends the same
prompt, and a new conversation starts on the tools and system prompt that
the phone's earlier calls and its warm-up (below) already cached
([binding](../models/binding.md) decides where it is sent).

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
type ToolFact = LaunchAllowed | DeviceNegotiation | InstallationViews | BrowserCommanded | MessageWords | ScreenShown | ViewDelivery
pure def shapesTools(f: ToolFact): bool = f == LaunchAllowed or f == DeviceNegotiation or f == InstallationViews or f == BrowserCommanded
pure def carriedByMessage(f: ToolFact): bool = f == MessageWords or f == ScreenShown or f == ViewDelivery
pure def lawNothingAMessageCarriesShapesTheTools(f: ToolFact): bool = carriedByMessage(f) implies not(shapesTools(f))
```

### A warm-up sends the planner's tools and system prompt once with a one-token cap, at most once every four minutes, and stores and shows nothing

A page that expects the owner to talk soon (the app opened, returned to
the foreground, Ask Alpha raised) asks the agent to warm up, so the first
turn finds the provider's prompt cache, the cloud and their connections
warm instead of paying for all three. The request carries the headers a
turn of that page carries, so a warm-up of the enrolled device runs under
that device's turn, as a first turn of a new conversation would: it builds
the tools and the system prompt exactly as that turn does, the
device-dependent tools included, and sends one planning call with them,
one placeholder message, an output cap of one token and the planner's own
choice of tools (Cerebras leaves the tools out of the prompt of a call
that may call none, which would warm only the system prompt), under the
agent's planning cache key, the one that turn names. Its answer is
dropped: it starts no run, stores and publishes no message, writes its
model-call log row under a room of its own and never a conversation's,
changes no account state ([binding](../models/binding.md)), and a failure
or a call that does not end within twenty seconds is dropped too. One
warm-up runs at a time, and one asked within four minutes of the last that
started is skipped, so a page may ask on every trigger and the account
pays for at most one warm-up in four minutes; one refused for a blocked account still counts, so signing in again waits out the four minutes or the next trigger after them. The request is answered at
once, saying only whether a warm-up was started; it never waits for the
model.

```quint
pure val warmUpOutputCap = 1
pure val warmUpSpacingMs = 240000
pure val warmUpDeadlineMs = 20000
pure def warmUpStarts(running: bool, lastStartedAt: int, now: int): bool =
  not(running) and (lastStartedAt < 0 or now - lastStartedAt >= warmUpSpacingMs)
pure val lastStartedAtValues = Set(-1, 0, 100000)
pure val nowValues = Set(0, 100000, 239999, 340000, 600000)
pure def lawAWarmUpWaitsFourMinutesAfterTheLast(running: bool, lastStartedAt: int, now: int): bool =
  (lastStartedAt >= 0 and now - lastStartedAt < warmUpSpacingMs) implies not(warmUpStarts(running, lastStartedAt, now))
pure def lawOneWarmUpRunsAtATime(lastStartedAt: int, now: int): bool = not(warmUpStarts(true, lastStartedAt, now))
pure def lawTheFirstWarmUpStarts(now: int): bool = warmUpStarts(false, -1, now)
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

### Every call of a turn is one the model chose, and a call this message serves in another place is refused before it runs and is no step of the turn

The model sees the person's message before anything runs, and every call
of the turn is one it made: no call runs before its first response, no
reply is given before it is asked, and no call is refused because of how
the person worded the request. What the words ask for, which app serves
them and when to ask a question back are the model's to judge; the
actions check what it proposed, and the tool descriptions and notes say
which action serves what.

An action whose tool is the same on every message may say, from what a
message carries, that a call of it has another home on that message:
`VIEWS` on a device message whose views are not delivered as completed
actions, where the device tool's `open_view` serves it
([device surfaces](../deviceActions/surfaces.md)), and a device operation
the message does not allow ([proposals](../deviceActions/index.md)). The
planner asks before it dispatches each call. Such a call runs nothing, not
even its action's own check, and the model reads in its result where the
message is served and that nothing ran, so it may take that way, ask or
answer. It is no step of the turn: the person's request was not refused,
only one way of serving it, which the tool offers on other messages, so
the reply never reports a failure for it. A call the action itself
refuses (one matching none of its forms, one its own check declines, one
its handler refuses) is a step as before. An action may also give the
turn a note on what this message allows of it, such as the device tool's
note on how views open; it is sent after the person's latest message
only while that action is offered, so it never tells the model of a tool
or a refusal the turn does not have.

```quint
type CallAdmission = Dispatched | ServedElsewhere
pure def callAdmission(servedElsewhere: bool): CallAdmission = if (servedElsewhere) ServedElsewhere else Dispatched
pure def isTurnStep(a: CallAdmission): bool = a == Dispatched
pure def lawACallServedElsewhereIsNoStep(servedElsewhere: bool): bool =
  servedElsewhere implies not(isTurnStep(callAdmission(servedElsewhere)))
pure def lawACallNothingRefusesIsDispatched(servedElsewhere: bool): bool =
  not(servedElsewhere) implies callAdmission(servedElsewhere) == Dispatched
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

### A planner can restore the turn's deferred history once and runs no sibling action from that response

When the planner has action tools, one fixed `RESTORE_CONTEXT` form follows
the discovery tools, even when the turn has nothing to restore. It asks for
a nonempty reason and accepts the scopes `history`, `providers` and `full`,
with `full` as the default. The owner-turn planner can restore only the
deferred dialogue already read for this conversation at the start of the
turn. It does no live provider read. The answer quotes the captured rows
after the existing history and says when there are older rows outside that
read. It sends the newest complete deferred rows that fit within 12,000
UTF-8 bytes and reports how many captured rows did not fit. A request with no available context, an invalid request or a second
restore gets a corrective result. A response containing a restore runs no
sibling action, sends no reply or cue from that response, and consumes one
of the bounded planner calls.

```quint
type RestoreAnswer = RestoredHistory | RestoreUnavailable | RestoreInvalid
pure def offersContextRestore(actions: int): bool = actions > 0
pure def contextRestoreOf(validRestore: bool, deferredHistory: bool, restoredHistory: bool): RestoreAnswer =
  if (not(validRestore)) RestoreInvalid
  else if (deferredHistory and not(restoredHistory)) RestoredHistory
  else RestoreUnavailable
pure def admitsPlannerWork(restoreCalls: int): bool = restoreCalls == 0
pure val maxRestoredHistoryBytes = 12000
pure val restoreCallsValues = Set(0, 1, 2)
pure val actionsValues = Set(0, 1, 3)
pure def lawRestoreNeedsActionTools(actions: int): bool =
  offersContextRestore(actions) == (actions > 0)
pure def lawRestoredHistoryIsReadOnlyOnce(validRestore: bool, deferredHistory: bool): bool =
  contextRestoreOf(validRestore, deferredHistory, true) != RestoredHistory
pure def lawOnlyAValidRestoreCanReturnHistory(deferredHistory: bool, restoredHistory: bool): bool =
  contextRestoreOf(false, deferredHistory, restoredHistory) == RestoreInvalid
pure def lawARestoreSuppressesItsSiblingActions(restoreCalls: int): bool =
  restoreCalls > 0 implies not(admitsPlannerWork(restoreCalls))
```

### Attached documents share a bounded text allowance and images stay images

The latest message's attachments follow its text in their original order.
Images remain image parts. The agent reads plain text, CSV, Markdown and JSON
as UTF-8, and the host's PDF service reads PDF when available. Across the
turn, complete document text parts share 32 KiB of UTF-8, including the
serialized name, type and external-content envelope. A document that
would exceed the remaining allowance reaches the model by name and type.
The reply tells the owner that some document content exceeded the limit.
Later documents can still use the remaining allowance. The uploaded files
stay intact. Audio, video, invalid UTF-8 and a PDF the host cannot read
reach the model by name and type with an unreadable marker. Names, types
and extracted text in every document part are external content. Model
calls carry images and text parts.

```quint
type AttachedKind = AttachedImage | AttachedText | AttachedPdf | AttachedMedia
type AttachedRead = AttachedAsImage | AttachedAsText | AttachedAsName
pure def attachedRead(attachedKind: AttachedKind, textRead: bool): AttachedRead =
  if (attachedKind == AttachedImage) AttachedAsImage
  else if ((attachedKind == AttachedText or attachedKind == AttachedPdf) and textRead) AttachedAsText
  else AttachedAsName
pure val attachedDocumentBytes: int = 32768
pure def documentTextFits(remaining: int, partBytes: int): bool =
  partBytes >= 0 and partBytes <= remaining
pure def lawOnlyAnImageReachesTheModelAsItself(attachedKind: AttachedKind, textRead: bool): bool =
  (attachedRead(attachedKind, textRead) == AttachedAsImage) iff (attachedKind == AttachedImage)
pure def lawAudioAndVideoReachTheModelOnlyByName(textRead: bool): bool = attachedRead(AttachedMedia, textRead) == AttachedAsName
pure def lawOnlyAReadableDocumentCanOfferText(attachedKind: AttachedKind, textRead: bool): bool =
  (attachedRead(attachedKind, textRead) == AttachedAsText) iff
    ((attachedKind == AttachedText or attachedKind == AttachedPdf) and textRead)
pure def lawIncludedTextFitsWithinTheSharedAllowance(remaining: int, partBytes: int): bool =
  (remaining <= attachedDocumentBytes and documentTextFits(remaining, partBytes)) implies
    (remaining - partBytes >= 0 and remaining - partBytes <= attachedDocumentBytes)
```

### A model call is sent again at most once, after a temporary rate limit or a tool call the provider could not parse

A step's model call refused with a temporary rate limit waits for the time
the refusal names, at most five seconds and five seconds when it names
none, and is sent once more; a call the provider refused because it could
not parse the model's tool call is sent once more at once. The wait ends
with the turn's cancellation. A dispatch that already started more than one
provider handler uses this retry budget. A second refusal, spent credit, a used-up
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

### A response with competing terminal decisions runs no sibling action and can be repaired once

One model response can carry at most one terminal decision. If it offers
more than one, none of its tool calls run and its draft is cleared. The
planner can ask for a corrected decision one time within the turn's
existing step budget. A second ambiguous response stops planning. Work
settled by an earlier response remains in the reply's record.

```quint
type TerminalAnswer = AdmitTerminalAnswer | RepairTerminalAnswer | RefuseTerminalAnswer
pure def terminalAnswerOf(terminalDecisions: int, terminalRepairSent: bool, hasSteps: bool): TerminalAnswer =
  if (terminalDecisions <= 1) AdmitTerminalAnswer
  else if (not(terminalRepairSent) and hasSteps) RepairTerminalAnswer
  else RefuseTerminalAnswer
pure val terminalDecisionsValues = Set(0, 1, 2, 3)
pure def lawCompetingTerminalDecisionsAreNeverAdmitted(terminalDecisions: int, terminalRepairSent: bool, hasSteps: bool): bool =
  terminalDecisions > 1 implies terminalAnswerOf(terminalDecisions, terminalRepairSent, hasSteps) != AdmitTerminalAnswer
pure def lawATerminalRepairUsesOneRemainingStep(terminalDecisions: int, terminalRepairSent: bool, hasSteps: bool): bool =
  terminalAnswerOf(terminalDecisions, terminalRepairSent, hasSteps) == RepairTerminalAnswer implies not(terminalRepairSent) and hasSteps
```

### An identical call runs at most once per model response, and a settled effect is never repeated in the turn

Two calls with the same tool name and canonical arguments in one response
are one operation even when the model gave them different ids. The second
receives a tool result saying that it did not run. A later response can
repeat an observation without effect-capable tags when it declares itself
read-only, or an observation whose receipts were all fresh no-ops or previews.
It cannot repeat an identical
operation that succeeded, applied an effect, or has a non-retryable
failure from its provenance, typed data or effect receipts. A receipt
with unknown acceptance also prevents repeating the operation. A different operation or
corrected arguments still go through the usual admission checks.

```quint
type ToolSettlement = ToolOpen | ToolSucceeded | ToolNonretryable
type ToolDispatch = FreshCall | DuplicateInBatch | AlreadySettled | RetryRefused
pure def toolDispatch(seen: bool, previousSettlement: ToolSettlement): ToolDispatch =
  if (seen) DuplicateInBatch else match previousSettlement {
    | ToolSucceeded => AlreadySettled
    | ToolNonretryable => RetryRefused
    | ToolOpen => FreshCall
  }
pure val previousSettlementValues = Set(ToolOpen, ToolSucceeded, ToolNonretryable)
pure def lawNoSecondCallInOneResponse(previousSettlement: ToolSettlement): bool =
  toolDispatch(true, previousSettlement) == DuplicateInBatch
pure def lawOnlyOpenCallsRunAcrossResponses(previousSettlement: ToolSettlement): bool =
  (toolDispatch(false, previousSettlement) == FreshCall) == (previousSettlement == ToolOpen)
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
later call to the same action can be for another request. An unlinked
refusal stays open as a call that did not start, even if the action later
runs. An open proposal is reported as awaiting the owner in the action's own
copy, whatever the model's prose claims. An open failure is reported as that
action's failure in the action's own words, except a failure with no
receipt that a later run of its action may have answered under the rule
below.

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

### A reply that leaves a failure unreported is written again once, and the delivered reply still reports open failures and attachment omissions

After planning, an open failure (above) whose own words the reply does not
hold is unreported, and so is an attached document left out for the turn's
allowance. A failure's own words are its action's text for the owner, its
error or its result text; a call its action's own check declined is
`unavailableNotice`, and a failure with no words is a sentence that the
call did not start or did not complete. A left-out document's are that some
attached documents exceeded what can be read in one turn. When anything is
unreported, or the reply states a time the turn did not observe (the clock
rules below), the model is asked once more: the turn's system prompt, its
tools with none to be chosen, the planner's transcript, the reply as the
assistant's, and one host note that names each such fact and says the reply
is not final yet. A failure's own words reach that note cut to a tool
message's length, and as external data unless the action marked them as its
words for the owner. Its answer takes the place of the model's prose, and
the action's own copy stays where composition puts it (below). That reply is
kept when it answers (it is neither blank nor a pending-work cue, read as
below), it is not the first reply again, and the clock rules hold of it.
Otherwise, or when the call fails, the first
reply is kept, or the clock's or the calendar change's own words (below)
take its place when it stated a time they did not observe. Under the
model's reply, first or kept second, each remaining open failure whose words
its action wrote for the owner, and each attachment omission, is reported in
those words if the reply does not already contain them; a failure's error,
its result text that no action marked for the owner, and the host's own
sentence that a call did not start or did not complete reached the model
only, and the owner hears that failure in the model's words alone. Only as
the last resort, under fixed words, does each remaining open failure follow
in its own words if the reply does not already contain them, so that a
reply never stands as if the step had happened.
A reply with nothing unreported and no
unobserved time makes no further call, a turn cut off at the model's output
limit is never asked again, and no turn is asked more than once.

Safety copy is never rewritten. A failure whose action marks its words as
safety copy (the emergency refusal of a phone that cannot open its keypad),
and every failure of a turn whose tool copy stands alone (below), is not put
to the model: its own words follow the reply whatever the model wrote.

```quint
type ReplySource = ModelReply | RevisedReply | FixedWords
pure def asksAgain(unreported: bool, ungrounded: bool, cutOff: bool): bool = (unreported or ungrounded) and not(cutOff)
pure def replySource(unreported: bool, ungrounded: bool, cutOff: bool, answered: bool, grounded: bool): ReplySource =
  if (not(unreported) and not(ungrounded)) ModelReply
  else if (asksAgain(unreported, ungrounded, cutOff) and answered and grounded) RevisedReply
  else FixedWords
pure def putToTheModel(held: bool, safetyCopy: bool): bool = not(held) and not(safetyCopy)
pure def reachesTheOwner(ownCopy: bool, safetyCopy: bool): bool = ownCopy or safetyCopy
pure def answeredAgain(draft: Draft, sameAsFirst: bool): bool = gaveAnAnswer(draft) and not(sameAsFirst)
pure def lawAGroundedReplyMakesNoFurtherCall(cutOff: bool): bool = not(asksAgain(false, false, cutOff))
pure def lawAGroundedReplyIsTheModels(cutOff: bool, answered: bool, grounded: bool): bool = replySource(false, false, cutOff, answered, grounded) == ModelReply
pure def lawASecondAnswerThatHoldsIsKept(unreported: bool, ungrounded: bool): bool =
  (unreported or ungrounded) implies replySource(unreported, ungrounded, false, true, true) == RevisedReply
pure def lawFixedWordsAreTheLastResort(unreported: bool, ungrounded: bool, cutOff: bool, answered: bool, grounded: bool): bool =
  replySource(unreported, ungrounded, cutOff, answered, grounded) == FixedWords implies ((unreported or ungrounded) and (cutOff or not(answered) or not(grounded)))
pure def lawACutOffTurnIsNeverAskedAgain(unreported: bool, ungrounded: bool): bool = not(asksAgain(unreported, ungrounded, true))
pure def lawSafetyCopyIsNeverRewritten(held: bool): bool = not(putToTheModel(held, true))
pure def lawOnlySafetyCopyFollowsAReplyWithoutTheActionsOwnWords(safetyCopy: bool): bool = reachesTheOwner(false, safetyCopy) == safetyCopy
pure def lawAnActionsOwnWordsForTheOwnerMayFollowAReply(safetyCopy: bool): bool = reachesTheOwner(true, safetyCopy)
pure def lawWordsTheReplyHoldsAreNotAskedFor(safetyCopy: bool): bool = not(putToTheModel(true, safetyCopy))
pure def lawACueIsNoSecondAnswer(sameAsFirst: bool): bool = not(answeredAgain(Cue, sameAsFirst)) and not(answeredAgain(Silent, sameAsFirst))
pure def lawTheFirstReplyAgainIsNoSecondAnswer(draft: Draft): bool = not(answeredAgain(draft, true))
pure def lawANewAnswerIsASecondAnswer(sameAsFirst: bool): bool = answeredAgain(Answer, sameAsFirst) == not(sameAsFirst)
```

### A failure with no receipt that a later run of its action may have answered is the model's to report, and its own words follow the reply unless the model stands by a reply without them

A call that failed or was refused without an effect receipt names nothing
the host can match, so a later call of the same action that ran (it applied,
proposed or had no effect) may have put it right: the model corrects its
own call after a refusal, such as `8 + 9` after a stray argument or 4 PM
after a misread 8 AM. It may also have been for another request, such as a
second recipient. A later call can answer a failure only when the model saw
that failure first, in an earlier planner response. Such a failure stays
open (above), and only the model can tell whether the later call did what
the failed one was for. When the reply leaves it out, its host note says a
later call of that action ran, that when that later call did what the failed
step was for the model gives its reply exactly as it was, word for word, and
that otherwise the reply must say the failed step did not happen. When the model
answers that note with its first reply again, word for word, it stands by
that reply, and when that reply is delivered, the failure's own words do not
follow it. Otherwise the failure is reported as any failure is (above): a
kept second answer reports it in the model's words, followed only by words
its action wrote for the owner, and its own words follow the reply when the
call fails, when the model answers with a blank or a pending-work cue (read
as below), when it gives another answer that is not kept, when the failure
was never put to the model, or when the clock's or the change's words take
the reply's place. A failure
with a receipt, a failure in the same planner response as the later call,
and safety copy are reported as above.

```quint
pure def answerableLater(receiptless: bool, seenFirst: bool, ranLater: bool): bool = receiptless and seenFirst and ranLater
pure def gaveAnAnswer(draft: Draft): bool = draft == Answer
pure def standsBy(draft: Draft, sameAsFirst: bool): bool = gaveAnAnswer(draft) and sameAsFirst
pure def followsTheReply(answerable: bool, asked: bool, stoodBy: bool, modelsReply: bool, safetyCopy: bool): bool =
  safetyCopy or not(answerable and asked and stoodBy and modelsReply)
pure def lawACueOrSilenceGivesNoAnswer(sameAsFirst: bool): bool =
  not(gaveAnAnswer(Cue)) and not(gaveAnAnswer(Silent)) and not(standsBy(Cue, sameAsFirst)) and not(standsBy(Silent, sameAsFirst))
pure def lawAnotherAnswerIsNoStandingBy(draft: Draft): bool = not(standsBy(draft, false))
pure def lawAFailureALaterRunMayHaveAnsweredDoesNotFollowAReplyTheModelStandsBy(safetyCopy: bool): bool =
  followsTheReply(true, true, true, true, safetyCopy) == safetyCopy
pure def lawUnlessTheModelStandsByItsReplyTheFailureStillFollows(answerable: bool, asked: bool, modelsReply: bool, safetyCopy: bool): bool =
  followsTheReply(answerable, asked, false, modelsReply, safetyCopy)
pure def lawAFailureNeverPutToTheModelStillFollows(answerable: bool, stoodBy: bool, modelsReply: bool): bool =
  followsTheReply(answerable, false, stoodBy, modelsReply, false)
pure def lawUnderTheHostsWordsTheFailureStillFollows(answerable: bool, asked: bool, stoodBy: bool): bool =
  followsTheReply(answerable, asked, stoodBy, false, false)
pure def lawAFailureWithAReceiptStillFollows(seenFirst: bool, ranLater: bool, asked: bool, stoodBy: bool, modelsReply: bool): bool =
  followsTheReply(answerableLater(false, seenFirst, ranLater), asked, stoodBy, modelsReply, false)
pure def lawAFailureInTheSameResponseStillFollows(receiptless: bool, ranLater: bool, asked: bool, stoodBy: bool, modelsReply: bool): bool =
  followsTheReply(answerableLater(receiptless, false, ranLater), asked, stoodBy, modelsReply, false)
```

### A coaching response stays in the planner transcript

A tool can ask the planner to correct its call. An unsuccessful result
marked as internal coaching and carrying no effect receipt goes back to
the planner and does not appear among the owner's action outcomes.
The call still uses a planning step. A result that records an effect
remains an action outcome.

```quint
pure def plannerOnlyCoaching(internal: bool, coaching: bool, success: bool, hasReceipt: bool): bool =
  internal and coaching and not(success) and not(hasReceipt)
pure def lawCoachingNeverHidesReceipts(internal: bool, coaching: bool, success: bool): bool =
  not(plannerOnlyCoaching(internal, coaching, success, true))
pure def lawOrdinaryRefusalsRemainOutcomes(internal: bool): bool =
  not(plannerOnlyCoaching(internal, false, false, false))
```

### A pending-work cue is spoken only before work runs and is never the reply, and an answer is delivered whole

The system prompt's cue rule asks the model to write, with its first tool
calls, only a brief cue that it heard the request: `Let me check.` or
`Let me check your calendar.` (or the owner's notes, inbox, messages,
reminders, tasks, files, photos or contacts) for a question or a lookup, a
request asked as a question (`Can you text Sam?`) included, naming a source
only for one simple lookup, so a message asking for several lookups or about
several named people or items gets the plain `Let me check.`; `Let me open
Maps.` when opening an app is part of other planned work, naming the app
asked for by its bare name (Calendar, Notes, Inbox, Maps, Files, Photos,
Settings, Workflows, Camera, Browser, Contacts, Messages, Phone or Clock)
and `On it.` for any other app; `Sure.`, `Sure, one sec.` or `Yeah, one
sec.` for a plain command (`Text Sam I'm late`, `Set an alarm for seven`);
`On it.` or `One sec.` for any other action. A request only to open one
app, with nothing to read, find or change there (`Open Maps.`), still calls
the tool that opens it, with no cue: the model writes nothing with that
call, and the reply after it confirms the destination (`Maps is open.`).
Any question or lookup gets its cue, even one about what is on the screen. The cue never names the people, items, times or outcome, never
says the work is done or under way, never repeats the request, and is left
empty, with the work still done, when the person asked for silence; later
tool calls come with no text. A cue comes only with a tool call: when no
offered tool can do what was asked, the model writes no cue and says
plainly, in its own words, that it can't.

The shell reads the model's text as a `Cue` only when the whole of it is
one to three sentences of the closed acknowledgment grammar (`On it`,
`One sec`, `Just a moment`, a lead such as `Let me` with a look-up verb and
an owner container such as `your calendar`, or a lead with an intent such
as `open Maps`, so `Let me open Maps.` is a cue), at most 120 characters, with no digits, clock times,
counts, names other than one after `check with`, or question mark. The
grammar has no past-tense verb, negation or completion word, so a cue never
claims that an effect happened or that the owner's tracked work is empty:
a destination confirmation (`Maps is open.`, `Opened your calendar.`) is
never a cue. The shell reads the text without its JSON objects (those
outside any other object) and without a code fence or tag they leave empty,
since an object beside a cue is a tool call written as text, which runs
nothing. So a cue beside any object (`Sure, one sec. {"type":
"send_message"}`) is still a cue, delivered without it, and so is a cue
beside a bracketed snake_case name with `key=value` arguments
(`[send_message contact="Sam"]`). Only such a bracketed call and a call
envelope are written calls on their own. A call envelope is an object core
reads as an action envelope; an object whose `action`, `tool`, `type` or
`name` field names an action registered in the runtime, offered this turn
or not, ignoring case and underscores (`{"type": "Calculate"}`), other than
`REPLY`, `IGNORE` and `NONE`; an object whose `action` or `tool` field is a
snake_case call name (`{"action": "open_app", "app": "Maps"}`, while
`{"type": "line_chart"}` is not);
or an object with one of those four fields beside an `arguments`, `args`,
`parameters`, `params` or `input` field holding an object or text (`{"name": "calculate",
"arguments": {…}}`). Bare assent beside a written call promises work as
`Sure, one sec.` does (below), and text that is only written calls is a
blank. Bare assent beside any other object (`Sure! {"name": "Bob"}`), and
text that is only other objects (`{"status": "in_progress"}`, `{"theme":
"dark_mode"}`), are an `Answer`. An answer is delivered without its call
envelopes and bracketed calls, and the rest of it is kept, so a typed
`{"tool": "search", …}` before a real answer never reaches the person.
A wait cue followed by more text that is not progress (`One second is
1,000 milliseconds.`, `Just a second, your dentist is Thursday.`) is an
`Answer`. A cue that comes with the turn's first tool calls is the turn's
acknowledgment (below); whatever text streamed with tool calls is
restarted to empty before they run, so a cue is never part of the reply's
text. A cue or a blank with no
tool call is not an answer, and neither is assent that goes on to a cue
(`Sure, one sec.`, below): it promised work that no call does. The model is
asked once more, with the turn's tools still offered unless that call is
the last step, and one host note
saying that its response gave the person no answer and was not sent. Before
the turn recorded a step, the note also says the response called no tool,
and that the model answers now, in its own words, a question it can answer
from what it already knows, and otherwise does the work now with an offered
tool or, if no offered tool can do it, tells the person plainly, in its own
words, that it can't; when no tool can be called on the next step, it says
that nothing can be done, opened, sent or looked up in the turn, that the
model answers such a question now in its own words, and that otherwise it
tells the person plainly that it can't and writes no tool call as text. After a step was recorded, it says
the tool results are what the turn did and that the model answers from
them, in its own words. A turn asks this at most once before it records a
step and at most once after, so a turn that recovered from a promise by
running a tool can still be asked to report what that tool did. When the response
after a note is again a cue or a blank with no tool call, or steps run out,
whatever text streamed with it is restarted to empty and the turn's failure
fallback is the reply, so a cue alone is never the turn's last word.

```quint
type Draft = Cue | Answer | Silent
type PlanMove = RunTools | Deliver | AskAgain | GiveUp
pure def acknowledges(draft: Draft, calls: int, earlierCalls: int): bool = draft == Cue and calls > 0 and earlierCalls == 0
pure def nextMove(draft: Draft, calls: int, stepsLeft: int, askedAgain: bool): PlanMove =
  if (calls > 0) RunTools
  else if (draft == Answer) Deliver
  else if (stepsLeft > 0 and not(askedAgain)) AskAgain
  else GiveUp
pure val stepsLeftValues = Set(0, 1, 3)
pure def lawAnAnswerIsDeliveredWhole(stepsLeft: int, askedAgain: bool): bool = nextMove(Answer, 0, stepsLeft, askedAgain) == Deliver
pure def lawACueIsNeverTheReply(calls: int, stepsLeft: int, askedAgain: bool): bool = nextMove(Cue, calls, stepsLeft, askedAgain) != Deliver
pure def askedAgainAt(worked: bool, askedBeforeWork: bool, askedAfterWork: bool): bool = if (worked) askedAfterWork else askedBeforeWork
pure def lawWorkGetsItsOwnReAsk(askedBeforeWork: bool): bool = not(askedAgainAt(true, askedBeforeWork, false))
pure def lawEachReAskIsSpentOnce(worked: bool): bool = askedAgainAt(worked, not(worked), worked)
pure def lawAPromiseWithoutWorkIsAskedAgainOnce(draft: Draft, stepsLeft: int): bool =
  (draft != Answer and stepsLeft > 0) implies (nextMove(draft, 0, stepsLeft, false) == AskAgain and nextMove(draft, 0, stepsLeft, true) == GiveUp)
pure val earlierCallsValues = Set(0, 1, 2)
pure def lawACueIsSpokenOnlyBeforeWork(draft: Draft, calls: int, earlierCalls: int): bool =
  acknowledges(draft, calls, earlierCalls) implies (calls > 0 and draft == Cue and earlierCalls == 0)
```

### A turn acknowledges at most once, with a cue that comes with its first tool calls, and bare assent is a cue only with work after an instruction

`Sure` or `Yeah` alone says yes, so it is a cue only when it
comes with tool calls and the owner's message is an instruction: after
fillers (`hey`, `ok`, `so`, `please`, …), a name and comma, or a greeting
and a wake name, it opens with a command verb (`text`, `set`, `call`, `remind`, …), it has no
question mark, and no sentence or comma clause opens with a question word
or an auxiliary (`am`, `is`, `can`, `what`, …). `Can you text Sam`, `Am I
free Friday` and `Any meetings today` are not instructions, so a bare
`Sure.` after them is an answer. With no tool call, assent is the answer
after any message: `Sure.` to `Call me Bob` or `Remember that I like tea`
is delivered, never asked again. Assent followed by a comma, dash, colon,
semicolon or sentence break and one or two sentences of the grammar
(`Sure, one sec.`, `Yeah. Let me check your calendar.`) also promises work:
with tool calls it is a cue only after an instruction, as bare assent is,
and with no tool call it is a cue after any message, so it is asked again
(above) and never delivered. `Sure!` before a lead form (`Sure! Let me
check your calendar.`) is a cue after any message. The acknowledgment is
delivered at most once per turn, as the [reply stream](./replyStream.md)'s
`acknowledgment` frame. A model cue is delivered only before work starts
and is suppressed when the owner asks for silence. A cue at a later step is
dropped with the rest of that step's text. A blank draft or one outside the
cue grammar is never spoken as acknowledgment. A navigation-only turn whose
model confirms the destination alongside its tool call still gives the owner
only the reply.

```quint
type DraftShape = Blank | GrammarCue | Assent | AssentCue | OtherText
pure def readDraft(shape: DraftShape, instruction: bool, calls: int): Draft = match shape {
  | Blank => Silent | GrammarCue => Cue | Assent => if (instruction and calls > 0) Cue else Answer
  | AssentCue => if (instruction or calls == 0) Cue else Answer | OtherText => Answer
}
pure def lawBareAssentIsACueOnlyWithWorkAfterAnInstruction(instruction: bool, calls: int): bool =
  (readDraft(Assent, instruction, calls) == Cue) iff (instruction and calls > 0)
pure def lawBareAssentWithoutWorkIsDelivered(instruction: bool, stepsLeft: int, askedAgain: bool): bool =
  nextMove(readDraft(Assent, instruction, 0), 0, stepsLeft, askedAgain) == Deliver
pure def lawAssentBeforeACueIsACueWithWorkOnlyAfterAnInstruction(instruction: bool, calls: int): bool =
  calls > 0 implies ((readDraft(AssentCue, instruction, calls) == Cue) iff instruction)
pure def lawAssentBeforeACueWithoutWorkIsNeverDelivered(instruction: bool, stepsLeft: int, askedAgain: bool): bool =
  nextMove(readDraft(AssentCue, instruction, 0), 0, stepsLeft, askedAgain) != Deliver
pure def lawTheGrammarIsACueAfterAnyMessage(instruction: bool, calls: int): bool = readDraft(GrammarCue, instruction, calls) == Cue
pure def lawNoCueOrADestinationConfirmationNeverAcknowledges(instruction: bool, calls: int, earlierCalls: int): bool =
  not(acknowledges(readDraft(Blank, instruction, calls), calls, earlierCalls)) and not(acknowledges(readDraft(OtherText, instruction, calls), calls, earlierCalls))
pure def lawATurnAcknowledgesAtMostOnce(draft: Draft, calls: int, earlierCalls: int, laterDraft: Draft, laterCalls: int): bool =
  acknowledges(draft, calls, earlierCalls) implies not(acknowledges(laterDraft, laterCalls, earlierCalls + calls))
```

### A delivered cue is told to the model as already said, so the reply never repeats it or takes it as evidence

A cue is delivered only when the turn's [reply stream](./replyStream.md)
took it as the turn's acknowledgment: a quiet turn, a send with no stream,
a draft that is not the turn's acknowledgment and a cue the stream refused
or did not report taking deliver nothing. The planner's transcript keeps the
text a step wrote beside its tool calls only when that text is the delivered
cue, so the model never takes text the owner did not receive as said. After the tool calls that came
with a delivered cue have all run and planning goes on, the model is told once, quoting the cue, that
it was already sent to the owner as progress: the reply does not repeat or
paraphrase it, goes straight to the result, any blocker or the question the
turn needs answered, and the cue is not evidence that any work succeeded. A
turn that delivered no cue is told nothing about one.

```quint
pure def cueDelivered(draft: Draft, calls: int, earlierCalls: int, quiet: bool, streamTook: bool): bool =
  acknowledges(draft, calls, earlierCalls) and not(quiet) and streamTook
pure def lawOnlyACueTheStreamTookIsDelivered(draft: Draft, calls: int, earlierCalls: int, quiet: bool): bool =
  not(cueDelivered(draft, calls, earlierCalls, quiet, false))
pure def lawAQuietTurnDeliversNoCue(draft: Draft, calls: int, earlierCalls: int, streamTook: bool): bool =
  not(cueDelivered(draft, calls, earlierCalls, true, streamTook))
pure def lawOnlyTheTurnsAcknowledgmentIsDelivered(draft: Draft, calls: int, earlierCalls: int, quiet: bool, streamTook: bool): bool =
  cueDelivered(draft, calls, earlierCalls, quiet, streamTook) implies acknowledges(draft, calls, earlierCalls)
```

### A tool's progress names its app only when one labelled app applies, and never its arguments or results

When a tool call starts, its progress carries the action's name and a
label for the owner: `Using <label>` when, among the contexts the call
shows other than the catch-all `general` and `simple` and any `system`
context, exactly one applies and the runtime's context registry gives it a
label, and `Working` otherwise. A call shows the app its action names for
its progress, and otherwise the action's declared contexts (core's catalog
when it declares none). The device tool names its app for each call from
its arguments: the app its operation's proposal family declares, and no app
when that family declares none, so a device call is named only by its
family's app and the arguments never appear in the label. Contexts with the
same label count once; an unlabelled context counts by its id, so an action
that may also reach an unnamed app is `Working`. The registry starts empty:
an app is named only once it registers its own labelled context when it
loads and its actions, or its proposal family, name that context. Maps
registers `Maps`, Calendar `Calendar`, Browser `Browser`, Files `Files`,
Inbox `Inbox`, Workflows `Workflows`, Notes `Notes`, and the assistant
`Reminders` for its reminders. An action that names no app and declares no
context, or only contexts nobody labelled, is `Working`: the assistant's
goals, to-dos, routines and briefings, the phone's call, message and
surface operations, the reminders family's operations, which reach both
Reminders and Clock, and a helper such as `CALCULATE`.

An action shared by several apps, such as `VIEWS`, shows every app it may
reach, so its progress is `Working`; the owner's words never pick one of
them. Only the call's own arguments can narrow what it shows, as the device
tool's do, and only to an app its action declares a way to name.

The app a call shows is its label and nothing else. Naming it never
changes the action's declared contexts, its role gate or the contexts the
call runs under, so it never widens or narrows which calls run, and it is
never part of the tools, the system prompt or the history.

```quint
type ToolActivity = UsingApp | Working
pure def toolActivity(applicable: int, labelled: int): ToolActivity =
  if (applicable == 1 and labelled == 1) UsingApp else Working
pure val applicableValues = Set(0, 1, 2, 3)
pure val labelledValues = Set(0, 1, 2)
pure def lawAnAppIsNamedOnlyWhenItIsTheOnlyOneThatApplies(applicable: int, labelled: int): bool =
  toolActivity(applicable, labelled) == UsingApp iff (applicable == 1 and labelled == 1)
pure def lawSeveralAppsNameNone(applicable: int, labelled: int): bool =
  applicable > 1 implies toolActivity(applicable, labelled) == Working
type DeviceFamilyApp = FamilyApp({ app: str }) | NoFamilyApp
pure def deviceCallReach(deviceFamily: DeviceFamilyApp): Set[str] = match deviceFamily { | FamilyApp(f) => Set(f.app) | NoFamilyApp => Set() }
pure val deviceFamilyValues = Set(FamilyApp({ app: "calendar" }), FamilyApp({ app: "notes" }), NoFamilyApp)
pure def lawADeviceCallReachesAtMostItsFamilysApp(deviceFamily: DeviceFamilyApp): bool = match deviceFamily {
  | FamilyApp(f) => deviceCallReach(deviceFamily).size() == 1 and deviceCallReach(deviceFamily).contains(f.app) | NoFamilyApp => deviceCallReach(deviceFamily).size() == 0 }
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
interaction block (`[CHOICE]`, `[FORM]`) is the action's own copy. It and
the emergency keypad's safety copy are delivered without model prose.

```quint
type Composition = NoText | ToolOnly | ProseOnly | ToolThenProse | FencedToolThenProse
type ToolTextShape = { present: bool, card: bool, multiline: bool, fenced: bool, ownCopy: bool, alone: bool }
pure def compose(tool: ToolTextShape, prose: bool, proseHoldsTool: bool, toolHoldsProse: bool): Composition =
  if (not(tool.present)) (if (prose) ProseOnly else NoText)
  else if (not(prose) or tool.ownCopy or tool.alone or toolHoldsProse) ToolOnly
  else if (proseHoldsTool) ProseOnly
  else if (tool.multiline and not(tool.card) and not(tool.fenced)) FencedToolThenProse
  else ToolThenProse
pure val toolValues = Set(
  { present: true, card: true, multiline: true, fenced: false, ownCopy: false, alone: false },
  { present: true, card: false, multiline: true, fenced: false, ownCopy: false, alone: false },
  { present: true, card: false, multiline: false, fenced: false, ownCopy: true, alone: false },
  { present: true, card: false, multiline: true, fenced: false, ownCopy: true, alone: false },
  { present: true, card: false, multiline: false, fenced: false, ownCopy: true, alone: true },
  { present: false, card: false, multiline: false, fenced: false, ownCopy: false, alone: false })
pure def lawACardIsNeverFenced(tool: ToolTextShape, prose: bool, proseHoldsTool: bool, toolHoldsProse: bool): bool =
  tool.card implies compose(tool, prose, proseHoldsTool, toolHoldsProse) != FencedToolThenProse
pure def lawOwnCopyIsNeverFenced(tool: ToolTextShape, prose: bool, proseHoldsTool: bool, toolHoldsProse: bool): bool =
  tool.ownCopy implies compose(tool, prose, proseHoldsTool, toolHoldsProse) != FencedToolThenProse
pure def lawGroundedProseIsKept(tool: ToolTextShape, proseHoldsTool: bool): bool =
  (tool.present and not(tool.ownCopy) and not(tool.alone)) implies compose(tool, true, proseHoldsTool, false) != ToolOnly
pure def lawProposalAndSafetyCopyStandAlone(tool: ToolTextShape, prose: bool, proseHoldsTool: bool, toolHoldsProse: bool): bool =
  (tool.present and (tool.ownCopy or tool.alone)) implies compose(tool, prose, proseHoldsTool, toolHoldsProse) == ToolOnly
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
instant: <YYYY-MM-DDTHH:MM>Z.` Any other clock reads `Agent time` for the
launch zone or `Server time` for the host's, then the full date and time,
the zone and the UTC instant, and says the user's timezone is unknown.
Every clock line ends with the days in its zone: `Today in <zone> is
<weekday> <YYYY-MM-DD>. Next 7 days: <weekday> <YYYY-MM-DD>, …`, the seven
dates after today, each with its weekday, so a weekday the person names in
the coming week is a date the model reads rather than one it counts out. The
zone is named because a clock other than the owner's local one may not be
the person's day. The days are context for the model; the shell does not
read the person's words for a day.

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

### What the person said earlier reaches the model with the minute it was said, on the turn's clock

Each message of the person in the history the model reads starts with
`[message_at=MM-DD HH:MM] `, the date and minute the message was stored,
in the zone of the turn's clock (above), so the model can answer "what
did I ask this morning" and order what was said against the clock line.
The stamp is [core's](../../core/context.md): the year leads only when it
is not the year of the turn's clock, and an offset follows only in the
hour a zone's clocks repeat. The agent's own earlier messages carry no
stamp. They are sent as the assistant's own words, and a stamp there
would be read as something it said and written into its next reply; each
reply follows the stamped request it answered. The latest message carries
none either: the clock line states its time. A message stored without a
time is sent as it is. A stamp depends only on the message's stored time
and the clock's zone and year, so the history stays the same bytes from
turn to turn while those hold.

```quint
pure def stampedForTheModel(fromPerson: bool, storedAt: int): bool = fromPerson and storedAt > 0
pure val storedAtValues = Set(-1, 0, 1763932800000)
pure def lawTheAgentsOwnWordsAreNeverStamped(storedAt: int): bool = not(stampedForTheModel(false, storedAt))
pure def lawAMessageStoredWithoutATimeIsSentAsItIs(fromPerson: bool, storedAt: int): bool = storedAt <= 0 implies not(stampedForTheModel(fromPerson, storedAt))
pure def lawWhatThePersonSaidAtAKnownTimeIsStamped(storedAt: int): bool = storedAt > 0 implies stampedForTheModel(true, storedAt)
```

### A standalone answer to a current-time question that names a date, weekday or clock the clock did not observe is asked for again, and the clock's own reading is the last resort

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
way around midnight. The model is then asked once more with the clock's
full reading as a host note (above), and its answer is kept when this check
holds of it. Otherwise, or when that call fails, the reply is `It's <full
date and time to the second, with its zone>.`. Any other reply is kept as
it is, with no further model call.

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

### A reply that gives a just-changed calendar event a time range other than the one it got is asked for again, and the change's own words are the last resort

When a turn's actions applied exactly one timed calendar event, through a
successful result that carries the event (its id, start, end, zone and
version, and a title naming no clock time) and its own applied create or
update receipt for that event at that version, a reply that states one
clock range, a start and an end such as "3–4 PM", is read on the event's
own clock. When its start or end is not the event's, the model is asked
once more with that action's own words as a host note (above), and its
answer is kept when this check holds of it. Otherwise, or when that call
fails, the reply is that action's own words. A reply
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
