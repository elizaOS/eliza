# Calendar on the device

The device calendar operations the agent may propose: creating an event in
the device's own calendar or a named calendar source, reading the next
event, and reading, changing or deleting one event the owner selected.
[Capability negotiation](./capabilities.md) owns the vocabulary, the
[foreground review](./capabilities.md) rule owns consent, and
[device action custody](./execution.md) journals the effect.

## Story: Let the agent work with my device calendar only as I reviewed

> As a user, the agent can add, read, change or delete a calendar event on
> my device only with the capability that operation needs, only with event
> fields that make sense, and the receipt it gets back is about exactly the
> event I reviewed.

### Each calendar operation needs its own capability

Creating an event in the device's own calendar needs the create capability.
Reading the next event needs the next-event capability, never inferred
from any other. Creating in a named calendar source, reading the selected
event, changing it and deleting it need the local event capability.

```quint
type CalendarOperation = CreateLocalEvent | ReadNextEvent | CreateInSource | ReadSelectedEvent | UpdateEvent | DeleteEvent
pure def calendarCapability(operation: CalendarOperation): str =
  if (operation == CreateLocalEvent) "calendar.create.v1"
  else if (operation == ReadNextEvent) "calendar.next-read.v1"
  else "calendar.local-event.v1"
pure def calendarAdmitted(operation: CalendarOperation, advertised: Set[str]): bool = advertised.contains(calendarCapability(operation))
pure val advertisedValues: Set[Set[str]] = Set(Set(), Set("calendar.local-event.v1"), Set("calendar.local-event.v1", "calendar.next-read.v1"), Set("calendar.create.v1"))
pure def lawNextReadNeedsItsOwnCapability(advertised: Set[str]): bool =
  not(advertised.contains("calendar.next-read.v1")) implies not(calendarAdmitted(ReadNextEvent, advertised))
pure def lawLocalCreateNeedsTheCreateCapability(advertised: Set[str]): bool =
  not(advertised.contains("calendar.create.v1")) implies not(calendarAdmitted(CreateLocalEvent, advertised))
```

### An event's fields are bounded and its end follows its start

An event's title is nonblank and at most 500 UTF-16 units, its description
at most 16,000 and its location at most 2,000, with no NUL anywhere. Its
start is not before the epoch, its end is after its start, and the event
spans at most 370 days.

```quint
type EventFields = { titleUnits: int, titleBlank: bool, descriptionUnits: int, locationUnits: int, noNul: bool, startMinute: int, endMinute: int }
pure val maxEventMinutes = 532800
pure def eventFieldsAdmitted(f: EventFields): bool =
  not(f.titleBlank) and f.titleUnits > 0 and f.titleUnits <= 500 and f.descriptionUnits >= 0 and f.descriptionUnits <= 16000 and
  f.locationUnits >= 0 and f.locationUnits <= 2000 and f.noNul and f.startMinute >= 0 and f.endMinute > f.startMinute and
  f.endMinute - f.startMinute <= maxEventMinutes
pure val goodFields: EventFields = { titleUnits: 12, titleBlank: false, descriptionUnits: 0, locationUnits: 0, noNul: true, startMinute: 600, endMinute: 660 }
pure val eventFieldsValues = Set(goodFields, { ...goodFields, endMinute: 600 }, { ...goodFields, endMinute: 600 + maxEventMinutes + 1 }, { ...goodFields, titleBlank: true }, { ...goodFields, noNul: false })
pure def lawEndFollowsStart(eventFields: EventFields): bool = eventFieldsAdmitted(eventFields) implies eventFields.endMinute > eventFields.startMinute
pure def lawEventSpanIsBounded(eventFields: EventFields): bool = eventFieldsAdmitted(eventFields) implies eventFields.endMinute - eventFields.startMinute <= maxEventMinutes
```

### A calendar receipt is about exactly the reviewed event

A receipt names the operation it answers, and the calendar source the
operation named. A receipt for reading, changing or deleting an event names
the same event; reading or deleting it also keeps the revision that was
reviewed, while a change answers with the revision it stored. Only the
read of a selected event carries the event's fields.

```quint
type CalendarReceipt = { sameKind: bool, sameSource: bool, sameEvent: bool, sameRevision: bool, hasFields: bool }
pure def calendarReceiptAdmitted(operation: CalendarOperation, receipt: CalendarReceipt): bool =
  receipt.sameKind and (operation == CreateLocalEvent or receipt.sameSource) and
  (operation == CreateLocalEvent or operation == CreateInSource or receipt.sameEvent) and
  ((operation == ReadSelectedEvent or operation == DeleteEvent) implies receipt.sameRevision) and
  receipt.hasFields == (operation == ReadSelectedEvent)
pure val exactReceipt: CalendarReceipt = { sameKind: true, sameSource: true, sameEvent: true, sameRevision: true, hasFields: false }
pure val receiptValues = Set(exactReceipt, { ...exactReceipt, hasFields: true }, { ...exactReceipt, sameRevision: false }, { ...exactReceipt, sameEvent: false }, { ...exactReceipt, sameSource: false })
pure def lawDeleteKeepsTheReviewedRevision(receipt: CalendarReceipt): bool =
  not(receipt.sameRevision) implies not(calendarReceiptAdmitted(DeleteEvent, receipt))
pure def lawChangeNamesTheSameEvent(receipt: CalendarReceipt): bool =
  not(receipt.sameEvent) implies not(calendarReceiptAdmitted(UpdateEvent, receipt))
pure def lawOnlySelectedReadCarriesFields(operation: CalendarOperation, receipt: CalendarReceipt): bool =
  (calendarReceiptAdmitted(operation, receipt) and receipt.hasFields) implies operation == ReadSelectedEvent
```

### The next event is read within thirty local days and lies inside them

Reading the next event covers exactly thirty local days from now. Its
answer is no event, or one timed event that does not start before the
window and starts before it ends, or an all-day event that has not ended
before the window, marked ongoing when it began before the window.

```quint
type NextEvent = { present: bool, allDay: bool, startMinute: int, endMinute: int, ongoing: bool }
pure val nextWindowDays = 30
pure def nextEventAdmitted(windowDays: int, windowStart: int, windowEnd: int, e: NextEvent): bool =
  windowDays == nextWindowDays and windowEnd > windowStart and
  (not(e.present) or
    (if (e.allDay) e.endMinute > windowStart and e.startMinute < windowEnd and e.ongoing == (e.startMinute < windowStart)
     else e.startMinute >= windowStart and e.startMinute < windowEnd and e.endMinute >= e.startMinute and not(e.ongoing)))
pure val upcomingValues = Set({ present: false, allDay: false, startMinute: 0, endMinute: 0, ongoing: false }, { present: true, allDay: false, startMinute: 100, endMinute: 160, ongoing: false }, { present: true, allDay: false, startMinute: -10, endMinute: 20, ongoing: false }, { present: true, allDay: true, startMinute: -100, endMinute: 1340, ongoing: true })
pure val windowDaysValues = Set(30, 31)
pure def lawTimedNextEventIsInsideTheWindow(windowDays: int, upcoming: NextEvent): bool =
  (nextEventAdmitted(windowDays, 0, 43200, upcoming) and upcoming.present and not(upcoming.allDay)) implies (upcoming.startMinute >= 0 and upcoming.startMinute < 43200)
pure def lawWindowIsThirtyDays(windowDays: int, upcoming: NextEvent): bool = nextEventAdmitted(windowDays, 0, 43200, upcoming) implies windowDays == 30
```
