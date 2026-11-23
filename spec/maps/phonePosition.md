# Maps phone position for the turn

A phone that holds the location permission, with the owner's agent location
setting on, reports its last known position with every message it sends.
The agent reads that position for the message it came with only and stores
none of it. [Maps navigation](./navigation.md) owns the precise fix a route
from here is planned from, which the phone takes itself. The same position
answers where the owner is.

## Story: Search near me with where my phone is now

> As the owner, I want "coffee near me" answered around where my phone is,
> without being asked for my location when my phone already said it, and
> never with a position so old it no longer describes where I am.

### A position reported with the message serves a nearby search only while it is recent

The position is read from the message it came with. It serves a nearby
search when it was taken at most 30 minutes before the message was handled
and at most one minute ahead of the agent's clock, with a reported accuracy
no worse than 5 km when the phone reports one. Without such a position a
nearby search asks the phone for its own precise location, and never
searches around a guessed or remembered place.

```quint
import navigation as N from "./navigation"
type PhonePosition = { present: bool, age: int, hasAccuracy: bool, accuracy: int }
pure val nearbyMaxAge = 1800000
pure val nearbyMaxAhead = 60000
pure val nearbyMaxAccuracy = 5000
pure def nearbyPositionUsable(p: PhonePosition): bool =
  p.present and p.age >= 0 - nearbyMaxAhead and p.age <= nearbyMaxAge and
  (not(p.hasAccuracy) or (p.accuracy >= 0 and p.accuracy <= nearbyMaxAccuracy))
pure val pValues = Set({ present: true, age: 0, hasAccuracy: true, accuracy: 20 }, { present: true, age: 1800001, hasAccuracy: false, accuracy: 0 },
  { present: true, age: -60001, hasAccuracy: true, accuracy: 10 }, { present: true, age: 600000, hasAccuracy: true, accuracy: 5001 },
  { present: false, age: 0, hasAccuracy: false, accuracy: 0 })
pure def lawAbsentPositionNeverSearches(p: PhonePosition): bool = not(p.present) implies not(nearbyPositionUsable(p))
pure def lawStalePositionNeverSearches(p: PhonePosition): bool = p.age > nearbyMaxAge implies not(nearbyPositionUsable(p))
```

### A kind of place near a named place is searched around that place, never around the phone

"Pharmacy near the Ferry Building" names where to search: the named place
is looked up first, and the kind of place is searched around it, nearest
first, whether or not the phone reported a position and even when the
request also asked for places near the owner. A named place that is not
found, or not one place, is said or asked about before anything is
searched. Without a recent position, a request for places near the owner
asks the phone for its location and says that a place to search near can
be named instead, such as "pharmacy near the Ferry Building".

```quint
type SearchAround = AroundNamedPlace | AroundPhone | AskForPosition | AroundNothing
pure def searchAround(namedPlace: bool, nearMe: bool, p: PhonePosition): SearchAround =
  if (namedPlace) AroundNamedPlace
  else if (nearMe) (if (nearbyPositionUsable(p)) AroundPhone else AskForPosition)
  else AroundNothing
pure def lawANamedPlaceNeverAsksThePhone(nearMe: bool, p: PhonePosition): bool = searchAround(true, nearMe, p) == AroundNamedPlace
pure def lawNearMeWithoutAPositionAsks(p: PhonePosition): bool = not(nearbyPositionUsable(p)) implies searchAround(false, true, p) == AskForPosition
```

### A reported position never becomes a route origin

The reported position carries no precision, so it is never the precise fix
a route from here is planned from: the phone plans that route from its own
fresh fix, and the agent only names the destination.

```quint
pure def asRouteFix(p: PhonePosition): N::Fix = { present: p.present, precise: false, age: p.age, accuracy: p.accuracy }
pure def lawReportedPositionIsNeverARouteOrigin(p: PhonePosition): bool = not(N::usableFix(asRouteFix(p)))
```

## Story: Ask where I am

> As the owner, I want "where am I?" answered from where my phone says it
> is, and when my phone only knows roughly, to hear the area I am in and
> never the one building nearest a guess, so that I am not told I am
> somewhere I am not.

### Where I am is the place at my phone's recent position, and only its area when that position is rough

Asked where the owner is, Maps looks up the place at the position the
phone reported with the message, through Cloud Maps' reverse lookup, and
never guesses a street, neighbourhood or city from the coordinates. The
position answers only while it is recent, as for a nearby search, at any
reported accuracy; without one Maps says it cannot tell and looks nothing
up. A position reported as accurate to more than 1 km is a rough
estimate, such as a Wi-Fi or cell fix, whose nearest address is not where
the owner is: the reply names only the area of the address found there
(the address without its street part or any word with a digit, at most
its last three parts), says the position is approximate and how far, and
shows no place card. A precise position, or one with no reported
accuracy, names the place found there with its card. Nothing found, or no
area in what was found, is said as such.

```quint
type WhereAnswer = NoRecentPosition | NamePlace | NameArea | NothingThere
pure val roughPositionMeters = 1000
pure def positionRecent(p: PhonePosition): bool =
  p.present and p.age >= 0 - nearbyMaxAhead and p.age <= nearbyMaxAge
pure def roughPosition(p: PhonePosition): bool = p.hasAccuracy and p.accuracy > roughPositionMeters
pure def whereAnswer(p: PhonePosition, placeFound: bool, areaKnown: bool): WhereAnswer =
  if (not(positionRecent(p))) NoRecentPosition
  else if (roughPosition(p)) (if (areaKnown) NameArea else NothingThere)
  else if (placeFound) NamePlace else NothingThere
pure def lawARoughPositionNeverNamesAPlace(p: PhonePosition, placeFound: bool, areaKnown: bool): bool =
  roughPosition(p) implies whereAnswer(p, placeFound, areaKnown) != NamePlace
pure def lawAStalePositionAnswersNothing(p: PhonePosition, placeFound: bool, areaKnown: bool): bool =
  p.age > nearbyMaxAge implies whereAnswer(p, placeFound, areaKnown) == NoRecentPosition
pure def lawAPreciseRecentPositionNamesWhatIsThere(p: PhonePosition, areaKnown: bool): bool =
  (positionRecent(p) and not(roughPosition(p))) implies whereAnswer(p, true, areaKnown) == NamePlace
```
