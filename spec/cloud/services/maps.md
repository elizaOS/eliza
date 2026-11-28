# Hosted maps

The cloud answers a signed-in device's maps requests: geocoding, place search
and details, routes, and raster tiles with their copyright text. One provider
serves a deployment, `google`, `osm` or `none`, named by the profile of
[the deployment](../deployment.md), with no fallback. Each paid request runs
over one hold of [metering](../shared/metering.md) and is settled once; maps
has no unit allowance, bucket or receipt of its own. The device side is
[the maps cloud connection](../../maps/cloudConnection.md). The routes and
provider integrations live in `packages/cloud-worker/src/services/maps.vibe`
and `packages/cloud-worker/src/providers/`.

The `google` profile's `baseUrl` is a template with exactly one `{host}`, such
as `https://{host}.googleapis.com`; for each call the shell puts in its place
`places`, `maps`, `routes` or `tile`, the Google service that answers it. A
legacy profile with exactly `https://maps.googleapis.com` is read as the
public Google template above.

The shell handles a request in this order: `requestAuth`, the deployment's
capability gate, `entryOf`, the plan's standard request limit (for every
operation but tiles) with `limitOf` in one store transaction, the body,
`providerQuote`, the hold (`M::admission`, then `courseOf`), `mayDispatch`,
`M::markDispatched`, the provider, and one `settlementOf`. For a tile, the
provider's tile session is started as soon as the tile address is read,
beside the hold rather than after it. Wire shapes and string formats are the
Effect Schemas of `src/services/maps.schema.ts`. Every maps answer is sent
`Cache-Control: no-store`. A successful metered response also reports in `Server-Timing`
how long the request spent in each phase, by name and duration only:
`maps_auth` (request authentication), `maps_admission` (the limits and the
hold, through `M::markDispatched`) and, for a dispatched request,
`maps_provider`.

## Story: Answer a maps request once and pay for it once

> As an account owner, I want each maps request answered once and paid for
> once, at what the provider billed when that is known and at its quote when
> the reply was lost, so that a repeated request never costs me twice.

### A deployment answers capabilities always, and any other operation only when its provider serves it

The `osm` provider serves no tiles, no viewport copyright, no nearby-place
lookup, no live traffic and no transit. An operation the provider does not
serve is refused `404 capability_unavailable` before its body is read; with
provider `none` that is every operation but capabilities.

`GET /maps/capabilities` is answered from the profile with no provider call.
With provider `none` it is exactly `{available: false}`. Otherwise it is
`{available: true}` with the fields the maps client configures itself from,
under the names it already reads: `providerId`, `connectionId`, `revision`,
`attribution`, `sources`, `disclosure`, `regions`, `capabilities` and, where
tiles are served, `tiles`. `providerId`, `regions` and `revision` come from
the profile's `provider`, `coverage` and `datasetRevision`, and
`capabilities` from `offerOf` and `supportsMode`. Every deployment that
serves search can order the returned candidates by distance, so
`capabilities.distanceRank` is true wherever maps is available. A device
sends `rank: "distance"` only when the deployment advertises it.

```quint
import types.* from "../shared/types"
import metering as M from "../shared/metering"
import rateLimit as R from "../shared/rateLimit"
type MapsProvider = GoogleMaps | OsmMaps | NoMaps
type MapsOperation = Geocode | Reverse | PlacesSearch | PlaceDetails | Routes | Tile | Viewport | Capabilities
type TravelMode = Drive | Walk | Bicycle | Transit
type MapsOffer = { available: bool, map: bool, placeLookup: bool, distanceRank: bool, liveTraffic: bool, scheduledTransit: bool }
pure def offerOf(provider: MapsProvider): MapsOffer =
  if (provider == GoogleMaps) { available: true, map: true, placeLookup: true, distanceRank: true, liveTraffic: true, scheduledTransit: true }
  else { available: provider == OsmMaps, map: false, placeLookup: false, distanceRank: provider == OsmMaps, liveTraffic: false, scheduledTransit: false }
pure def serves(provider: MapsProvider, op: MapsOperation): bool =
  if (op == Capabilities) true
  else if (op == Tile or op == Viewport) offerOf(provider).map
  else offerOf(provider).available
pure def supportsMode(provider: MapsProvider, mode: TravelMode): bool = serves(provider, Routes) and (mode != Transit or offerOf(provider).scheduledTransit)
pure def lawMapsOffServesOnlyCapabilities(op: MapsOperation): bool = serves(NoMaps, op) iff op == Capabilities
```

