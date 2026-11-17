# Stated clock time

When a person writes a time in a message ("at 3pm", "noon", "9:30 to
11am", "18:45"), the agent, a calendar and a reminder must agree on which
clock time was meant, and must agree that a message naming two different
times names neither. This contract reads the hour, minute and meridiem a
mention states and decides whether the message names no time, exactly one
time or range, or several.

The text is modeled as the mentions found in it: each mention as the hour,
minute and meridiem it wrote, already read as a clock or as unreadable, and
at most one range such as "9 to 11am". "Noon" is read as 12:00 and
"midnight" as 0:00.

## Story: Read the time a message states

> As a person scheduling something by message, I want the time I wrote to
> be read as exactly that time, and an ambiguous message to be treated as
> ambiguous rather than guessed.

### A stated hour and minute become a clock time on the 24-hour dial

A minute must be 0 to 59. Without a meridiem the hour must be 0 to 23.
With "am" or "pm" the hour must be 1 to 12: 12am is 0:00, 12pm is 12:00,
and every other pm hour adds 12.

```quint
type Meridiem = NoMeridiem | AmMeridiem | PmMeridiem
type StatedClock = { hour: int, minute: int }
type ClockReading = { readable: bool, clock: StatedClock }
pure val unreadableClock: ClockReading = { readable: false, clock: { hour: 0, minute: 0 } }
pure def clockFromParts(hour: int, minute: int, meridiem: Meridiem): ClockReading =
  if (minute < 0 or minute > 59) unreadableClock
  else if (meridiem == NoMeridiem) (if (hour >= 0 and hour <= 23) { readable: true, clock: { hour: hour, minute: minute } } else unreadableClock)
  else if (hour < 1 or hour > 12) unreadableClock
  else { readable: true, clock: { hour: (hour % 12) + (if (meridiem == PmMeridiem) 12 else 0), minute: minute } }
pure val hourValues = Set(-1, 0, 1, 11, 12, 13, 23, 24)
pure val minuteValues = Set(-1, 0, 30, 59, 60)
pure def lawStatedClockIsOnTheDial(hour: int, minute: int, meridiem: Meridiem): bool = {
  val reading = clockFromParts(hour, minute, meridiem)
  reading.readable implies (reading.clock.hour >= 0 and reading.clock.hour <= 23 and reading.clock.minute >= 0 and reading.clock.minute <= 59)
}
pure def lawTwelveAmIsMidnight(minute: int): bool =
  (minute >= 0 and minute <= 59) implies clockFromParts(12, minute, AmMeridiem).clock.hour == 0
pure def lawTwelvePmIsNoon(minute: int): bool =
  (minute >= 0 and minute <= 59) implies clockFromParts(12, minute, PmMeridiem).clock.hour == 12
```

### A message names one time only when every mention reads as the same clock time

A range whose two ends both read is one time with an end, provided the
message mentions no other time. A message naming the same clock time twice
names one time. Any unreadable mention, an unreadable range end, two
different times, or a range beside another mention makes the message name
several times, and nothing is chosen from it.

```quint
type StatedTimesKind = NoStatedTime | OneStatedTime | SeveralStatedTimes
type StatedTimes = { statedKind: StatedTimesKind, opensAt: StatedClock, closesAt: StatedClock, ranged: bool }
type RangeReading = { present: bool, opening: ClockReading, closing: ClockReading }
pure val noClock: StatedClock = { hour: 0, minute: 0 }
pure val severalTimes: StatedTimes = { statedKind: SeveralStatedTimes, opensAt: noClock, closesAt: noClock, ranged: false }
pure def minuteOfDay(clock: StatedClock): int = clock.hour * 60 + clock.minute
pure def statedTimes(span: RangeReading, mentions: List[ClockReading]): StatedTimes = {
  val unreadable = mentions.foldl(false, (seen, m) => seen or not(m.readable))
  val distinct = mentions.foldl(Set(), (acc, m) => acc.union(Set(minuteOfDay(m.clock))))
  if (span.present)
    (if (not(span.opening.readable and span.closing.readable) or mentions.length() > 0) severalTimes
     else { statedKind: OneStatedTime, opensAt: span.opening.clock, closesAt: span.closing.clock, ranged: true })
  else if (unreadable) severalTimes
  else if (mentions.length() == 0) { statedKind: NoStatedTime, opensAt: noClock, closesAt: noClock, ranged: false }
  else if (distinct.size() > 1) severalTimes
  else { statedKind: OneStatedTime, opensAt: mentions.nthOr(0, unreadableClock).clock, closesAt: noClock, ranged: false }
}
pure val threePm: ClockReading = { readable: true, clock: { hour: 15, minute: 0 } }
pure val nineAm: ClockReading = { readable: true, clock: { hour: 9, minute: 0 } }
pure val noRange: RangeReading = { present: false, opening: unreadableClock, closing: unreadableClock }
pure val spanValues: Set[RangeReading] = Set(noRange).union(Set({ present: true, opening: nineAm, closing: threePm })).union(Set({ present: true, opening: nineAm, closing: unreadableClock }))
pure val mentionsValues: Set[List[ClockReading]] = Set(List()).union(Set(List(threePm))).union(Set(List(threePm, threePm))).union(Set(List(threePm, nineAm))).union(Set(List(unreadableClock)))
pure val readingValues: Set[ClockReading] = Set(threePm).union(Set(nineAm)).union(Set(unreadableClock))
pure def lawOneTimeOnlyWhenEveryMentionAgrees(span: RangeReading, mentions: List[ClockReading]): bool = {
  val result = statedTimes(span, mentions)
  (result.statedKind == OneStatedTime and not(span.present)) implies
    mentions.foldl(true, (ok, m) => ok and m.readable and minuteOfDay(m.clock) == minuteOfDay(result.opensAt))
}
pure def lawRangeIsOneTimeOnlyWhenBothEndsRead(span: RangeReading, mentions: List[ClockReading]): bool =
  (span.present and statedTimes(span, mentions).statedKind == OneStatedTime) implies
    (span.opening.readable and span.closing.readable and mentions.length() == 0 and statedTimes(span, mentions).ranged)
pure def lawRepeatedMentionIsOneTime(reading: ClockReading): bool =
  reading.readable implies statedTimes(noRange, List(reading, reading)).statedKind == OneStatedTime
pure def lawRangeWithAnotherMentionIsAmbiguous(span: RangeReading, reading: ClockReading): bool =
  span.present implies statedTimes(span, List(reading)).statedKind == SeveralStatedTimes
pure def lawUnreadableMentionIsAmbiguous(span: RangeReading, mentions: List[ClockReading]): bool =
  mentions.foldl(false, (seen, m) => seen or not(m.readable)) implies statedTimes(span, mentions).statedKind == SeveralStatedTimes
```
