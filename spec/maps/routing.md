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
place. Those requests keep the planner's own choice. A routed request
owns the whole message: while every Maps action it is routed to is
offered this turn, a call of the view actions `VIEWS` and `VIEWS_SHOW` is
refused before it runs ([planning](../agent/conversation/planning.md)),
so the request is never answered by only opening the Maps view.

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
pure def ownsWholeRequest(routed: RoutedTo): bool = routed != ToPlanner
pure def lawARequestLeftToThePlannerRefusesNoView(r: MapsRequest): bool =
  (not(r.ownerTurn) or r.shape == OtherRequest) implies not(ownsWholeRequest(mapsRouteOf(r)))
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

### Only the owner's next turn answers an open question, by its position or the place's name, within ten minutes

When Maps asks "which one did you mean?", the question is open for the
owner who was asked, in that conversation, and only their next turn can
answer it. A turn after that closes it, as do ten minutes, so "the second
one" said later about another list is never taken as this answer. The
next turn answers by a position among the options offered ("the second
one", "2", "the last one"), or by naming exactly one option: its name
with its address as listed, or its name alone when no other option
shares it. The answer continues the operation that asked. Any other
reply leaves the question to the planner.

```quint
pure val choiceLifetime = 600000
type ChoiceTurn = AskingTurn | NextOwnerTurn | LaterTurn
type ChoiceAnswer = { open: bool, sameConversation: bool, turn: ChoiceTurn, age: int, position: int, options: int }
pure def choiceOpenAt(turn: ChoiceTurn, age: int): bool = turn != LaterTurn and age >= 0 and age <= choiceLifetime
pure def choiceBinds(a: ChoiceAnswer): bool =
  a.open and a.sameConversation and a.turn == NextOwnerTurn and choiceOpenAt(a.turn, a.age) and a.position >= 1 and a.position <= a.options
type NamedOption = ByListedLabel | ByNameAlone | NoOptionNamed
pure def namedOption(labelMatches: int, nameMatches: int): NamedOption =
  if (labelMatches == 1) ByListedLabel else if (nameMatches == 1) ByNameAlone else NoOptionNamed
pure val aValues = Set({ open: true, sameConversation: true, turn: NextOwnerTurn, age: 0, position: 2, options: 3 },
  { open: true, sameConversation: false, turn: NextOwnerTurn, age: 0, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: NextOwnerTurn, age: 600001, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: NextOwnerTurn, age: 10, position: 4, options: 3 },
  { open: false, sameConversation: true, turn: NextOwnerTurn, age: 10, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: LaterTurn, age: 10, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: AskingTurn, age: 10, position: 1, options: 3 })
pure val labelMatchesValues = Set(0, 1, 2)
pure val nameMatchesValues = Set(0, 1, 2)
pure def lawExpiredChoiceNeverBinds(a: ChoiceAnswer): bool = a.age > choiceLifetime implies not(choiceBinds(a))
pure def lawChoiceStaysInItsConversation(a: ChoiceAnswer): bool = not(a.sameConversation) implies not(choiceBinds(a))
pure def lawPositionIsAmongTheOptions(a: ChoiceAnswer): bool = choiceBinds(a) implies a.position <= a.options
pure def lawOnlyTheNextTurnAnswers(a: ChoiceAnswer): bool = a.turn != NextOwnerTurn implies not(choiceBinds(a))
pure def lawALaterTurnClosesTheQuestion(age: int): bool = not(choiceOpenAt(LaterTurn, age))
pure def lawOptionsSharingANameAreNotNamedByIt(labelMatches: int, nameMatches: int): bool =
  (labelMatches != 1 and nameMatches != 1) implies namedOption(labelMatches, nameMatches) == NoOptionNamed
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

### A first result named as asked is taken when the others are parts of it or mostly around it

Cloud Maps returns places in its own order of relevance, with no score.
Among the results that fit, the first is the place meant, and is used
without asking, when its name holds the name asked for and either every
other result is within 300 m of it (a building, its marketplace and its
farmers market are one site), or all of these hold. No other result of
the same name stands between 300 m and 50 km from it, other than a
same-named area of one landmark (above): that is a branch of a chain,
such as another Starbucks. It is named exactly as asked, or no other
result whose name holds the name asked for stands more than 1 km away,
so "Blue Bottle Coffee" is not what "coffee" means while another coffee
place stands elsewhere. And more than half of the results, the first
among them, are within 25 km of it, so far-away namesakes are the
minority. Otherwise Maps asks which one.

```quint
pure val sameSiteMeters = 300
pure val sameComplexMeters = 1000
pure val branchAreaMeters = 50000
pure val firstAreaMeters = 25000
type FirstResult = { namedAsAsked: bool, exactName: bool, others: int, othersAtItsSite: int, nearbyBranches: int, namesakesElsewhere: int, othersAround: int }
pure def atTheSameSite(meters: int): bool = meters >= 0 and meters <= sameSiteMeters
pure def nearbyBranch(sameName: bool, firstIsArea: bool, otherIsArea: bool, meters: int): bool =
  sameName and meters > sameSiteMeters and meters <= branchAreaMeters and not(sameLandmark(firstIsArea, otherIsArea, meters))
pure def namesakeElsewhere(namedAsAsked: bool, meters: int): bool = namedAsAsked and meters > sameComplexMeters
pure def aroundTheFirst(meters: int): bool = meters >= 0 and meters <= firstAreaMeters
pure def firstResultMeant(f: FirstResult): bool =
  f.namedAsAsked and (f.othersAtItsSite >= f.others
    or (f.nearbyBranches == 0 and (f.exactName or f.namesakesElsewhere == 0) and (f.othersAround + 1) * 2 > f.others + 1))
pure val fValues = Set({ namedAsAsked: true, exactName: true, others: 2, othersAtItsSite: 2, nearbyBranches: 0, namesakesElsewhere: 0, othersAround: 2 },
  { namedAsAsked: true, exactName: true, others: 1, othersAtItsSite: 0, nearbyBranches: 1, namesakesElsewhere: 1, othersAround: 1 },
  { namedAsAsked: true, exactName: false, others: 1, othersAtItsSite: 0, nearbyBranches: 0, namesakesElsewhere: 1, othersAround: 1 },
  { namedAsAsked: true, exactName: true, others: 1, othersAtItsSite: 0, nearbyBranches: 0, namesakesElsewhere: 1, othersAround: 0 },
  { namedAsAsked: true, exactName: true, others: 2, othersAtItsSite: 1, nearbyBranches: 0, namesakesElsewhere: 0, othersAround: 2 },
  { namedAsAsked: false, exactName: false, others: 2, othersAtItsSite: 2, nearbyBranches: 0, namesakesElsewhere: 0, othersAround: 2 })
pure def lawAFirstResultNotNamedAsAskedIsNeverMeant(f: FirstResult): bool = not(f.namedAsAsked) implies not(firstResultMeant(f))
pure def lawANearbyBranchStillAsks(f: FirstResult): bool = (f.nearbyBranches > 0 and f.othersAtItsSite < f.others) implies not(firstResultMeant(f))
pure def lawPartsOfOneSiteAreTheFirstResult(f: FirstResult): bool = (f.namedAsAsked and f.othersAtItsSite >= f.others) implies firstResultMeant(f)
pure def lawOneLandmarksAreaIsNoBranch(meters: int): bool = sameLandmark(true, true, meters) implies not(nearbyBranch(true, true, true, meters))
```

### A route's settled end is kept for the owner's next turn, which may name only the other

When a route turn settles one end and cannot plan yet, that end and the
travel mode are kept as the open question of that conversation, for the
owner's next turn only (above): the route starts where the owner is, so
the phone is asked for its location and the destination is kept; or the
destination was not found, and the start is kept. A next turn that names
only the other end ("from Chicago") plans the route with the kept one.
Naming the same end again by the same words keeps the place already
settled, a different name replaces it, and a start from where the owner
is replaces a kept start with the phone's position. A destination Maps
asked about keeps the start it had settled. A planned route keeps
nothing.

```quint
type RouteEnd = NamedThisTurn | KeptFromLastTurn | NotKnown
pure def routeEnd(namedNow: bool, kept: bool, sameAsKept: bool, fromHere: bool): RouteEnd =
  if (kept and not(fromHere) and (not(namedNow) or sameAsKept)) KeptFromLastTurn
  else if (namedNow) NamedThisTurn
  else NotKnown
pure def lawADifferentNameReplacesTheKeptEnd(kept: bool, fromHere: bool): bool = routeEnd(true, kept, false, fromHere) == NamedThisTurn
pure def lawNothingKeptIsNeverCarried(namedNow: bool, sameAsKept: bool, fromHere: bool): bool = routeEnd(namedNow, false, sameAsKept, fromHere) != KeptFromLastTurn
pure def lawFromHereReplacesAKeptStart(namedNow: bool, kept: bool, sameAsKept: bool): bool = routeEnd(namedNow, kept, sameAsKept, true) != KeptFromLastTurn
```

### A route is planned only in a travel mode Cloud Maps offers, by car when the owner named none

A route between two named places is planned by car unless the owner
named walking, cycling or transit. Before any place is looked up, Maps
reads what Cloud Maps offers: when it serves no maps the reply says Cloud
Maps is not available yet, and a travel mode it does not route is refused
by name. The planned route is said with its time and distance, the
alternatives Cloud offers when it offers them, and Cloud's attribution.

```quint
type ModeCourse = PlanInMode | RefuseMode | MapsNotServed
pure def modeCourse(served: bool, modeOffered: bool): ModeCourse =
  if (not(served)) MapsNotServed else if (modeOffered) PlanInMode else RefuseMode
pure def lawAnUnofferedModeIsNeverPlanned(served: bool): bool = modeCourse(served, false) != PlanInMode
```

### Directions start on the phone only while it is connected for the turn, and are a link otherwise

Directions from where the owner is go to the phone when it offers its
navigation for this turn's conversation and reports it can take a request
now: the phone plans the route from its own location, and the reply says
only the state it reported. A route shown and waiting says its time and
distance when the phone gave them and asks the owner to press Start; a
phone with no usable location says the route is not planned yet and asks
where the owner starts from; guidance, a place shown on the map and
stopped navigation are said as such. Without the phone the reply is a
directions link the owner opens in a maps app, with a geo link, an Apple
Maps link and an OpenStreetMap link to the destination. Showing a place
without the phone describes it with its card. Rerouting and stopping need
the phone, and without it say the phone isn't connected for navigation.

```quint
type StartCourse = StartOnPhone | HandOffLink
pure def startCourse(phoneOffered: bool, phoneReady: bool): StartCourse = if (phoneOffered and phoneReady) StartOnPhone else HandOffLink
pure def lawWithoutAReadyPhoneDirectionsAreALink(phoneOffered: bool): bool = startCourse(phoneOffered, false) == HandOffLink
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

### A Maps screen selection asks the planner to name the place

A screen selection handle identifies an observation of the Maps screen.
When it is offered as a provider place ID, Maps uses the provided place
name or address, or an already bound answer to an open Maps question.
When the handle is the only target, the planner receives a request to name
the place from the conversation. The handle never reaches the provider.

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

## Story: Hear Maps answer in its own words

> As the owner, I want what Maps found said to me as Maps wrote it, with
> its card, nearest places first, and a failure that tells me whether
> asking again can help.

### Every Maps answer is the action's own text, and a failure says whether asking again can help

A Maps action's answer, its numbered question and its card are shown to
the owner as the action wrote them, never reworded by the model. Only the
coaching refusal of a screen selection handle (above) stays out of what
the owner sees. A failure carries Cloud's own sentence and whether the
same request can be tried again: only when Maps was unreachable, timed
out or asked the owner to wait. Every Maps action declares the Maps
context, registered with its label, beside the general context every
owner turn is planned in, so it runs on any owner turn and the owner sees
"Using Maps" while it does ([planning](../agent/conversation/planning.md)).

```quint
pure val mapsContext = "maps"
pure def retryableFailure(rateLimited: bool, unreachable: bool, timedOut: bool): bool = rateLimited or unreachable or timedOut
pure def lawAnotherFailureIsNotRetried(rateLimited: bool): bool = retryableFailure(rateLimited, false, false) == rateLimited
```

### Places found around a point are listed nearest first with how far each is

A search around the phone, a named place or coordinates orders what Cloud
Maps returned by distance from that point and says how far each place is.
A search with no point keeps Cloud's order. The reply lists at most five
places and its card holds at most ten.

```quint
type PlaceOrder = NearestFirst | CloudOrder
pure val listedPlaces = 5
pure def placeOrder(aroundAPoint: bool): PlaceOrder = if (aroundAPoint) NearestFirst else CloudOrder
```

### A route planned without any traffic says so on its card

A route's card carries the warning "No live traffic." when Cloud Maps
planned the chosen route with no traffic at all. A route planned with
approximated or live traffic carries no warning.

```quint
type RouteTraffic = NoTraffic | ApproximatedTraffic | LiveTraffic
pure val noLiveTrafficWarning = "No live traffic."
pure def warnsNoLiveTraffic(traffic: RouteTraffic): bool = traffic == NoTraffic
pure def lawARouteWithTrafficIsNotWarned(traffic: RouteTraffic): bool = traffic != NoTraffic implies not(warnsNoLiveTraffic(traffic))
```
