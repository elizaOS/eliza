# Scanned event suggestions

A scanned poster or flyer can become a Calendar event draft. [Local
OCR](../localOcr.md) supplies the scan's text; this spec governs which
event fields that text suggests and which reviewed fields become a draft.
Nothing here reads an image, calls a service or writes a calendar: the
renderer shows every suggested field and every inference for review, and
Calendar's own review and Save remain the only write. The text is English.

## Story: Turn a scanned poster into a Calendar draft I review

> As the owner, I want a poster I scanned to suggest its event, with every
> guess shown to me, so that nothing I did not check reaches my calendar.

### A date is suggested only when every date printed agrees, and a year, weekday or relative day is inferred only from the device's clock and disclosed

A date is printed as `YYYY-MM-DD` or as an English month name and day with
or without a year (`October 10, 2026`, `10th Oct. 2026`). A numeric date
such as `10/11/2026` is unclear, since regions read it differently, and so
is a date that does not exist or falls outside 1970 through 2100. The
suggested date is the one every printed date names, and none when any is
unclear or two disagree. Without a reference instant a date with no year is
unclear. With the device's clock and zone (the reference instant), a date
with no year is its next occurrence from today, `today` and `tomorrow`
resolve against that day, a weekday alone is its next occurrence, a weekday
beside a date must be that date's weekday, and two different weekdays are
unclear. Each inference is listed among the suggestion's disclosures.

```quint
type DateFacts = { candidates: int, unclear: int, distinctDays: int }
pure def dateSuggested(facts: DateFacts): bool = facts.candidates > 0 and facts.unclear == 0 and facts.distinctDays == 1
pure val factsValues = Set(
  { candidates: 1, unclear: 0, distinctDays: 1 },
  { candidates: 2, unclear: 0, distinctDays: 1 },
  { candidates: 2, unclear: 0, distinctDays: 2 },
  { candidates: 2, unclear: 1, distinctDays: 1 },
  { candidates: 0, unclear: 0, distinctDays: 0 })
pure def lawAnUnclearDateSuggestsNoDate(facts: DateFacts): bool = facts.unclear > 0 implies not(dateSuggested(facts))
pure def lawDisagreeingDatesSuggestNoDate(facts: DateFacts): bool = facts.distinctDays > 1 implies not(dateSuggested(facts))
```

### A start time is suggested only when every time printed agrees, in the device's zone or in one explicit zone it converts from

A time is a 12-hour clock with AM or PM (`6:30 p.m.`) or a 24-hour clock
(`18:30`), alone or as a same-day range of 15 to 1,440 minutes, which also
suggests the duration; otherwise the duration is 60 minutes. A time is
suggested only when every printed time and range agree and the date, if one
is printed, is suggested. Without a reference instant any time zone
printed leaves the time blank. With one, a time zone abbreviation such as
`PST` or `ET` is ambiguous and two different explicit zones conflict, and
either leaves the time blank; one explicit IANA zone or UTC offset converts
the time and date into the device's zone, but only when the date is
suggested and the wall time exists exactly once in that zone, and the
conversion and its source zone are disclosed. With a reference instant, a
dated poster with no time printed is suggested as all-day.

```quint
type ZoneFacts = NoZonePrinted | OneZonePrinted | ZonesConflict | ZoneAmbiguous
pure def timeSuggested(withClock: bool, zone: ZoneFacts, consistent: bool, dateClear: bool, instantExists: bool): bool =
  consistent and (zone == NoZonePrinted or (withClock and zone == OneZonePrinted and dateClear and instantExists))
pure def allDaySuggested(withClock: bool, dateClear: bool, timePrinted: bool): bool = withClock and dateClear and not(timePrinted)
pure def lawAnAmbiguousZoneSuggestsNoTime(withClock: bool, consistent: bool, dateClear: bool, instantExists: bool): bool =
  not(timeSuggested(withClock, ZoneAmbiguous, consistent, dateClear, instantExists)) and not(timeSuggested(withClock, ZonesConflict, consistent, dateClear, instantExists))
pure def lawWithoutTheClockAZoneSuggestsNoTime(zone: ZoneFacts, consistent: bool, dateClear: bool, instantExists: bool): bool =
  zone != NoZonePrinted implies not(timeSuggested(false, zone, consistent, dateClear, instantExists))
pure def lawAConvertedTimeHasItsDate(zone: ZoneFacts, consistent: bool, instantExists: bool): bool =
  zone != NoZonePrinted implies not(timeSuggested(true, zone, consistent, false, instantExists))
pure def lawAPrintedTimeIsNeverAllDay(withClock: bool, dateClear: bool): bool = not(allDaySuggested(withClock, dateClear, true))
```

### A repeat is only a hint the owner turns on

With a reference instant, wording such as `every Tuesday`, `weekdays` or
`daily` suggests one repeat (daily, weekdays or weekly) with the words it
came from, off until the owner turns it on. Wording for any other repeat
(`every other week`, `monthly`) is disclosed as unsupported and suggests
none, and so does wording for two different repeats.

```quint
pure def repeatHinted(withClock: bool, repeatsFound: int, unsupported: bool): bool = withClock and repeatsFound == 1 and not(unsupported)
pure def lawConflictingRepeatsHintNone(withClock: bool, repeatsFound: int, unsupported: bool): bool =
  repeatsFound > 1 implies not(repeatHinted(withClock, repeatsFound, unsupported))
pure def lawAnUnsupportedRepeatHintsNone(withClock: bool, repeatsFound: int): bool = not(repeatHinted(withClock, repeatsFound, true))
```

