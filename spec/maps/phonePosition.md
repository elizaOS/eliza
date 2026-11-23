# Maps phone position for the turn

A phone that holds the location permission, with the owner's agent location
setting on, reports its last known position with every message it sends.
The agent reads that position for the message it came with only and stores
none of it. [Maps navigation](./navigation.md) owns the precise fix a route
from here is planned from, which the phone takes itself.

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

### A reported position never becomes a route origin

The reported position carries no precision, so it is never the precise fix
a route from here is planned from: the phone plans that route from its own
fresh fix, and the agent only names the destination.

```quint
pure def asRouteFix(p: PhonePosition): N::Fix = { present: p.present, precise: false, age: p.age, accuracy: p.accuracy }
pure def lawReportedPositionIsNeverARouteOrigin(p: PhonePosition): bool = not(N::usableFix(asRouteFix(p)))
```