### Every operation except capabilities and viewport needs an idempotency key and runs over one hold of the calling credential

Capabilities and viewport (the copyright text of the visible tiles) cost the
provider nothing: they hold nothing, are charged nothing, and a key sent with
them is ignored. Any other operation without a well-formed `Idempotency-Key`
is refused `400 invalid_request`. The hold's caller is the calling credential
(a device key or a session), so two credentials of one organization never
share a maps hold.

```quint
type MapsEntry = EnterUnmetered | EnterMetered | RefuseEntry({ code: RefusalCode })
pure def idempotencyRequired(op: MapsOperation): bool = op != Capabilities and op != Viewport
pure def entryOf(provider: MapsProvider, op: MapsOperation, hasKey: bool): MapsEntry =
  if (not(serves(provider, op))) RefuseEntry({ code: CapabilityUnavailable })
  else if (not(idempotencyRequired(op))) EnterUnmetered
  else if (hasKey) EnterMetered
  else RefuseEntry({ code: InvalidRequest })
pure def mapsHoldKey(caller: str, requestId: IdempotencyKey): HoldKey = { service: MeteredMaps, caller: caller, requestId: requestId, part: WholeRequest }
pure def lawCredentialsNeverShareAHold(caller: str, other: str, requestId: IdempotencyKey): bool =
  mapsHoldKey(caller, requestId) == mapsHoldKey(other, requestId) implies caller == other
```

### A credential makes at most 300 tile requests and 60 other maps requests a minute

The subject of both limits is the calling credential. A map draws many tiles
for one gesture, so tiles spend only the tile limit: neither the limit of the
other operations nor the plan's standard request limit of
[plans](../billing/plans.md). Capabilities and viewport count as operations
and are standard requests. A device key's requests, tiles included, first
pass the per-key ingress limit of [request auth](../identity/requestAuth.md).
A request over a limit is refused `429 rate_limited` by
[the rate limiter](../shared/rateLimit.md).

```quint
pure val operationsLimit: R::RateLimit = R::perMinute("maps-operations", 60)
pure val tilesLimit: R::RateLimit = R::perMinute("maps-tiles", 300)
pure def limitOf(op: MapsOperation): R::RateLimit = if (op == Tile) tilesLimit else operationsLimit
pure def lawTilesHaveTheirOwnValidLimit(op: MapsOperation): bool =
  R::validLimit(limitOf(op)) and (limitOf(op).name == tilesLimit.name iff op == Tile) and operationsLimit.name != tilesLimit.name
```

### A request is quoted from the provider's price table with no markup

The table is the `google` provider's price of one request in µUSD: place
search 32,000; place details 20,000; geocode and reverse 5,000; a reverse
lookup that prefers a place 37,000 (one nearby search and one geocode); a
driving route with live traffic 10,000 and any other route 5,000; a tile 600.
The `osm` provider is the operator's own stack and bills nothing per call, so
with no markup its quote and its observed price are 0; its requests still
hold, repeat and settle like any other. `traffic` is whether the provider
computes routes with live traffic, and `preferPlace` counts only where the
provider offers the nearby lookup.

