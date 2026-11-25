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

The position is read from the message it came with, where the turn keeps
the screen observation that carries it. It serves a nearby search when it
was taken at most 30 minutes before the message was handled and at most
one minute ahead of the agent's clock, at any reported accuracy: a Wi-Fi
or cell estimate kilometres wide is still searched around. Without such a
position a nearby search asks the phone for its own precise location, and
never searches around a guessed or remembered place.

```quint
import navigation as N from "./navigation"
type PhonePosition = { present: bool, age: int, hasAccuracy: bool, accuracy: int }
pure val nearbyMaxAge = 1800000
pure val nearbyMaxAhead = 60000
pure def nearbyPositionUsable(p: PhonePosition): bool =
  p.present and p.age >= 0 - nearbyMaxAhead and p.age <= nearbyMaxAge
pure val pValues = Set({ present: true, age: 0, hasAccuracy: true, accuracy: 20 }, { present: true, age: 1800001, hasAccuracy: false, accuracy: 0 },
  { present: true, age: -60001, hasAccuracy: true, accuracy: 10 }, { present: true, age: 600000, hasAccuracy: true, accuracy: 5001 },
  { present: false, age: 0, hasAccuracy: false, accuracy: 0 })
pure def lawAbsentPositionNeverSearches(p: PhonePosition): bool = not(p.present) implies not(nearbyPositionUsable(p))
pure def lawStalePositionNeverSearches(p: PhonePosition): bool = p.age > nearbyMaxAge implies not(nearbyPositionUsable(p))
pure def lawAnyAccuracyOfARecentPositionSearches(p: PhonePosition, accuracy: int): bool =
  nearbyPositionUsable(p) implies nearbyPositionUsable({ ...p, hasAccuracy: true, accuracy: accuracy })
```

### A kind of place near a named place is searched around that place, never around the phone

"Pharmacy near the Ferry Building" names where to search: the planner
passes the kind of place and the place to search near, the named place is
looked up first, and the kind of place is searched around it, nearest
first, whether or not the phone reported a position and even when the
request also asked for places near the owner. Which words name that place
is the model's reading, not a phrase list: the owner's own position
("coffee near me right now") names no place, and is a search near the
owner, around the phone. "The nearest pharmacy to the Ferry Building"
names its own point and is no request near the owner; only "the nearest
pharmacy to me" is. A named place that is not found is said, with a
request to name another place or area to search near; one with several
matches is asked about as a numbered question that the owner's next turn
answers. The results begin "Near" the place, and their card shows the
place they are near. Without a recent position, a request for places
near the owner asks the phone for its location and says that a place to
search near can be named instead, such as "pharmacy near the Ferry
Building".

```quint
type SearchAround = AroundNamedPlace | AroundPhone | AskForPosition | AroundNothing
pure def searchAround(namedPlace: bool, nearMe: bool, p: PhonePosition): SearchAround =
  if (namedPlace) AroundNamedPlace
  else if (nearMe) (if (nearbyPositionUsable(p)) AroundPhone else AskForPosition)
  else AroundNothing
pure def lawANamedPlaceNeverAsksThePhone(nearMe: bool, p: PhonePosition): bool = searchAround(true, nearMe, p) == AroundNamedPlace
pure def lawNearMeWithoutAPositionAsks(p: PhonePosition): bool = not(nearbyPositionUsable(p)) implies searchAround(false, true, p) == AskForPosition
```

### A search around a point asks Cloud for the closest places whenever Cloud ranks by distance

A place search around the phone's position, a named place or coordinates
the owner names is a request for what is nearest, so it asks Cloud Maps
for the closest places it finds around that point (`rank: "distance"`),
not the closest of the few it ranks most relevant. Cloud's capabilities,
read for that search, decide: a Cloud whose capabilities do not report
`distanceRank` is asked without the rank, because it refuses a field it
does not know. Looking a place up by its name, such as a route's start or
destination or the place a search is around, asks for the most relevant.
Either way the places found are listed nearest the point first.

```quint
pure def asksForClosest(aroundPoint: bool, cloudRanksByDistance: bool): bool = aroundPoint and cloudRanksByDistance
pure def lawOnlyAPointSearchOnACloudThatRanksAsksForTheClosest(aroundPoint: bool, cloudRanksByDistance: bool): bool =
  asksForClosest(aroundPoint, cloudRanksByDistance) implies (aroundPoint and cloudRanksByDistance)
```

### A reported position never becomes a route origin

The reported position carries no precision, so it is never the precise fix
a route from here is planned from: the phone plans that route from its own
fresh fix, and the agent only names the destination. A route asked for
from where the owner is, which the planner asks for by leaving the start
out or by naming the owner's own position as the start, answers with a
card that asks the phone for its location and carries the destination
found; a destination the planner names as the nearest or a nearby kind of
place, or one with several matches, goes to the phone as the words asked,
for the phone to search around itself.

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
position answers only while it is recent, as for a nearby search; without
one Maps says it cannot tell and looks nothing up. A position reported as accurate to more than 1 km is a rough
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
pure def roughPosition(p: PhonePosition): bool = p.hasAccuracy and p.accuracy > roughPositionMeters
pure def whereAnswer(p: PhonePosition, placeFound: bool, areaKnown: bool): WhereAnswer =
  if (not(nearbyPositionUsable(p))) NoRecentPosition
  else if (roughPosition(p)) (if (areaKnown) NameArea else NothingThere)
  else if (placeFound) NamePlace else NothingThere
pure def lawARoughPositionNeverNamesAPlace(p: PhonePosition, placeFound: bool, areaKnown: bool): bool =
  roughPosition(p) implies whereAnswer(p, placeFound, areaKnown) != NamePlace
pure def lawAStalePositionAnswersNothing(p: PhonePosition, placeFound: bool, areaKnown: bool): bool =
  p.age > nearbyMaxAge implies whereAnswer(p, placeFound, areaKnown) == NoRecentPosition
pure def lawAPreciseRecentPositionNamesWhatIsThere(p: PhonePosition, areaKnown: bool): bool =
  (nearbyPositionUsable(p) and not(roughPosition(p))) implies whereAnswer(p, true, areaKnown) == NamePlace
```

### Coordinates the owner names are looked up or searched around as given, never the phone's position

Given coordinates and no place, Maps looks up the place at that point
through Cloud Maps' reverse lookup and names it with its card, or says
that no named place is known there. Given a kind of place or a name with
them, it searches around that point, nearest first. Named coordinates are
a place to search near: the phone is never asked for its position, and
the position it reported plays no part. When the planner cannot look a
reported position up, it gives the coordinates as they are rather than a
guessed street.

```quint
type PointRequest = PlaceAtPoint | SearchAroundPoint
pure def pointRequest(searchedFor: bool): PointRequest = if (searchedFor) SearchAroundPoint else PlaceAtPoint
pure def lawNamedCoordinatesNeverAskThePhone(nearMe: bool, p: PhonePosition): bool = searchAround(true, nearMe, p) != AskForPosition
```
