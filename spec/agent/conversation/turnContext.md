# Turn context

With each message a client may describe its screen in two parts of the
turn's `metadata`: `metadata.observation` (the view, an optional selected
record and, on the calendar, the civil day in view) and `metadata.voiceUi`
(what the voice renderer shows and how it takes completed actions). Each
part is untrusted data about that one message: opaque identifiers, never
record contents, never an instruction, and no device, provider, navigation
or record permission. Each part is accepted whole or not at all. Every
other key of `metadata` is stored with the message and decoded by nothing
here. Actions and providers (device-action admission, actions on the
selected record, the current-time provider) read an accepted part only
through `readTurnContext(message)`, which returns `{observation?, voiceUi?}`,
never through raw metadata keys; prompt assembly shows it to the model only
as labelled untrusted data. Nothing is truncated or summarized.

The decoders live in `conversation/turn-context.schema.vibe`, with the
client encoder `encodeTurnContext`. They hand this library the facts a
pattern or the platform decides; text a rule inspects is given as its
UTF-16 units, the units core stream units count.

## Story: Tell the agent what my screen shows, and nothing more

> As a person talking to the agent from my device, I want it to know which
> screen and record I mean, so that I can say "this one" without my screen's
> contents, or my sensitive screens, ever reaching it.

### An observation is kept only when every field is valid, a sensitive screen names no record, a civil day is on the calendar stated not sensitive in its own zone, and it fits 2,048 bytes

An observation that fails is dropped and the message goes on without it.
The decoder reports a malformed view, record or day, or an unknown zone,
from these wire forms (any other key is an unknown field):

| Key | Form |
| --- | --- |
| `view` | `[a-z][a-z0-9-]{0,63}` |
| `revision` | safe integer, 0 or more |
| `sensitive` | boolean, optional |
| `timeZone` | optional; at most 64 characters, `[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,3}`, known to the platform |
| `selectedObject` | `{kind, id, revision?, accountId?, sourceRevision?, occurrenceId?, timingVersion?}`: `kind` as `view`; `id` `[A-Za-z0-9][A-Za-z0-9._:@=+-]{0,511}`; `accountId`, `sourceRevision`, `occurrenceId` `[A-Za-z0-9][A-Za-z0-9._:@=+-]{0,255}`; `revision` that form or an entity tag `(W/)?"[!#-~]+"`, at most 256 characters; `timingVersion` 2 |
| `calendarDay` | `{date, timeZone}`: `date` `YYYY-MM-DD`, a real civil date from 1970 on; `timeZone` as above |

The size is the UTF-8 length of the JSON of the decoded observation, keys
in the table's order, `sensitive` always written as a boolean, and only the
stated optional fields included.

```quint
type ViewName = View({ viewName: str }) | MalformedView
type Sensitivity = SensitivityUnstated | Sensitive | NotSensitive
type ZoneFact = NoZone | Zone({ zoneName: str }) | UnknownZone
type RecordFact = NoSelectedRecord | SelectedRecord | MalformedRecord
type DayFact = NoDay | Day({ dayZone: str, dayBytes: int }) | MalformedDay
type ObservationFacts = { unknownField: bool, view: ViewName, revision: int, sensitivity: Sensitivity, zone: ZoneFact, selection: RecordFact, day: DayFact, bytesWithoutDay: int }
pure val observationMaxBytes = 2048
pure val maxSafeInteger = 9007199254740991
pure val calendarView: ViewName = View({ viewName: "calendar" })
pure def dayAccepted(day: DayFact, view: ViewName, sensitivity: Sensitivity, zone: ZoneFact): bool = match day {
  | NoDay => true
  | MalformedDay => false
  | Day(d) => d.dayBytes > 0 and view == calendarView and sensitivity == NotSensitive and zone == Zone({ zoneName: d.dayZone })
}
pure def dayBytesOf(day: DayFact): int = match day { | Day(d) => d.dayBytes | _ => 0 }
pure def observationAccepted(o: ObservationFacts): bool =
  not(o.unknownField) and o.view != MalformedView and o.revision >= 0 and o.revision <= maxSafeInteger and o.zone != UnknownZone and o.selection != MalformedRecord and
  not(o.sensitivity == Sensitive and o.selection != NoSelectedRecord) and dayAccepted(o.day, o.view, o.sensitivity, o.zone) and o.bytesWithoutDay + dayBytesOf(o.day) <= observationMaxBytes
pure def withoutOptionalFields(o: ObservationFacts): ObservationFacts = { ...o, day: NoDay }
pure val oValues: Set[ObservationFacts] = {
  val base = { unknownField: false, view: View({ viewName: "calendar" }), revision: 3, sensitivity: NotSensitive, zone: Zone({ zoneName: "Europe/Berlin" }), selection: SelectedRecord, day: Day({ dayZone: "Europe/Berlin", dayBytes: 60 }), bytesWithoutDay: 400 }
  List(
    base,
    { ...base, sensitivity: Sensitive, day: NoDay },
    { ...base, sensitivity: Sensitive, selection: NoSelectedRecord },
    { ...base, sensitivity: SensitivityUnstated },
    { ...base, view: View({ viewName: "notes" }) },
    { ...base, day: Day({ dayZone: "America/New_York", dayBytes: 60 }) },
    { ...base, zone: NoZone },
    { ...base, day: MalformedDay },
    { ...base, bytesWithoutDay: 2000 },
    { ...base, unknownField: true }
  ).foldl(Set(), (acc, o) => acc.union(Set(o)))
}
pure def lawASensitiveScreenSharesNoRecordAndNoDay(o: ObservationFacts): bool =
  (o.sensitivity == Sensitive and (o.selection == SelectedRecord or o.day != NoDay)) implies not(observationAccepted(o))
pure def lawACivilDayNeedsTheCalendarInAKnownZone(o: ObservationFacts): bool =
  o.day != NoDay implies (not(observationAccepted({ ...o, view: View({ viewName: "notes" }) })) and not(observationAccepted({ ...o, sensitivity: SensitivityUnstated })) and not(observationAccepted({ ...o, zone: NoZone })))
pure def lawTheCalendarDayIsAcceptedInItsOwnZone(o: ObservationFacts): bool =
  (observationAccepted(withoutOptionalFields(o)) and o.view == calendarView and o.sensitivity == NotSensitive and o.bytesWithoutDay < observationMaxBytes) implies
    match o.zone { | Zone(z) => observationAccepted({ ...o, day: Day({ dayZone: z.zoneName, dayBytes: observationMaxBytes - o.bytesWithoutDay }) }) | _ => true }
pure def lawWithoutOptionalFieldsTheObservationStaysAccepted(o: ObservationFacts): bool =
  observationAccepted(o) implies observationAccepted(withoutOptionalFields(o))
```