```quint
pure val searchPrice: Micros = 32000
pure val detailsPrice: Micros = 20000
pure val geocodePrice: Micros = 5000
pure val nearbyPrice: Micros = 32000
pure val trafficRoutePrice: Micros = 10000
pure val routePrice: Micros = 5000
pure val tilePrice: Micros = 600
pure def quoteOf(op: MapsOperation, preferPlace: bool, mode: TravelMode, traffic: bool): Micros =
  if (op == PlacesSearch) searchPrice
  else if (op == PlaceDetails) detailsPrice
  else if (op == Geocode) geocodePrice
  else if (op == Reverse) (if (preferPlace) nearbyPrice + geocodePrice else geocodePrice)
  else if (op == Routes) (if (mode == Drive and traffic) trafficRoutePrice else routePrice)
  else if (op == Tile) tilePrice
  else 0
pure def providerQuote(provider: MapsProvider, op: MapsOperation, preferPlace: bool, mode: TravelMode): Micros =
  if (provider == GoogleMaps) quoteOf(op, preferPlace and offerOf(provider).placeLookup, mode, offerOf(provider).liveTraffic) else 0
pure def lawPricedExactlyWhenKeyed(op: MapsOperation, preferPlace: bool, mode: TravelMode, traffic: bool): bool =
  quoteOf(op, preferPlace, mode, traffic) > 0 iff idempotencyRequired(op)
pure def lawNoProviderQuotesAboveTheTable(provider: MapsProvider, op: MapsOperation, preferPlace: bool, mode: TravelMode): bool =
  providerQuote(provider, op, preferPlace, mode) >= 0 and providerQuote(provider, op, preferPlace, mode) <= quoteOf(op, preferPlace, mode, true)
```

### A request reaches the provider only under the standing that admitted it, for at most 10 seconds and 2 MiB

Just before `M::markDispatched` the shell checks again that the credential
is live, the account is active and the funding lane is the one the hold was
reserved under. A lost credential or account answers what `requestAuth`
answers now, a changed lane answers `409 billing_state_conflict`, and either
way the hold is released. Each provider call ends after 10 seconds, and a
body over 2 MiB ends it as `503 provider_unavailable`.

```quint
pure val upstreamTimeout: Millis = 10 * millisPerSecond
pure val upstreamBodyCap: int = 2 * 1024 * 1024
pure def mayDispatch(credentialLive: bool, accountActive: bool, laneUnchanged: bool): bool = credentialLive and accountActive and laneUnchanged
```

### A dispatched request is charged what the provider billed, or its quote when the reply was lost, and one never dispatched is charged nothing

A provider call answered with status 200 or 404 is billed at its table price;
one answered 401, 403, 429 or 5xx is rejected and not billed; any other
status, a timeout or a network failure leaves the bill unclear. The observed
price is the sum over the billed calls. An answered request, and one refused
`422 no_route`, `422 unsupported_mode`, `422 unsupported_region`,
`502 provider_invalid_response` or (every call rejected or too large)
`503 provider_unavailable`, has a known outcome and is charged the observed
price, 0 when nothing was billed. A request with an unclear call is a lost
reply and is charged its quote. It answers `502 provider_invalid_response`
when the provider answered with a 4xx status the table does not name, such
as a 400, and `503 provider_unavailable` after a redirect, a timeout or a
network failure. Only a place-details call carries a value from the caller
that the provider can refuse, its place id: when Google answers it `400`
with an error whose status is `INVALID_ARGUMENT` and that states no reason
(no detail of type `ErrorInfo` or with a `reason`), as for `Not a valid
Place ID`, the request answers `400 invalid_request` instead, still a lost
reply charged its quote, since its bill is just as unclear. A `400` that
names a reason (`API_KEY_INVALID`, `API_KEY_EXPIRED`, `SERVICE_DISABLED`),
one whose body cannot be read, any other details status, and a `400` to a
search, nearby, geocoding or routes call, which Cloud builds only from
inputs it has validated, stay the provider's fault: `502
provider_invalid_response`. A refusal decided before dispatch releases the hold. An
observed price above the quote is an adapter fault: it is charged at the
quote and logged as an error.

A geocoding call is billed by the status its reply names; its replies with
status 200, 400 and 404 are all read. A reply naming a quota, a denial or a
provider error (`OVER_QUERY_LIMIT`, `OVER_DAILY_LIMIT`, `REQUEST_DENIED`,
`UNKNOWN_ERROR`) is rejected and not billed, whatever its status. Only `OK`
with status 200 and `ZERO_RESULTS` with status 200 or 404 are billed, and
`ZERO_RESULTS` answers no places. Any other reply, `INVALID_REQUEST` or an
`OK` with status 400 or 404 included, and a reply that cannot be read, is
not billed as a call: its bill is unclear, so the request is a lost reply
charged its quote, and it answers `502 provider_invalid_response`.

```quint
type CallBilling = CallBilled | CallNotBilled | CallUnclear
type MapsOutcome = MapsAnswered | MapsRefused({ code: RefusalCode }) | ReplyLost
type MapsSettlement = ChargeObserved({ actual: Micros }) | ChargeQuote | ReleaseUncharged
pure def billingOf(status: int): CallBilling =
  if (status == 200 or status == 404) CallBilled
  else if (status == 401 or status == 403 or status == 429 or status >= 500) CallNotBilled
  else CallUnclear
