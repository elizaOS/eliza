# Alpha Calendar availability data

This contract covers the availability operation that AlphaPhone
negotiates when the agent advertises `calendar.availability-read.v1`.
The owner selects sources locally. The returned data describes time
occupancy without identifying events or calendars. This module specifies
the projection and input producers. The Calendar selected-access story
owns owner review, cancellation and the current readback required to
publish a result.

Product pin `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` owns the
browser implementation in `apps/app/src/browser/{calendar,calendar-records,calendar-recurrence,calendar-time}.ts`
and the Android wrapper `AlphaCalendarPlugin.java` and
`CalendarSyncFreshness.java` and `CalendarZones.java`. Eliza gitlink
`c518127a025ab173874af9c7d304f26b25213b0d` owns
`packages/contracts/src/device-reviews.ts`,
`plugins/plugin-calendar/src/client/availability-review.ts` and
`plugins/plugin-native-calendar/.../read/SelectedCalendarReader.java`.

## Story: Share only the occupied time in my reviewed calendars

### Choose a bounded interval and accept occupancy-only rows

The request has exactly `type: calendar_availability`, `start`,
`end`, and `timeZone`. Both endpoints round-trip as four-digit-year
UTC strings with millisecond precision. The start is nonnegative, the
interval is positive and at most 604,800,000 ms, and the zone is
supported by Intl, nonempty, up to 128 UTF-16 units and contains no NUL.
The picker admits at most 64 sources with distinct nonempty IDs up to
128 units, no NUL and lowercase 64-hex source revisions. Select 1–16
distinct offered sources. Calendar names and account labels stay local.
The picker trims eligible labels to 200 units and provides a fallback
for missing, blank or NUL-containing values.

The whole input has at most 200 rows, including transparent rows.
Each row has exactly `start`, `end`, `allDay` and `availability`.
The timestamps use the same UTC serialization and availability is
busy, free or tentative. Validate the row before deciding if it
overlaps. A reversed timed row or malformed all-day interval invalidates
the whole read, even outside the approved window. An all-day interval
encodes increasing civil dates as UTC midnights. Resolve each bound
to the owner-zone day boundary. A midnight fold uses the first
midnight, a midnight gap uses the beginning of the actual day, and a
skipped date resolves to the following day. A civil day may occupy a
different number of milliseconds across transitions. Date string
validation and the pinned Intl civil conversion supply normalized
facts to the model. The model admits a collapsed all-day interval
when both bounds resolve to one instant.

In a half-open window, a positive-length busy or tentative event is
clipped to the window. An overlapping free event increments
`transparentIgnored`. An adjacent or zero-length event contributes
nothing. The named-event overlap helper separately admits a point at
or after the start and before the end for lookup.

