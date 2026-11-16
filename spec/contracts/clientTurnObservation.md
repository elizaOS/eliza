# Client turn observation

With each message, a client may report what its screen shows: the view, an
optional selected record and, on a calendar, the civil day in view. The
report travels once per message, as untrusted data about that message: it
carries opaque identifiers only, never record contents; it is not an
instruction; and it grants no device access. Device-action admission,
planner hints and prompt assembly all read it through this contract, so no
client wraps the person's own words in an instruction of its own. A host
may narrow which views and selections it sends; this contract fixes the
shape and the bounds.

The observation is modeled as the facts its strict parser checks: whether
every field is a known one, whether each identifier matches its pattern,
the revision, the sensitivity flag, the time zones, and the size of the
canonical JSON form.

## Story: Tell the agent what my screen shows, and nothing more

> As a person talking to the agent from a device, I want the agent to know
> which screen and record I mean, without my screen's contents or my
> sensitive screens ever reaching it.

### An observation is accepted whole or not at all

Every field must be a known one. The view name and each identifier must
match its pattern, the revision must not be negative, and a stated time
zone must be one the platform knows. A screen for credentials, unlocking
or a vault reports itself as sensitive and names no selected record. The
civil day in view is a lookup bound, never authority over a record or a
write: it is accepted only on the calendar view, stated not sensitive, in
the observation's own time zone. The canonical form is at most 2048 bytes.
Nothing is truncated or summarized: an observation that fails any check is
dropped, and the message goes on without one.

```quint
pure val observationMaxBytes = 2048
type SelectionInput = { selected: bool, selectionWellFormed: bool }
type DayInput = { dayShown: bool, civilDate: bool, dayZone: str }
type ObservationInput = { onlyKnownFields: bool, viewName: str, viewValid: bool, revision: int, sensitive: bool, sensitiveStated: bool, zone: str, zoneValid: bool, selection: SelectionInput, day: DayInput, bytes: int }
pure def selectionAccepted(selection: SelectionInput): bool = not(selection.selected) or selection.selectionWellFormed
pure def dayAccepted(o: ObservationInput): bool =
  not(o.day.dayShown) or (o.day.civilDate and o.viewName == "calendar" and o.sensitiveStated and not(o.sensitive) and o.zone != "" and o.zoneValid and o.zone == o.day.dayZone)
pure def acceptObservation(o: ObservationInput): bool =
  o.onlyKnownFields and o.viewValid and o.revision >= 0 and (o.zone == "" or o.zoneValid) and
  not(o.sensitive and o.selection.selected) and selectionAccepted(o.selection) and dayAccepted(o) and o.bytes <= observationMaxBytes
pure val calendarView: ObservationInput = { onlyKnownFields: true, viewName: "calendar", viewValid: true, revision: 3, sensitive: false, sensitiveStated: true, zone: "Europe/Berlin", zoneValid: true, selection: { selected: true, selectionWellFormed: true }, day: { dayShown: true, civilDate: true, dayZone: "Europe/Berlin" }, bytes: 400 }
pure val oValues: Set[ObservationInput] = List(
  calendarView,
  { ...calendarView, sensitive: true, selection: { selected: false, selectionWellFormed: false }, day: { dayShown: false, civilDate: false, dayZone: "" } },
  { ...calendarView, sensitive: true },
  { ...calendarView, viewName: "notes" },
  { ...calendarView, day: { dayShown: true, civilDate: true, dayZone: "America/New_York" } },
  { ...calendarView, sensitiveStated: false, sensitive: false },
  { ...calendarView, bytes: 2049 },
  { ...calendarView, revision: -1 },
  { ...calendarView, onlyKnownFields: false }
).foldl(Set(), (acc, o) => acc.union(Set(o)))
pure def lawSensitiveScreenSharesNoSelection(o: ObservationInput): bool =
  (acceptObservation(o) and o.sensitive) implies not(o.selection.selected)
pure def lawCalendarDayNeedsTheCalendarView(o: ObservationInput): bool =
  (acceptObservation(o) and o.day.dayShown) implies (o.viewName == "calendar" and not(o.sensitive) and o.zone == o.day.dayZone)
pure def lawOversizedObservationIsRefused(o: ObservationInput): bool =
  o.bytes > observationMaxBytes implies not(acceptObservation(o))
```

### Optional fields are sent only to the exact agent process that declared support

A client sends the calendar day only after the agent process it is
connected to declared support for it. The declaration counts only when it
comes from the process instance the client's authenticated handshake
named; a missing or malformed declaration leaves every optional field off.

```quint
type SupportDeclaration = { supportVersion: int, declaresDay: bool, unknownSupportFields: bool }
pure def calendarDaySupported(statusInstance: str, expectedInstance: str, declaration: SupportDeclaration): bool =
  expectedInstance != "" and statusInstance == expectedInstance and declaration.supportVersion == 1 and not(declaration.unknownSupportFields) and declaration.declaresDay
pure val statusInstanceValues = Set("", "instance1", "instance2")
pure val expectedInstanceValues = Set("", "instance1")
pure val declarationValues: Set[SupportDeclaration] = Set({ supportVersion: 1, declaresDay: true, unknownSupportFields: false }, { supportVersion: 1, declaresDay: false, unknownSupportFields: false }, { supportVersion: 2, declaresDay: true, unknownSupportFields: false }, { supportVersion: 1, declaresDay: true, unknownSupportFields: true })
pure def lawSupportComesFromTheExpectedProcess(statusInstance: str, expectedInstance: str, declaration: SupportDeclaration): bool =
  statusInstance != expectedInstance implies not(calendarDaySupported(statusInstance, expectedInstance, declaration))
```
