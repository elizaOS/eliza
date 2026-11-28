# Phone calls, call controls, dial handoff, call log and SIM lines

The phone module (`packages/os/android/phone/`, from
`plugins/plugin-native-phone/android` and the call-log and placement parts of
the telephony plugin of `plugins/plugin-native-messages/android`). A host
that holds the dialer role subclasses `TelecomCallService`, Android's
`InCallService`, which keeps the calls Android reports and their ongoing-call
notices; the call screen acts only on the Telecom call it names, never on a
number it rebuilt. A caller's name, and the names beside the calls of a
recents page, are [contacts](./contacts.md)'s display-only lookup; the call
log's own cached name is shown only when that lookup names nobody. Voicemail
is [voicemail](./voicemail.md)'s. The operations `PhoneDial` and `PhoneCall`,
their shape checks and the capabilities `phone.dial.v1` and `phone.call.v1`
are the agent's ([operations](../../agent/deviceActions/operations.md),
[capabilities](../../agent/deviceActions/capabilities.md)); this spec keeps
the Android device check, what the call screen offers for a call, which
keypad tone may sound and which calls alert, what a handoff and a placement
may report, the call-log read and what a SIM line may show. Calls are
admitted as [the bridge](./bridge.md) says and pages follow
[keyset paging](./paging.md).

## Story: Show my calls truthfully

> As the person, I want the ongoing-call notice to match the calls Android
> reports now, so that it never shows or comes back for a call that ended.

Android calls the service on its main thread. Each added call gets a fresh
ID and its own callback; a state change queues an update, and Android does
not revoke one already queued when the call is removed or the service is
destroyed, so the update checks, when it runs, that its call is registered.

### A queued call update changes a notice only while its call is still registered

Adding a call registers it and publishes its notice. Delivering a queued
update for a registered call publishes the notice, or withdraws it if Android
reported the call disconnected; an update whose call was removed, or whose
service was destroyed, is dropped and changes nothing. Removing a call drops
its notice; destroying the service drops every call. There is one set of
calls: the callbacks are not tracked apart from it.

```quint
import bridge.* from "./bridge"
type CallService = { live: bool, issued: Set[str], calls: Set[str], ended: Set[str], queued: Set[str], notices: Set[str] }
pure val initial: CallService = { live: true, issued: Set(), calls: Set(), ended: Set(), queued: Set(), notices: Set() }
pure def canAddCall(s: CallService, callId: str): bool = s.live and not(s.issued.contains(callId))
pure def addCall(s: CallService, callId: str): CallService =
  { ...s, issued: s.issued.union(Set(callId)), calls: s.calls.union(Set(callId)), notices: s.notices.union(Set(callId)) }
pure def canReportCallState(s: CallService, callId: str): bool = s.calls.contains(callId)
pure def reportCallState(s: CallService, callId: str, disconnected: bool): CallService =
  { ...s, ended: if (disconnected) s.ended.union(Set(callId)) else s.ended, queued: s.queued.union(Set(callId)) }
pure def canDeliverCallUpdate(s: CallService, callId: str): bool = s.queued.contains(callId) and s.calls.contains(callId)
pure def deliverCallUpdate(s: CallService, callId: str): CallService =
  { ...s, queued: s.queued.exclude(Set(callId)), notices: if (s.ended.contains(callId)) s.notices.exclude(Set(callId)) else s.notices.union(Set(callId)) }
pure def canDropRetiredUpdate(s: CallService, callId: str): bool = s.queued.contains(callId) and not(s.calls.contains(callId))
pure def dropRetiredUpdate(s: CallService, callId: str): CallService = { ...s, queued: s.queued.exclude(Set(callId)) }
pure def canRemoveCall(s: CallService, callId: str): bool = s.calls.contains(callId)
pure def removeCall(s: CallService, callId: str): CallService =
  { ...s, calls: s.calls.exclude(Set(callId)), notices: s.notices.exclude(Set(callId)) }
pure def canDestroyCallService(s: CallService): bool = s.live
pure def destroyCallService(s: CallService): CallService = { ...s, live: false, calls: Set(), notices: Set() }
pure val callIdValues = Set("call1", "call2")
pure def alwaysNoticeHasARegisteredCall(s: CallService): bool = s.notices.subseteq(s.calls)
pure def alwaysDestroyedServiceHasNoCalls(s: CallService): bool = not(s.live) implies (s.calls.size() == 0 and s.notices.size() == 0)
pure def alwaysCallsWereIssued(s: CallService): bool = s.calls.subseteq(s.issued) and s.ended.subseteq(s.issued) and s.queued.subseteq(s.issued)
pure def sometimesOneOfTwoCallsRemains(s: CallService): bool = s.issued.size() == 2 and s.calls.size() == 1 and s.notices.size() == 1
pure def sometimesUpdateOutlivesItsCall(s: CallService): bool = s.queued.exists(c => not(s.calls.contains(c)))
```

