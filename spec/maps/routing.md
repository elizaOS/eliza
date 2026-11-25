# Maps turn routing

How an owner request reaches the Maps action that answers it, and how the
owner's next turn answers a question Maps asked. Which action a request
needs is the model's to judge from the actions' own descriptions; this
spec decides how an open question binds the answer and how a place is
taken. [Maps navigation](./navigation.md) owns what those actions may do.

## Story: Send my directions request to Maps, not to a view

> As the owner, I want "directions to Coit Tower" to plan a route and "take
> me to settings" to open Settings, and "the second one" to answer the
> question Maps just asked me.

### A Maps request is the model's to recognize, and opening the Maps view never answers one

The Maps actions are offered to the model like any other action, and each
description says what it serves: directions and routes, a place to find
or show on the map, travel to a destination, places of a kind near a point.
Whether a message is Maps work, and which Maps action serves it, is the
model's choice: nothing routes a request before the model has seen it, and
no action is refused for the words of a request. The `VIEWS` description
says that showing a view acts on nothing in it, so showing Maps finds no
place and plans no route, and a request for one is a Maps action's.
A Maps result tells the model what Maps found, planned or did, and the
model words the reply from it: the owner sees the result's card as it is,
and its sentences only as the model put them. Only the question Maps asks
before it shares a place is shown in its own words, with its choices.

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

### Only the owner's next turn answers an open question, with a listed place's id the model passes, within ten minutes

When Maps asks "which one did you mean?", the question is open for the
owner who was asked, in that conversation, and only their next turn can
answer it. A turn after that closes it, as do ten minutes, so "the second
one" said later about another list is never taken as this answer. While
the question is open, the owner's next message reaches the model with a
note on the action that asked, numbering the options it offered with each
one's place id and naming the argument that takes the answer. Which
option the owner's words pick ("the second one", "the one on Valencia",
the place's name) is the model's to read: it calls that action again with
the chosen option's place id. That id continues the operation that asked
only when it is one of the listed options. An id that is not one of them
is never looked up as the answer: when the call also names a place, that
name is searched as a new request; otherwise the model is told, out of
the owner's sight, which ids the question listed, and nothing is looked
up. A call without an id leaves the question to the planner.

