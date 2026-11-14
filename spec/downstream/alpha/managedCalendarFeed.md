# Managed Calendar provider feed, cache drain and mapped pull

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses the
resident Calendar route from Eliza `c518127a025ab173874af9c7d304f26b25213b0d`.
`plugins/plugin-calendar/src/service/managed-calendar-read.ts` checks the
private host response. `CalendarService.ts` owns aggregate read admission,
canonical cache persistence and managed mapped-event pulls. The baseline
`ManagedCalendarPull.qnt` includes read-only pull and grant-cache drain.
The [Alpha renderer](./canonicalCalendarRead.md) owns presentation
freshness. [Linked control](./canonicalCalendarSync.md) owns user commands
and control receipts. Exact effectful provider reconciliation and the
general provider merge algorithm are separately refined.

## Story: Read the connected Calendar and keep its source information intact

### The resident accepts only complete broker data for the exact selected source and window

The private endpoint uses HTTP loopback at 127.0.0.1 with a port and exact
path `/__alpha-owner-gmail`, with no query, fragment or user information.
Its bearer token is 64 ASCII URL-safe characters. Requests are POST with
JSON, disallow redirects, and combine parent cancellation with a 30-second
deadline. Sources and ordinary responses have a 256 KiB byte limit. A feed
has a 512 KiB limit. The response must be HTTP success, provide a readable
body and parse to a JSON object. Closed diagnostic evidence for typed read
errors describes the attempt without granting source authority. An
operation-bound classified broker header is used only for a read HTTP 409.
Malformed JSON propagates its parser failure. Endpoint construction errors
carry no read-attempt diagnostics.

A source catalog contains at most 1,000 rows. Rows have Google owner side,
a lowercase 64-hex `alpha-google:` grant whose value equals the connector
account, and string calendar ID and summary. The pinned decoder tests
the string conversion of access against reader, writer and owner, while
retaining the original value. An invalid optional connection UUID is
omitted from the retained summary. The resident checks the request grant
before calling the broker. The caller owns request window and zone syntax.

A feed echoes the exact calendar ID and request window strings, declares
complete synced coverage, supplies a parsed synchronization time and
carries exactly one fresh health row with the selected grant, calendar,
provider and side. Every event has the same grant, calendar, provider and
side, string ID and title, and parseable timestamp strings. This decoder
does not compare the two event timestamp values or require a particular
provider-supplied agent ID. The resident overwrites that ID with its own.
The decoder checks the source result before canonical cache persistence.

```quint
type BrokerCalendarCall = CalendarSourcesCall | CalendarFeedCall | CalendarOtherCall
type BrokerCalendarWire = { scopeValid: bool, httpSuccess: bool, bodyReadable: bool, bytesRead: int,
  jsonObject: bool, envelopeValid: bool, exactWindowAndCalendar: bool, onlyFreshHealth: bool, exactEvents: bool }
pure def brokerCalendarByteLimit(callKind: BrokerCalendarCall): int =
  if (callKind == CalendarFeedCall) 524288 else 262144
pure def managedCalendarWireAccepted(callKind: BrokerCalendarCall, wire: BrokerCalendarWire): bool =
  wire.scopeValid and wire.httpSuccess and wire.bodyReadable and wire.bytesRead >= 0 and
  wire.bytesRead <= brokerCalendarByteLimit(callKind) and wire.jsonObject and wire.envelopeValid and
  (callKind != CalendarFeedCall or (wire.exactWindowAndCalendar and wire.onlyFreshHealth and wire.exactEvents))
pure def managedCatalogAccepted(rowCount: int, everySourceValid: bool): bool =
  rowCount >= 0 and rowCount <= 1000 and everySourceValid
pure def lawManagedFeedRequiresExactSource(wire: BrokerCalendarWire): bool =
  managedCalendarWireAccepted(CalendarFeedCall,wire) implies wire.exactWindowAndCalendar and wire.onlyFreshHealth and wire.exactEvents
pure def lawManagedFeedByteOverflowRefused(callKind: BrokerCalendarCall, wire: BrokerCalendarWire): bool =
  wire.bytesRead > brokerCalendarByteLimit(callKind) implies not(managedCalendarWireAccepted(callKind,wire))
pure val correctWire: BrokerCalendarWire = { scopeValid: true, httpSuccess: true, bodyReadable: true, bytesRead: 512,
  jsonObject: true, envelopeValid: true, exactWindowAndCalendar: true, onlyFreshHealth: true, exactEvents: true }
pure val wireValues = Set(correctWire,{ ...correctWire,scopeValid:false },{ ...correctWire,exactEvents:false },
  { ...correctWire,onlyFreshHealth:false },{ ...correctWire,bytesRead:262145 },{ ...correctWire,bytesRead:524289 })
pure val rowCountValues = Set(0,1,1000,1001)
```

### A purge drains preexisting writes for its grant before acknowledging local removal