### A disconnected call keeps its notice only until its queued update is delivered

A disconnected call stays registered, without a notice, until Telecom
removes it; a later report never makes it active again.

```quint
pure def alwaysEndedNoticeAwaitsItsUpdate(s: CallService): bool = s.notices.forall(c => s.ended.contains(c) implies s.queued.contains(c))
pure def stepDisconnectedCallStaysEnded(before: CallService, after: CallService): bool = before.ended.subseteq(after.ended)
pure def sometimesDisconnectedCallStaysRegistered(s: CallService): bool = s.calls.exists(c => s.ended.contains(c) and not(s.notices.contains(c)))
```

### A removed call never comes back

Every added call has an ID never used before in the service.

```quint
pure def stepRemovedCallStaysRemoved(before: CallService, after: CallService): bool =
  before.issued.forall(c => before.calls.contains(c) or not(after.calls.contains(c)))
```

### A queued update of a removed call is always dropped in the end

Whatever updates the remaining calls keep queuing.

```quint
pure val fair_dropRetiredUpdate = "weak"
pure def leadsToRetiredUpdateDropped(s: CallService, later: CallService): bool =
  s.queued.forall(c => s.calls.contains(c) or not(later.queued.contains(c)))
```

## Story: Control a call only with what it can do

> As the person, I want the call screen to offer only the controls that can
> work for the call in front of me, a keypad tone that never outlives its
> call, and an alert only while my phone rings, so that no control misleads
> me and a connected call stays quiet.

### A call offers Answer and Decline only while it rings, and each other control only when it can work

The screen acts on the Telecom call it shows. A ringing call offers Answer
and Decline and nothing else, and a call that is ending or has ended offers
nothing. Every other call offers End; Mute only once Telecom has reported an
audio state; Speaker only with that state and with both the speaker and an
earpiece or wired route supported; Hold only for a call Telecom says can be
held; and the keypad only while the call is connected, because tones go only
into a connected call.

