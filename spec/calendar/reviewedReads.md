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

## Story: Propose on my phone only the Calendar request I made

> As the owner, I want a chat request about my phone's calendar to become a
> phone review only for the event, source, name and time that my own words
> and my screen give, and never for one the agent chose.

### A phone Calendar proposal is offered only where its record may be proposed

The turn's screen decides whose calendar records a request is about. A
sensitive screen, or a Calendar screen whose selection is malformed or a
calendar record of another kind, is about no records the agent may name.
A Calendar screen with a phone event or phone calendar selected is about
the phone's records; any other screen is about the app's records. The next
event read may be proposed from any screen; a new event on the phone's own
calendar, a named event and an availability check from Home or Calendar;
a selected read, delete or new event in a chosen calendar only with that
phone record selected. A selected app calendar record is never proposed to
the phone. When the agent keeps its own calendar, a new phone event needs
the phone's record selected or the owner's words naming the phone's
calendar, so one request never writes two stores.

```quint
type CalendarView = HomeView | CalendarAppView | OtherView
type RecordSource = AppRecords | PhoneRecords | UnknownRecords
type ProposalReach = AnyView | HomeOrCalendar | SelectedOnPhone
pure def recordSource(view: CalendarView, sensitive: bool, phoneSelected: bool, otherCalendarSelected: bool): RecordSource =
  if (sensitive) UnknownRecords
  else if (view != CalendarAppView) AppRecords
  else if (phoneSelected) PhoneRecords
  else if (otherCalendarSelected) UnknownRecords
  else AppRecords
pure def reachAdmits(reach: ProposalReach, view: CalendarView, source: RecordSource): bool = match reach {
  | AnyView => true
  | HomeOrCalendar => view != OtherView
  | SelectedOnPhone => source == PhoneRecords
}
pure def calendarProposalAdmitted(reach: ProposalReach, view: CalendarView, source: RecordSource, appSelected: bool, unnamedLocalCreate: bool): bool =
  source != UnknownRecords and not(appSelected) and not(unnamedLocalCreate and source != PhoneRecords) and reachAdmits(reach, view, source)
pure def lawASelectedProposalNeedsAPhoneRecord(view: CalendarView, source: RecordSource, appSelected: bool, unnamedLocalCreate: bool): bool =
  calendarProposalAdmitted(SelectedOnPhone, view, source, appSelected, unnamedLocalCreate) implies source == PhoneRecords
pure def lawAnAppSelectionIsNeverProposed(reach: ProposalReach, view: CalendarView, source: RecordSource, unnamedLocalCreate: bool): bool =
  not(calendarProposalAdmitted(reach, view, source, true, unnamedLocalCreate))
pure def lawASensitiveScreenProposesNothing(view: CalendarView, phoneSelected: bool, otherCalendarSelected: bool): bool =
  recordSource(view, true, phoneSelected, otherCalendarSelected) == UnknownRecords
```

### A selected target, a chosen calendar and a named event are the ones the owner gave

A selected read or delete names exactly the event selected on the phone
screen, by source and event with their revisions, and a new event in a
chosen calendar names exactly the selected calendar; a target the model
wrote that differs offers nothing. A named delete or change names an event
whose name is in the owner's own words. The agent never proposes a named
read of its own: a named read is offered only as the first step of a change
the owner asked for.

```quint
pure def targetGrounded(selectionKnown: bool, sameAsSelected: bool): bool = selectionKnown and sameAsSelected
pure def namedGrounded(nameInOwnerWords: bool, ownerAskedTheChange: bool): bool = nameInOwnerWords and ownerAskedTheChange
pure def lawAnUnselectedTargetIsNeverProposed(sameAsSelected: bool): bool = not(targetGrounded(false, sameAsSelected))
pure def lawAnUnnamedEventIsNeverProposed(ownerAskedTheChange: bool): bool = not(namedGrounded(false, ownerAskedTheChange))
```

### A delete is proposed only when the owner's own words ask for it, and a no keeps the event

