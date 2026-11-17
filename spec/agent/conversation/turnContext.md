# Turn context

With each message a client may describe its screen in two parts of the
turn's `metadata`: `metadata.observation` (the view, an optional selected
record and, on the calendar, the civil day in view) and `metadata.voiceUi`
(what the voice renderer shows and how it takes completed actions). Each
part is untrusted data about that one message. It carries opaque
identifiers, never record contents; it is never an instruction; and it
grants no device, provider, navigation or record permission. Each part is
accepted whole or dropped whole, and a dropped part never stops the message,
which goes on without it. Every other key of `metadata` is stored with the
message and decoded by nothing here.

The decoders live in `conversation/turn-context.schema.vibe`. They hand
this library the facts a pattern or the platform decides: whether a name or
identifier matches its pattern, whether a time zone is one the platform
knows, whether a date is a real civil date, and the size of the canonical
JSON form. Text that a rule inspects is given as its UTF-16 units, the
units core stream units count.

## Story: Tell the agent what my screen shows, and nothing more

> As a person talking to the agent from my device, I want it to know which
> screen and record I mean, so that I can say "this one" without my screen's
> contents, or my sensitive screens, ever reaching it.

### An observation is accepted whole or dropped whole

Every field must be a known one. The view is a name (`[a-z][a-z0-9-]{0,63}`)
and the revision is a whole number, not negative. A stated time zone is an
IANA zone the platform knows. A selected record carries a kind (a name), an
opaque identifier (at most 512 characters) and optional opaque revision,
source, source revision and occurrence tokens (at most 256 characters each;
a revision may also be an HTTP entity tag), and a timing version that is 2
when stated; anything else in it is malformed. A screen that says it is
sensitive (credentials, unlock, a vault) names no selected record. The civil
day in view is a real date from 1970 on, in a known zone, accepted only on
the `calendar` view stated not sensitive, in the observation's own time
zone; it bounds a lookup and grants nothing. The canonical JSON form, civil
day included, is at most 2,048 UTF-8 bytes. Nothing is truncated or
summarized.

```quint
type ViewName = View({ viewName: str }) | MalformedView
type Sensitivity = SensitivityUnstated | Sensitive | NotSensitive
type ZoneFact = NoZone | Zone({ zoneName: str }) | UnknownZone
type RecordFact = NoSelectedRecord | SelectedRecord | MalformedRecord
type DayFact = NoDay | Day({ dayZone: str, dayBytes: int }) | MalformedDay
type ObservationFacts = { unknownField: bool, view: ViewName, revision: int, sensitivity: Sensitivity, zone: ZoneFact, selection: RecordFact, day: DayFact, bytesWithoutDay: int }
pure val observationMaxBytes = 2048
pure val calendarView: ViewName = View({ viewName: "calendar" })
pure def dayAccepted(day: DayFact, view: ViewName, sensitivity: Sensitivity, zone: ZoneFact): bool = match day {
  | NoDay => true
  | MalformedDay => false
  | Day(d) => d.dayBytes > 0 and view == calendarView and sensitivity == NotSensitive and zone == Zone({ zoneName: d.dayZone })
}
pure def dayBytesOf(day: DayFact): int = match day { | Day(d) => d.dayBytes | _ => 0 }
pure def observationAccepted(o: ObservationFacts): bool =
  not(o.unknownField) and o.view != MalformedView and o.revision >= 0 and o.zone != UnknownZone and o.selection != MalformedRecord and
  not(o.sensitivity == Sensitive and o.selection != NoSelectedRecord) and dayAccepted(o.day, o.view, o.sensitivity, o.zone) and o.bytesWithoutDay + dayBytesOf(o.day) <= observationMaxBytes
pure val calendarObservation: ObservationFacts = { unknownField: false, view: calendarView, revision: 3, sensitivity: NotSensitive, zone: Zone({ zoneName: "Europe/Berlin" }), selection: SelectedRecord, day: Day({ dayZone: "Europe/Berlin", dayBytes: 60 }), bytesWithoutDay: 400 }
pure val oValues: Set[ObservationFacts] = List(
  calendarObservation,
  { ...calendarObservation, sensitivity: Sensitive, selection: NoSelectedRecord, day: NoDay },
  { ...calendarObservation, sensitivity: Sensitive, day: NoDay },
  { ...calendarObservation, sensitivity: Sensitive, selection: NoSelectedRecord },
  { ...calendarObservation, sensitivity: SensitivityUnstated },
  { ...calendarObservation, view: View({ viewName: "notes" }) },
  { ...calendarObservation, view: View({ viewName: "notes" }), day: NoDay },
  { ...calendarObservation, day: Day({ dayZone: "America/New_York", dayBytes: 60 }) },
  { ...calendarObservation, zone: NoZone },
  { ...calendarObservation, zone: UnknownZone, day: NoDay },
  { ...calendarObservation, selection: MalformedRecord },
  { ...calendarObservation, day: MalformedDay },
  { ...calendarObservation, bytesWithoutDay: 2049, day: NoDay },
  { ...calendarObservation, bytesWithoutDay: 2000 },
  { ...calendarObservation, revision: -1 },
  { ...calendarObservation, unknownField: true },
  { ...calendarObservation, view: MalformedView }
).foldl(Set(), (acc, o) => acc.union(Set(o)))
pure def lawASensitiveScreenSharesNoRecordAndNoDay(o: ObservationFacts): bool =
  (observationAccepted(o) and o.sensitivity == Sensitive) implies (o.selection == NoSelectedRecord and o.day == NoDay)
pure def lawACivilDayNeedsTheCalendarInAKnownZone(o: ObservationFacts): bool =
  (observationAccepted(o) and o.day != NoDay) implies (o.view == calendarView and o.sensitivity == NotSensitive and o.zone != NoZone and o.zone != UnknownZone)
pure def lawTheCalendarDayIsAcceptedInItsOwnZone(zoneName: str, dayBytes: int): bool =
  (dayBytes > 0 and dayBytes <= observationMaxBytes - calendarObservation.bytesWithoutDay) implies
    observationAccepted({ ...calendarObservation, zone: Zone({ zoneName: zoneName }), day: Day({ dayZone: zoneName, dayBytes: dayBytes }) })
```