```quint
type CallStage = RingingCall | DialingCall | ConnectedCall | HeldCall | EndedCall
type CallControls = { offersAnswer: bool, offersDecline: bool, offersEnd: bool, offersMute: bool, offersKeypad: bool, offersSpeaker: bool, offersHold: bool }
pure val noControls: CallControls = { offersAnswer: false, offersDecline: false, offersEnd: false, offersMute: false, offersKeypad: false, offersSpeaker: false, offersHold: false }
pure def callControls(stage: CallStage, audioKnown: bool, speakerRoutable: bool, holdable: bool): CallControls =
  if (stage == RingingCall) { ...noControls, offersAnswer: true, offersDecline: true }
  else if (stage == EndedCall) noControls
  else { ...noControls, offersEnd: true, offersMute: audioKnown, offersKeypad: stage == ConnectedCall, offersSpeaker: audioKnown and speakerRoutable, offersHold: holdable }
pure def lawARingingCallOffersOnlyAnswerAndDecline(audioKnown: bool, speakerRoutable: bool, holdable: bool): bool =
  callControls(RingingCall, audioKnown, speakerRoutable, holdable) == { ...noControls, offersAnswer: true, offersDecline: true }
pure def lawAnEndedCallOffersNothing(audioKnown: bool, speakerRoutable: bool, holdable: bool): bool =
  callControls(EndedCall, audioKnown, speakerRoutable, holdable) == noControls
pure def lawOnlyALiveCallOffersEnd(stage: CallStage, audioKnown: bool, speakerRoutable: bool, holdable: bool): bool =
  callControls(stage, audioKnown, speakerRoutable, holdable).offersEnd == (stage != RingingCall and stage != EndedCall)
pure def lawTheKeypadNeedsAConnectedCall(stage: CallStage, audioKnown: bool, speakerRoutable: bool, holdable: bool): bool =
  callControls(stage, audioKnown, speakerRoutable, holdable).offersKeypad == (stage == ConnectedCall)
pure def lawMuteAndSpeakerNeedAReportedAudioState(stage: CallStage, speakerRoutable: bool, holdable: bool): bool =
  not(callControls(stage, false, speakerRoutable, holdable).offersMute) and not(callControls(stage, false, speakerRoutable, holdable).offersSpeaker)
```

### A keypad tone belongs to one call, and its deadline never stops a newer tone

One tone sounds at a time. A key press first releases the tone that was
sounding and then asks Telecom to play the new one into the call on screen;
if Telecom refuses, because the call is gone, no tone is owned. Each
accepted tone is given a turn of its own and a deadline that names it, so a
deadline stops only its own tone and an older one never cuts a newer key
short. The tone is also released when another call is selected, when its
call stops being connected and when the screen stops; a tone already
released is not released again.

```quint
type KeypadTone = { toneCall: str, turn: int }
pure val noTone: KeypadTone = { toneCall: "", turn: 0 }
pure def toneSounding(tone: KeypadTone): bool = tone != noTone
pure def pressKey(callId: str, telecomPlays: bool, issued: int): KeypadTone =
  if (telecomPlays and issued > 0) { toneCall: callId, turn: issued } else noTone
pure def toneDeadline(tone: KeypadTone, turn: int): KeypadTone = if (tone.turn == turn) noTone else tone
pure def retainTone(tone: KeypadTone, shownCall: str, connected: bool): KeypadTone =
  if (connected and shownCall == tone.toneCall) tone else noTone
pure val toneValues = Set(noTone, { toneCall: "call1", turn: 1 }, { toneCall: "call2", turn: 2 })
pure val shownCallValues = Set("call1", "call2")
pure val issuedValues = Set(0, 1, 2, 3)
pure val turnValues = Set(0, 1, 2)
pure def lawAnOlderDeadlineNeverStopsANewerTone(callId: str, issued: int, turn: int): bool =
  issued != turn implies toneDeadline(pressKey(callId, true, issued), turn) == pressKey(callId, true, issued)
pure def lawADeadlineStopsItsOwnTone(callId: str, issued: int): bool =
  toneDeadline(pressKey(callId, true, issued), issued) == noTone
pure def lawARefusedKeyOwnsNoTone(callId: str, issued: int): bool =
  pressKey(callId, false, issued) == noTone
pure def lawAToneNeverOutlivesItsConnectedCallOnScreen(tone: KeypadTone, shownCall: str, connected: bool): bool =
  toneSounding(retainTone(tone, shownCall, connected)) implies (connected and shownCall == tone.toneCall)
pure def lawAReleasedToneIsNotReleasedAgain(shownCall: str, connected: bool, turn: int): bool =
  not(toneSounding(retainTone(noTone, shownCall, connected))) and not(toneSounding(toneDeadline(noTone, turn)))
```

### Only a ringing call alerts, and every other call uses the quiet channel

The service keeps two notice channels. The host's own channel carries only
a ringing call, with its full-screen call screen; it has no sound of its
own, because Telecom plays the ringtone. A quiet channel derived from it
carries an outgoing, connected or held call and neither sounds nor
vibrates.