### A draft holds only reviewed fields within their bounds, timed or all day as the owner reviewed it

A reviewed event keeps the exact reviewed text, at most 16,000 characters,
as its notes, a title of 1 to 200 characters that is not blank, a location
of at most 500, and the repeat the owner chose, none unless they chose one.
Its date is a real `YYYY-MM-DD` day from 1970 through 2100. A timed draft
also has a start `HH:MM` that exists on that day in the device's zone (not
skipped by a clock change) and a whole duration of 15 to 1,440 minutes; a
field marked all day never becomes a timed draft, and is saved as an
all-day event only through the all-day review. Each refusal names the first
bound broken, and the draft records the whole days from the review's own
day to its date.

```quint
type ScanEventReview = { notesUnits: int, titleBlank: bool, titleUnits: int, locationUnits: int, repeatSupported: bool, allDay: bool,
  datePattern: bool, yearInRange: bool, dayExists: bool, timePattern: bool, wholeMinutes: bool, minutes: int, localTimeExists: bool }
type ScanEventAnswer = ScanEventAccepted | NotesTooLong | TitleOrLocationOutOfBounds | RepeatUnsupported | TimedNeedsStart
  | DateMissing | DateAndTimeMissing | YearOutOfRange | DayMissing | DurationOutOfRange | LocalTimeSkipped
pure val scanEventNotesMaxUnits = 16000
pure def commonAnswer(review: ScanEventReview): ScanEventAnswer =
  if (review.notesUnits > scanEventNotesMaxUnits) NotesTooLong
  else if (review.titleBlank or review.titleUnits > 200 or review.locationUnits > 500) TitleOrLocationOutOfBounds
  else if (not(review.repeatSupported)) RepeatUnsupported
  else ScanEventAccepted
pure def civilAnswer(review: ScanEventReview): ScanEventAnswer =
  if (not(review.yearInRange)) YearOutOfRange else if (not(review.dayExists)) DayMissing else ScanEventAccepted
pure def allDayEventAnswer(review: ScanEventReview): ScanEventAnswer =
  if (commonAnswer(review) != ScanEventAccepted) commonAnswer(review)
  else if (not(review.datePattern)) DateMissing
  else civilAnswer(review)
pure def timedEventAnswer(review: ScanEventReview): ScanEventAnswer =
  if (commonAnswer(review) != ScanEventAccepted) commonAnswer(review)
  else if (review.allDay) TimedNeedsStart
  else if (not(review.datePattern and review.timePattern)) DateAndTimeMissing
  else if (civilAnswer(review) != ScanEventAccepted) civilAnswer(review)
  else if (not(review.wholeMinutes) or review.minutes < 15 or review.minutes > 1440) DurationOutOfRange
  else if (not(review.localTimeExists)) LocalTimeSkipped
  else ScanEventAccepted
pure val reviewValues = Set(
  { notesUnits: 20, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: true, dayExists: true, timePattern: true, wholeMinutes: true, minutes: 90, localTimeExists: true },
  { notesUnits: 16001, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: true, dayExists: true, timePattern: true, wholeMinutes: true, minutes: 90, localTimeExists: true },
  { notesUnits: 20, titleBlank: true, titleUnits: 0, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: true, dayExists: true, timePattern: true, wholeMinutes: true, minutes: 90, localTimeExists: true },
  { notesUnits: 20, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: true,
    datePattern: true, yearInRange: true, dayExists: true, timePattern: false, wholeMinutes: true, minutes: 60, localTimeExists: true },
  { notesUnits: 20, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: false, dayExists: true, timePattern: true, wholeMinutes: true, minutes: 60, localTimeExists: true },
  { notesUnits: 20, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: true, dayExists: false, timePattern: true, wholeMinutes: true, minutes: 60, localTimeExists: true },
  { notesUnits: 20, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: true, dayExists: true, timePattern: true, wholeMinutes: false, minutes: 15, localTimeExists: true },
  { notesUnits: 20, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: true, dayExists: true, timePattern: true, wholeMinutes: true, minutes: 1441, localTimeExists: true },
  { notesUnits: 20, titleBlank: false, titleUnits: 5, locationUnits: 4, repeatSupported: true, allDay: false,
    datePattern: true, yearInRange: true, dayExists: true, timePattern: true, wholeMinutes: true, minutes: 60, localTimeExists: false })
pure def lawATimedDraftHasAStartThatExistsAndABoundedDuration(review: ScanEventReview): bool =
  timedEventAnswer(review) == ScanEventAccepted implies
    (not(review.allDay) and review.timePattern and review.dayExists and review.localTimeExists and review.wholeMinutes and review.minutes >= 15 and review.minutes <= 1440)
pure def lawAnAllDayFieldNeverBecomesATimedDraft(review: ScanEventReview): bool = review.allDay implies timedEventAnswer(review) != ScanEventAccepted
pure def lawEveryDraftKeepsItsBounds(review: ScanEventReview): bool =
  (timedEventAnswer(review) == ScanEventAccepted or allDayEventAnswer(review) == ScanEventAccepted) implies
    (review.notesUnits <= scanEventNotesMaxUnits and not(review.titleBlank) and review.titleUnits <= 200 and review.locationUnits <= 500 and review.dayExists and review.yearInRange)
```
