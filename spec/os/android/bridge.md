# Android bridge vocabulary

What every native bridge of an Android host shares: when a renderer call is
admitted, how the app's main Activity keeps its WebView, and how a device
change is reported. Each bridge spec in this directory imports it
(`import bridge.* from "./bridge"`, or `"../bridge"`) and adds its own
operations; host generation is [the host profile](../build/androidHost.md).
The sources are `ElizaBridgeActivity.java` of the browser surface plugin and
the provider writes of the calendar and contacts plugins.

## Story: Admit a bridge call only with current evidence

> As an owner, I want a native bridge to act only when my app built it in,
> registered it, and Android says the device, the screen and my grants allow
> the operation, so that nothing runs on evidence the page made up.

### A call is admitted only when the plugin is registered and every fact the operation needs holds

Three pieces of evidence are separate. Build inclusion comes from the host
profile; registration comes from the Activity, which registers its plugins
before the base `onCreate` (a plugin registered later is not part of the
bridge); the device facts come from Android at the time of the call. A
renderer string or an unchecked WebView route attests none of them. A
device feature (telephony, for example) is checked on every call that needs
it, not once per install.

```quint
import receipts as R from "../../core/receipts"
type PluginPresence = PluginNotBuilt | PluginNotRegistered | PluginRegistered
type HostNeed = Anytime | InForeground | WhileUnlocked | WithFocus
type BridgeCall = { need: HostNeed, needsGrant: bool, needsFeature: bool }
type HostFacts = { foreground: bool, unlocked: bool, focused: bool, granted: bool, featurePresent: bool }
type Admission = CallAdmitted | BridgeUnavailable | DeviceUnsupported | HostNotReady | PermissionRequired
pure def meetsNeed(need: HostNeed, facts: HostFacts): bool =
  if (need == Anytime) true
  else if (need == InForeground) facts.foreground
  else if (need == WhileUnlocked) facts.foreground and facts.unlocked
  else facts.foreground and facts.unlocked and facts.focused
pure def admitCall(presence: PluginPresence, call: BridgeCall, facts: HostFacts): Admission =
  if (presence != PluginRegistered) BridgeUnavailable
  else if (call.needsFeature and not(facts.featurePresent)) DeviceUnsupported
  else if (not(meetsNeed(call.need, facts))) HostNotReady
  else if (call.needsGrant and not(facts.granted)) PermissionRequired
  else CallAdmitted
pure val callValues = Set(
  { need: Anytime, needsGrant: true, needsFeature: false },
  { need: InForeground, needsGrant: false, needsFeature: true },
  { need: WhileUnlocked, needsGrant: true, needsFeature: false },
  { need: WithFocus, needsGrant: true, needsFeature: true }
)
pure val factsValues = Set(
  { foreground: true, unlocked: true, focused: true, granted: true, featurePresent: true },
  { foreground: true, unlocked: true, focused: true, granted: false, featurePresent: true },
  { foreground: true, unlocked: false, focused: true, granted: true, featurePresent: true },
  { foreground: true, unlocked: true, focused: false, granted: true, featurePresent: false },
  { foreground: false, unlocked: true, focused: false, granted: true, featurePresent: true }
)
pure def lawAdmissionNeedsEveryPieceOfEvidence(presence: PluginPresence, call: BridgeCall, facts: HostFacts): bool =
  admitCall(presence, call, facts) == CallAdmitted implies
    (presence == PluginRegistered and meetsNeed(call.need, facts) and (call.needsGrant implies facts.granted) and (call.needsFeature implies facts.featurePresent))
pure def lawHostNeedsAreALadder(facts: HostFacts): bool =
  (meetsNeed(WithFocus, facts) implies meetsNeed(WhileUnlocked, facts)) and (meetsNeed(WhileUnlocked, facts) implies meetsNeed(InForeground, facts))
```

### Android's permission prompt is asked only for a call that is otherwise admitted

`PermissionRequired` is the one refusal the shell answers by asking Android
for the grant; a call that is unavailable, unsupported or made from the
background or a locked screen never raises a permission prompt.

```quint
pure def lawPermissionIsAskedLast(presence: PluginPresence, call: BridgeCall, facts: HostFacts): bool =
  admitCall(presence, call, facts) == PermissionRequired implies
    (presence == PluginRegistered and meetsNeed(call.need, facts) and (call.needsFeature implies facts.featurePresent) and call.needsGrant and not(facts.granted))
```