```quint
type CallChannel = AlertingChannel | QuietChannel
pure def callChannel(stage: CallStage): CallChannel = if (stage == RingingCall) AlertingChannel else QuietChannel
pure def lawOnlyARingingCallAlerts(stage: CallStage): bool = (callChannel(stage) == AlertingChannel) == (stage == RingingCall)
```

## Story: Hand an approved number to my phone

> As the person, I want the agent to open my dial screen with the number I
> approved, or ask Android to call it when this app is my phone app, so
> that I am never told a call connected when the phone does not know.

### A dial opens the system dial screen only on an unlocked phone with telephony, and never commits

`dialable` is the shell's check of the number against the dial pattern;
the telephony feature is asked of Android at the time of the call. The dial
screen, which also keeps emergency numbers, belongs to the person: an opened
screen is a `Preview` receipt and names the app that opened, unless
Android's own chooser did.

```quint
import receipts as R from "../../core/receipts"
type DialerAnswer = DialerMissing | DialerOpened | DialerFailed
type DialStatus = DialHandedOff | DialUnavailable | DialFailed | DialRefused
type DialResult = { dialStatus: DialStatus, namesHandler: bool }
pure val dialCall: BridgeCall = { need: WhileUnlocked, needsGrant: false, needsFeature: true }
pure def dialResult(presence: PluginPresence, facts: HostFacts, dialable: bool, screen: DialerAnswer, chooser: bool): DialResult =
  if (admitCall(presence, dialCall, facts) != CallAdmitted or not(dialable)) { dialStatus: DialRefused, namesHandler: false }
  else if (screen == DialerMissing) { dialStatus: DialUnavailable, namesHandler: false }
  else if (screen == DialerFailed) { dialStatus: DialFailed, namesHandler: false }
  else { dialStatus: DialHandedOff, namesHandler: not(chooser) }
pure def dialReceipt(result: DialResult): R::Receipt = receiptOfHandoff(if (result.dialStatus == DialHandedOff) Opened else Refused)
pure def lawDialOpensOnlyAnAdmittedNumberAndNeverCommits(presence: PluginPresence, facts: HostFacts, dialable: bool, screen: DialerAnswer, chooser: bool): bool = {
  val result = dialResult(presence, facts, dialable, screen, chooser)
  ((result.dialStatus == DialHandedOff) iff (presence == PluginRegistered and facts.featurePresent and facts.foreground and facts.unlocked and dialable and screen == DialerOpened))
    and (result.namesHandler implies result.dialStatus == DialHandedOff) and not(R::committedReceipt(dialReceipt(result)))
}
```

### A call is placed only for an ordinary number, with the dialer role, the call grant and a free line, and only Telecom's acceptance commits

A number Android classes as emergency, or cannot class, is never placed: the
dial screen opens with it instead. Otherwise the phone must place calls, the
host must hold the dialer role and `CALL_PHONE`, and no call may be ringing
or in progress; an unreadable line state places nothing. `CallPlaced` means
Telecom took the request, not that the call connected. On `CallRoleRequired`
or `CallPermissionRequired` the app may fall back to the dial handoff.

