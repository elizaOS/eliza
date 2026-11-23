# Maps turn routing

A short owner request that is plainly Maps work goes straight to the Maps
action that answers it, instead of a view switch or a small-talk reply. The
shell reads the request's shape from its words; this spec decides what each
shape is routed to. Anything uncertain keeps the planner's own choice.
[Maps navigation](./navigation.md) owns what those actions may do.

## Story: Send my directions request to Maps, not to a view

> As the owner, I want "directions to Coit Tower" to plan a route and "take
> me to settings" to open Settings, and "the second one" to answer the
> question Maps just asked me.

### A plain Maps request of the owner's own chat turn goes to the Maps action for its shape

Only the owner's own direct chat or voice turn is routed. A request with
further work or a condition in it ("then text Sam", "if it's open"), one
that names a web address, or one whose destination is part of an app or a
document is never routed. Directions between places, and directions to a
place, go to route planning or navigation from here; a place to show on the
map goes to showing or finding it; travelling to a destination, or going to
a named place or street address, goes to navigation from here unless the
destination names one of the agent's views; a nearby or nearest kind of
place, and a kind of place near a named place, go to place search.
Weather, traffic, news or a forecast near a place, and things kept on the
phone such as photos, messages or notes, are not a kind of place; a time,
a holiday, a price or the owner's own place after "near" is not a named
place. Those requests keep the planner's own choice.

```quint
type RequestShape = DirectionsRequest | PlaceOnMap | TravelTo | GoToNamedPlace | NearbyKind | KindNearNamedPlace | ChoiceReply | OtherRequest
type RoutedTo = ToDirections | ToShowPlace | ToTravel | ToPlaceSearch | ToChoice | ToPlanner
type MapsRequest = { ownerTurn: bool, shape: RequestShape, compound: bool, webAddress: bool, appDestination: bool, namesView: bool }
pure def mapsRouteOf(r: MapsRequest): RoutedTo =
  if (not(r.ownerTurn) or r.compound or r.webAddress or r.appDestination) ToPlanner
  else if (r.shape == DirectionsRequest) ToDirections
  else if (r.shape == PlaceOnMap) ToShowPlace
  else if (r.shape == TravelTo or r.shape == GoToNamedPlace) (if (r.namesView) ToPlanner else ToTravel)
  else if (r.shape == NearbyKind or r.shape == KindNearNamedPlace) ToPlaceSearch
  else if (r.shape == ChoiceReply) ToChoice
  else ToPlanner
pure val plainMapsRequest: MapsRequest = { ownerTurn: true, shape: DirectionsRequest, compound: false, webAddress: false, appDestination: false, namesView: false }
pure val rValues = Set(plainMapsRequest, { ...plainMapsRequest, ownerTurn: false }, { ...plainMapsRequest, compound: true },
  { ...plainMapsRequest, webAddress: true }, { ...plainMapsRequest, appDestination: true }, { ...plainMapsRequest, shape: PlaceOnMap },
  { ...plainMapsRequest, shape: TravelTo }, { ...plainMapsRequest, shape: TravelTo, namesView: true },
  { ...plainMapsRequest, shape: GoToNamedPlace, namesView: true }, { ...plainMapsRequest, shape: KindNearNamedPlace },
  { ...plainMapsRequest, shape: ChoiceReply }, { ...plainMapsRequest, shape: OtherRequest },
  { ...plainMapsRequest, shape: OtherRequest, ownerTurn: false, namesView: true })
pure def lawOnlyTheOwnersTurnIsRouted(r: MapsRequest): bool = not(r.ownerTurn) implies mapsRouteOf(r) == ToPlanner
pure def lawAViewDestinationStaysViewNavigation(r: MapsRequest): bool =
  (r.namesView and (r.shape == TravelTo or r.shape == GoToNamedPlace)) implies mapsRouteOf(r) != ToTravel
pure def lawCompoundRequestKeepsThePlanner(r: MapsRequest): bool = (r.compound or r.webAddress or r.appDestination) implies mapsRouteOf(r) == ToPlanner
pure def lawOtherRequestKeepsThePlanner(r: MapsRequest): bool = r.shape == OtherRequest implies mapsRouteOf(r) == ToPlanner
```

### A choice reply answers only the open question of the same conversation, within its options and ten minutes

When Maps asks "which one did you mean?", the question stays open in that
conversation for ten minutes. A reply that names a position ("the second
one", "2", "the last one") answers it only while it is open, in the same
conversation, and for a position among the options offered; it continues
the operation that asked. Any other turn leaves the question to the planner.

```quint
pure val choiceLifetime = 600000
type ChoiceAnswer = { open: bool, sameConversation: bool, age: int, position: int, options: int }
pure def choiceBinds(a: ChoiceAnswer): bool =
  a.open and a.sameConversation and a.age >= 0 and a.age <= choiceLifetime and a.position >= 1 and a.position <= a.options
pure val aValues = Set({ open: true, sameConversation: true, age: 0, position: 2, options: 3 }, { open: true, sameConversation: false, age: 0, position: 1, options: 3 },
  { open: true, sameConversation: true, age: 600001, position: 1, options: 3 }, { open: true, sameConversation: true, age: 10, position: 4, options: 3 },
  { open: false, sameConversation: true, age: 10, position: 1, options: 3 })
pure def lawExpiredChoiceNeverBinds(a: ChoiceAnswer): bool = a.age > choiceLifetime implies not(choiceBinds(a))
pure def lawChoiceStaysInItsConversation(a: ChoiceAnswer): bool = not(a.sameConversation) implies not(choiceBinds(a))
pure def lawPositionIsAmongTheOptions(a: ChoiceAnswer): bool = choiceBinds(a) implies a.position <= a.options
```

### Same-named areas close together are one place, and same-named street addresses still ask

When a place search for a route, a saved place or navigation finds several
places with exactly the name asked for, Maps asks which one was meant. Two
such places count as one landmark, and the first is used without asking,
when neither is at a street address and they are within 5 km of each
other: a park and the neighbourhood named after it. Branches of a chain at
street addresses, and same-named areas farther apart, still ask.

```quint
pure val landmarkAreaMeters = 5000
pure def sameLandmark(firstIsArea: bool, otherIsArea: bool, meters: int): bool =
  firstIsArea and otherIsArea and meters >= 0 and meters <= landmarkAreaMeters
pure val metersValues = Set(0, 1400, 5000, 5001, 20000)
pure def lawStreetAddressStillAsks(otherIsArea: bool, meters: int): bool =
  not(sameLandmark(false, otherIsArea, meters)) and not(sameLandmark(otherIsArea, false, meters))
pure def lawFarAreasStillAsk(meters: int): bool = meters > landmarkAreaMeters implies not(sameLandmark(true, true, meters))
pure def lawCloseAreasAreOneLandmark(meters: int): bool = (meters >= 0 and meters <= landmarkAreaMeters) implies sameLandmark(true, true, meters)
```
