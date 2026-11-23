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