Reads share four service-wide permits, including across simultaneous
aggregate queries. Same-calendar reads serialize. Different calendars
can hold permits concurrently. A grant's admission lock covers
registration of its calendar work. During imported-data removal for the
exact Google owner grant and connector account, this lock prevents new
admission until all calendar work registered for that grant has
settled, including writes already in progress on cancelled requests.
Another grant remains eligible, subject to the shared limit.

The purge requires explicit confirmation. It initially handles
reminder plans for the exact cached events, then removes the imported
projection for its agent, provider, side, grant and connector account.
A failed purge does not return a success receipt. A later explicitly
admitted read can import again if access still permits. Read cancellation
before each cache write prevents another write, and a write already
awaiting commit may finish without returning a successful read.
Discovered by the proof: a successful read can exist only in the
settled phase. An active read cannot already hold its success receipt.

This machine projects one old read and one unrelated grant's cache.
Actions represent registration, broker admission, one cache write and
purge over a retained generation. The surrounding port owns actual
slots, grant namespaces and per-calendar serialization.

```quint
type ManagedReadPhase = ManagedReadIdle | ManagedBrokerReading | ManagedCacheWriting | ManagedReadSettled
type ManagedPurgePhase = ManagedPurgeIdle | ManagedPurgeDraining | ManagedPurgeFailed | ManagedPurgeCommitted
type ManagedFeedCache = { readPhase: ManagedReadPhase, purgePhase: ManagedPurgePhase, cancelled: bool,
  oldEntry: bool, foreignEntry: bool, freshGeneration: bool, successfulRead: bool }
pure val initial: ManagedFeedCache = { readPhase: ManagedReadIdle, purgePhase: ManagedPurgeIdle,
  cancelled: false, oldEntry: false, foreignEntry: true, freshGeneration: false, successfulRead: false }
pure def managedGrantMayRegister(phase: ManagedPurgePhase, matchingGrant: bool, permitAvailable: bool): bool =
  permitAvailable and (phase != ManagedPurgeDraining or not(matchingGrant))
pure def managedReadPermit(heldPermits: int): bool = heldPermits >= 0 and heldPermits < 4
pure def canRegisterManagedRead(s: ManagedFeedCache, permitAvailable: bool): bool =
  (s.readPhase == ManagedReadIdle or s.readPhase == ManagedReadSettled) and
    managedGrantMayRegister(s.purgePhase,true,permitAvailable)
pure def registerManagedRead(s: ManagedFeedCache, permitAvailable: bool): ManagedFeedCache =
  { ...s, readPhase: ManagedBrokerReading, cancelled: false,
    freshGeneration: s.purgePhase == ManagedPurgeCommitted, successfulRead:false }
pure def canReceiveManagedFeed(s: ManagedFeedCache): bool = s.readPhase == ManagedBrokerReading
pure def receiveManagedFeed(s: ManagedFeedCache, brokerAccepted: bool): ManagedFeedCache =
  { ...s, readPhase: if (brokerAccepted and not(s.cancelled)) ManagedCacheWriting else ManagedReadSettled }
pure def canSettleManagedWrite(s: ManagedFeedCache): bool = s.readPhase == ManagedCacheWriting
pure def settleManagedWrite(s: ManagedFeedCache, durableCache: bool): ManagedFeedCache =
  { ...s, readPhase: ManagedReadSettled, oldEntry: s.oldEntry or (durableCache and not(s.freshGeneration)),
    successfulRead: durableCache and not(s.cancelled) }
pure def canCancelManagedRead(s: ManagedFeedCache): bool =
  (s.readPhase == ManagedBrokerReading or s.readPhase == ManagedCacheWriting) and not(s.cancelled)
pure def cancelManagedRead(s: ManagedFeedCache): ManagedFeedCache = { ...s, cancelled:true }
pure def canRequestManagedPurge(s: ManagedFeedCache, confirmed: bool): bool =
  confirmed and (s.purgePhase == ManagedPurgeIdle or s.purgePhase == ManagedPurgeFailed)
pure def requestManagedPurge(s: ManagedFeedCache, confirmed: bool): ManagedFeedCache =
  { ...s, purgePhase: ManagedPurgeDraining }
pure def canSettleManagedPurge(s: ManagedFeedCache): bool =
  s.purgePhase == ManagedPurgeDraining and s.readPhase != ManagedBrokerReading and s.readPhase != ManagedCacheWriting
pure def settleManagedPurge(s: ManagedFeedCache, durableRemoval: bool): ManagedFeedCache =
  { ...s, purgePhase: if (durableRemoval) ManagedPurgeCommitted else ManagedPurgeFailed,
    oldEntry: s.oldEntry and not(durableRemoval) }
pure def alwaysPurgeFencesOldCache(s: ManagedFeedCache): bool =
  (s.purgePhase == ManagedPurgeCommitted implies not(s.oldEntry) and
    ((s.readPhase == ManagedBrokerReading or s.readPhase == ManagedCacheWriting) implies s.freshGeneration)) and
  s.foreignEntry and (s.successfulRead implies not(s.cancelled) and s.readPhase == ManagedReadSettled)
pure def sometimesCancelledWriteStillDrains(s: ManagedFeedCache): bool =
  s.purgePhase == ManagedPurgeDraining and s.cancelled and s.readPhase == ManagedCacheWriting
pure def sometimesPurgeCommitsAfterDrain(s: ManagedFeedCache): bool =
  s.purgePhase == ManagedPurgeCommitted and s.readPhase == ManagedReadSettled and not(s.oldEntry)
pure def sometimesFreshReadAfterPurge(s: ManagedFeedCache): bool =
  s.purgePhase == ManagedPurgeCommitted and s.freshGeneration and s.successfulRead
pure def lawForeignGrantCanProceedDuringDrain(permitAvailable: bool): bool =
  managedGrantMayRegister(ManagedPurgeDraining,false,permitAvailable) == permitAvailable and
  not(managedGrantMayRegister(ManagedPurgeDraining,true,permitAvailable))
pure val heldPermitsValues = Set(0,3,4,5)
pure val weight_registerManagedRead = 8
pure val weight_receiveManagedFeed = 8
pure val weight_settleManagedWrite = 8
pure val weight_settleManagedPurge = 8
```

