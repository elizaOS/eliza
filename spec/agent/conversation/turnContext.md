# Turn context

With each message a client may describe its screen in three parts of the
turn's `metadata`: `metadata.observation` (the view, an optional selected
record and, on the calendar, the civil day in view), `metadata.voiceUi`
(what the voice renderer shows and how it takes completed actions) and
`metadata.browserPage` (the public web page open in Browser as the message
was sent). Each part is untrusted data about that one message, never an
instruction, and no device, provider, navigation or record permission. The
observation and the voice context hold opaque identifiers, never record
contents; the Browser page is web content the owner is looking at. Each
part is accepted whole or not at all. An observation may also carry
the phone's last known position, which a client sends only while the
platform's location permission is granted and the owner has location on. Every
other key of `metadata` is stored with the message and decoded by nothing
here. Actions and providers (device-action admission, actions on the
selected record, the current-time provider) read an accepted part only
through `readTurnContext(message)`, which returns `{observation?, voiceUi?,
browserPage?}`, never through raw metadata keys; prompt assembly shows it to
the model only as labelled untrusted data. Nothing is truncated or
summarized; a client sends a long page's text already cut and says so.

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
| `location` | `{latitude, longitude, accuracyMeters?, capturedAt}`: `latitude` a number from −90 to 90; `longitude` from −180 to 180; `accuracyMeters` from 0 to 1,000,000; `capturedAt` epoch milliseconds, a safe integer, 0 or more |

The size is the UTF-8 length of the JSON of the decoded observation, keys
in the table's order, `sensitive` always written as a boolean, and only the
stated optional fields included.