### The voice view context is accepted whole or dropped whole

The voice renderer may state its view path (at most 2,048 units, and when
not empty, rooted at `/` and never starting with `//`), its subview and time
zone (free text of at most 128 units each), that it presents the native
browser, that it takes views as completed actions, its routing identity
(`[A-Za-z0-9._-]{1,128}`, the one its authenticated client sends as
`X-ElizaOS-Client-Id`) and the person's direct-request preference, which
needs completed-action delivery and a routing identity. Any other value of a
stated field drops the whole context; a key it does not name is not
carried. The preference is a preference only: it grants no system or
provider permission.

```quint
type TextField = NoText | Text({ units: List[int] }) | NotText
type Delivery = NoDelivery | CompletedAction | OtherDelivery
type BrowserSurface = NoSurface | NativeSurface | OtherSurface
type ActionMode = NoActionMode | DirectRequest | OtherActionMode
type VoiceUiFacts = { viewPath: TextField, subview: TextField, timeZone: TextField, surface: BrowserSurface, delivery: Delivery, routingId: TextField, actionMode: ActionMode }
pure val viewPathMaxUnits = 2048
pure val shortTextMaxUnits = 128
pure val slashUnit = 47
pure def textUnits(text: TextField): List[int] = match text { | Text(t) => t.units | _ => List() }
pure def textWithin(text: TextField, limit: int): bool = text != NotText and textUnits(text).length() <= limit
pure def pathRooted(units: List[int]): bool = units.length() == 0 or (units.nthOr(0, 0) == slashUnit and units.nthOr(1, 0) != slashUnit)
pure def routingUnit(code: int): bool = (code >= 48 and code <= 57) or (code >= 65 and code <= 90) or (code >= 97 and code <= 122) or code == 46 or code == 95 or code == 45
pure def routingIdNamed(text: TextField): bool = match text { | Text(t) => t.units.length() >= 1 and t.units.length() <= shortTextMaxUnits and t.units.every(code => routingUnit(code)) | _ => false }
pure def voiceUiAccepted(u: VoiceUiFacts): bool =
  textWithin(u.viewPath, viewPathMaxUnits) and pathRooted(textUnits(u.viewPath)) and textWithin(u.subview, shortTextMaxUnits) and textWithin(u.timeZone, shortTextMaxUnits) and
  u.surface != OtherSurface and u.delivery != OtherDelivery and (u.routingId == NoText or routingIdNamed(u.routingId)) and u.actionMode != OtherActionMode and
  (u.actionMode == DirectRequest implies (u.delivery == CompletedAction and routingIdNamed(u.routingId)))
pure val silentRenderer: VoiceUiFacts = { viewPath: NoText, subview: NoText, timeZone: NoText, surface: NoSurface, delivery: NoDelivery, routingId: NoText, actionMode: NoActionMode }
pure val boundRenderer: VoiceUiFacts = { viewPath: Text({ units: List(47, 99) }), subview: Text({ units: List(100) }), timeZone: NoText, surface: NativeSurface, delivery: CompletedAction, routingId: Text({ units: List(99, 49) }), actionMode: DirectRequest }
pure val uValues: Set[VoiceUiFacts] = List(
  boundRenderer,
  silentRenderer,
  { ...boundRenderer, delivery: NoDelivery },
  { ...boundRenderer, routingId: NoText },
  { ...boundRenderer, routingId: Text({ units: List(99, 32) }) },
  { ...boundRenderer, routingId: Text({ units: List() }), actionMode: NoActionMode },
  { ...boundRenderer, actionMode: NoActionMode, delivery: NoDelivery, routingId: NoText },
  { ...boundRenderer, viewPath: Text({ units: List(47, 47, 99) }) },
  { ...boundRenderer, viewPath: Text({ units: List(99) }) },
  { ...boundRenderer, viewPath: Text({ units: List() }) },
  { ...boundRenderer, viewPath: NotText },
  { ...boundRenderer, timeZone: NotText },
  { ...boundRenderer, surface: OtherSurface },
  { ...boundRenderer, actionMode: OtherActionMode }
).foldl(Set(), (acc, u) => acc.union(Set(u)))
pure def lawDirectRequestNeedsTheBoundRenderer(u: VoiceUiFacts): bool =
  (voiceUiAccepted(u) and u.actionMode == DirectRequest) implies (u.delivery == CompletedAction and textUnits(u.routingId).length() >= 1)
pure def lawARootedPathIsAccepted(rest: List[int]): bool =
  (rest.length() < viewPathMaxUnits and rest.nthOr(0, 0) != slashUnit) implies voiceUiAccepted({ ...silentRenderer, viewPath: Text({ units: List(slashUnit).concat(rest) }) })
pure def lawAPathFromAnotherHostIsRefused(rest: List[int]): bool =
  not(voiceUiAccepted({ ...silentRenderer, viewPath: Text({ units: List(slashUnit, slashUnit).concat(rest) }) }))
```