pure def unclearAnswerIsInvalid(status: int): bool = status >= 400 and status <= 499 and billingOf(status) == CallUnclear
pure def placeIdRefused(op: MapsOperation, status: int, refusesTheArgument: bool): bool =
  op == PlaceDetails and status == 400 and refusesTheArgument
pure def lostReplyRefusal(op: MapsOperation, status: int, refusesTheArgument: bool): RefusalCode =
  if (placeIdRefused(op, status, refusesTheArgument)) InvalidRequest
  else if (unclearAnswerIsInvalid(status)) ProviderInvalidResponse
  else ProviderUnavailable
pure def lawOnlyAPlaceIdTheProviderRefusesIsTheCallersFault(op: MapsOperation, status: int, refusesTheArgument: bool): bool =
  lostReplyRefusal(op, status, refusesTheArgument) == InvalidRequest implies (op == PlaceDetails and status == 400 and refusesTheArgument)
pure def lawARefusedPlaceIdIsStillALostReply(op: MapsOperation, status: int, refusesTheArgument: bool): bool =
  placeIdRefused(op, status, refusesTheArgument) implies (billingOf(status) == CallUnclear and unclearAnswerIsInvalid(status))
pure def lawAnotherOperationsUnnamed4xxIsTheProvidersFault(op: MapsOperation, status: int, refusesTheArgument: bool): bool =
  (op != PlaceDetails and unclearAnswerIsInvalid(status)) implies lostReplyRefusal(op, status, refusesTheArgument) == ProviderInvalidResponse
pure val unbilledGeocodeStatuses = Set("OVER_QUERY_LIMIT", "OVER_DAILY_LIMIT", "REQUEST_DENIED", "UNKNOWN_ERROR")
pure def geocodeBillingOf(status: int, geocodeStatus: str): CallBilling =
  if (billingOf(status) == CallNotBilled or ((status == 200 or status == 400 or status == 404) and unbilledGeocodeStatuses.contains(geocodeStatus))) CallNotBilled
  else if ((status == 200 and geocodeStatus == "OK") or ((status == 200 or status == 404) and geocodeStatus == "ZERO_RESULTS")) CallBilled
  else CallUnclear
pure def geocodeFoundNothing(status: int, geocodeStatus: str): bool = geocodeBillingOf(status, geocodeStatus) == CallBilled and geocodeStatus == "ZERO_RESULTS"
pure def lawAGeocodeReplyNeverBillsACallItsStatusDidNot(status: int, geocodeStatus: str): bool =
  (geocodeBillingOf(status, geocodeStatus) == CallBilled implies billingOf(status) == CallBilled)
  and (geocodeFoundNothing(status, geocodeStatus) implies (status == 200 or status == 404))
pure def lawAnInvalidGeocodeRequestIsNeverBilled(status: int): bool =
  geocodeBillingOf(status, "INVALID_REQUEST") != CallBilled and (billingOf(status) != CallNotBilled implies geocodeBillingOf(status, "INVALID_REQUEST") == CallUnclear)
