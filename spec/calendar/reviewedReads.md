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
the phone. A new event on the phone's own calendar is offered wherever the
phone negotiated it, beside the agent's own calendar: the model reads from
the owner's request which calendar it names, so one request writes one
store, and code matches no calendar words.

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
pure def calendarProposalAdmitted(reach: ProposalReach, view: CalendarView, source: RecordSource, appSelected: bool): bool =
  source != UnknownRecords and not(appSelected) and reachAdmits(reach, view, source)
pure def lawASelectedProposalNeedsAPhoneRecord(view: CalendarView, source: RecordSource, appSelected: bool): bool =
  calendarProposalAdmitted(SelectedOnPhone, view, source, appSelected) implies source == PhoneRecords
pure def lawAnAppSelectionIsNeverProposed(reach: ProposalReach, view: CalendarView, source: RecordSource): bool =
  not(calendarProposalAdmitted(reach, view, source, true))
pure def lawASensitiveScreenProposesNothing(view: CalendarView, phoneSelected: bool, otherCalendarSelected: bool): bool =
  recordSource(view, true, phoneSelected, otherCalendarSelected) == UnknownRecords
```

### A selected target, a chosen calendar and a named event are the ones the owner gave

A selected read or delete names exactly the event selected on the phone
screen, by source and event with their revisions, and a new event in a
chosen calendar names exactly the selected calendar; a target the model
wrote that differs offers nothing. A named delete or change names an event
whose name is in the owner's own words: its words appear whole and in order
among theirs, so "dentist" is not named in "dentistry". Chinese and
Japanese write no space between words and Korean joins a particle to the
word, so a name in Han, Hiragana, Katakana or Hangul script is also named
when the owner's whole request is that exact name with the delete verb
("删除牙医预约", "歯医者を削除して", "치과를 삭제해줘"); a longer name that only
holds it ("小児歯医者を削除して") does not name it. A named read is the first
step of a change, so it is offered only when [the change can follow
it](#a-change-after-a-shared-read-is-the-edit-the-model-read-from-the-owners-request-keeping-every-other-field).
Whether the owner asked to delete, or turned a delete down, is the model's
reading of the request; code matches no delete or decline words, and
every phone delete, selected or named, is a review the owner approves on
the phone.

```quint
pure def targetGrounded(selectionKnown: bool, sameAsSelected: bool): bool = selectionKnown and sameAsSelected
pure def nameSaid(wholeWordsSaid: bool, denseScriptName: bool, wholeDenseDelete: bool): bool =
  wholeWordsSaid or (denseScriptName and wholeDenseDelete)
pure def namedGrounded(nameInOwnerWords: bool, changeCanFollow: bool): bool = nameInOwnerWords and changeCanFollow
pure def lawAnUnselectedTargetIsNeverProposed(sameAsSelected: bool): bool = not(targetGrounded(false, sameAsSelected))
pure def lawAnUnnamedEventIsNeverProposed(changeCanFollow: bool): bool = not(namedGrounded(false, changeCanFollow))
pure def lawASpacedNameNeedsItsWholeWords(wholeDenseDelete: bool): bool = not(nameSaid(false, false, wholeDenseDelete))
pure def lawADenseNameIsNamedByItsWholeDelete(wholeWordsSaid: bool): bool = nameSaid(wholeWordsSaid, true, true)
```

### A new phone event is the timed event the model read, at a clock time the owner said, on the phone's clock

A new event is proposed with the title, start and end the model read from
the owner's request; code reads no day or time from the words. It is
proposed only when the phone reported its zone for the turn and the model
placed the event on that zone (a time in another zone the owner named,
"3pm Tokyo time", offers nothing and asks for the phone's clock), its
start is a clock time the owner's words hold, as a [stated clock
is](./readClock.md#a-clock-time-the-owner-stated-is-one-the-owners-words-hold),
on that clock, its start is still ahead of the turn, and the title's
words are among the owner's; the phone's operation already holds an end
after its start. One phone event holds
no repeat, guests or all-day time, so the model sends those to the
Calendar action instead; code reads no repeat words, so a one-off phone
event the model sent for a repeating request is proposed as that one
event, which the owner sees as one event on the review before it is saved. A description or location is kept only when its
words are among the owner's, and is otherwise left empty. A start or end
the model wrote with its offset ("2026-11-27T12:00:00-08:00") is that same
instant, written in UTC before the operation is checked, for a new event
and for an availability window alike; a time with no offset names no
instant and is checked as sent.

```quint
pure def newEventStated(phoneZoneKnown: bool, onPhoneZone: bool, startHeldByOwnerWords: bool, startAhead: bool, titleInOwnerWords: bool): bool =
  phoneZoneKnown and onPhoneZone and startHeldByOwnerWords and startAhead and titleInOwnerWords