```quint
pure val choiceLifetime = 600000
type ChoiceTurn = AskingTurn | NextOwnerTurn | LaterTurn
type ChoiceAnswer = { open: bool, sameConversation: bool, turn: ChoiceTurn, age: int, position: int, options: int }
pure def choiceOpenAt(turn: ChoiceTurn, age: int): bool = turn != LaterTurn and age >= 0 and age <= choiceLifetime
pure def answersTheQuestion(a: ChoiceAnswer): bool =
  a.open and a.sameConversation and a.turn == NextOwnerTurn and choiceOpenAt(a.turn, a.age) and a.options >= 1
pure def choiceBinds(a: ChoiceAnswer): bool = answersTheQuestion(a) and a.position >= 1 and a.position <= a.options
type ChoiceCourse = ContinueTheAskedRequest | SendBackToPick | SearchTheNamedPlace | PlanAsANewRequest
pure def choiceCourse(a: ChoiceAnswer, idGiven: bool, placeNamed: bool): ChoiceCourse =
  if (idGiven and choiceBinds(a)) ContinueTheAskedRequest
  else if (idGiven and answersTheQuestion(a) and placeNamed) SearchTheNamedPlace
  else if (idGiven and answersTheQuestion(a)) SendBackToPick
  else PlanAsANewRequest
pure val aValues = Set({ open: true, sameConversation: true, turn: NextOwnerTurn, age: 0, position: 2, options: 3 },
  { open: true, sameConversation: false, turn: NextOwnerTurn, age: 0, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: NextOwnerTurn, age: 600001, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: NextOwnerTurn, age: 10, position: 4, options: 3 },
  { open: true, sameConversation: true, turn: NextOwnerTurn, age: 10, position: 0, options: 3 },
  { open: false, sameConversation: true, turn: NextOwnerTurn, age: 10, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: LaterTurn, age: 10, position: 1, options: 3 },
  { open: true, sameConversation: true, turn: AskingTurn, age: 10, position: 1, options: 3 })
pure def lawExpiredChoiceNeverBinds(a: ChoiceAnswer): bool = a.age > choiceLifetime implies not(choiceBinds(a))
pure def lawChoiceStaysInItsConversation(a: ChoiceAnswer): bool = not(a.sameConversation) implies not(choiceBinds(a))
pure def lawPositionIsAmongTheOptions(a: ChoiceAnswer): bool = choiceBinds(a) implies a.position <= a.options
pure def lawOnlyTheNextTurnAnswers(a: ChoiceAnswer): bool = a.turn != NextOwnerTurn implies not(choiceBinds(a))
pure def lawALaterTurnClosesTheQuestion(age: int): bool = not(choiceOpenAt(LaterTurn, age))
pure def lawOnlyAListedIdContinues(a: ChoiceAnswer, idGiven: bool, placeNamed: bool): bool =
  choiceCourse(a, idGiven, placeNamed) == ContinueTheAskedRequest implies (idGiven and a.position >= 1 and a.position <= a.options and a.turn == NextOwnerTurn)
pure def lawAnUnlistedIdIsNeverLookedUpAsTheAnswer(a: ChoiceAnswer, placeNamed: bool): bool =
  (answersTheQuestion(a) and not(choiceBinds(a))) implies choiceCourse(a, true, placeNamed) == (if (placeNamed) SearchTheNamedPlace else SendBackToPick)
pure def lawWithoutAnIdTheQuestionIsThePlannersToLeave(a: ChoiceAnswer, placeNamed: bool): bool = choiceCourse(a, false, placeNamed) == PlanAsANewRequest
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

### Only a kind of place near a named place is searched around that place

"Pharmacy near Union Square" and "gas station near US 101" name a kind of
place and the place to search around. The words after "near", "around",
"close to" or "next to" name no place when they are the owner's own
position ("me", "us", "by", "me, please", "us right now", "me open now"),
which is a search around the phone; a time ("around midnight", "near
5pm", "around Christmas"); a price ("around 500 dollars", "around 150 a
night", "around 100 euros a night"); or the owner's own places ("near
home", "near my office"). A place whose name only begins like the owner's
position, such as "US Bank Tower", "us post office" or "Here East", is
still a named place, and courtesy after it ("near Union Square, please")
is not part of its name. The words before "near" name no kind of place
when they are something the phone keeps ("photos near the Ferry
Building") or something about the place itself ("the weather near
Austin", "traffic near the Bay Bridge", "news around Austin"), even when
the words after "near" do name a place. None of these is searched around
a named place: each searches just as it would with no place named, around
the phone for "near me" and around nothing otherwise.

```quint
import phonePosition as Pos from "./phonePosition"
type NearWords = NamedPlace | OwnPosition | NotAPlace
type NearKind = PlaceKind | NotAPlaceKind
type NearSearch = AroundTheNamedPlace | NoNamedPlaceSearch
pure def nearSearch(nearKind: NearKind, nearWords: NearWords): NearSearch =
  if (nearKind == PlaceKind and nearWords == NamedPlace) AroundTheNamedPlace else NoNamedPlaceSearch
pure def lawTheOwnersPositionIsNeverSearchedAsANamedPlace(nearKind: NearKind, p: Pos::PhonePosition): bool =
  Pos::searchAround(nearSearch(nearKind, OwnPosition) == AroundTheNamedPlace, true, p) != Pos::AroundNamedPlace
pure def lawAKindOfPlaceNearANamedPlaceIsSearchedAroundThatPlace(nearMe: bool, p: Pos::PhonePosition): bool =
  Pos::searchAround(nearSearch(PlaceKind, NamedPlace) == AroundTheNamedPlace, nearMe, p) == Pos::AroundNamedPlace
pure def lawAnythingElseNeverMovesTheSearch(nearKind: NearKind, nearWords: NearWords, nearMe: bool, p: Pos::PhonePosition): bool =
  not(nearKind == PlaceKind and nearWords == NamedPlace) implies
    Pos::searchAround(nearSearch(nearKind, nearWords) == AroundTheNamedPlace, nearMe, p) == Pos::searchAround(false, nearMe, p)
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