```quint
type Availability = Blocking | Transparent | Tentative
type TimeWindow = { begin: int, finish: int }
type WindowRequest = { window: TimeWindow, exactWire: bool, canonicalIso: bool, supportedZone: bool }
type EventRow = { encoded: TimeWindow, resolved: TimeWindow, allDay: bool, availability: Availability, exactWire: bool, canonicalIso: bool }
type BusySlot = { begin: int, finish: int, allDay: bool, tentative: bool }
type RowKind = Malformed | Outside | IgnoredFree | Occupied
type RowProjection = { kind: RowKind, slot: BusySlot }
pure val emptySlot: BusySlot = { begin: 0, finish: 0, allDay: false, tentative: false }
pure def windowAdmitted(req: WindowRequest): bool =
  req.exactWire and req.canonicalIso and req.supportedZone and req.window.begin >= 0 and
  req.window.finish > req.window.begin and req.window.finish - req.window.begin <= 604800000
pure def countAdmitted(calendarCount: int): bool = calendarCount >= 1 and calendarCount <= 16
pure def rowsAdmitted(rowCount: int): bool = rowCount >= 0 and rowCount <= 200
pure def rowAdmitted(ev: EventRow): bool =
  ev.exactWire and ev.canonicalIso and
  (if (ev.allDay)
    ev.encoded.begin % 86400000 == 0 and ev.encoded.finish % 86400000 == 0 and
    ev.encoded.finish > ev.encoded.begin and ev.resolved.finish >= ev.resolved.begin
   else ev.encoded.finish >= ev.encoded.begin and ev.resolved.begin == ev.encoded.begin and ev.resolved.finish == ev.encoded.finish)
pure def positiveOverlap(win: TimeWindow, interval: TimeWindow): bool =
  interval.finish > interval.begin and interval.begin < win.finish and interval.finish > win.begin
pure def lookupOverlap(win: TimeWindow, interval: TimeWindow): bool =
  if (interval.finish == interval.begin) interval.begin >= win.begin and interval.begin < win.finish
  else positiveOverlap(win, interval)
pure def forWindow(win: TimeWindow, ev: EventRow): RowProjection =
  if (not(rowAdmitted(ev))) { kind: Malformed, slot: emptySlot }
  else if (not(positiveOverlap(win, ev.resolved))) { kind: Outside, slot: emptySlot }
  else if (ev.availability == Transparent) { kind: IgnoredFree, slot: emptySlot }
  else { kind: Occupied, slot: {
    begin: if (ev.resolved.begin > win.begin) ev.resolved.begin else win.begin,
    finish: if (ev.resolved.finish < win.finish) ev.resolved.finish else win.finish,
    allDay: ev.allDay, tentative: ev.availability == Tentative } }
pure def slotInWindow(win: TimeWindow, slot: BusySlot): bool =
  slot.begin >= win.begin and slot.finish <= win.finish and slot.begin < slot.finish
pure def lawOnlyPositiveTimeIsBusy(win: TimeWindow, ev: EventRow): bool =
  val projection = forWindow(win, ev)
  win.finish > win.begin and projection.kind == Occupied implies slotInWindow(win, projection.slot)
pure def lawNeverBusyForTransparent(win: TimeWindow, ev: EventRow): bool =
  ev.availability == Transparent implies forWindow(win, ev).kind != Occupied
pure def lawInvalidTakesPriority(win: TimeWindow, ev: EventRow): bool =
  not(rowAdmitted(ev)) implies forWindow(win, ev).kind == Malformed
pure def lawPointLookupDiffers(win: TimeWindow, ev: EventRow): bool =
  rowAdmitted(ev) and ev.resolved.finish == ev.resolved.begin and lookupOverlap(win, ev.resolved)
  implies forWindow(win, ev).kind == Outside
pure val winValues = Set({ begin: 0, finish: 4 }, { begin: 2, finish: 6 }, { begin: 0, finish: 0 })
pure val evValues = Set(
  { encoded: { begin: 0, finish: 5 }, resolved: { begin: 0, finish: 5 }, allDay: false, availability: Tentative, exactWire: true, canonicalIso: true },
  { encoded: { begin: 3, finish: 3 }, resolved: { begin: 3, finish: 3 }, allDay: false, availability: Blocking, exactWire: true, canonicalIso: true },
  { encoded: { begin: 0, finish: 86400000 }, resolved: { begin: 0, finish: 82800000 }, allDay: true, availability: Transparent, exactWire: true, canonicalIso: true },
  { encoded: { begin: 4, finish: 2 }, resolved: { begin: 4, finish: 2 }, allDay: false, availability: Transparent, exactWire: true, canonicalIso: true })
```

### Return sorted rows and preserve their multiplicity

The producer sorts clipped intervals by start, end, timed before
all-day, and busy before tentative. Each qualifying row contributes
its own interval. Keep duplicates, overlaps and adjacency. A free
result may have a positive transparent count. On an invalid row or
overflow there is no partial result.

The result has exactly `version: 1`, `kind: calendar_availability`,
`window`, `calendarCount`, `status`, `busy` and
`transparentIgnored`. The window echoes the exact operation's start,
end and zone strings. Each interval has exactly `start`, `end`,
`allDay` and `tentative`, with canonical UTC bounds, true
booleans, and positive duration inside the window. No event or
calendar identifiers, titles, descriptions, locations, attendees or
credentials are present. The result validator requires monotonic
starts. It accepts alternate tie order and checks the busy row and
transparent counts separately against 200. The producer has the
stronger input bound across all rows and the defined tie-order
sorting. The result is busy precisely when it has a busy interval.
A private reviewed/current comparison uses canonical reconstructed
result JSON equality before sharing.