pure def lawANamedProviderErrorIsNeverBilled(status: int, geocodeStatus: str): bool =
  unbilledGeocodeStatuses.contains(geocodeStatus) implies geocodeBillingOf(status, geocodeStatus) != CallBilled
pure def lawAnUnclearAnswerIsInvalidOnlyForAStatusTheTableDoesNotName(status: int): bool =
  unclearAnswerIsInvalid(status) implies (billingOf(status) == CallUnclear and status != 401 and status != 403 and status != 404 and status != 429)
pure val statusValues = Set(200, 302, 400, 401, 404, 429, 500)
pure val geocodeStatusValues = Set("OK", "ZERO_RESULTS", "UNKNOWN_ERROR", "OVER_QUERY_LIMIT", "INVALID_REQUEST", "")
pure def isProviderRefusal(code: RefusalCode): bool = Set(NoRoute, UnsupportedMode, UnsupportedRegion, ProviderInvalidResponse, ProviderUnavailable).contains(code)
pure def observedWithin(quote: Micros, observed: Micros): Micros = if (observed < 0) 0 else M::minOf(observed, quote)
pure def settlementOf(dispatched: bool, reply: MapsOutcome, quote: Micros, observed: Micros): MapsSettlement =
  if (not(dispatched)) ReleaseUncharged
  else if (reply == ReplyLost) ChargeQuote
  else ChargeObserved({ actual: observedWithin(quote, observed) })
pure def applySettlement(h: M::Hold, settlement: MapsSettlement, creditFree: Micros): M::Hold = match settlement {
  | ChargeObserved(c) => M::settleKnown(h, c.actual, creditFree)
  | ChargeQuote => M::settleUnknown(h)
  | ReleaseUncharged => M::release(h)
}
pure val replyValues = Set(MapsAnswered, MapsRefused({ code: NoRoute }), MapsRefused({ code: ProviderUnavailable }), ReplyLost)
pure val observedValues = Set(-1, 0, 1, 3, 9)
pure def lawADispatchedRequestIsChargedOnceWithinItsQuote(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, reply: MapsOutcome, observed: Micros, creditFree: Micros): bool = {
  val sent = M::markDispatched(M::reserve(M::initial, mapsHoldKey("c1", "r1"), quote, lane, allowanceAvailable, creditAvailable, 0), 0)
  val closed = applySettlement(sent, settlementOf(true, reply, quote, observed), creditFree)
  (M::fundable(lane, quote, allowanceAvailable, creditAvailable) and creditFree >= 0) implies
    (closed.phase == M::Settled and closed.charged >= 0 and closed.charged <= quote and closed.uncollected == 0 and (reply == ReplyLost implies closed.charged == quote))
}
pure def lawAnUndispatchedRequestIsChargedNothing(lane: M::FundingLane, quote: Micros, allowanceAvailable: Micros, creditAvailable: Micros, reply: MapsOutcome, observed: Micros, creditFree: Micros): bool = {
  val held = M::reserve(M::initial, mapsHoldKey("c1", "r1"), quote, lane, allowanceAvailable, creditAvailable, 0)
  val ended = applySettlement(held, settlementOf(false, reply, quote, observed), creditFree)
  M::fundable(lane, quote, allowanceAvailable, creditAvailable) implies (ended.phase == M::Released and ended.charged == 0)
}
```

### A route whose endpoints coincide is a zero-length route, never a malformed answer

The provider answers in proto3 JSON, which leaves out a zero
`distanceMeters`, so a route from a place to itself comes back with no
distance and a line of one point or none. Such a route is answered with
distance 0 and a line of two points: its one point twice, or the request's
start and end. A route that has a distance still needs the provider's own
line of at least two points, and one without it, or without a duration, is
`502 provider_invalid_response`.

```quint
type RouteLine = ProvidersLine | ItsPointTwice | StartToEnd | NoUsableLine
pure def routeLine(points: int, distanceMeters: int): RouteLine =
  if (points >= 2) ProvidersLine
  else if (distanceMeters > 0) NoUsableLine
  else if (points == 1) ItsPointTwice
  else StartToEnd
