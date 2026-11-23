# Hosted maps

The cloud answers a signed-in device's maps requests: geocoding, place search
and details, routes, and raster tiles with their copyright text. One provider
serves a deployment, `google`, `osm` or `none`, named by the profile of
[the deployment](../deployment.md), with no fallback. Each paid request runs
over one hold of [metering](../shared/metering.md) and is settled once; maps
has no unit allowance, bucket or receipt of its own. The device side is
[the maps cloud connection](../../maps/cloudConnection.md). Sources are
develop `packages/cloud/api/src/lib/{maps-route,maps-request-admission}.ts`,
`packages/cloud/shared/src/lib/services/maps/{contract,google-provider,osm-provider}.ts`
and the Quint models `maps_credit_funding`, `MapsPlaceLookup` and
`MapsTileCache`.

The shell handles a request in this order: `requestAuth`, the deployment's
capability gate, `entryOf`, the plan's standard request limit (for every
operation but tiles) with `limitOf` in one store transaction, the body,
`providerQuote`, the hold (`M::admission`, then `courseOf`), `mayDispatch`,
`M::markDispatched`, the provider, and one `settlementOf`. Wire shapes and string formats are the
Effect Schemas of `src/services/maps.schema.ts`. Every maps answer is sent
`Cache-Control: no-store`.

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
`capabilities` from `offerOf` and `supportsMode`.

```quint
import types.* from "../shared/types"
import metering as M from "../shared/metering"
import rateLimit as R from "../shared/rateLimit"
type MapsProvider = GoogleMaps | OsmMaps | NoMaps
type MapsOperation = Geocode | Reverse | PlacesSearch | PlaceDetails | Routes | Tile | Viewport | Capabilities
type TravelMode = Drive | Walk | Bicycle | Transit
type MapsOffer = { available: bool, map: bool, placeLookup: bool, liveTraffic: bool, scheduledTransit: bool }
pure def offerOf(provider: MapsProvider): MapsOffer =
  if (provider == GoogleMaps) { available: true, map: true, placeLookup: true, liveTraffic: true, scheduledTransit: true }
  else { available: provider == OsmMaps, map: false, placeLookup: false, liveTraffic: false, scheduledTransit: false }
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
reply: it answers `503 provider_unavailable` and is charged its quote. A
refusal decided before dispatch releases the hold. An observed price above
the quote is an adapter fault: it is charged at the quote and logged as an
error.

A geocoding call is also billed by the status its reply names. A reply
naming a quota, a denial or a provider error (`OVER_QUERY_LIMIT`,
`OVER_DAILY_LIMIT`, `REQUEST_DENIED`, `UNKNOWN_ERROR`) is rejected and not
billed, even when it came with status 200. A `ZERO_RESULTS` reply is billed
and answers no places, whether it came with status 200 or 404; any other
reply with status 404 is `502 provider_invalid_response`.

```quint
type CallBilling = CallBilled | CallNotBilled | CallUnclear
type MapsOutcome = MapsAnswered | MapsRefused({ code: RefusalCode }) | ReplyLost
type MapsSettlement = ChargeObserved({ actual: Micros }) | ChargeQuote | ReleaseUncharged
pure def billingOf(status: int): CallBilling =
  if (status == 200 or status == 404) CallBilled
  else if (status == 401 or status == 403 or status == 429 or status >= 500) CallNotBilled
  else CallUnclear
pure val unbilledGeocodeStatuses = Set("OVER_QUERY_LIMIT", "OVER_DAILY_LIMIT", "REQUEST_DENIED", "UNKNOWN_ERROR")
pure def geocodeBillingOf(status: int, geocodeStatus: str): CallBilling =
  if (billingOf(status) == CallBilled and unbilledGeocodeStatuses.contains(geocodeStatus)) CallNotBilled else billingOf(status)
pure def geocodeFoundNothing(status: int, geocodeStatus: str): bool = geocodeBillingOf(status, geocodeStatus) == CallBilled and geocodeStatus == "ZERO_RESULTS"
pure def lawAGeocodeReplyNeverBillsACallItsStatusDidNot(status: int, geocodeStatus: str): bool =
  (geocodeBillingOf(status, geocodeStatus) == CallBilled implies billingOf(status) == CallBilled)
  and (geocodeFoundNothing(status, geocodeStatus) implies (status == 200 or status == 404))
pure val statusValues = Set(200, 400, 404, 429, 500)
pure val geocodeStatusValues = Set("OK", "ZERO_RESULTS", "UNKNOWN_ERROR", "OVER_QUERY_LIMIT", "INVALID_REQUEST")
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

### A repeated key reaches no provider and moves no money: it repeats the outcome kept for it, or is refused

`M::admission` answers a known key with the same operation and body as a
replay, and another request under that key `409 idempotency_conflict`. A
replay repeats the outcome kept for the first request, its answer or its
refusal. That copy is the only provider content the cloud holds, it is
readable only under the same credential and key, and it is deleted 15
minutes after it was kept. Nothing is kept for a tile or for a lost reply.
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