## Story: Keep my app's page alive and honest through its Activity's life

> As an owner, I want my app's screen to survive Android ending its page
> renderer, and a turned-off screen never to leave the page running as
> visible.

The app's main Activity extends `ElizaBridgeActivity`. When Android ends the
renderer, the Activity removes and destroys the dead WebView instead of
letting the whole process (and the agent service in it) die, calls its
`onRendererGone` hook, and recreates itself when it is next started, at once
if it is on screen. Pausing happens on stop, not on pause, so a permission
dialog over the visible app does not hide the page.

### A new page never loads mixed content, and a dead page is never used again

A subclass checks `isRendererGone()` before it reaches the WebView through
`getBridge().getWebView()`.

```quint
type ActivityHook = HookCreate | HookStart | HookStop | HookRendererGone
type HostCommand = BlockMixedContent | ResumePage | PausePage | DestroyDeadView | RecreateActivity
type HostActivity = { started: bool, rendererGone: bool }
type HostStep = { activity: HostActivity, commands: List[HostCommand] }
pure val freshActivity: HostActivity = { started: false, rendererGone: false }
pure def onActivity(activity: HostActivity, hook: ActivityHook): HostStep =
  if (hook == HookCreate) { activity: freshActivity, commands: List(BlockMixedContent) }
  else if (hook == HookRendererGone) { activity: { ...activity, rendererGone: true }, commands: if (activity.rendererGone) List() else if (activity.started) List(DestroyDeadView, RecreateActivity) else List(DestroyDeadView) }
  else if (hook == HookStart) { activity: { ...activity, started: true }, commands: if (activity.rendererGone) List(RecreateActivity) else List(ResumePage) }
  else { activity: { ...activity, started: false }, commands: if (activity.rendererGone) List() else List(PausePage) }
pure def touchesPage(command: HostCommand): bool = command == BlockMixedContent or command == ResumePage or command == PausePage
pure val activityValues = Set(
  { started: false, rendererGone: false }, { started: true, rendererGone: false },
  { started: false, rendererGone: true }, { started: true, rendererGone: true }
)
pure def lawNewPageNeverLoadsMixedContent(activity: HostActivity): bool =
  onActivity(activity, HookCreate).commands.includes(BlockMixedContent) and not(onActivity(activity, HookCreate).activity.rendererGone)
pure def lawDeadPageIsNeverUsed(activity: HostActivity, hook: ActivityHook): bool =
  activity.rendererGone and hook != HookCreate implies not(onActivity(activity, hook).commands.some(c => touchesPage(c)))
```

### Renderer death destroys the dead page and recreates the Activity on its next start

```quint
pure def lawRendererDeathRecreatesTheActivity(activity: HostActivity): bool = {
  val gone = onActivity(activity, HookRendererGone)
  (not(activity.rendererGone) implies (gone.commands.includes(DestroyDeadView) and gone.commands.includes(RecreateActivity) == activity.started)) and
  onActivity(gone.activity, HookStart).commands.includes(RecreateActivity)
}
```

### A stopped page is paused and a started page resumes

```quint
pure def lawStoppedPageIsPaused(activity: HostActivity): bool =
  not(activity.rendererGone) implies (onActivity(activity, HookStop).commands.includes(PausePage) and onActivity(activity, HookStart).commands.includes(ResumePage))
```

## Story: Report a device change only as Android confirmed it

> As an owner, I want a calendar, contact or other provider change reported
> as done only when the provider committed it and read it back, and a hand-off
> to Android's own screen never reported as the change itself, so that I am
> never told something happened when it did not.

A guarded provider write asserts the reviewed revision, mutates and reads
back in one provider batch. The shell turns the provider's answer into a
`ProviderReply`; a failure after dispatch with no answer is `NoReply`. A
handoff opens one of Android's own screens or apps; what the owner then does
there is not the bridge's to report.

### A write is Applied only when the provider committed it and the readback confirmed it

A committed batch whose readback failed may still be what the owner asked
for, but the caller holds no current revision to assert, so it is
`Uncertain` until it reads the row.

