# Reviewed Calendar reads

A selected event and an availability answer reach the agent only through
a current result receipt of a read the owner reviewed. A reviewed read
never edits the calendar. [Workflow admission](../workflow/admission.md)
owns workflow authority and schedule.

## Story: Share only the exact current Calendar information I reviewed

> As the owner, I want the agent to see only the calendar information I
> reviewed, and only while it is still what I reviewed.

### A named read opens Share for the owner's existing selected event

The active context must be Calendar, nonsensitive and hold a valid
selected event, identified by source and event with their revisions. The
operation requires both the named-read and the scoped Calendar
capability. It shares the whole event only from an applied receipt for
the exact selected target, from a complete feed, whose fresh title
matches the request (normalized, case-insensitive containment). A stale
or non-applied receipt, a partial feed, a new search, an inferred target
or a substituted provider shares nothing, and nothing is written.
Switching owner or cancelling retires the read.

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
pure def accept(s: NamedRead, ownerId: int, requestId: int, target: EventTarget, applied: bool, titleMatches: bool, feedComplete: bool): NamedRead = {
  val admitted = applied and titleMatches and feedComplete and target == s.selected
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

### The read window covers the whole second around the selected start

The provider filters by whole seconds, so the read window runs from the
second before the start's second to the second after it, and an event
with a fractional start or a one-millisecond duration is never lost. The
window only finds the record; it grants no authority to read.

```quint
pure def wholeSecond(ms: int): int = (ms / 1000) * 1000
pure def windowIncludes(startMs: int, durationMs: int): bool =
  startMs < wholeSecond(startMs + 1000) and startMs + durationMs > wholeSecond(startMs - 1000)
pure def lawWholeSecondWindowIncludesSelection(startMs: int, durationMs: int): bool =
  startMs >= 1000 and durationMs >= 1 implies windowIncludes(startMs, durationMs)
pure val startMsValues = Set(10000, 10500, 10999)
pure val durationMsValues = Set(1, 1000)
```

### Availability publishes only a reviewed projection with matching fresh readback

The coordinator captures the requested dates and time zone, checks
context and device zone before reads, explicitly gets read permission,
and lists available source IDs and revisions. Retry on unavailable source
listing is retried a bounded number of times. The owner chooses unique offered calendars within the contract limit.
Only a fresh local read of those exact sources produces an availability
projection. Confirmation is for that projection. The second read repeats
the same request and compares the full serialized result. A changed zone,
selection, session, source or projection returns an explicit failure or
cancellation. [Availability](./availability.md) owns the projection itself.

```quint
type AvailabilityEvidence = { zoneMatches: bool, exactChosenSources: bool, freshLocal: bool, sameReviewedProjection: bool, stillCurrent: bool, confirmed: bool }
pure val evidenceValues = Set({ zoneMatches: true, exactChosenSources: true, freshLocal: true, sameReviewedProjection: true, stillCurrent: true, confirmed: true }, { zoneMatches: true, exactChosenSources: true, freshLocal: true, sameReviewedProjection: false, stillCurrent: true, confirmed: true }, { zoneMatches: false, exactChosenSources: true, freshLocal: true, sameReviewedProjection: true, stillCurrent: true, confirmed: true })
pure def shareAvailability(evidence: AvailabilityEvidence): bool = evidence.zoneMatches and evidence.exactChosenSources and evidence.freshLocal and evidence.sameReviewedProjection and evidence.stillCurrent and evidence.confirmed
pure def lawChangedReadbackDoesNotPublish(evidence: AvailabilityEvidence): bool = shareAvailability(evidence) implies evidence.sameReviewedProjection and evidence.freshLocal and evidence.confirmed and evidence.stillCurrent
```