pure val pointsValues = Set(0, 1, 2, 3)
pure val distanceMetersValues = Set(0, 1, 300)
pure def lawAZeroLengthRouteAlwaysHasALine(points: int, distanceMeters: int): bool =
  (distanceMeters == 0 and points >= 0) implies routeLine(points, distanceMeters) != NoUsableLine
pure def lawARouteWithADistanceKeepsOnlyTheProvidersLine(points: int, distanceMeters: int): bool =
  distanceMeters > 0 implies ((routeLine(points, distanceMeters) == ProvidersLine) iff points >= 2)
```

### A repeated key reaches no provider and moves no money: it repeats the outcome kept for it, or is refused

`M::admission` answers a known key with the same operation and body as a
replay, and another request under that key `409 idempotency_conflict`. A
replay repeats the outcome kept for the first request, its answer or its
refusal. The result copy is the only provider answer content the cloud
keeps. It is readable under the same credential and key for 15 minutes,
after which the expiry sweep deletes it. Nothing is kept for a tile or for
a lost reply.
A replay with nothing kept (the first request still runs, its reply was
lost, the copy was deleted, or it is a tile) is refused
`409 idempotency_conflict`. A device sends a fresh key for each attempt.

```quint
type MapsCourse = RunFresh | RepeatKept | RefuseRepeat
pure val answerKeptFor: Millis = 15 * millisPerMinute
pure def keepsAnswer(op: MapsOperation, reply: MapsOutcome): bool = idempotencyRequired(op) and op != Tile and reply != ReplyLost
pure def stillKept(keptAt: Millis, now: Millis): bool = now >= keptAt and now - keptAt < answerKeptFor
pure def courseOf(replayed: bool, sameRequest: bool, kept: bool): MapsCourse =
  if (not(replayed)) RunFresh else if (sameRequest and kept) RepeatKept else RefuseRepeat
```

### Every maps refusal is well formed, and only a provider outage is retryable

The refusals of `requestAuth` (`401`), the rate limiter (`429`) and metering
(`402`, `503`) pass through unchanged.

```quint
pure def isMapsRefusal(code: RefusalCode): bool =
  isProviderRefusal(code) or Set(CapabilityUnavailable, InvalidRequest, IdempotencyConflict, BillingStateConflict).contains(code)
pure def lawMapsRefusalsAreWellFormed(code: RefusalCode): bool =
  isMapsRefusal(code) implies (wellFormed(refuse(code)) and (retryableOf(refuse(code)) iff code == ProviderUnavailable))
```

## Story: Keep maps requests within the provider's terms

> As the operator, I want a place lookup to make the fewest provider calls
> that answer it, and no map tile kept or sent outside a paid request, so
> that the deployment stays within its provider's terms.

### A place lookup asks for nearby places first only when preferred, and for the address only when there are none

A reverse lookup that was cancelled makes no provider call. One that prefers
a place asks for nearby places and falls back to the address lookup only when
there are none; otherwise it asks for the address. It makes each call at most
once, its result is what the last call returned, and its calls never cost
more than its quote.

```quint
type LookupAnswer = AnswerPlace | AnswerAddress | AnswerEmpty | AnswerInvalid | AnswerOutage | AnswerCancelled
type PlaceLookup = { nearbyCalls: int, geocodeCalls: int, answer: LookupAnswer }
pure def placeLookup(prefer: bool, cancelled: bool, nearby: LookupAnswer, fallback: LookupAnswer): PlaceLookup =
  if (cancelled) { nearbyCalls: 0, geocodeCalls: 0, answer: AnswerCancelled }
  else if (prefer and nearby != AnswerEmpty) { nearbyCalls: 1, geocodeCalls: 0, answer: nearby }
  else if (prefer) { nearbyCalls: 1, geocodeCalls: 1, answer: fallback }
  else { nearbyCalls: 0, geocodeCalls: 1, answer: fallback }