### Optional fields go only to the process instance the client compared for this turn

An optional field (today the civil day) is a format the agent process
understands, never a permission. A client learns the process instance once
per verified connection, from the `serverInstanceId` of an authenticated
`GET /api/status`, compared exactly as returned. Each turn that would carry
an optional field reads the status again and sends it only when the
instance is the learned one; otherwise the turn carries the observation
without its optional fields, which stays accepted. A mismatch, or a status
read that names no instance, ends optional fields for that connection: a
later instance is never learned under it, and only a new verified
connection learns afresh.

```quint
type PeerSupport = NotLearned | SamePeer({ instance: str }) | OrdinaryOnly
pure def learnPeer(support: PeerSupport, statusInstance: str): PeerSupport =
  if (support != NotLearned) support else if (statusInstance == "") OrdinaryOnly else SamePeer({ instance: statusInstance })
pure def comparePeer(support: PeerSupport, statusInstance: str): PeerSupport = match support {
  | SamePeer(p) => if (statusInstance == p.instance) SamePeer({ instance: p.instance }) else OrdinaryOnly
  | _ => support
}
pure def sendsOptionalFields(support: PeerSupport, statusInstance: str): bool = match support {
  | SamePeer(p) => p.instance != "" and statusInstance == p.instance
  | _ => false
}
pure def withoutOptionalFields(o: ObservationFacts): ObservationFacts = { ...o, day: NoDay }
pure val supportValues = Set(NotLearned, SamePeer({ instance: "instance1" }), SamePeer({ instance: "instance2" }), OrdinaryOnly)
pure val statusInstanceValues = Set("", "instance1", "instance2")
pure val firstValues = statusInstanceValues
pure val secondValues = statusInstanceValues
pure def lawOnlyTheComparedInstanceReceivesOptionalFields(support: PeerSupport, statusInstance: str): bool =
  sendsOptionalFields(support, statusInstance) implies (statusInstance != "" and comparePeer(support, statusInstance) == SamePeer({ instance: statusInstance }))
pure def lawAMismatchEndsOptionalFields(support: PeerSupport, first: str, second: str): bool =
  not(sendsOptionalFields(support, first)) implies not(sendsOptionalFields(comparePeer(support, first), second))
pure def lawALaterInstanceIsNeverLearned(first: str, second: str): bool =
  first != second implies not(sendsOptionalFields(learnPeer(learnPeer(NotLearned, first), second), second))
pure def lawALearnedInstanceIsAdmitted(first: str): bool =
  first != "" implies sendsOptionalFields(learnPeer(NotLearned, first), first)
pure def lawWithoutOptionalFieldsTheObservationStaysAccepted(o: ObservationFacts): bool =
  observationAccepted(o) implies observationAccepted(withoutOptionalFields(o))
```