```quint
type ProviderReply = RevisionMismatch | NothingWritten | CommittedAndReadBack | CommittedNotReadBack | NoReply
type WriteOutcome = Applied | Conflict | NotWritten | Uncertain
type HandoffOutcome = Opened | Refused
pure def writeOutcome(reply: ProviderReply): WriteOutcome =
  if (reply == CommittedAndReadBack) Applied
  else if (reply == RevisionMismatch) Conflict
  else if (reply == NothingWritten) NotWritten
  else Uncertain
pure def lawOnlyAConfirmedCommitIsApplied(reply: ProviderReply): bool =
  (writeOutcome(reply) == Applied iff reply == CommittedAndReadBack) and
  (writeOutcome(reply) == Uncertain iff (reply == NoReply or reply == CommittedNotReadBack))
```

### Only an Applied write yields a committed receipt; a handoff never does

Outcomes reach the agent as `R::Receipt`s. `Conflict`, `NotWritten` and
`Refused` are `Failed`; `Uncertain` stays `Pending`; `Opened` is a
`Preview`: Android showed its screen, nothing more.

```quint
pure def receiptOfWrite(outcome: WriteOutcome): R::Receipt =
  { receiptKind: if (outcome == Applied) R::Applied else if (outcome == Uncertain) R::Pending else R::Failed, durable: false, providerAccepted: outcome == Applied, hasKey: false, replayed: false, reverted: false }
pure def receiptOfHandoff(handoff: HandoffOutcome): R::Receipt =
  { receiptKind: if (handoff == Opened) R::Preview else R::Failed, durable: false, providerAccepted: false, hasKey: false, replayed: false, reverted: false }
pure def lawOnlyAppliedWriteCommits(outcome: WriteOutcome): bool =
  R::committedReceipt(receiptOfWrite(outcome)) iff outcome == Applied
pure def lawHandoffNeverCommits(handoff: HandoffOutcome): bool = not(R::committedReceipt(receiptOfHandoff(handoff)))
pure def lawRefusalsAreFailures(outcome: WriteOutcome, handoff: HandoffOutcome): bool =
  ((receiptOfWrite(outcome).receiptKind == R::Failed) iff (outcome == Conflict or outcome == NotWritten)) and
  ((receiptOfHandoff(handoff).receiptKind == R::Failed) iff handoff == Refused)
```

### An Uncertain write blocks another write until an explicit read that began after it settled

A bridge keeps one write gate per provider target. Only one write is in
flight; an `Uncertain` outcome keeps the gate shut across visits and owner
changes, and nothing retries the write on its own. An automatic refresh, or a
read already running when the write settled, cannot open it.

```quint
type WriteGate = WriteIdle | WriteInFlight | WriteUnsettled
type ReadKind = AutomaticRead | ExplicitRead
type ReadEvidence = { kind: ReadKind, startedAfterSettle: bool, succeeded: bool }
pure def gateAllowsWrite(gate: WriteGate): bool = gate == WriteIdle
pure def gateOnDispatch(gate: WriteGate): WriteGate = if (gate == WriteIdle) WriteInFlight else gate
pure def gateOnOutcome(gate: WriteGate, outcome: WriteOutcome): WriteGate =
  if (gate != WriteInFlight) gate else if (outcome == Uncertain) WriteUnsettled else WriteIdle
pure def readSettlesUncertainty(read: ReadEvidence): bool = read.kind == ExplicitRead and read.startedAfterSettle and read.succeeded
pure def gateOnRead(gate: WriteGate, read: ReadEvidence): WriteGate =
  if (gate == WriteUnsettled and readSettlesUncertainty(read)) WriteIdle else gate
pure val readValues = Set(
  { kind: ExplicitRead, startedAfterSettle: true, succeeded: true },
  { kind: ExplicitRead, startedAfterSettle: false, succeeded: true },
  { kind: ExplicitRead, startedAfterSettle: true, succeeded: false },
  { kind: AutomaticRead, startedAfterSettle: true, succeeded: true }
)
pure def lawOneWriteAtATime(gate: WriteGate): bool = not(gateAllowsWrite(gateOnDispatch(gate)))
pure def lawUncertainWriteBlocksUntilExplicitRead(read: ReadEvidence): bool = {
  val unsettled = gateOnOutcome(WriteInFlight, Uncertain)
  not(gateAllowsWrite(unsettled)) and (gateAllowsWrite(gateOnRead(unsettled, read)) iff readSettlesUncertainty(read))
}
pure def lawSettledWriteFreesTheGate(outcome: WriteOutcome): bool =
  outcome != Uncertain implies gateAllowsWrite(gateOnOutcome(WriteInFlight, outcome))
```