```quint
type InsertCursor = { inserted: bool, slots: List[BusySlot] }
type AvailabilityData = { valid: bool, transparentCount: int, slots: List[BusySlot] }
type ValidationCursor = { valid: bool, previousBegin: int }
pure val emptyData: AvailabilityData = { valid: true, transparentCount: 0, slots: List() }
pure val refusedData: AvailabilityData = { ...emptyData, valid: false }
pure def slotEarlier(left: BusySlot, right: BusySlot): bool =
  if (left.begin != right.begin) left.begin < right.begin
  else if (left.finish != right.finish) left.finish < right.finish
  else if (left.allDay != right.allDay) not(left.allDay)
  else not(left.tentative) and right.tentative
pure def appendSlot(slots: List[BusySlot], slot: BusySlot): List[BusySlot] = slots.append(slot)
pure def insertionStep(slot: BusySlot, pending: InsertCursor, present: BusySlot): InsertCursor =
  if (not(pending.inserted) and slotEarlier(slot, present))
    { inserted: true, slots: appendSlot(appendSlot(pending.slots, slot), present) }
  else { ...pending, slots: appendSlot(pending.slots, present) }
pure def insertSlot(slots: List[BusySlot], slot: BusySlot): List[BusySlot] =
  val seed: InsertCursor = { inserted: false, slots: List() }
  val cursor = slots.foldl(seed, (acc, present) => insertionStep(slot, acc, present))
  if (cursor.inserted) cursor.slots else appendSlot(cursor.slots, slot)
pure def accumulate(win: TimeWindow, acc: AvailabilityData, ev: EventRow): AvailabilityData =
  val projection = forWindow(win, ev)
  if (not(acc.valid) or projection.kind == Malformed) refusedData
  else if (projection.kind == Occupied) { ...acc, slots: insertSlot(acc.slots, projection.slot) }
  else if (projection.kind == IgnoredFree) { ...acc, transparentCount: acc.transparentCount + 1 }
  else acc
pure def aggregate(req: WindowRequest, calendarCount: int, events: List[EventRow]): AvailabilityData =
  if (not(windowAdmitted(req)) or not(countAdmitted(calendarCount)) or not(rowsAdmitted(events.length())))
    refusedData
  else events.foldl(emptyData, (acc, ev) => accumulate(req.window, acc, ev))
pure def hasBusy(slots: List[BusySlot]): bool = slots.length() > 0
pure def resultAdmitted(win: TimeWindow, calendarCount: int, slots: List[BusySlot], transparentCount: int, saysBusy: bool, exactWire: bool): bool =
  val seed: ValidationCursor = { valid: true, previousBegin: win.begin }
  val cursor = slots.foldl(seed, (acc, slot) =>
    { valid: acc.valid and slotInWindow(win, slot) and slot.begin >= acc.previousBegin, previousBegin: slot.begin })
  exactWire and countAdmitted(calendarCount) and rowsAdmitted(slots.length()) and rowsAdmitted(transparentCount) and saysBusy == hasBusy(slots) and cursor.valid
pure def noResult(acc: AvailabilityData): bool =
  val slots = acc.slots
  not(acc.valid) and acc.transparentCount == 0 and slots.length() == 0
pure def sameSlot(left: BusySlot, right: BusySlot): bool =
  left.begin == right.begin and left.finish == right.finish and left.allDay == right.allDay and left.tentative == right.tentative
pure def lawRefusalDropsPartial(win: TimeWindow, acc: AvailabilityData, ev: EventRow): bool =
  not(acc.valid) or not(rowAdmitted(ev)) implies noResult(accumulate(win, acc, ev))
pure def lawBadOperationRefused(req: WindowRequest, calendarCount: int, events: List[EventRow]): bool =
  not(windowAdmitted(req)) or not(countAdmitted(calendarCount)) or not(rowsAdmitted(events.length()))
  implies noResult(aggregate(req, calendarCount, events))
pure def lawLaterSlotFollows(left: BusySlot, right: BusySlot): bool =
  val orderedSlots = insertSlot(List(right), left)
  slotEarlier(left, right) implies not(slotEarlier(right, left)) and orderedSlots.length() == 2 and
  sameSlot(orderedSlots[0], left) and sameSlot(orderedSlots[1], right)
pure def lawEqualSlotsBothSurvive(slot: BusySlot): bool =
  val orderedSlots = insertSlot(List(slot), slot)
  orderedSlots.length() == 2 and sameSlot(orderedSlots[0], slot) and sameSlot(orderedSlots[1], slot)
pure def lawInvalidResultBoundary(win: TimeWindow, calendarCount: int, slots: List[BusySlot], transparentCount: int, saysBusy: bool, exactWire: bool): bool =
  (not(exactWire) or not(countAdmitted(calendarCount)) or not(rowsAdmitted(transparentCount)) or saysBusy != hasBusy(slots))
  implies not(resultAdmitted(win, calendarCount, slots, transparentCount, saysBusy, exactWire))
pure val reqValues = Set(
  { window: { begin: 0, finish: 86400000 }, exactWire: true, canonicalIso: true, supportedZone: true },
  { window: { begin: 1, finish: 604800002 }, exactWire: true, canonicalIso: true, supportedZone: true },
  { window: { begin: 0, finish: 20 }, exactWire: false, canonicalIso: true, supportedZone: true })
pure val calendarCountValues = Set(0, 1, 16, 17)
pure val slotValues = Set(emptySlot,
  { begin: 1, finish: 3, allDay: false, tentative: false },
  { begin: 1, finish: 3, allDay: false, tentative: true },
  { begin: 1, finish: 3, allDay: true, tentative: false },
  { begin: 1, finish: 2, allDay: false, tentative: true })
pure val pendingValues = Set({ inserted: false, slots: List() }, { inserted: true, slots: List(emptySlot) })
pure val presentValues = slotValues
pure val leftValues = slotValues
pure val rightValues = slotValues
pure val slotsValues = Set(List(), List(emptySlot),
  List({ begin: 1, finish: 3, allDay: true, tentative: false }, { begin: 1, finish: 2, allDay: false, tentative: true }),
  List({ begin: 2, finish: 3, allDay: false, tentative: false }, { begin: 1, finish: 2, allDay: false, tentative: false }))
pure val eventsValues = Set(List(),
  List({ encoded: { begin: 1, finish: 2 }, resolved: { begin: 1, finish: 2 }, allDay: false, availability: Tentative, exactWire: true, canonicalIso: true }))
pure val accValues = Set(emptyData, refusedData, { ...emptyData, transparentCount: 200, slots: List(emptySlot) })
pure val transparentCountValues = Set(-1, 0, 1, 200, 201)
```