## Story: Show one checked copy of a mapped event after a provider read

### A successful provider feed only offers pull for an exact clean mapping

Managed reads first cache validated observations with their current
resident identity. The pull pass additionally requires current calendar
record policy, unpaused control, no held dispatch, and its exact connector
account and calendar. A clean mapping must retain its provider event ID
and the same destination. A matching etag skips the extra operation. If
the event is missing from the feed, a local event must intersect the same
window. All-day membership uses the requested civil time zone. The
matching reconciliation operation checks canonical provider state again;
absence from the feed alone cannot delete a local row. A refused link
operation from a racing authorization or dispatch leaves the healthy
read available and reports the refused pull.

After a confirmed pull, the service rereads local feed data before
aggregate projection. It uses the current link records for exact mapped
copy suppression. General portable event deduplication retains its own
provider, UID, occurrence and revision policy. The aggregate declares
complete only when all listed source health is fresh and all component
feeds are complete. A stale or fresh usable source otherwise gives
partial coverage, while no usable source gives unavailable coverage.

```quint
type ManagedMappedPull = { recordPolicy: bool, paused: bool, dispatchHeld: bool, currentDestination: bool,
  cleanMapping: bool, retainedProviderEvent: bool, sameDestination: bool, remoteVisible: bool,
  etagMatches: bool, localIntersectsWindow: bool }
type ManagedAggregate = ManagedAggregateComplete | ManagedAggregatePartial | ManagedAggregateUnavailable
pure def shouldOfferManagedPull(pull: ManagedMappedPull): bool =
  pull.recordPolicy and not(pull.paused or pull.dispatchHeld) and pull.currentDestination and
  pull.cleanMapping and pull.retainedProviderEvent and pull.sameDestination and
  (if (pull.remoteVisible) not(pull.etagMatches) else pull.localIntersectsWindow)
pure def mayPublishManagedPull(pulled: bool, localReadback: bool): bool = not(pulled) or localReadback
pure def managedAggregateState(allHealthFresh: bool, everyFeedComplete: bool, usableSource: bool): ManagedAggregate =
  if (allHealthFresh and everyFeedComplete) ManagedAggregateComplete
  else if (usableSource) ManagedAggregatePartial else ManagedAggregateUnavailable
pure def lawManagedPullNeedsExactCleanMap(pull: ManagedMappedPull): bool =
  shouldOfferManagedPull(pull) implies pull.cleanMapping and pull.retainedProviderEvent and pull.sameDestination and
    pull.currentDestination and not(pull.paused or pull.dispatchHeld)
pure def lawManagedAbsenceRequiresRelevantLocalWindow(pull: ManagedMappedPull): bool =
  shouldOfferManagedPull(pull) and not(pull.remoteVisible) implies pull.localIntersectsWindow
pure def lawManagedPullProjectsOnlyAfterReadback(localReadback: bool): bool =
  mayPublishManagedPull(true,localReadback) implies localReadback
pure def lawPartialComponentCannotClaimComplete(allHealthFresh: bool, usableSource: bool): bool =
  managedAggregateState(allHealthFresh,false,usableSource) != ManagedAggregateComplete
pure val matchingPull: ManagedMappedPull = { recordPolicy: true, paused: false, dispatchHeld: false, currentDestination:true,
  cleanMapping:true, retainedProviderEvent:true, sameDestination:true, remoteVisible:true, etagMatches:false, localIntersectsWindow:true }
pure val pullValues = Set(matchingPull,{ ...matchingPull, paused:true },{ ...matchingPull, dispatchHeld:true },
  { ...matchingPull, etagMatches:true },{ ...matchingPull, cleanMapping:false },
  { ...matchingPull, remoteVisible:false },{ ...matchingPull, remoteVisible:false, localIntersectsWindow:false })
```