pure def lookupCost(lookup: PlaceLookup): Micros = lookup.nearbyCalls * nearbyPrice + lookup.geocodeCalls * geocodePrice
pure def lawCancelledLookupCallsNothing(prefer: bool, nearby: LookupAnswer, fallback: LookupAnswer): bool =
  placeLookup(prefer, true, nearby, fallback).nearbyCalls + placeLookup(prefer, true, nearby, fallback).geocodeCalls == 0
pure def lawGeocodeOnlyAsFallback(prefer: bool, nearby: LookupAnswer, fallback: LookupAnswer): bool =
  placeLookup(prefer, false, nearby, fallback).geocodeCalls == 1 implies (not(prefer) or nearby == AnswerEmpty)
pure def lawNearbyAnswerStandsWithoutGeocode(nearby: LookupAnswer, fallback: LookupAnswer): bool =
  nearby != AnswerEmpty implies (placeLookup(true, false, nearby, fallback).geocodeCalls == 0 and placeLookup(true, false, nearby, fallback).answer == nearby)
pure def lawLookupCallsEachAtMostOnceWithinItsQuote(prefer: bool, cancelled: bool, nearby: LookupAnswer, fallback: LookupAnswer): bool = {
  val lookup = placeLookup(prefer, cancelled, nearby, fallback)
  lookup.nearbyCalls >= 0 and lookup.nearbyCalls <= 1 and lookup.geocodeCalls >= 0 and lookup.geocodeCalls <= 1 and lookupCost(lookup) <= quoteOf(Reverse, prefer, Drive, false)
}
```

### A tile is never stored, and none is sent without a freshly admitted hold

The provider's tiles may not be kept. The cloud keeps no tile for any
outcome, so a repeated tile key has nothing to repeat and is refused, and a
tile leaves the cloud only as the provider's answer to a request whose hold
was admitted for it.

```quint
pure def tileStored(reply: MapsOutcome): bool = keepsAnswer(Tile, reply)
pure def answerSent(op: MapsOperation, replayed: bool, sameRequest: bool, earlier: MapsOutcome, reply: MapsOutcome): bool = {
  val course = courseOf(replayed, sameRequest, keepsAnswer(op, earlier))
  if (course == RunFresh) reply == MapsAnswered else course == RepeatKept and earlier == MapsAnswered
}
pure val earlierValues = replyValues
pure def lawTileIsNeverStored(reply: MapsOutcome): bool = not(tileStored(reply))
pure def lawNoTileWithoutAnAdmittedHold(replayed: bool, sameRequest: bool, earlier: MapsOutcome, reply: MapsOutcome): bool =
  answerSent(Tile, replayed, sameRequest, earlier, reply) implies (not(replayed) and reply == MapsAnswered)
```

### Every tile a process serves shares one provider tile session, started beside the hold and renewed only near its expiry or when it is refused

A process holds one tile session per provider address. A tile finds it
held, waits for the one being started, or starts it, so however many tiles
of a cold process arrive together, the provider is asked for one session.
The session is created apart from the tile that started it: a caller's
cancellation stops only that caller's wait, never the creation the other
tiles share, and the request that started it is not finished, so its
process is kept, until the creation ends. A failed creation is forgotten,
and the next tile starts another; a session within `tileSessionRenewMargin`
of its expiry is replaced. A tile the provider refuses `401` or `403` drops
the session only if it is still the one the tile was refused under, then
shares or starts the next and is sent once more. A session that cannot be
created refuses the tile `503 provider_unavailable`, or
`502 provider_invalid_response` for an unreadable answer, as a known outcome
charged nothing, since no tile was asked of the provider.

```quint
pure val tileSessionRenewMargin: Millis = 60 * millisPerMinute
pure def tileSessionFresh(expiresAt: Millis, now: Millis): bool = expiresAt - tileSessionRenewMargin > now
pure val expiresAtValues = Set(0, 3600000, 3600001, 7200000)
pure def lawAFreshTileSessionOutlivesItsMargin(expiresAt: Millis, now: Millis): bool =
  tileSessionFresh(expiresAt, now) implies expiresAt > now + tileSessionRenewMargin