```quint
type NumberKind = OrdinaryNumber | EmergencyNumber
type CallLine = LineFree | LineBusy | LineUnknown
type TelecomAnswer = TelecomAccepted | TelecomRefused | TelecomMissing
type Placement = { numberKind: NumberKind, voiceCapable: bool, roleHeld: bool, callGrant: bool, line: CallLine }
type PlaceStatus = CallPlaced | CallEmergencyHandoff | CallBusy | CallUnavailable | CallFailed | CallRoleRequired | CallPermissionRequired | CallRefused
pure def placeStatus(presence: PluginPresence, facts: HostFacts, dialable: bool, placement: Placement, screen: DialerAnswer, telecom: TelecomAnswer): PlaceStatus =
  if (admitCall(presence, dialCall, facts) != CallAdmitted or not(dialable)) CallRefused
  else if (placement.numberKind == EmergencyNumber) (if (screen == DialerOpened) CallEmergencyHandoff else if (screen == DialerMissing) CallUnavailable else CallFailed)
  else if (not(placement.voiceCapable)) CallUnavailable
  else if (not(placement.roleHeld)) CallRoleRequired
  else if (not(placement.callGrant)) CallPermissionRequired
  else if (placement.line == LineBusy) CallBusy
  else if (placement.line == LineUnknown) CallUnavailable
  else if (telecom == TelecomAccepted) CallPlaced
  else if (telecom == TelecomRefused) CallFailed
  else CallUnavailable
pure def placeReceipt(status: PlaceStatus): R::Receipt =
  if (status == CallPlaced) { receiptKind: R::Applied, durable: false, providerAccepted: true, hasKey: false, replayed: false, reverted: false }
  else receiptOfHandoff(if (status == CallEmergencyHandoff) Opened else Refused)
pure val placementValues = Set(
  { numberKind: OrdinaryNumber, voiceCapable: true, roleHeld: true, callGrant: true, line: LineFree },
  { numberKind: OrdinaryNumber, voiceCapable: true, roleHeld: true, callGrant: true, line: LineBusy },
  { numberKind: OrdinaryNumber, voiceCapable: true, roleHeld: false, callGrant: true, line: LineFree },
  { numberKind: OrdinaryNumber, voiceCapable: true, roleHeld: true, callGrant: false, line: LineUnknown },
  { numberKind: EmergencyNumber, voiceCapable: true, roleHeld: true, callGrant: true, line: LineFree }
)
pure def lawPlacedOnlyOnEveryCheck(presence: PluginPresence, facts: HostFacts, dialable: bool, placement: Placement, screen: DialerAnswer, telecom: TelecomAnswer): bool = {
  val status = placeStatus(presence, facts, dialable, placement, screen, telecom)
  (R::committedReceipt(placeReceipt(status)) iff status == CallPlaced) and
  ((status == CallPlaced) iff (admitCall(presence, dialCall, facts) == CallAdmitted and dialable and placement.numberKind == OrdinaryNumber and placement.voiceCapable
    and placement.roleHeld and placement.callGrant and placement.line == LineFree and telecom == TelecomAccepted))
}
pure def lawEmergencyNumberOnlyOpensTheDialScreen(presence: PluginPresence, facts: HostFacts, dialable: bool, placement: Placement, screen: DialerAnswer, telecom: TelecomAnswer): bool = {
  val status = placeStatus(presence, facts, dialable, placement, screen, telecom)
  placement.numberKind == EmergencyNumber implies (status != CallPlaced and (status == CallEmergencyHandoff iff (status != CallRefused and screen == DialerOpened)))
}
```

## Story: Read my recent calls

> As the person, I want to read my recent calls a page at a time, newest
> first, so that none is shown twice, made up or left out.

### A call-log page is published only to a host that declares the call log, on an unlocked phone with the grant, and only if access still holds at publication

A host that does not declare call-log access answers unavailable, never an
empty page; a refused admission carries its reason, so only
`PermissionRequired` raises Android's prompt. The read runs off the main
thread, is cancelled on background, lock, screen-off and grant change, and is
fenced again before it is published (`fenceHolds`). The caller requests a
limit from 1 to 50 calls, and the page may be empty.