## Story: Read the reviewed local source with its actual calendar rules

### Enforce source identity and local freshness before reading instances

On Android check read permission, foreground, unlocked state and the
requested zone before querying. Equal Android zone rules permit aliases.
The offer includes CalendarProvider
sources available at free-busy level or above. For a selected read,
assert each source revision before freshness. Every selected source
must have exactly one current CalendarProvider row with local account
type. An unknown freshness selection rejects the whole read before
querying any instances. Next, the shared reader checks the selected
identities again and filters provider instances by selected IDs and
undeleted rows, using the broader union of the instant window and
UTC-encoded owner civil date window for the provider URI. All-day
membership uses strict overlap with the civil window. Timed membership
uses strict overlap with the instant window. The last inclusive
civil date is taken at end minus 1 ms.

Only calendar ID, begin, end, all-day, availability, status and self
attendee status are queried. A row returned for an unselected calendar
fails even if cancelled. After that check, provider-cancelled and
owner-declined rows are skipped. Missing or unrecognized availability
defaults to busy. More than 200 remaining rows causes explicit overflow.
The reader rechecks identities after the query. The Android wrapper
rechecks read permission, foreground, unlock and the identity of the
captured device zone before producing local evidence. If the provider returns a zero-length row with its
begin strictly inside the bounds, the shared reducer excludes it.

The browser offers only the current app Calendar document and its
source revision. The operation must match the browser-resolved zone.
The browser reads the document and matches the selected source and
revision. It expands the recurrence/read range across the instant
and civil windows, then filters to the correct overlap per row kind.
Every resulting event is busy. Truncated expansion or more than 200
remaining rows is an explicit overflow. Local freshness and exact
source checks remain necessary for publication.

```quint
type NativeAdmission = SourceChanged | FreshnessUnknown | CanQuery
type NativeRowDecision = WrongCalendar | SkippedAppointment | BadInterval | ReadAppointment
pure def nativeAdmission(sameIdentity: bool, allLocal: bool): NativeAdmission =
  if (not(sameIdentity)) SourceChanged else if (not(allLocal)) FreshnessUnknown else CanQuery
pure def nativeRowDecision(isSelected: bool, cancelledEvent: bool, declinedEvent: bool, interval: TimeWindow): NativeRowDecision =
  if (not(isSelected)) WrongCalendar
  else if (cancelledEvent or declinedEvent) SkippedAppointment
  else if (interval.finish < interval.begin) BadInterval
  else ReadAppointment
pure def browserAdmitted(calendarCount: int, sameSource: bool, sameRevision: bool, sameZone: bool): bool =
  calendarCount == 1 and sameSource and sameRevision and sameZone
pure def calendarReadOverflow(truncated: bool, rowCount: int): bool = truncated or rowCount > 200
pure def lawScopePrecedesRowPrivacy(isSelected: bool, cancelledEvent: bool, declinedEvent: bool, interval: TimeWindow): bool =
  not(isSelected) implies nativeRowDecision(isSelected, cancelledEvent, declinedEvent, interval) == WrongCalendar
pure val intervalValues = winValues
pure def lawMixedFreshnessCannotQuery(sameIdentity: bool): bool =
  nativeAdmission(sameIdentity, false) != CanQuery
pure def lawIdentityPrecedesFreshness(allLocal: bool): bool =
  nativeAdmission(false, allLocal) == SourceChanged
pure def lawTruncatedExpansionRefuses(rowCount: int): bool =
  calendarReadOverflow(true, rowCount)
```