```quint
type ViewName = View({ viewName: str }) | MalformedView
type Sensitivity = SensitivityUnstated | Sensitive | NotSensitive
type ZoneFact = NoZone | Zone({ zoneName: str }) | UnknownZone
type RecordFact = NoSelectedRecord | SelectedRecord | MalformedRecord
type DayFact = NoDay | Day({ dayZone: str, dayBytes: int }) | MalformedDay
type LocationFact = NoLocation | Located({ locationBytes: int }) | MalformedLocation
type ObservationFacts = { unknownField: bool, view: ViewName, revision: int, sensitivity: Sensitivity, zone: ZoneFact, selection: RecordFact, day: DayFact, location: LocationFact, coreBytes: int }
pure val observationMaxBytes = 2048
pure val maxSafeInteger = 9007199254740991
pure val calendarView: ViewName = View({ viewName: "calendar" })
pure def dayAccepted(day: DayFact, view: ViewName, sensitivity: Sensitivity, zone: ZoneFact): bool = match day {
  | NoDay => true
  | MalformedDay => false
  | Day(d) => d.dayBytes > 0 and view == calendarView and sensitivity == NotSensitive and zone == Zone({ zoneName: d.dayZone })
}
pure def dayBytesOf(day: DayFact): int = match day { | Day(d) => d.dayBytes | _ => 0 }
pure def locationAccepted(location: LocationFact): bool = match location { | NoLocation => true | MalformedLocation => false | Located(p) => p.locationBytes > 0 }
pure def locationBytesOf(location: LocationFact): int = match location { | Located(p) => p.locationBytes | _ => 0 }
pure def observationAccepted(o: ObservationFacts): bool =
  not(o.unknownField) and o.view != MalformedView and o.revision >= 0 and o.revision <= maxSafeInteger and o.zone != UnknownZone and o.selection != MalformedRecord and
  not(o.sensitivity == Sensitive and o.selection != NoSelectedRecord) and dayAccepted(o.day, o.view, o.sensitivity, o.zone) and locationAccepted(o.location) and
  o.coreBytes + dayBytesOf(o.day) + locationBytesOf(o.location) <= observationMaxBytes
pure def withoutOptionalFields(o: ObservationFacts): ObservationFacts = { ...o, day: NoDay, location: NoLocation }
pure val oValues: Set[ObservationFacts] = {
  val base = { unknownField: false, view: View({ viewName: "calendar" }), revision: 3, sensitivity: NotSensitive, zone: Zone({ zoneName: "Europe/Berlin" }), selection: SelectedRecord, day: Day({ dayZone: "Europe/Berlin", dayBytes: 60 }), location: NoLocation, coreBytes: 400 }
  List(
    base,
    { ...base, sensitivity: Sensitive, day: NoDay },
    { ...base, sensitivity: Sensitive, selection: NoSelectedRecord },
    { ...base, sensitivity: SensitivityUnstated },
    { ...base, view: View({ viewName: "notes" }) },
    { ...base, day: Day({ dayZone: "America/New_York", dayBytes: 60 }) },
    { ...base, zone: NoZone },
    { ...base, day: MalformedDay },
    { ...base, coreBytes: 2000 },
    { ...base, unknownField: true },
    { ...base, location: Located({ locationBytes: 90 }) },
    { ...base, sensitivity: Sensitive, selection: NoSelectedRecord, day: NoDay, location: Located({ locationBytes: 90 }) },
    { ...base, location: MalformedLocation },
    { ...base, coreBytes: 1950, location: Located({ locationBytes: 90 }) }
  ).foldl(Set(), (acc, o) => acc.union(Set(o)))
}
pure def lawASensitiveScreenSharesNoRecordAndNoDay(o: ObservationFacts): bool =
  (o.sensitivity == Sensitive and (o.selection == SelectedRecord or o.day != NoDay)) implies not(observationAccepted(o))
pure def lawACivilDayNeedsTheCalendarInAKnownZone(o: ObservationFacts): bool =
  o.day != NoDay implies (not(observationAccepted({ ...o, view: View({ viewName: "notes" }) })) and not(observationAccepted({ ...o, sensitivity: SensitivityUnstated })) and not(observationAccepted({ ...o, zone: NoZone })))
pure def lawTheCalendarDayIsAcceptedInItsOwnZone(o: ObservationFacts): bool = {
  val zone = o.zone
  val calendarCoreAccepted = observationAccepted(withoutOptionalFields(o)) and o.view == calendarView and o.sensitivity == NotSensitive and o.coreBytes < observationMaxBytes
  calendarCoreAccepted implies
    match zone { | Zone(z) => observationAccepted({ ...o, location: NoLocation, day: Day({ dayZone: z.zoneName, dayBytes: observationMaxBytes - o.coreBytes }) }) | _ => true }
}
pure def lawWithoutOptionalFieldsTheObservationStaysAccepted(o: ObservationFacts): bool =
  observationAccepted(o) implies observationAccepted(withoutOptionalFields(o))
```

### A location is kept on any screen only when each coordinate, its accuracy and its time are in range, and it counts within the 2,048 bytes