```quint
import paging as Pg from "./paging"
type CallLogAnswer = CallLogPage({ rows: List[Pg::RowKey], more: Pg::PageEnd }) | CallLogUnavailable | CallLogNotAdmitted({ admission: Admission }) | CallLogLimitRefused | CallLogCursorRefused | CallLogUnreadable | CallLogStale
pure val maxCallLogPage = 50
pure val callLogCall: BridgeCall = { need: WhileUnlocked, needsGrant: true, needsFeature: true }
pure def callLogKey(date: int, rowId: int): Pg::RowKey = { major: 0 - date, minor: 0 - rowId, rowId: rowId }
pure def readCallLog(declared: bool, presence: PluginPresence, facts: HostFacts, request: Pg::PageRequest, numberFilter: str, pageLimit: int, providerRows: List[Pg::RowKey], fenceHolds: bool): CallLogAnswer = {
  val start = Pg::startOf(request, numberFilter, true)
  val startRefused = start == Pg::Refused({ reason: Pg::OtherQuery }) or start == Pg::Refused({ reason: Pg::MovedBoundary })
  val admission = admitCall(presence, callLogCall, facts)
  if (not(declared)) CallLogUnavailable
  else if (admission != CallAdmitted) CallLogNotAdmitted({ admission: admission })
  else if (pageLimit < 1 or pageLimit > maxCallLogPage) CallLogLimitRefused
  else if (startRefused) CallLogCursorRefused
  else if (not(Pg::inPageOrder(providerRows))) CallLogUnreadable
  else if (not(fenceHolds)) CallLogStale
  else CallLogPage({ rows: Pg::takePage(providerRows, start, pageLimit), more: Pg::pageEnd(numberFilter, providerRows, start, pageLimit) })
}
pure val requestValues = Set(Pg::FirstRequest, Pg::ContinueRequest({ resume: { query: "", last: { major: 0, minor: 0, rowId: 1 } } }),
  Pg::ContinueRequest({ resume: { query: "ann", last: { major: 0, minor: 0, rowId: 2 } } }))
pure val numberFilterValues = Set("", "ann")
pure val pageLimitValues = Set(0, 1, 2, 50, 51)
pure val providerRowsValues = Pg::rowsValues
pure def isCallLogPage(answer: CallLogAnswer): bool = match answer { | CallLogPage(_) => true | _ => false }
pure def lawCallLogPageNeedsEveryCheck(declared: bool, presence: PluginPresence, facts: HostFacts, request: Pg::PageRequest, numberFilter: str, pageLimit: int, providerRows: List[Pg::RowKey], fenceHolds: bool): bool =
  isCallLogPage(readCallLog(declared, presence, facts, request, numberFilter, pageLimit, providerRows, fenceHolds)) implies
    (declared and presence == PluginRegistered and facts.featurePresent and facts.foreground and facts.unlocked and facts.granted
      and pageLimit >= 1 and pageLimit <= maxCallLogPage and Pg::inPageOrder(providerRows) and fenceHolds)
```

### Calls are read newest first and a row out of order or repeated fails the whole read

The key of a call is `callLogKey(date, rowId)`: newest date first, then the
highest provider ID. The shell checks the rows it read, the lookahead row
included; a row with a bad ID, a repeated row or one out of order is never
skipped or repaired. A page holds at most its limit of the rows the
provider returned, each after its cursor; its next cursor, under the number
filter as its query, is `Pg`'s.

```quint
pure val dateValues = Set(1, 2)
pure val rowIdValues = Set(1, 2)
pure def lawNewerCallsComeFirst(date: int, rowId: int): bool =
  Pg::precedes(callLogKey(date + 1, rowId), callLogKey(date, rowId)) and Pg::precedes(callLogKey(date, rowId + 1), callLogKey(date, rowId))
pure def lawCallLogPageStaysOnItsQuery(declared: bool, presence: PluginPresence, facts: HostFacts, request: Pg::PageRequest, numberFilter: str, pageLimit: int, providerRows: List[Pg::RowKey], fenceHolds: bool): bool = {
  val answer = readCallLog(declared, presence, facts, request, numberFilter, pageLimit, providerRows, fenceHolds)
  val start = Pg::startOf(request, numberFilter, true)
  (not(Pg::inPageOrder(providerRows)) implies not(isCallLogPage(answer))) and match answer {
    | CallLogPage(p) => p.rows.length() <= pageLimit and p.rows.every(k => Pg::isAfterStart(start, k) and providerRows.includes(k))
    | _ => true
  }
}
```

## Story: See my SIM lines without guesses

> As the person, I want Settings to show each SIM's carrier, number, network
> and identifiers only as far as Android let this app read them, so that a
> field Android refused reads as unread and never as a guess.

