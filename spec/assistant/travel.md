# Owner travel

The owner tells the assistant in conversation that they are away: "I'm
traveling until November 21st", "I'm on vacation through 2026-12-03", "I'm
out of the office". The assistant keeps a trip from the instant of that
message to the return the owner named, or for thirty days when it reads no
return. "I'm back", "back home" or "I'm in the office" ends the trip.
While a tick falls within the trip the owner is travelling
([time zone](./timezone.md)); a trip told in conversation names no
destination zone, so the owner's clock stays on the zone they stated.

After each owner message a model reads whether the owner says they
themselves are away now, are back, or neither: someone else's trip, a trip
only planned and a question are neither, and the words are never matched
against a pattern. With "away" it writes the return the owner named as a
day, `YYYY-MM-DD`, or `MM-DD` when they named a month and day without a
year, counting a weekday or relative day from today on the owner's clock;
an output with any other signal is refused. A return is a calendar day on
the owner's clock, and the trip ends at that day's local midnight. Each
day is passed to the rules below as a number that orders days, with
today's day, and the midnight instant of the stated day this year and of
the same day next year. A date the calendar does not have, such as
November 31st, is not a real day, and a return written in neither form is
a return the shell cannot read.

## Story: Keep my trip to the day I said I am back

> As an owner, when I say I'm traveling until a day, I want the assistant
> to treat me as away until that day, and never for a month because it
> misread the day I named.

### A return ends the trip, a trip starts at the message, and anything else leaves the trip as it was

```quint
type TravelSignal = SaysBack | SaysAway | SaysNothing
type TravelWindow = { startAt: int, endAt: int }
pure val noTrip: TravelWindow = { startAt: 0, endAt: 0 }
pure def travellingAt(w: TravelWindow, at: int): bool = w.startAt <= at and at < w.endAt
pure def travelAfter(signal: TravelSignal, before: TravelWindow, now: int, endAt: int): TravelWindow = match signal {
  | SaysBack => noTrip
  | SaysAway => { startAt: now, endAt: endAt }
  | SaysNothing => before
}
pure val beforeValues: Set[TravelWindow] = List(noTrip, { startAt: 1, endAt: 5 }, { startAt: 2, endAt: 3 }).foldl(Set(), (acc, w) => acc.union(Set(w)))
pure def lawAReturnEndsTheTrip(before: TravelWindow, now: int, endAt: int, at: int): bool =
  not(travellingAt(travelAfter(SaysBack, before, now, endAt), at))
pure def lawATripStartsAtTheMessage(before: TravelWindow, now: int, endAt: int): bool =
  travelAfter(SaysAway, before, now, endAt) == { startAt: now, endAt: endAt }
pure def lawAnotherMessageKeepsTheTrip(before: TravelWindow, now: int, endAt: int): bool =
  travelAfter(SaysNothing, before, now, endAt) == before
```

### The return is the stated day, or the same day next year when no year was named and the day has passed

A day passes only once the calendar moves past it: a return named for
today is kept even though its midnight is earlier than now, so "until
November 14th" said on the afternoon of November 14 ends the trip at once
instead of keeping it for thirty days. A named year is never moved.

```quint
type StatedReturn = { named: bool, real: bool, yearGiven: bool, day: int, at: int, nextReal: bool, nextDay: int, nextAt: int }
pure def returnDayKept(r: StatedReturn, today: int): bool =
  r.named and r.real and (r.day >= today or (not(r.yearGiven) and r.nextReal and r.nextDay >= today))
pure def statedReturnAt(r: StatedReturn, today: int): int = if (r.day >= today) r.at else r.nextAt
```

### A trip ends at the return within thirty days, and otherwise thirty days after the message

A trip told without a return, with a return the shell cannot read, with a
day the calendar does not have, or with a return more than thirty days
away, ends thirty days after the message; an "I'm back" or a later
statement ends it sooner.

```quint
pure val travelHorizonMs = 2592000000
pure def tripEndAt(r: StatedReturn, today: int, now: int): int =
  if (returnDayKept(r, today) and statedReturnAt(r, today) - now <= travelHorizonMs) statedReturnAt(r, today) else now + travelHorizonMs
pure val noReturn: StatedReturn = { named: false, real: false, yearGiven: false, day: 0, at: 0, nextReal: false, nextDay: 0, nextAt: 0 }
pure val rValues: Set[StatedReturn] = List(
  noReturn, { ...noReturn, named: true }, { ...noReturn, named: true, real: true, day: 3, at: 3, nextReal: true, nextDay: 9, nextAt: 9 },
  { ...noReturn, named: true, real: true, day: 1, at: 1, nextReal: true, nextDay: 9, nextAt: 9 },
  { ...noReturn, named: true, real: true, yearGiven: true, day: 1, at: 1 }, { ...noReturn, named: true, real: true, day: 2, at: 2 }
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure def lawATripNeverOutlastsThirtyDays(r: StatedReturn, today: int, now: int): bool = tripEndAt(r, today, now) <= now + travelHorizonMs
pure def lawAnUnreadReturnKeepsThirtyDays(r: StatedReturn, today: int, now: int): bool =
  not(returnDayKept(r, today)) implies tripEndAt(r, today, now) == now + travelHorizonMs
pure def lawAReturnNamedForTodayIsKept(r: StatedReturn, today: int, now: int): bool =
  (r.named and r.real and r.day == today and r.at <= now) implies tripEndAt(r, today, now) == r.at
pure def lawAReturnNamedForTodayIsNotTravel(r: StatedReturn, today: int, now: int): bool =
  (r.named and r.real and r.day == today and r.at <= now) implies not(travellingAt({ startAt: now, endAt: tripEndAt(r, today, now) }, now))
pure def lawAPassedDayWithItsYearIsNotKept(r: StatedReturn, today: int, now: int): bool =
  (r.yearGiven and r.day < today) implies tripEndAt(r, today, now) == now + travelHorizonMs
```