pure def ownerWordsKept(stated: bool, proposed: str): str = if (stated) proposed else ""
pure def lawAnotherZoneIsNeverAStart(phoneZoneKnown: bool, startHeldByOwnerWords: bool, startAhead: bool, titleInOwnerWords: bool): bool =
  not(newEventStated(phoneZoneKnown, false, startHeldByOwnerWords, startAhead, titleInOwnerWords))
pure def lawAnUnsaidClockIsNeverAStart(phoneZoneKnown: bool, onPhoneZone: bool, startAhead: bool, titleInOwnerWords: bool): bool =
  not(newEventStated(phoneZoneKnown, onPhoneZone, false, startAhead, titleInOwnerWords))
pure def lawAPastStartIsNeverProposed(phoneZoneKnown: bool, onPhoneZone: bool, startHeldByOwnerWords: bool, titleInOwnerWords: bool): bool =
  not(newEventStated(phoneZoneKnown, onPhoneZone, startHeldByOwnerWords, false, titleInOwnerWords))
pure def lawUnstatedWordsAreNeverKept(proposed: str): bool = ownerWordsKept(false, proposed) == ""
```

### A change after a shared read is the edit the model read from the owner's request, keeping every other field

A change to an event is proposed in two steps: a read of the selected or
named event, which the owner shares, and then the edit. After the share
the model reads the edit from the shared record and the owner's original
request, in any language, and returns it as JSON: the new title, place,
notes, start, end and zone the request asks for, that it asks for no
change, or a question when the change is not fully said. Code reads no
change from the words; it checks what the model returned instead. A new
title, place or notes is kept only when its words are among the owner's;
a start or end is a canonical UTC instant and a zone a known IANA zone;
every part the model did not return is kept. Anything else the model
returned, or no answer at all, is no edit.

A read of a named event is proposed only when a change can follow it: the
phone reported its zone for the turn and can finish a read for this turn.
Otherwise it is refused with words telling the owner why. A read for
which the model returns no change, or no edit it can hold, is answered as
a read: the model answers the owner's request from the record they
shared, in its own words, and nothing is proposed, so a question about
the event is always answered. A question the model returned is asked in
its own words. An edit that the shared record still cannot hold offers
nothing and answers the owner in fixed words instead of the model's: a
named read that matched no event, an end not after its start, or an edit
that changes nothing. A prepared edit answers that it is ready for its
review and that nothing has changed yet. A selected read on a phone that
reported no zone is answered as a read and proposes no change.

```quint
type EditRead = EditReturned | NoChangeReturned | QuestionReturned | EditUnreadable
type EditPrepared = EditReady | NoEventMatched | EndNotAfterStart | NothingToChange | AnswersTheRead | AsksTheOwner
pure def changeReadAdmitted(phoneZoneKnown: bool, readsComplete: bool): bool = phoneZoneKnown and readsComplete
pure def preparedEdit(eventMatched: bool, read: EditRead, endAfterStart: bool, changesSomething: bool): EditPrepared =
  if (not(eventMatched)) NoEventMatched
  else if (read == NoChangeReturned or read == EditUnreadable) AnswersTheRead
  else if (read == QuestionReturned) AsksTheOwner
  else if (not(endAfterStart)) EndNotAfterStart
  else if (not(changesSomething)) NothingToChange
  else EditReady
pure def lawAChangeReadNeedsThePhoneZoneAndACompletedRead(phoneZoneKnown: bool, readsComplete: bool): bool =
  changeReadAdmitted(phoneZoneKnown, readsComplete) iff (phoneZoneKnown and readsComplete)
pure def lawOnlyAHoldableEditIsReady(eventMatched: bool, read: EditRead, endAfterStart: bool, changesSomething: bool): bool =
  (preparedEdit(eventMatched, read, endAfterStart, changesSomething) == EditReady) iff (eventMatched and read == EditReturned and endAfterStart and changesSomething)
pure def lawAnUnreadableEditAnswersTheRead(endAfterStart: bool, changesSomething: bool): bool =
  preparedEdit(true, EditUnreadable, endAfterStart, changesSomething) == AnswersTheRead
pure def lawAReadAskingNoChangeIsAnswered(endAfterStart: bool, changesSomething: bool): bool =
  preparedEdit(true, NoChangeReturned, endAfterStart, changesSomething) == AnswersTheRead
```
