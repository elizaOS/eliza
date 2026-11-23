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

## Story: Use the place I already named when following up on my map

> As the owner, I want directions to the place we just discussed without
> having to name it again because the phone supplied a selection handle.

### A phone selection handle cannot become a provider place identifier

A phone observation's `maps_<uuid>` value identifies a selection inside
that phone. It is never sent for Cloud place details. If the action already
has a place name or address, it uses that text. Otherwise, the action
returns a correction to the planner with the applicable name field and
makes no Cloud lookup or device change. The planner can use the name from
the conversation before asking the owner. A real provider identifier still
uses the details lookup before asking for position for a nearby search.
When Cloud explicitly refuses the place ID as invalid, or reports that
it found no such place, the action can search by the provided name.
Provider faults and other service refusals remain visible. A request
with no identifier or name can ask for a place in the ordinary way.
After the phone confirms selection, the result includes the provider,
canonical place ID, and name so a later tool can refer to the place.

```quint
type PlaceIdentifier = PhoneSelection | ProviderPlace | NoPlaceIdentifier
type PlaceResolution = FromProviderId | FromPlaceName | AskPlannerForPlace | AskOwnerForPlace
pure def placeResolution(identifier: PlaceIdentifier, named: bool): PlaceResolution =
  if (identifier == ProviderPlace) FromProviderId
  else if (named) FromPlaceName
  else if (identifier == PhoneSelection) AskPlannerForPlace
  else AskOwnerForPlace
pure def lawSelectionNeverResolvesByProviderId(named: bool): bool =
  placeResolution(PhoneSelection, named) != FromProviderId
pure def lawSelectionAsksPlannerOnlyWithoutAName(named: bool): bool =
  placeResolution(PhoneSelection, named) == (if (named) FromPlaceName else AskPlannerForPlace)
```