A position says where the phone is, not what its screen shows, so a
sensitive screen keeps it; a malformed one drops the whole observation, as
any malformed field does. It is shown to the model with the rest of the
accepted observation, labelled untrusted data about the device, and so
reaches the bound backend, which may be hosted inference (Eliza Cloud or
the owner's own provider). The agent never asks the device for it. With
it comes a note that it is the phone's last known position, that no
street, neighbourhood or city is guessed from its coordinates, that where
the owner is comes from the Maps place lookup or else is given as the
coordinates themselves, and that an accuracy over 1,000 m is a rough
estimate that names only the area, never a street or building
([Maps](../../maps/phonePosition.md) answers where the owner is).

```quint
pure val locationBytesValues = Set(1, 90, 2048)
pure def lawALocationIsKeptOnAnyScreen(o: ObservationFacts, locationBytes: int): bool = {
  val core = withoutOptionalFields(o)
  (observationAccepted(core) and locationBytes > 0 and o.coreBytes + locationBytes <= observationMaxBytes) implies
    observationAccepted({ ...core, location: Located({ locationBytes: locationBytes }) })
}
pure def lawAMalformedLocationDropsTheObservation(o: ObservationFacts): bool = not(observationAccepted({ ...o, location: MalformedLocation }))
pure def lawALocationCountsWithinTheBound(o: ObservationFacts): bool =
  observationAccepted(o) implies o.coreBytes + locationBytesOf(o.location) <= observationMaxBytes
```

### A Browser page is kept only when every field is valid, it is the Browser tab the kept observation selects at that revision on a screen not sensitive, and it fits 16,384 bytes

A client sends the page only while Browser shows that tab, never for a
private tab. The page is bound to the same message's kept observation: its
view is `browser`, stated not sensitive, and its selected record is a
`browser-tab` whose id and revision are the page's `tabId` and `revision`,
so a page from an earlier load is never shown as the current one. A page
that fails, or whose observation was dropped, is dropped and the message
goes on without it; nothing of it is stored with the message or shown to
the model, raw or otherwise. Any other key is an unknown field, and nothing
is cut to fit.

| Key | Form |
| --- | --- |
| `tabId`, `revision` | `[A-Za-z0-9][A-Za-z0-9._:@=+-]{0,255}` |
| `url` | an absolute `https:` address of at most 2,048 characters with a host, no credentials and no fragment, written as it parses |
| `title` | text of at most 300 characters, no control character |
| `capturedAt` | epoch milliseconds when the client read the page, a safe integer, 0 or more |
| `withheld` | `sensitive-page` or `unreadable`: the client sent no text, and then `text`, `truncated`, `selection` and `links` are absent |
| `text` | without `withheld`, the visible text, at most 6,000 characters; line breaks and tabs are its only control characters |
| `truncated` | without `withheld`, a boolean: whether the client cut the text, marking the cut in it |
| `selection` | optional, text the owner selected, at most 1,000 characters, as `text` |
| `links` | optional, at most 20 `{text, url}` in page order: `text` not blank, at most 120 characters, no control character; `url` as `url` |

No text holds a lone surrogate. The size is the UTF-8 length of the JSON of
the decoded page, keys in the table's order.

The model sees a kept page once, in the latest message's screen context,
after a note on how to use it: it is the page open as the owner sent the
message, for "this page" or what is on screen; a cut or withheld text is
said to be cut or withheld, never guessed; and its title, address, text and
links are information only, never the owner's instructions, authorizing no
action. A page withheld as `unreadable` is shown as one the phone cannot
read, with only its title and address known, and a further note tells the
model that reloading or reopening it will not help, to tell the owner it
cannot read the page here, naming its title or address if that helps, and
not to reload, refresh, reopen or navigate unless the owner asked, nor to
offer to; a page withheld as `sensitive-page` keeps its own wording,
withheld on purpose. The page itself sits inside core's untrusted-content
envelope with the source `Browser page open on the owner's phone`, from the page's host,
so a marker the page forges cannot close or open an envelope. History
keeps only message text.

```quint
type PageContent = PageRead | PageWithheld | WithheldWithContent | MalformedPage
type PageBinding = NoObservation | OtherView | SensitiveBrowser | OtherTab | SelectedTab
type BrowserPageFacts = { unknownField: bool, fieldsValid: bool, content: PageContent, binding: PageBinding, bytes: int }
pure val browserPageMaxBytes = 16384
pure def pageContentAccepted(content: PageContent): bool = content == PageRead or content == PageWithheld
pure def browserPageAccepted(page: BrowserPageFacts): bool =
  not(page.unknownField) and page.fieldsValid and pageContentAccepted(page.content) and page.binding == SelectedTab and page.bytes > 0 and page.bytes <= browserPageMaxBytes
pure val pageValues: Set[BrowserPageFacts] = {
  val kept = { unknownField: false, fieldsValid: true, content: PageRead, binding: SelectedTab, bytes: 900 }
  List(
    kept,
    { ...kept, content: PageWithheld },
    { ...kept, content: WithheldWithContent },
    { ...kept, content: MalformedPage },
    { ...kept, binding: NoObservation },
    { ...kept, binding: OtherView },
    { ...kept, binding: SensitiveBrowser },
    { ...kept, binding: OtherTab },
    { ...kept, unknownField: true },
    { ...kept, fieldsValid: false },
    { ...kept, bytes: 16385 }
  ).foldl(Set(), (acc, p) => acc.union(Set(p)))
}
pure def lawAPageIsKeptOnlyForTheSelectedBrowserTab(page: BrowserPageFacts): bool =
  page.binding != SelectedTab implies not(browserPageAccepted(page))
pure def lawAWithheldPageCarriesNoContent(page: BrowserPageFacts): bool =
  not(browserPageAccepted({ ...page, content: WithheldWithContent }))
pure def lawAPageFitsItsBound(page: BrowserPageFacts): bool =
  browserPageAccepted(page) implies page.bytes <= browserPageMaxBytes
pure def lawAWellFormedBoundPageIsKept(page: BrowserPageFacts): bool =
  (not(page.unknownField) and page.fieldsValid and pageContentAccepted(page.content) and page.bytes > 0 and page.bytes <= browserPageMaxBytes) implies
    browserPageAccepted({ ...page, binding: SelectedTab })
```

### A voice view context is accepted only when every stated field has an allowed value and direct requests have completed-action delivery and a routing identity

A context that fails refuses the whole turn with 400
`VOICE_UI_CONTEXT_INVALID`, so the client learns its direct-request
preference was not applied; a failed observation only drops itself. The
direct-request preference grants no system or provider permission. A saved
Notes editor also requires completed-action delivery and a routing identity.

| Key | Allowed value |
| --- | --- |
| `uiViewPath` | text of at most 2,048 units; when not empty, starts with `/` and not with `//` |
| `uiViewSubview`, `uiTimeZone` | text of at most 128 units |
| `uiBrowserSurface` | `native` |
| `viewDelivery` | `completed-action` |
| `uiClientId` | a view interaction client id (core's pattern), equal to the turn's `X-ElizaOS-Client-Id` when it sends one; it names the client that receives completed-action views |
| `agentActionMode` | `direct-request-v1`, or `direct-files-v1`, which asks for direct requests of the Files family only |
| `uiNotesEditor` | `saved-note-v1`, with completed-action delivery and a routing identity |

A key not named here is not carried.

```quint
import streamUnits.* from "../../core/streamUnits"
type TextField = NoText | Text({ units: List[int] }) | NotText
type Delivery = NoDelivery | CompletedAction | OtherDelivery
type BrowserSurface = NoSurface | NativeSurface | OtherSurface
type ActionMode = NoActionMode | DirectRequest | DirectFilesRequest | OtherActionMode
type NoteEditorMode = NoNoteEditor | SavedNoteEditor | OtherNoteEditor
type RoutingFact = NoRouting | Routing | MalformedRouting
type VoiceUiFacts = { viewPath: TextField, subview: TextField, timeZone: TextField, surface: BrowserSurface, delivery: Delivery, routingId: RoutingFact, actionMode: ActionMode, noteEditor: NoteEditorMode }
type ContextOutcome = ContextCarried | ContextDropped | TurnRefused
pure val viewPathMaxUnits = 2048
pure val shortTextMaxUnits = 128
pure val slashUnit = 47
pure def textUnits(text: TextField): List[int] = match text { | Text(t) => t.units | _ => List() }
pure def textWithin(text: TextField, limit: int): bool = text != NotText and textUnits(text).length() <= limit
pure def pathRooted(units: List[int]): bool = units.length() == 0 or (unitPrefix(units, List(slashUnit)) and not(unitPrefix(units, List(slashUnit, slashUnit))))
pure def asksDirect(mode: ActionMode): bool = mode == DirectRequest or mode == DirectFilesRequest
pure def voiceUiAccepted(u: VoiceUiFacts): bool =
  textWithin(u.viewPath, viewPathMaxUnits) and pathRooted(textUnits(u.viewPath)) and textWithin(u.subview, shortTextMaxUnits) and textWithin(u.timeZone, shortTextMaxUnits) and
  u.surface != OtherSurface and u.delivery != OtherDelivery and u.routingId != MalformedRouting and u.actionMode != OtherActionMode and u.noteEditor != OtherNoteEditor and
  ((asksDirect(u.actionMode) or u.noteEditor == SavedNoteEditor) implies (u.delivery == CompletedAction and u.routingId == Routing))
pure def observationOutcome(o: ObservationFacts): ContextOutcome = if (observationAccepted(o)) ContextCarried else ContextDropped
pure def voiceUiOutcome(u: VoiceUiFacts): ContextOutcome = if (voiceUiAccepted(u)) ContextCarried else TurnRefused
pure val silentRenderer: VoiceUiFacts = { viewPath: NoText, subview: NoText, timeZone: NoText, surface: NoSurface, delivery: NoDelivery, routingId: NoRouting, actionMode: NoActionMode, noteEditor: NoNoteEditor }
pure val uValues: Set[VoiceUiFacts] = {
  val bound = { ...silentRenderer, viewPath: Text({ units: List(47, 99) }), subview: Text({ units: List(100) }), surface: NativeSurface, delivery: CompletedAction, routingId: Routing, actionMode: DirectRequest }
  List(
    bound,
    { ...bound, actionMode: DirectFilesRequest },
    { ...bound, actionMode: DirectFilesRequest, routingId: NoRouting },
    silentRenderer,
    { ...bound, delivery: NoDelivery },
    { ...bound, routingId: NoRouting },
    { ...bound, routingId: MalformedRouting, actionMode: NoActionMode },
    { ...bound, viewPath: Text({ units: List(47, 47, 99) }) },
    { ...bound, viewPath: Text({ units: List(99) }) },
    { ...bound, timeZone: NotText },
    { ...bound, surface: OtherSurface },
    { ...bound, actionMode: NoActionMode, noteEditor: SavedNoteEditor },
    { ...bound, actionMode: NoActionMode, noteEditor: SavedNoteEditor, routingId: NoRouting },
    { ...bound, noteEditor: OtherNoteEditor }
  ).foldl(Set(), (acc, u) => acc.union(Set(u)))
}
pure def lawDirectRequestNeedsTheBoundRenderer(u: VoiceUiFacts): bool =
  asksDirect(u.actionMode) implies (not(voiceUiAccepted({ ...u, delivery: NoDelivery })) and not(voiceUiAccepted({ ...u, routingId: NoRouting })))
pure def lawSavedNoteEditorNeedsTheBoundRenderer(u: VoiceUiFacts): bool =
  u.noteEditor == SavedNoteEditor implies (not(voiceUiAccepted({ ...u, delivery: NoDelivery })) and not(voiceUiAccepted({ ...u, routingId: NoRouting })))
pure def lawABoundRendererMayAskForDirectRequests(u: VoiceUiFacts): bool =
  (voiceUiAccepted(u) and u.delivery == CompletedAction and u.routingId == Routing) implies
    (voiceUiAccepted({ ...u, actionMode: DirectRequest }) and voiceUiAccepted({ ...u, actionMode: DirectFilesRequest }))
pure def lawARootedPathIsAccepted(rest: List[int]): bool =
  (rest.length() < viewPathMaxUnits and rest.nthOr(0, 0) != slashUnit) implies voiceUiAccepted({ ...silentRenderer, viewPath: Text({ units: List(slashUnit).concat(rest) }) })
pure def lawAPathFromAnotherHostIsRefused(rest: List[int]): bool =
  voiceUiOutcome({ ...silentRenderer, viewPath: Text({ units: List(slashUnit, slashUnit).concat(rest) }) }) == TurnRefused
```

### Optional fields go only to the process instance the client compared for this turn

An optional field (today the civil day, the location and the Browser page)
is a format the agent process understands, never a permission. A client learns the process instance once
per verified connection from the non-empty `serverInstanceId` of an
authenticated `GET /api/status`, compared exactly as returned. A turn that
would carry an optional field first waits for that learn (joining one in
progress, or starting one), then reads the status again and sends the field
only when the instance is the learned one; otherwise it sends the
observation without its optional fields, which stays accepted, and no
Browser page. A learn
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
pure def sendsOptionalFields(support: PeerSupport, read: StatusRead): bool = {
  val compared = comparePeer(support, read)
  match compared { | SamePeer(_) => true | _ => false }
}
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