### A SIM line shows a field only when Android let this app read it

The read needs no permission of its own, runs only on the unlocked phone in
front and is fenced again before it is published. Its answer says which
parts Android let the app read: the active SIM list (phone-state access),
the lines' own numbers (phone-number or SMS access, or the SMS role) and
the device identifiers (the privileged permission or carrier privileges).
Without phone-state access no line is listed, which is not a claim that the
phone has no SIM. A line's number is null without number access, and its
ICCID and IMEI are null without identifier access; each field is read on its
own, so a field Android refused, or whose value does not have its shape, is
null and the others are still read. At most `maxSimLines` lines are
listed. An answer that fills a field its access refuses is malformed.

```quint
type SimAccess = { phoneState: bool, phoneNumbers: bool, deviceIdentifiers: bool }
type SimLine = { hasNumber: bool, hasIccid: bool, hasImei: bool }
pure val maxSimLines = 4
pure def lineFollowsAccess(access: SimAccess, sim: SimLine): bool =
  (sim.hasNumber implies access.phoneNumbers) and ((sim.hasIccid or sim.hasImei) implies access.deviceIdentifiers)
pure def linesFollowAccess(access: SimAccess, sims: List[SimLine]): bool =
  sims.length() <= maxSimLines and (access.phoneState or sims.length() == 0) and sims.every(sim => lineFollowsAccess(access, sim))
pure def readSimLine(access: SimAccess, sim: SimLine): SimLine =
  { hasNumber: access.phoneNumbers and sim.hasNumber, hasIccid: access.deviceIdentifiers and sim.hasIccid, hasImei: access.deviceIdentifiers and sim.hasImei }
pure val accessValues = Set(
  { phoneState: true, phoneNumbers: true, deviceIdentifiers: true },
  { phoneState: true, phoneNumbers: false, deviceIdentifiers: false },
  { phoneState: true, phoneNumbers: true, deviceIdentifiers: false },
  { phoneState: false, phoneNumbers: false, deviceIdentifiers: false }
)
pure val simValues = Set(
  { hasNumber: true, hasIccid: true, hasImei: true },
  { hasNumber: true, hasIccid: false, hasImei: false },
  { hasNumber: false, hasIccid: false, hasImei: true },
  { hasNumber: false, hasIccid: false, hasImei: false }
)
pure def lawARefusedFieldIsNeverFilled(access: SimAccess, sim: SimLine): bool = lineFollowsAccess(access, readSimLine(access, sim))
pure def lawALineReadTwiceReadsTheSame(access: SimAccess, sim: SimLine): bool =
  readSimLine(access, readSimLine(access, sim)) == readSimLine(access, sim)
pure def lawWithoutPhoneStateNoLineIsListed(access: SimAccess, sim: SimLine): bool =
  not(access.phoneState) implies not(linesFollowAccess(access, List(readSimLine(access, sim))))
```

### A line's network reads as no service only when the radio is known to have none

The network is the line's data network type, or its voice network type when
data reports none. With neither reported, the line reads "none" only when
Android's service state says the radio has no service; a service state that
could not be read, a line without its own telephony manager and a type this
build does not recognise all read "unknown".

```quint
type NetworkTypeRead = TypeUnreported | TypeRecognised | TypeUnrecognised
type ServiceRead = ServiceUnread | InService | OutOfService
type NetworkShown = NetworkNamed | NetworkNone | NetworkUnknown
pure def networkShown(typeRead: NetworkTypeRead, service: ServiceRead): NetworkShown =
  if (typeRead == TypeRecognised) NetworkNamed
  else if (typeRead == TypeUnreported and service == OutOfService) NetworkNone
  else NetworkUnknown
pure def lawNoServiceIsShownOnlyWhenTheRadioSaysSo(typeRead: NetworkTypeRead, service: ServiceRead): bool =
  (networkShown(typeRead, service) == NetworkNone) == (typeRead == TypeUnreported and service == OutOfService)
```
