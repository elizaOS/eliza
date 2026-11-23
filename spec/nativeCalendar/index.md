# Native calendar

Apple EventKit grants full or write-only access. Android's host-configured CalendarProvider follows the [Android calendar contract](../os/android/calendar.md), including its reviewed writes and readback.

## Story: View and write the device calendar within the access I granted

> As the owner, I want both platform adapters to preserve which calendars are readable, which edits are valid, and which writes the device confirmed.

### Write-only access permits creation without revealing existing events

The bridge distinguishes check and request permissions, calendar and bounded-event listing, create, update and delete. The shell decodes provider receipts, and calendars and events use identifiers supplied by that same provider.

```quint
type CalendarGrant = CalendarFull | CalendarWriteOnly | CalendarDenied | CalendarUnavailable
type CalendarOperation = ListNativeCalendars | ListNativeEvents | CreateCalendarEvent | UpdateCalendarEvent | DeleteCalendarEvent
type CalendarRange = { startsAt: int, endsAt: int }
pure def mayUseNativeCalendar(grant: CalendarGrant, op: CalendarOperation): bool =
  grant == CalendarFull or (grant == CalendarWriteOnly and op == CreateCalendarEvent)
pure def validCalendarRange(interval: CalendarRange): bool = interval.startsAt < interval.endsAt
pure def canSubmitCalendarDraft(grant: CalendarGrant, calendarWritable: bool, eventTitle: str, interval: CalendarRange): bool =
  mayUseNativeCalendar(grant, CreateCalendarEvent) and calendarWritable and eventTitle != "" and validCalendarRange(interval)
pure def lawWriteOnlyMayOnlyCreate(op: CalendarOperation): bool =
  mayUseNativeCalendar(CalendarWriteOnly, op) == (op == CreateCalendarEvent)
pure def lawInvertedRangeNeverSubmits(grant: CalendarGrant, calendarWritable: bool, eventTitle: str, interval: CalendarRange): bool =
  interval.endsAt <= interval.startsAt implies not(canSubmitCalendarDraft(grant, calendarWritable, eventTitle, interval))
pure val intervalValues = Set(
  { startsAt: 1800000, endsAt: 3600000 },
  { startsAt: 3600000, endsAt: 3600000 },
  { startsAt: 3600000, endsAt: 1800000 })
pure val eventTitleValues = Set("", "School pickup")
```