```

## Story: Find the closest places, not the closest of the most relevant

> As an account owner asking for the nearest kind of place, I want the
> closest places the provider found around my point, not the closest of
> the few it ranked most relevant, so that "the nearest pharmacy" is the
> nearest one.

### A search ranked by distance needs a point to measure from

`POST /maps/places/search` takes `rank: "distance"` beside `query`, `near`
and `limit`, and nothing else for `rank`. A search that asks for it with
no `near`, or on a provider whose offer has no `distanceRank`, is refused
`400 invalid_request` before any hold is taken or provider called. A
search without `rank` is ranked by the provider's relevance, as before.

```quint
type SearchRank = RankByRelevance | RankByDistance
pure def searchRankAccepted(provider: MapsProvider, rank: SearchRank, hasNear: bool): bool =
  rank == RankByRelevance or (hasNear and offerOf(provider).distanceRank)
pure def lawADistanceRankNeedsAPoint(provider: MapsProvider, rank: SearchRank): bool =
  searchRankAccepted(provider, rank, false) iff rank == RankByRelevance
pure def lawEveryProviderThatSearchesRanksByDistance(provider: MapsProvider): bool =
  serves(provider, PlacesSearch) implies searchRankAccepted(provider, RankByDistance, true)
```

### A search ranked by distance reads the provider's largest page and answers its nearest places first

A search ranked by distance asks for one page of up to 20 places at the
same quote as any search. Cloud asks Google Text Search for distance
ranking with the existing location bias. Google applies that preference
to supported queries. For OpenStreetMap, Cloud orders the page Nominatim
returns. Cloud measures each returned place from `near` along the Earth's
surface in whole metres and keeps the `limit` nearest (10 by default).
Places the same number of metres away retain the provider's order. A
relevance search asks for `limit` places and returns them in provider
order without requesting distance ranking.

```quint
pure val searchPageMax: int = 20
pure val searchLimitDefault: int = 10
pure def searchPageSize(rank: SearchRank, limit: int): int = if (rank == RankByDistance) searchPageMax else limit
pure def placeIndexes(meters: List[int]): List[int] = meters.foldl(List(), (indexes, place) => indexes.append(indexes.length()))
pure def nearerThan(meters: List[int], first: int, second: int): bool =
  meters.nthOr(first, 0) < meters.nthOr(second, 0) or (meters.nthOr(first, 0) == meters.nthOr(second, 0) and first < second)
pure def closestFirst(meters: List[int], limit: int): List[int] = {
  val indexes = placeIndexes(meters)
  indexes.foldl(List(), (kept, rank) => if (kept.length() < limit) kept.concat(indexes.select(i => indexes.select(j => nearerThan(meters, j, i)).length() == rank)) else kept)
}
pure def lawADistanceSearchReadsTheLargestPage(limit: int): bool = searchPageSize(RankByDistance, limit) == searchPageMax
pure def lawTheAnswerHoldsTheLimitOrTheWholePage(meters: List[int], limit: int): bool =
  closestFirst(meters, limit).length() == (if (limit < 0) 0 else if (limit < meters.length()) limit else meters.length())
pure def lawTheAnswerIsNearestFirst(meters: List[int], limit: int): bool = {
  val kept = closestFirst(meters, limit)
  placeIndexes(kept).every(at => at == 0 or nearerThan(meters, kept.nthOr(at - 1, 0), kept.nthOr(at, 0)))
}
pure def lawNoPlaceLeftOutIsNearer(meters: List[int], limit: int): bool = {
  val kept = closestFirst(meters, limit)
  placeIndexes(meters).every(left => kept.includes(left) or kept.every(taken => nearerThan(meters, taken, left)))
}
```
