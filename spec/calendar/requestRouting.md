# Calendar requests across views

## Story: Change a calendar event from the view I am using

> As the owner, I want to ask to create, move or delete an event while
> another view is open, and keep any other work I asked for.

### An explicit event change adds Calendar relevance only to its admitted action

The Calendar plugin reads the current owner's original words. A named
event request can supply a fixed Calendar note and an action-local
Calendar context without reading any events. Ordinary references to
another app's records, pronouns without a current target, and requests
for the phone's system calendar add no resident Calendar context.
Neither the current view nor the suggested action changes which tools
the launch and turn allow.

```quint
type CalendarIntent = NoEventIntent | CreateEventIntent | UpdateEventIntent | DeleteEventIntent
pure def relevantCalendarIntent(words: CalendarIntent, privateOwner: bool, calendarOffered: bool): CalendarIntent =
  if (privateOwner and calendarOffered) words else NoEventIntent
pure def lawNoCalendarRelevanceWithoutPrivateOwner(words: CalendarIntent, calendarOffered: bool): bool =
  relevantCalendarIntent(words, false, calendarOffered) == NoEventIntent
pure def lawNoCalendarRelevanceWithoutOfferedAction(words: CalendarIntent, privateOwner: bool): bool =
  relevantCalendarIntent(words, privateOwner, false) == NoEventIntent
pure def canAddEventContext(relevant: CalendarIntent, called: CalendarIntent): bool =
  relevant != NoEventIntent and relevant == called
pure def lawTheAddedContextIsOnlyForTheAskedOperation(relevant: CalendarIntent, called: CalendarIntent): bool =
  canAddEventContext(relevant, called) implies relevant == called
```

The note identifies the applicable Calendar operation and carries no
event title, provider data or view selection. Dispatch still has to pass
the action's own owner, audience, target and review rules.

### A dense delete request reaches Calendar and the named title decides the target

A Chinese, Japanese or Korean delete command of the form recognized by
the Calendar action adds delete context for that operation. Its explicit
title takes priority over a selected event on the screen. A new deletion
still requires a complete read and exactly one named resident occurrence
to run immediately. A pending confirmation keeps its existing checks.

```quint
pure def denseCalendarDeleteContext(matchesDenseDelete: bool): CalendarIntent =
  if (matchesDenseDelete) DeleteEventIntent else NoEventIntent
pure def selectedCalendarDeleteTarget(matchesDenseDelete: bool, selected: bool): bool =
  not(matchesDenseDelete) and selected
pure def lawDenseDeleteAddsOnlyDeleteContext(matchesDenseDelete: bool): bool =
  matchesDenseDelete iff denseCalendarDeleteContext(matchesDenseDelete) == DeleteEventIntent
pure def lawDenseDeleteNeverUsesTheSelection(selected: bool): bool =
  not(selectedCalendarDeleteTarget(true, selected))
```

### A short answer applies only to the immediately preceding Calendar question

The agent takes the preceding ordinary reply from the same private owner
conversation and checks its originating message and the exact Calendar
question text. For a reply with reported audio playback it uses the heard
portion. A recognized answer to that live question adds only the
confirmation operation. That operation takes no target, scope or notice
fields from the model.

```quint
pure def calendarAnswerAdmitted(answerRecognized: bool, liveQuestion: bool, sameOrigin: bool, promptPresent: bool): bool =
  answerRecognized and liveQuestion and sameOrigin and promptPresent
pure def lawAnotherPromptDoesNotAdmitTheAnswer(answerRecognized: bool, liveQuestion: bool, sameOrigin: bool, promptPresent: bool): bool =
  (not(sameOrigin) or not(promptPresent)) implies not(calendarAnswerAdmitted(answerRecognized, liveQuestion, sameOrigin, promptPresent))
```

## Story: Check my calendar availability from the view I am using

> As the owner, I want to check whether an interval is free or find an
> opening of the length I asked for while I keep using another view.

### A private availability request adds Calendar relevance for its own read

A first-person free-time question with a date or time can admit an
aggregate resident Calendar check. A request for an opening with one
stated length admits only a slot search of that length. A request to
find an opening without its length asks for that detail. A duration
from a separate requested task does not become the opening length.
An explicit phone Calendar request, or one served by the current live
phone Calendar availability proposal, does not add resident relevance.
Relevance never adds Calendar context for a write or a narrowed
Calendar source. The ordinary availability action checks the time
window and requires a complete read.

```quint
type AvailabilityIntent = NoAvailability | CheckInterval | FindOpening({ minutes: int }) | NeedOpeningLength
pure val availabilityAskedValues = Set(NoAvailability, CheckInterval, FindOpening({ minutes: 4 }), FindOpening({ minutes: 5 }), FindOpening({ minutes: 20 }), FindOpening({ minutes: 30 }), FindOpening({ minutes: 480 }), FindOpening({ minutes: 481 }), NeedOpeningLength)
pure val availabilityCalledValues = availabilityAskedValues
pure def residentAvailabilityIntent(availabilityAsked: AvailabilityIntent, phoneOwns: bool): AvailabilityIntent =
  if (phoneOwns) NoAvailability else availabilityAsked
pure def availabilityCallAdmitted(availabilityAsked: AvailabilityIntent, availabilityCalled: AvailabilityIntent, scoped: bool): bool =
  not(scoped) and match availabilityAsked {
    | CheckInterval => availabilityCalled == CheckInterval
    | FindOpening(n) => availabilityCalled == FindOpening(n) and n.minutes >= 5 and n.minutes <= 480
    | _ => false
  }
pure def lawPhoneAvailabilityDoesNotAdmitAResidentRead(availabilityAsked: AvailabilityIntent): bool =
  residentAvailabilityIntent(availabilityAsked, true) == NoAvailability
pure def lawAvailabilityDoesNotAddASourceOrOtherOperation(availabilityAsked: AvailabilityIntent, availabilityCalled: AvailabilityIntent, scoped: bool): bool =
  availabilityCallAdmitted(availabilityAsked, availabilityCalled, scoped) implies not(scoped) and availabilityAsked == availabilityCalled and availabilityCalled != NoAvailability and availabilityCalled != NeedOpeningLength
pure def lawAnOpeningNeedsTheOwnersDuration(minutes: int, proposed: int): bool =
  availabilityCallAdmitted(FindOpening({ minutes: minutes }), FindOpening({ minutes: proposed }), false) implies proposed == minutes
```