### Expand browser recurrence before projecting availability

The browser expands once, daily, weekdays and weekly. Series remain
unmodified. Nonrecurring intervals are copied only on positive
overlap. Recurrences use saved wall time and the stored elapsed
duration. Timed recurrence uses its saved zone or UTC by default.
All-day recurrence uses UTC. A weekly rule advances seven civil
days. Daily and weekdays advance one, and weekdays skip Saturday
and Sunday. Index zero uses the original instant. The wall-time
adapter picks the earliest matching instant at a fold and forwards a
nonexistent desired time through a gap. A skipped civil date may
resolve to the same instant as another date. The expansion emits that
start once with the original series and resolved start encoding
the occurrence ID.

The bounded search seeks near the window with a three-index margin on
each side, rejects a span greater than 40,000 indices and rejects a
maximum outside 1–10,000. The document reads each series at a cap of
2,000. Detached overrides and deleted occurrence starts suppress the
matching generated occurrences. Existing overrides with positive
overlap can appear as rows. The document sums surviving rows, sorts
by begin then ID and caps at 2,000, with a truncated flag if any
series or the combined range is truncated. Availability refuses
truncation even when a subsequent filter would fit under its limit.
Android recurrence is supplied by CalendarProvider instances.
Provider mutation of recurring events is a separate contract.

The model takes resolved wall-clock instants and civil weekdays as
inputs. It covers applicability, duration, replacement and expansion
bounds. Offset discovery and disambiguation belong to the pinned
wall-time adapter and its transition fixtures.

```quint
type RepeatRule = Once | Daily | Weekdays | Weekly
pure def stride(rule: RepeatRule): int = if (rule == Weekly) 7 else 1
pure def civilDayAllowed(rule: RepeatRule, weekday: int): bool =
  weekday >= 0 and weekday <= 6 and (rule != Weekdays or (weekday != 0 and weekday != 6))
pure val originalValues = winValues
pure def occurrenceRange(original: TimeWindow, at: int): TimeWindow =
  { begin: at, finish: at + original.finish - original.begin }
pure def newOccurrence(win: TimeWindow, original: TimeWindow, at: int, alreadySeen: bool, excludedStart: bool, replacedId: bool): bool =
  not(alreadySeen) and not(excludedStart) and not(replacedId) and positiveOverlap(win, occurrenceRange(original, at))
pure def expansionAdmitted(firstIndex: int, lastIndex: int, maximum: int): bool =
  firstIndex >= 0 and lastIndex >= firstIndex and lastIndex - firstIndex <= 40000 and maximum >= 1 and maximum <= 10000
pure def rangeCapped(oneSeriesTruncated: bool, survivingCount: int): bool =
  oneSeriesTruncated or survivingCount > 2000
pure def lawRecurrencePreservesDuration(original: TimeWindow, at: int): bool =
  occurrenceRange(original, at).finish - at == original.finish - original.begin
pure def lawOccurrenceSuppression(win: TimeWindow, original: TimeWindow, at: int, alreadySeen: bool, excludedStart: bool, replacedId: bool): bool =
  alreadySeen or excludedStart or replacedId implies not(newOccurrence(win, original, at, alreadySeen, excludedStart, replacedId))
pure def lawWeekdaySkipsWeekend(weekday: int): bool =
  weekday == 0 or weekday == 6 implies not(civilDayAllowed(Weekdays, weekday))
pure def lawDocumentTruncationFailsAvailability(oneSeriesTruncated: bool, survivingCount: int, rowCount: int): bool =
  rangeCapped(oneSeriesTruncated, survivingCount) implies calendarReadOverflow(rangeCapped(oneSeriesTruncated, survivingCount), rowCount)
```
