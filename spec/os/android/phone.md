# Phone calls, dial handoff and call log

The phone module (`packages/os/android/phone/`, from
`plugins/plugin-native-phone/android` and the call-log and placement parts of
the telephony plugin of `plugins/plugin-native-messages/android`). A host
that holds the dialer role subclasses `TelecomCallService`, Android's
`InCallService`, which keeps the calls Android reports and their ongoing-call
notices; the call screen answers, rejects, holds and ends only the current
Telecom call it names, never a number it rebuilt. A caller's contact name is
[contacts](./contacts.md)'s; voicemail is [voicemail](./voicemail.md)'s. The
operation `phone-dial`, its number validation and the telephony capability
names are the agent's
([device action operations](../../agent/deviceActions/operations.md),
[capabilities](../../agent/deviceActions/capabilities.md)); this spec keeps
the Android device check, what the handoff and a placement may report, and
the call-log read. Calls are admitted as [the bridge vocabulary](./bridge.md)
says and pages follow [keyset paging](./paging.md).

## Story: Show my calls truthfully

> As the person, I want the ongoing-call notice to match the calls Android
> reports now, so that it never shows or comes back for a call that ended.

Android calls the service on its main thread. Each added call gets a fresh
ID and its own callback. A state change queues that callback; Android does
not revoke a callback already queued when the call is removed or the service
is destroyed, so the callback checks, when it runs, that its call is still
registered.

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
pure def canReportCallState(s: CallService, callId: str): bool = s.calls.contains(callId) and not(s.queued.contains(callId))
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

A disconnected call stays registered until Telecom removes it, without a
notice.

```quint
pure def alwaysEndedNoticeAwaitsItsUpdate(s: CallService): bool = s.notices.forall(c => s.ended.contains(c) implies s.queued.contains(c))
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

## Story: Hand an approved number to my phone

> As the person, I want the agent to open my dial screen with the number I
> approved, or ask Android to call it when this app is my phone app, so
> that I am never told a call connected when the phone does not know.

### A dial opens the system dial screen only on an unlocked phone with telephony, and never commits

The shell checks the number with the agent's dial-number validation
(`dialable`) and asks Android, at the time of the call, for the telephony
feature. The dial screen, which also keeps emergency numbers, belongs to the
person: an opened screen is a `Preview` receipt and names the app that
opened, unless Android's own chooser did.

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
empty page. The read runs off the main thread, is cancelled on background,
lock, screen-off and grant change, and is fenced again before it is
published (`fenceHolds`). A page holds 1 to 50 calls.

```quint
import paging as Pg from "./paging"
type CallLogAnswer = CallLogPage({ rows: List[Pg::RowKey], more: Pg::PageEnd }) | CallLogUnavailable | CallLogNotAdmitted | CallLogLimitRefused | CallLogCursorRefused | CallLogUnreadable | CallLogStale
pure val maxCallLogPage = 50
pure val callLogCall: BridgeCall = { need: WhileUnlocked, needsGrant: true, needsFeature: true }
pure def callLogKey(date: int, rowId: int): Pg::RowKey = { major: 0 - date, minor: 0 - rowId, rowId: rowId }
pure def readCallLog(declared: bool, presence: PluginPresence, facts: HostFacts, request: Pg::PageRequest, numberFilter: str, pageLimit: int, providerRows: List[Pg::RowKey], fenceHolds: bool): CallLogAnswer = {
  val start = Pg::startOf(request, numberFilter, true)
  val startRefused = start == Pg::Refused({ reason: Pg::OtherQuery }) or start == Pg::Refused({ reason: Pg::MovedBoundary })
  if (not(declared)) CallLogUnavailable
  else if (admitCall(presence, callLogCall, facts) != CallAdmitted) CallLogNotAdmitted
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