### A voice view context is accepted only when every stated field has an allowed value and direct requests have completed-action delivery and a routing identity

A context that fails refuses the whole turn with 400
`VOICE_UI_CONTEXT_INVALID`, so the client learns its direct-request
preference was not applied; a failed observation only drops itself. The
direct-request preference grants no system or provider permission.

| Key | Allowed value |
| --- | --- |
| `uiViewPath` | text of at most 2,048 units; when not empty, starts with `/` and not with `//` |
| `uiViewSubview`, `uiTimeZone` | text of at most 128 units |
| `uiBrowserSurface` | `native` |
| `viewDelivery` | `completed-action` |
| `uiClientId` | a view interaction client id (core's pattern), equal to the turn's `X-ElizaOS-Client-Id` when it sends one; it names the client that receives completed-action views |
| `agentActionMode` | `direct-request-v1` |

A key not named here is not carried.

```quint
import streamUnits.* from "../../core/streamUnits"
type TextField = NoText | Text({ units: List[int] }) | NotText
type Delivery = NoDelivery | CompletedAction | OtherDelivery
type BrowserSurface = NoSurface | NativeSurface | OtherSurface
type ActionMode = NoActionMode | DirectRequest | OtherActionMode
type RoutingFact = NoRouting | Routing | MalformedRouting
type VoiceUiFacts = { viewPath: TextField, subview: TextField, timeZone: TextField, surface: BrowserSurface, delivery: Delivery, routingId: RoutingFact, actionMode: ActionMode }
type ContextOutcome = ContextCarried | ContextDropped | TurnRefused
pure val viewPathMaxUnits = 2048
pure val shortTextMaxUnits = 128
pure val slashUnit = 47
pure def textUnits(text: TextField): List[int] = match text { | Text(t) => t.units | _ => List() }
pure def textWithin(text: TextField, limit: int): bool = text != NotText and textUnits(text).length() <= limit
pure def pathRooted(units: List[int]): bool = units.length() == 0 or (unitPrefix(units, List(slashUnit)) and not(unitPrefix(units, List(slashUnit, slashUnit))))
pure def voiceUiAccepted(u: VoiceUiFacts): bool =
  textWithin(u.viewPath, viewPathMaxUnits) and pathRooted(textUnits(u.viewPath)) and textWithin(u.subview, shortTextMaxUnits) and textWithin(u.timeZone, shortTextMaxUnits) and
  u.surface != OtherSurface and u.delivery != OtherDelivery and u.routingId != MalformedRouting and u.actionMode != OtherActionMode and
  (u.actionMode == DirectRequest implies (u.delivery == CompletedAction and u.routingId == Routing))
pure def observationOutcome(o: ObservationFacts): ContextOutcome = if (observationAccepted(o)) ContextCarried else ContextDropped
pure def voiceUiOutcome(u: VoiceUiFacts): ContextOutcome = if (voiceUiAccepted(u)) ContextCarried else TurnRefused
pure val silentRenderer: VoiceUiFacts = { viewPath: NoText, subview: NoText, timeZone: NoText, surface: NoSurface, delivery: NoDelivery, routingId: NoRouting, actionMode: NoActionMode }
pure val uValues: Set[VoiceUiFacts] = {
  val bound = { ...silentRenderer, viewPath: Text({ units: List(47, 99) }), subview: Text({ units: List(100) }), surface: NativeSurface, delivery: CompletedAction, routingId: Routing, actionMode: DirectRequest }
  List(
    bound,
    silentRenderer,
    { ...bound, delivery: NoDelivery },
    { ...bound, routingId: NoRouting },
    { ...bound, routingId: MalformedRouting, actionMode: NoActionMode },
    { ...bound, viewPath: Text({ units: List(47, 47, 99) }) },
    { ...bound, viewPath: Text({ units: List(99) }) },
    { ...bound, timeZone: NotText },
    { ...bound, surface: OtherSurface }
  ).foldl(Set(), (acc, u) => acc.union(Set(u)))
}
pure def lawDirectRequestNeedsTheBoundRenderer(u: VoiceUiFacts): bool =
  u.actionMode == DirectRequest implies (not(voiceUiAccepted({ ...u, delivery: NoDelivery })) and not(voiceUiAccepted({ ...u, routingId: NoRouting })))
pure def lawABoundRendererMayAskForDirectRequests(u: VoiceUiFacts): bool =
  (voiceUiAccepted(u) and u.delivery == CompletedAction and u.routingId == Routing) implies voiceUiAccepted({ ...u, actionMode: DirectRequest })
pure def lawARootedPathIsAccepted(rest: List[int]): bool =
  (rest.length() < viewPathMaxUnits and rest.nthOr(0, 0) != slashUnit) implies voiceUiAccepted({ ...silentRenderer, viewPath: Text({ units: List(slashUnit).concat(rest) }) })
pure def lawAPathFromAnotherHostIsRefused(rest: List[int]): bool =
  voiceUiOutcome({ ...silentRenderer, viewPath: Text({ units: List(slashUnit, slashUnit).concat(rest) }) }) == TurnRefused
```

### Optional fields go only to the process instance the client compared for this turn

An optional field (today the civil day) is a format the agent process
understands, never a permission. A client learns the process instance once
per verified connection from the non-empty `serverInstanceId` of an
authenticated `GET /api/status`, compared exactly as returned. A turn that
would carry an optional field first waits for that learn (joining one in
progress, or starting one), then reads the status again and sends the field
only when the instance is the learned one; otherwise it sends the
observation without its optional fields, which stays accepted. A learn
whose read fails or is cancelled learns nothing, so a later turn tries
again. A learn that names no instance, a mismatch, or a compare whose read
fails or is cancelled ends optional fields for that connection: nothing is
learned under it again. Ending the connection discards what it learned; a
new verified connection starts unlearned.

```quint
type PeerSupport = NotLearned | SamePeer({ instance: str }) | OrdinaryOnly
type StatusRead = Read({ instance: str }) | NoInstance | ReadFailed
pure def learnPeer(support: PeerSupport, read: StatusRead): PeerSupport =
  if (support != NotLearned) support else match read { | Read(r) => SamePeer({ instance: r.instance }) | NoInstance => OrdinaryOnly | ReadFailed => NotLearned }
pure def comparePeer(support: PeerSupport, read: StatusRead): PeerSupport = match support {
  | SamePeer(p) => if (read == Read({ instance: p.instance })) support else OrdinaryOnly
  | _ => support
}
pure def sendsOptionalFields(support: PeerSupport, read: StatusRead): bool = match comparePeer(support, read) { | SamePeer(_) => true | _ => false }
pure val readValues = Set(Read({ instance: "instance1" }), Read({ instance: "instance2" }), NoInstance, ReadFailed)
pure val supportValues = Set(NotLearned, SamePeer({ instance: "instance1" }), OrdinaryOnly)
pure val firstValues = readValues
pure val secondValues = readValues
pure def lawAMismatchEndsOptionalFields(support: PeerSupport, first: StatusRead, second: StatusRead): bool =
  not(sendsOptionalFields(support, first)) implies not(sendsOptionalFields(comparePeer(support, first), second))
pure def lawALaterInstanceIsNeverLearned(support: PeerSupport, first: StatusRead, second: StatusRead): bool =
  (support != NotLearned and not(sendsOptionalFields(support, first))) implies not(sendsOptionalFields(learnPeer(comparePeer(support, first), second), second))
pure def lawALearnedInstanceIsAdmitted(first: StatusRead): bool = match first {
  | Read(_) => sendsOptionalFields(learnPeer(NotLearned, first), first)
  | _ => true
}
pure def lawAFailedLearnMayBeRetried(first: StatusRead): bool = match first {
  | Read(_) => sendsOptionalFields(learnPeer(learnPeer(NotLearned, ReadFailed), first), first)
  | _ => true
}
```
