# Alpha's reviewed Calendar reads

Alpha connects `apps/app/src/prototype/agent-calendar-adapter.ts` and
`calendar-approval-adapter.ts` to Eliza's `plugins/plugin-calendar/src/client/{named-read,availability-review}.ts`
and `plugins/plugin-assistant/src/services/device-actions/calendar-contract.ts`.
The reviewed read boundary has no authority to edit calendar entries.
The [workflow model](../workflow.md) owns workflow authority and schedule.
Here the selected event and availability response cross into the agent
only through a current result receipt. Source capabilities include
`calendar.named-read.v1`, `calendar.availability-read.v1`, and the scoped
Calendar operation capability.

## Story: Share only the exact current Calendar information I reviewed

### A named read opens Share for the owner's existing selected event

The active context must be Calendar, nonsensitive and hold a valid
selected event. The target carries source ID, source revision, event ID
and event revision. The operation requires both named read and scoped
Calendar capabilities. It rejects a stale or non-applied provider
receipt. Only the fresh returned title matched against the request
using NFKC and case-insensitive containment authorizes a response. No
new event search, inferred target, provider substitution, or write occurs.
Switching owner or canceling retires publication and cancels the exact
operation when supported. The decoder provides normalized name-match and
receipt shape facts; the model requires those facts alongside identity
and revision. `owner` represents the authenticated session plus its
credential/environment identity.

```quint
type EventTarget = { sourceId: str, sourceVersion: int, eventId: str, eventVersion: int }
type NamedRequest = { calendarView: bool, sensitive: bool, namedCapability: bool, scopedCapability: bool, ownSelection: bool, target: EventTarget }
type ReadPhase = Idle | Sharing | Shared | Refused | Retired
pure val noTarget: EventTarget = { sourceId: "", sourceVersion: 0, eventId: "", eventVersion: 0 }
pure val chosenTarget: EventTarget = { sourceId: "personal", sourceVersion: 1, eventId: "event", eventVersion: 2 }
pure val amendedTarget: EventTarget = { ...chosenTarget, eventVersion: 3 }
pure val targetValues = Set(noTarget, chosenTarget, amendedTarget)
pure val requestValues = Set({ calendarView: true, sensitive: false, namedCapability: true, scopedCapability: true, ownSelection: true, target: chosenTarget }, { calendarView: true, sensitive: true, namedCapability: true, scopedCapability: true, ownSelection: true, target: chosenTarget }, { calendarView: false, sensitive: false, namedCapability: true, scopedCapability: false, ownSelection: false, target: noTarget })
type NamedRead = { owner: int, requestId: int, selected: EventTarget, delivered: EventTarget, phase: ReadPhase }
pure val initial: NamedRead = { owner: 0, requestId: 0, selected: noTarget, delivered: noTarget, phase: Idle }
pure def validNamedRequest(request: NamedRequest): bool = request.calendarView and not(request.sensitive) and request.namedCapability and request.scopedCapability and request.ownSelection and request.target.sourceId != "" and request.target.eventId != ""
pure def canStart(s: NamedRead, ownerId: int, request: NamedRequest): bool = s.phase != Sharing and ownerId > 0 and validNamedRequest(request)
pure def start(s: NamedRead, ownerId: int, request: NamedRequest): NamedRead =
  { owner: ownerId, requestId: s.requestId + 1, selected: request.target, delivered: noTarget, phase: Sharing }
pure def canAccept(s: NamedRead, ownerId: int, requestId: int): bool = s.phase == Sharing and ownerId == s.owner and requestId == s.requestId
pure def accept(s: NamedRead, ownerId: int, requestId: int, target: EventTarget, applied: bool, titleMatches: bool): NamedRead = {
  val admitted = applied and titleMatches and target == s.selected
  { ...s, delivered: if (admitted) target else noTarget, phase: if (admitted) Shared else Refused }
}
pure def canCancel(s: NamedRead): bool = s.phase == Sharing
pure def cancel(s: NamedRead): NamedRead = { ...s, phase: Retired, delivered: noTarget }
pure val ownerIdValues = Set(1, 2)
pure val requestIdValues = Set(1, 2, 3, 4)
pure def alwaysSharedHasSelectedIdentity(s: NamedRead): bool = s.phase == Shared implies s.delivered == s.selected and s.selected.sourceId != "" and s.selected.eventId != ""
pure def alwaysUnsharedHasNoResult(s: NamedRead): bool = s.phase == Shared or s.delivered == noTarget
pure def alwaysActiveHasSelectedIdentity(s: NamedRead): bool = s.phase == Sharing implies s.owner > 0 and s.selected.sourceId != "" and s.selected.eventId != ""
pure def stepOnlyOwnedReceiptShares(before: NamedRead, via: str, after: NamedRead): bool =
  before.phase != Shared and after.phase == Shared implies via == "accept" and before.phase == Sharing and before.owner == after.owner and before.requestId == after.requestId
pure def sometimesShared(s: NamedRead): bool = s.phase == Shared
pure def sometimesRefused(s: NamedRead): bool = s.phase == Refused
```

### Availability publishes only a reviewed projection with matching fresh readback

The coordinator captures the requested dates and time zone, checks
context and device zone before reads, explicitly gets read permission,
and lists available source IDs and revisions. Retry on unavailable source
listing is at most four attempts, with a pause before each retry. The
owner chooses unique offered calendars within the contract limit.
Only a fresh local read of those exact sources produces an availability
projection. Confirmation is for that projection. The second read repeats
the same request and compares the full serialized result. A changed zone,
selection, session, source or projection returns an explicit failure or
cancellation. The read and aggregation shell must validate ranges,
recurrence and source limits and reproduce exact event aggregation.

```quint
type AvailabilityEvidence = { zoneMatches: bool, exactChosenSources: bool, freshLocal: bool, sameReviewedProjection: bool, stillCurrent: bool, confirmed: bool }
pure val evidenceValues = Set({ zoneMatches: true, exactChosenSources: true, freshLocal: true, sameReviewedProjection: true, stillCurrent: true, confirmed: true }, { zoneMatches: true, exactChosenSources: true, freshLocal: true, sameReviewedProjection: false, stillCurrent: true, confirmed: true }, { zoneMatches: false, exactChosenSources: true, freshLocal: true, sameReviewedProjection: true, stillCurrent: true, confirmed: true })
pure def shareAvailability(evidence: AvailabilityEvidence): bool = evidence.zoneMatches and evidence.exactChosenSources and evidence.freshLocal and evidence.sameReviewedProjection and evidence.stillCurrent and evidence.confirmed
pure def lawChangedReadbackDoesNotPublish(evidence: AvailabilityEvidence): bool = shareAvailability(evidence) implies evidence.sameReviewedProjection and evidence.freshLocal and evidence.confirmed and evidence.stillCurrent
pure def retrySourceList(attempt: int, unavailable: bool, currentOwner: bool): bool = unavailable and currentOwner and attempt >= 1 and attempt < 4
pure def lawListingStopsAfterFourthAttempt(attempt: int, unavailable: bool, currentOwner: bool): bool = attempt >= 4 implies not(retrySourceList(attempt, unavailable, currentOwner))
```
