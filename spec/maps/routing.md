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
"Get to" before a verb is a chance to do something, not a trip: "how do I
get to talk to someone" or "can I get to see my results" is no travel
request. See, hear and try still travel before a place ("get to see the
Eiffel Tower") and stop it only before a possessive or a person.
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

### A place named with its locality is taken only from that locality, and otherwise Maps asks which one

A typed place is looked up and taken when exactly one result fits it, or
when the search ran near a known point; several that fit are offered as a
numbered question, and no result is the plain not-found reply. A name
qualified by its locality ("Union Station, Washington, DC", "Union Station
in Washington") fits only a result whose name holds the name and whose
address holds the locality, or whose name or address holds the whole query.
When no result is in the named locality, Maps asks which one rather than
taking a namesake elsewhere, even when it found only one.

```quint
type PlacePick = TakePlace | AskWhich | NoPlace
pure def placePick(found: int, qualified: bool, matching: int, near: bool): PlacePick =
  if (found <= 0) NoPlace
  else if (qualified and matching <= 0) AskWhich
  else if (matching == 1 or near) TakePlace
  else AskWhich
pure val foundValues = Set(0, 1, 3)
pure val matchingValues = Set(0, 1, 2)
pure def lawANamesakeOutsideTheLocalityIsNeverTaken(found: int, near: bool): bool = placePick(found, true, 0, near) != TakePlace
pure def lawNothingFoundIsNeverTaken(qualified: bool, matching: int, near: bool): bool = placePick(0, qualified, matching, near) == NoPlace
pure def lawOneFittingResultIsTaken(found: int, qualified: bool, near: bool): bool = found > 0 implies placePick(found, qualified, 1, near) == TakePlace
```

### A route's destination that names no locality is taken from within 100 km of its start when any result is there

A route's destination is searched around its starting place: when it
names no locality, the results within 100 km of the start are the ones
that fit, if any are, so "Union Square" from the Ferry Building is the
one in San Francisco. That alone never takes a result: two that fit still
ask, as for any typed place.

```quint
pure val startAreaMeters = 100000
pure def aroundTheStart(meters: int): bool = meters >= 0 and meters <= startAreaMeters
pure def lawAFarNamesakeIsNotAroundTheStart(meters: int): bool = meters > startAreaMeters implies not(aroundTheStart(meters))
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

## Story: Ask for directions to the place on my phone's map

> As the owner, after "show me Coit Tower" I want "directions to it" to
> plan the route to Coit Tower, not fail on a Cloud error or ask me which
> place I mean again.

### A Maps screen selection asks the planner to name the place

A screen selection handle identifies an observation of the Maps screen:
`maps_` and a UUID, which the turn's device context carries as the
selected object's id. It is never a place Cloud knows. When it is offered
as a provider place ID, starting place ID or destination ID, Maps uses
what else the request gives for that place: its name or address,
coordinates, "near me" or "where am I" for a search, "from here" for a
route's start, or an already bound answer to an open Maps question. When
the handle is the only target, nothing is looked up or changed and the
planner receives a coaching request (`MAPS_SELECTION_HANDLE`) to name
the place from the conversation, asking the owner only when no place was
named; the owner hears nothing of it
([planning](../agent/conversation/planning.md)). The handle never reaches
the provider. A place shown on the phone's map is reported with its
provider, provider place id and name, so a later "directions to it" can
pass a real id.

```quint
type SelectionTarget = UsePlaceId | UsePlaceName | AskPlannerForPlace
pure def mapsSelectionTarget(hasHandle: bool, hasName: bool): SelectionTarget =
  if (not(hasHandle)) UsePlaceId
  else if (hasName) UsePlaceName
  else AskPlannerForPlace
pure def lawMapsHandleNeverServesAsPlaceId(hasName: bool): bool =
  mapsSelectionTarget(true, hasName) != UsePlaceId
pure def lawMapsHandleOnlyAsksForThePlace(hasName: bool): bool =
  (mapsSelectionTarget(true, hasName) == AskPlannerForPlace) == not(hasName)
```

### A place id Cloud refuses or no longer knows falls back to the place's name

A place id Cloud refuses (`400 invalid_request`, or a place outside its
coverage), or has no details for, does not end the request when the
request also names the place: Maps looks the place up by that name
instead. With no name it is the plain "which place" question for a place
id Cloud does not know, and Cloud's refusal for one it refused. Any other
failure, such as Cloud being unreachable, is reported as it is.

```quint
type DetailsAnswer = DetailsFound | DetailsUnknown | DetailsRefused | DetailsFailed
type PlaceCourse = UseTheDetails | SearchByName | AskWhichPlace | ReportTheFailure
pure def placeCourse(answer: DetailsAnswer, named: bool): PlaceCourse = match answer {
  | DetailsFound => UseTheDetails
  | DetailsUnknown => if (named) SearchByName else AskWhichPlace
  | DetailsRefused => if (named) SearchByName else ReportTheFailure
  | DetailsFailed => ReportTheFailure
}
pure def lawARefusedOrUnknownIdWithANameIsSearchedByName(answer: DetailsAnswer): bool =
  (answer == DetailsUnknown or answer == DetailsRefused) implies placeCourse(answer, true) == SearchByName
pure def lawAnyOtherFailureIsReported(named: bool): bool = placeCourse(DetailsFailed, named) == ReportTheFailure
```

### An answer Maps cannot use is said in the owner's words, naming the place a start could not look up

An answer from Cloud Maps that does not decode, including one too large
to keep, and Cloud's own `502 provider_invalid_response`, are said as
"Maps got an answer it couldn't use. Try again in a moment.", never in
transport or provider wording. When that happens while directions are
being started, the reply names the place: "Maps couldn't look up <place>
right now, so the route isn't planned. Try again in a moment." A place id
Cloud refused, with no name to fall back to, is "Cloud Maps could not use
this request."

```quint
type UnusableAnswerReply = UnusableAnswer | StartNotPlanned
pure def unusableAnswerReply(startingDirections: bool): UnusableAnswerReply =
  if (startingDirections) StartNotPlanned else UnusableAnswer
pure def lawOnlyAStartNamesThePlaceItCouldNotLookUp(startingDirections: bool): bool =
  (unusableAnswerReply(startingDirections) == StartNotPlanned) iff startingDirections
```

## Story: Share a place only once I agree, and hear where Maps works

> As the owner, I want "share this place" to send its location only after
> I say yes to sharing it, and "where does Maps work" answered from what
> my Maps service says it serves.

### A place's location is shared only after the owner's own later yes to sharing that place

Asked to share a place, Maps finds it as it finds a place to show, then
asks "Share the location of <place>?" with Share and Don't share choices,
and shares nothing. Only the owner's own later reply to that question,
for the same place and within five minutes, settles it: a yes returns a
geo link, an Apple Maps link and an OpenStreetMap link for the place with
the time it was shared; a no says it was not shared; anything unclear
asks again. The message that asked never answers its own question, and
no parameter the planner sets confirms it.

```quint
type ShareDecision = ShareAsked | ShareConfirmed | ShareCancelled
pure def sharesLocation(d: ShareDecision): bool = d == ShareConfirmed
pure def lawOnlyAConfirmedShareSendsTheLocation(d: ShareDecision): bool = sharesLocation(d) implies d == ShareConfirmed
```

### Asked where Maps works, the reply states only what Cloud Maps reports

The reply names the regions and dataset revision Cloud Maps reports, the
travel modes it routes and whether it offers alternatives, that it does
not look up places from coordinates when it says so, which of live
traffic, transit schedules and offline use it lacks, who receives search
text and route points, and its attribution. A deployment that serves no
maps says so, and nothing is inferred for what it does not report.

```quint
type CoverageAnswer = NoMapsServed | ReportedCoverage
pure def coverageAnswer(served: bool): CoverageAnswer = if (served) ReportedCoverage else NoMapsServed
```