An owner who turns a delete down has asked for nothing, so no delete is
proposed from those words, even when the model proposes one; a delete the
owner declined on the phone stays declined. A decline is a reply that opens
by turning the request down ("no, keep it", "never mind", "wait"), the whole
reply "cancel that", or a negation of the delete itself ("don't delete
it"). Other negative words in a request that asks to delete ("delete my
3pm, I don't need it", "cancel the lunch, we're not meeting") are not a
decline.

```quint
pure def deleteAsked(asksToDelete: bool, declines: bool): bool = asksToDelete and not(declines)
pure def lawADeclineIsNeverADelete(asksToDelete: bool): bool = not(deleteAsked(asksToDelete, true))
```

### A new phone event starts at the day and time the owner stated, in the phone's zone

A new event is proposed only when the owner's words state its day and one
clock time, the phone reported its zone, the owner named no other zone or
offset ("3pm Tokyo time", "15:00 UTC"), the title is in the owner's own
words, and the request asks for nothing one timed event cannot hold: a
repeat, guests or an all-day event. Its start is that day and time on the
phone's clock, and a time the clock skips or repeats, at its start or at
the end of a stated range, offers nothing. Its end is the end of a stated
range, else the start plus a stated length, else the start plus the length
the model proposed, else one hour later. The zone is the phone's, never
one the model chose. A description or location is kept only when the
owner's words state it, and is otherwise left empty.

```quint
type StatedClock = NoClock | OneClock | SeveralClocks
pure def newEventStated(dayStated: bool, clock: StatedClock, phoneZoneKnown: bool, otherZoneNamed: bool, unsupportedAsked: bool, wallTimeExists: bool, titleInOwnerWords: bool): bool =
  dayStated and clock == OneClock and phoneZoneKnown and not(otherZoneNamed) and not(unsupportedAsked) and wallTimeExists and titleInOwnerWords
pure def statedEnd(startsAt: int, rangeEnd: int, statedLength: int, proposedLength: int): int =
  if (rangeEnd > startsAt) rangeEnd
  else if (statedLength > 0) startsAt + statedLength
  else if (proposedLength > 0) startsAt + proposedLength
  else startsAt + 3600000
pure def ownerWordsKept(stated: bool, proposed: str): str = if (stated) proposed else ""
pure def lawAStatedEventEndsAfterItStarts(startsAt: int, rangeEnd: int, statedLength: int, proposedLength: int): bool =
  statedEnd(startsAt, rangeEnd, statedLength, proposedLength) > startsAt
pure def lawSeveralClocksAreNeverAStart(dayStated: bool, phoneZoneKnown: bool, otherZoneNamed: bool, unsupportedAsked: bool, wallTimeExists: bool, titleInOwnerWords: bool): bool =
  not(newEventStated(dayStated, SeveralClocks, phoneZoneKnown, otherZoneNamed, unsupportedAsked, wallTimeExists, titleInOwnerWords))
pure def lawAnotherZoneIsNeverAStart(dayStated: bool, clock: StatedClock, phoneZoneKnown: bool, unsupportedAsked: bool, wallTimeExists: bool, titleInOwnerWords: bool): bool =
  not(newEventStated(dayStated, clock, phoneZoneKnown, true, unsupportedAsked, wallTimeExists, titleInOwnerWords))
pure def lawUnstatedWordsAreNeverKept(proposed: str): bool = ownerWordsKept(false, proposed) == ""
```

### A change after a shared read moves the event to the day and time the owner gave it, keeping its length unless the owner gave one

A change to an event is proposed in two steps: a read of the selected or
named event, which the owner shares, and then the edit, prepared from the
shared record and the owner's original words with no model call. The
change is read from the owner's words when the read is proposed, and the
edit after it is the same change. A change is asked only when the request
opens with the change itself ("move", "reschedule", "change", "rename",
"call it", after "please", "can you" or "I want to"); "don't rename it",
"how do I move this event?" or "what is this meeting about?" ask for none.
A selected read that asks for no change is shared as a read and prepares
no edit; a named read is proposed only for a change.

A change is either a new title or a new time, one at a time. A rename takes
the new title exactly as the owner wrote it and keeps every other field. A
time change takes its clock time from the words after the destination
marker ("to", or "for", "until" or "till" before a day or time), and its
day from those words too, else the event keeps its own day on the phone's
clock: "reschedule the standup for tomorrow at 10am" moves the standup to
tomorrow and never looks for a standup tomorrow, and "move my 3pm to 4pm"
keeps its day. It keeps the event's length unless the owner states exactly
one length, and it is placed on the clock the phone reported for the
original turn, never on the event's own zone.

The read is refused before it is proposed, with words telling the owner
what to say, when the phone reported no zone for the turn, when the request
asks for a rename and a time change together, when it is compound or
conditional, names a zone, a calendar or a part beyond the title and time
(location, description, notes, guests, repeats), or when a time change
states no single clock time, several lengths, or a day and time the clock
skips or repeats. An edit that the shared record still cannot hold, such as
a named read that matched no event or a kept day whose time the clock skips,
offers nothing.

```quint
type ChangeAsked = NoChangeAsked | RenameAsked | TimeChangeAsked | SeveralChangesAsked | OtherChangeAsked
pure def changeOf(leadsWithChange: bool, renameAsked: bool, moveAsked: bool, otherAsked: bool): ChangeAsked =
  if (not(leadsWithChange)) NoChangeAsked
  else if (otherAsked) OtherChangeAsked
  else if (renameAsked and moveAsked) SeveralChangesAsked
  else if (renameAsked) RenameAsked
  else if (moveAsked) TimeChangeAsked
  else OtherChangeAsked
pure def timeChangeStated(clock: StatedClock, lengthsStated: int, wallTimeExists: bool): bool =
  clock == OneClock and lengthsStated <= 1 and wallTimeExists
pure def editAfterRead(change: ChangeAsked, timeStated: bool): bool =
  change == RenameAsked or (change == TimeChangeAsked and timeStated)
pure def changeReadAdmitted(change: ChangeAsked, timeStated: bool, phoneZoneKnown: bool, byName: bool): bool =
  if (change == NoChangeAsked) not(byName) else editAfterRead(change, timeStated) and phoneZoneKnown
pure def changedEnd(newStart: int, oldStart: int, oldEnd: int, statedLength: int): int =
  if (statedLength > 0) newStart + statedLength else newStart + (oldEnd - oldStart)
pure def lawAnUnstatedLengthIsKept(newStart: int, oldStart: int, oldEnd: int): bool =
  changedEnd(newStart, oldStart, oldEnd, 0) - newStart == oldEnd - oldStart
pure def lawACompoundRequestIsNeverAnEdit(leadsWithChange: bool, renameAsked: bool, moveAsked: bool, timeStated: bool): bool =
  not(editAfterRead(changeOf(leadsWithChange, renameAsked, moveAsked, true), timeStated))
pure def lawARenameAndAMoveAreNeverOneEdit(timeStated: bool): bool =
  not(editAfterRead(changeOf(true, true, true, false), timeStated))
pure def lawAnUnaskedChangeIsNeverAnEdit(renameAsked: bool, moveAsked: bool, otherAsked: bool, timeStated: bool): bool =
  not(editAfterRead(changeOf(false, renameAsked, moveAsked, otherAsked), timeStated))
pure def lawAChangeReadNeedsThePhoneZone(change: ChangeAsked, timeStated: bool, byName: bool): bool =
  changeReadAdmitted(change, timeStated, false, byName) implies change == NoChangeAsked
pure def lawANamedReadIsAlwaysAChange(change: ChangeAsked, timeStated: bool, phoneZoneKnown: bool): bool =
  changeReadAdmitted(change, timeStated, phoneZoneKnown, true) implies editAfterRead(change, timeStated)
```
