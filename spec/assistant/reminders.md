# Reminders

A reminder is created from what the owner said. The planner proposes a
reminder plan: when it is due and on which clock, where to deliver it and
how loudly to alert. Before anything is written, the owner's original
message is checked again to confirm that it asked for this reminder; a
plan alone never grants the authority to write one. This machine follows
one fresh creation.

The clock is either UTC or the owner's local clock. A delivery choice
(destination or alert) is either unknown or one of two resolved
alternatives; how a destination or alert is presented, and how a reminder
later fires on the device, belong to the device and its reminder journal.

## Story: Create the reminder I asked for, and only that

> As an owner, I want the agent to write a reminder only when I asked for
> one, exactly as planned, and never twice.

### A reminder intent is proposed with a plan and what the original message asked

The verification of the original message reports whether it asked for a
reminder, the clock it names, any delivery choices it states, and whether
it says the reminder is important or urgent.

Core's catalog gives the reminders action the general context every owner turn is
planned in, beside its tasks and automation contexts, so the owner can set
a reminder from any chat, as on the phone before VibeStack; its owner role
gate and the checks below are unchanged.

A plan's due time is a duration, an instant with its offset, a wall time
on a day of the owner's clock, a day alone, which comes at 09:00 that day
as a deadline "by the 20th" does, a repeat at a wall time every day or
on the weekdays the owner named, or a repeat on an interval ("every two
hours"). A repeat keeps the owner's clock and follows it when they state a
new zone.

The reminders action tells the model every field of the plan and of each
kind of due time, with its type, so a plan in that shape is accepted as
the action's arguments and reaches the check below. A plan that leaves out
a delivery choice leaves it unknown, as one that gives it as null does.

```quint
type ReminderPhase = NoReminderIntent | IntentPending | IntentReady | IntentRejected | IntentCancelled | ReminderSaved
type ReminderClock = UtcClock | OwnerLocalClock
type DeliveryChoice = UnknownChoice | FirstChoice | SecondChoice
type ReminderIntent = { reminderPhase: ReminderPhase, requested: bool, checked: bool, writes: int,
  plannedClock: ReminderClock, extractedClock: ReminderClock, savedClock: ReminderClock,
  plannedDestination: DeliveryChoice, extractedDestination: DeliveryChoice, savedDestination: DeliveryChoice,
  plannedAlert: DeliveryChoice, extractedAlert: DeliveryChoice, savedAlert: DeliveryChoice, saidHigh: bool, savedHigh: bool }
pure val initial: ReminderIntent = { reminderPhase: NoReminderIntent, requested: false, checked: false, writes: 0,
  plannedClock: UtcClock, extractedClock: UtcClock, savedClock: UtcClock,
  plannedDestination: UnknownChoice, extractedDestination: UnknownChoice, savedDestination: UnknownChoice,
  plannedAlert: UnknownChoice, extractedAlert: UnknownChoice, savedAlert: UnknownChoice, saidHigh: false, savedHigh: false }
pure def canProposeReminder(s: ReminderIntent): bool = s.reminderPhase == NoReminderIntent
pure def proposeReminder(s: ReminderIntent, requested: bool, plannedClock: ReminderClock, extractedClock: ReminderClock, plannedDestination: DeliveryChoice, extractedDestination: DeliveryChoice, plannedAlert: DeliveryChoice, extractedAlert: DeliveryChoice, saidHigh: bool): ReminderIntent =
  { ...s, reminderPhase: IntentPending, requested: requested, plannedClock: plannedClock, extractedClock: extractedClock,
    plannedDestination: plannedDestination, extractedDestination: extractedDestination, plannedAlert: plannedAlert, extractedAlert: extractedAlert, saidHigh: saidHigh }
```

### The original message is checked before a reminder is written

A check that finds the message asked for the reminder makes it ready; one
that finds it did not, or a check that cannot run, rejects it. The owner
may cancel before it is written. The check sends no client output limit
and supplies the `low` thinking hint
of [model binding](../agent/models/binding.md), so a model that documents
a reasoning effort spends a bounded one on this yes-or-no reading instead
of its default.

```quint
pure def canCheckRequest(s: ReminderIntent): bool = s.reminderPhase == IntentPending
pure def checkRequest(s: ReminderIntent): ReminderIntent = { ...s, checked: true, reminderPhase: if (s.requested) IntentReady else IntentRejected }
pure def canCheckUnavailable(s: ReminderIntent): bool = s.reminderPhase == IntentPending
pure def checkUnavailable(s: ReminderIntent): ReminderIntent = { ...s, reminderPhase: IntentRejected }
pure def canCancelReminder(s: ReminderIntent): bool = s.reminderPhase == IntentPending or s.reminderPhase == IntentReady
pure def cancelReminder(s: ReminderIntent): ReminderIntent = { ...s, reminderPhase: IntentCancelled }
pure def alwaysCheckedBeforeWrite(s: ReminderIntent): bool = s.writes > 0 implies (s.checked and s.requested)
```

### An alert nobody stated is an alert

The first alternative of the alert choice is an alert and the second a
silent reminder. A reminder alerts unless the owner asked for a silent
one: when neither the plan nor the message states the choice, it is saved
with an alert, and the owner is not asked.

```quint
pure def alertWhenUnstated(stated: DeliveryChoice): DeliveryChoice = if (stated == UnknownChoice) FirstChoice else stated
pure def lawAnUnstatedAlertIsAnAlert(stated: DeliveryChoice): bool =
  alertWhenUnstated(stated) != UnknownChoice and (stated != UnknownChoice implies alertWhenUnstated(stated) == stated)
```

### A reminder is written at most once, and a refusal writes nothing

```quint
pure def recoveredChoice(planned: DeliveryChoice, extracted: DeliveryChoice): DeliveryChoice = if (planned != UnknownChoice) planned else extracted
pure def canSaveReminder(s: ReminderIntent): bool = s.reminderPhase == IntentReady and s.checked and s.requested
pure def saveReminder(s: ReminderIntent): ReminderIntent =
  { ...s, reminderPhase: ReminderSaved, writes: s.writes + 1, savedClock: s.plannedClock,
    savedDestination: recoveredChoice(s.plannedDestination, s.extractedDestination),
    savedAlert: alertWhenUnstated(recoveredChoice(s.plannedAlert, s.extractedAlert)), savedHigh: s.saidHigh }
pure def alwaysWrittenAtMostOnce(s: ReminderIntent): bool = s.writes >= 0 and s.writes <= 1 and ((s.writes == 1) == (s.reminderPhase == ReminderSaved))
pure def alwaysRefusalWritesNothing(s: ReminderIntent): bool = (s.reminderPhase == IntentRejected or s.reminderPhase == IntentCancelled) implies s.writes == 0
```

### The written reminder keeps the planned clock

The clock the message names never overrides the clock of a complete plan.

```quint
pure def alwaysPlannedClockKept(s: ReminderIntent): bool = s.writes > 0 implies s.savedClock == s.plannedClock
```

### A known delivery choice is kept, and only an unknown one is taken from the message

An alert choice that the message leaves unknown too is saved as an alert.

```quint
pure def alwaysDeliveryChoicesKept(s: ReminderIntent): bool =
  s.writes > 0 implies (s.savedDestination == recoveredChoice(s.plannedDestination, s.extractedDestination)
    and s.savedAlert == alertWhenUnstated(recoveredChoice(s.plannedAlert, s.extractedAlert)))
pure def sometimesSavedWithAnUnstatedAlert(s: ReminderIntent): bool =
  s.reminderPhase == ReminderSaved and s.plannedAlert == UnknownChoice and s.extractedAlert == UnknownChoice and s.savedAlert == FirstChoice
```

### A silent reminder comes due without a phone notification

A reminder saved with an alert notifies the phone when it comes due and
posts its text in the conversation it was asked in. One saved silent
only posts its text in that conversation, and with no conversation it
comes due unannounced, still listed with the owner's reminders.

```quint
type DueNotice = NotifiesPhone | ConversationOnly | Unannounced
pure def firstAlert(savedAlert: DeliveryChoice, hasConversation: bool): DueNotice =
  if (savedAlert != SecondChoice) NotifiesPhone else if (hasConversation) ConversationOnly else Unannounced
pure def lawASilentReminderNeverNotifiesThePhone(hasConversation: bool): bool = firstAlert(SecondChoice, hasConversation) != NotifiesPhone
pure def lawAnAlertingReminderNotifiesThePhone(hasConversation: bool): bool = firstAlert(FirstChoice, hasConversation) == NotifiesPhone
```

### A reminder for a day comes at 09:00 that day, and a repeat at its time on the days it names, or every day when it names none

A reminder asked for a day without a time, as a deadline "by the 25th"
is, comes at 09:00 on that day on the owner's clock. A repeat at a time
comes at that time on each weekday it names, and every day when it names
no day or names all seven, which the reply then calls every day.

```quint
pure val dayReminderMinute = 540
pure def repeatsOnDay(namedDays: int, namesThisDay: bool): bool = namedDays == 0 or namesThisDay
pure def lawARepeatNamingNoDayComesEveryDay(namesThisDay: bool): bool = repeatsOnDay(0, namesThisDay)
pure def lawARepeatNamingDaysComesOnlyOnThem(namedDays: int): bool = namedDays > 0 implies not(repeatsOnDay(namedDays, false))
```

### A reminder repeats on an interval only when the interval divides the hour or the day evenly

An interval is whole minutes, from five minutes to a day. One shorter
than an hour must divide the hour, and a longer one must be whole hours
that divide the day, so every firing keeps its place on the owner's clock:
every 5, 6, 10, 12, 15, 20 or 30 minutes, or every 1, 2, 3, 4, 6, 8, 12 or
24 hours. The first firing comes one interval after the request. Any other
interval saves nothing, and the reply names the intervals that repeat.

```quint
pure val everyMinutesValues = Set(0, 4, 5, 7, 20, 45, 60, 90, 120, 300, 1440, 2880)
pure def intervalRepeats(everyMinutes: int): bool =
  if (everyMinutes < 5 or everyMinutes > 1440) false
  else if (everyMinutes < 60) 60 % everyMinutes == 0
  else everyMinutes % 60 == 0 and 1440 % everyMinutes == 0
pure def lawAnIntervalUnderFiveMinutesNeverRepeats(everyMinutes: int): bool = everyMinutes < 5 implies not(intervalRepeats(everyMinutes))
pure def lawAnIntervalLongerThanADayNeverRepeats(everyMinutes: int): bool = everyMinutes > 1440 implies not(intervalRepeats(everyMinutes))
pure def lawAnIntervalOfHoursIsWholeHours(everyMinutes: int): bool =
  (everyMinutes >= 60 and intervalRepeats(everyMinutes)) implies everyMinutes % 60 == 0
```

### A reminder is high priority only when the owner's message says so

The plan's priority never makes a reminder high priority: only the
owner's own message, read again, saying it is important or urgent does,
and a message that says nothing of it saves a normal one.

```quint
pure def alwaysHighPriorityOnlyWhenSaid(s: ReminderIntent): bool = s.writes > 0 implies s.savedHigh == s.saidHigh
pure def sometimesSavedHighPriority(s: ReminderIntent): bool = s.reminderPhase == ReminderSaved and s.savedHigh
```

### A proposed reminder is settled

```quint
pure val fair_checkRequest = "weak"
pure val fair_saveReminder = "weak"
pure def leadsToReminderSettles(s: ReminderIntent, later: ReminderIntent): bool =
  (s.reminderPhase == IntentPending or s.reminderPhase == IntentReady) implies
    (later.reminderPhase == ReminderSaved or later.reminderPhase == IntentRejected or later.reminderPhase == IntentCancelled)
```

### A reminder can be saved with a choice taken from the message, rejected, or cancelled

```quint
pure def sometimesSavedWithRecoveredDestination(s: ReminderIntent): bool =
  s.reminderPhase == ReminderSaved and s.plannedDestination == UnknownChoice and s.savedDestination != UnknownChoice
pure def sometimesRejected(s: ReminderIntent): bool = s.reminderPhase == IntentRejected and s.checked
pure def sometimesCancelledWhenReady(s: ReminderIntent): bool = s.reminderPhase == IntentCancelled and s.checked
```

## Story: Answer the question a reminder I asked for drew

> As an owner, when the assistant asks me when to remind me because the
> time it had could not be used, I want my answer to finish that reminder
> without saying all of it again.

### An answer finishes only the reminder this conversation asked about, from a later message within five minutes

A reminder the owner's message asked for, whose time could not be read,
had already passed or was an interval that does not repeat, saves nothing
and is kept for its conversation with the title, body, delivery choices
and priority its checked message gave. The owner's next message need not
ask for a reminder again. It is read again, and when it gives a time for
the kept reminder, that reminder is saved at the time the new plan
carries, on the check of the message that asked for it. Only a later
message than the one that drew the question finishes it, within five
minutes of the question. A message that does not answer finishes nothing
and leaves the kept reminder waiting, a message that itself asks for a
reminder is a new request and discards it, and a plan alone still saves
nothing.

```quint
pure val answerWindowMs = 300000
pure def answersKeptReminder(keptAt: int, now: int, sameMessage: bool, givesATime: bool): bool =
  givesATime and not(sameMessage) and now >= keptAt and now - keptAt <= answerWindowMs
pure def lawAStaleQuestionIsNeverFinished(keptAt: int, now: int, sameMessage: bool, givesATime: bool): bool =
  now - keptAt > answerWindowMs implies not(answersKeptReminder(keptAt, now, sameMessage, givesATime))
pure def lawTheMessageThatDrewTheQuestionNeverFinishesIt(keptAt: int, now: int, givesATime: bool): bool =
  not(answersKeptReminder(keptAt, now, true, givesATime))
pure def lawAMessageThatGivesNoTimeFinishesNothing(keptAt: int, now: int, sameMessage: bool): bool =
  not(answersKeptReminder(keptAt, now, sameMessage, false))
```

## Story: Take back the reminder I just saved

> As an owner, when I say "actually, don't save that one" right after a
> reminder was saved, I want that reminder gone and nothing else changed.

### A retraction takes back only the reminder this conversation just saved, from a later message within five minutes

Whether a message takes back the reminder just saved ("actually, don't
save that one", "never mind", "get rid of it", in any words or language)
is the model's to read: it asks for a retraction, and nothing in the
owner's words asks for one by itself. A retraction is honored only from a
later message than the one that saved the reminder, within five minutes of
the save, while that reminder is still live, and when it names no other
reminder. Otherwise nothing changes, and the model is told that nothing
was taken back. A message that also asks for a new reminder takes back
the old one first and then saves the new one.

```quint
pure val retractionWindowMs = 300000
pure def retractsRecentSave(savedAt: int, now: int, sameMessage: bool, saveLive: bool, otherTarget: bool): bool =
  saveLive and not(sameMessage) and not(otherTarget) and now >= savedAt and now - savedAt <= retractionWindowMs
pure def lawAStaleSaveIsNeverTakenBack(savedAt: int, now: int, sameMessage: bool, saveLive: bool, otherTarget: bool): bool =
  now - savedAt > retractionWindowMs implies not(retractsRecentSave(savedAt, now, sameMessage, saveLive, otherTarget))
pure def lawTheSavingMessageNeverTakesItBack(savedAt: int, now: int, saveLive: bool, otherTarget: bool): bool =
  not(retractsRecentSave(savedAt, now, true, saveLive, otherTarget))
pure def lawAnotherReminderIsNeverTakenBack(savedAt: int, now: int, sameMessage: bool, saveLive: bool): bool =
  not(retractsRecentSave(savedAt, now, sameMessage, saveLive, true))
```

## Story: Move the reminder I just saved

> As an owner, when I say "actually make that 30 minutes" or "move it to
> 5pm" about a reminder I saved, I want it to go off then, with nothing
> else about it changed.

### A delay moves a waiting reminder to that long after the request, and anything else changes nothing

A move carries a delay in whole seconds or whole minutes, and seconds win
when both are given, so a second count that is not a positive whole
number is no delay even beside a good minute count; a fraction of the
winning unit is no delay. The
delay counts from the instant of the owner's message, as "in 20 minutes"
does when a reminder is saved. The move names the reminder by its title
or its id, or by "that" or "it", which is the reminder this conversation
just saved. Only a reminder still waiting to fire moves: one that already
went off is snoozed instead. A delay that is not positive, is longer than
366 days, or lands at or before now changes nothing, and the reply says
why. The moved reminder keeps its title, its delivery choices and its
escalation plan, and the reply names its new time on the owner's clock.

```quint
pure val maxMoveDelayMs = 31622400000
pure def movedDueAt(askedAt: int, delayMs: int): int = askedAt + delayMs
pure def moveAdmitted(waiting: bool, delayMs: int, askedAt: int, now: int): bool =
  waiting and delayMs > 0 and delayMs <= maxMoveDelayMs and movedDueAt(askedAt, delayMs) > now
pure def lawAMoveCountsFromTheRequest(askedAt: int, delayMs: int): bool = movedDueAt(askedAt, delayMs) - askedAt == delayMs
pure def lawAReminderThatWentOffIsNeverMoved(delayMs: int, askedAt: int, now: int): bool = not(moveAdmitted(false, delayMs, askedAt, now))
pure def lawNoDelayNeverMoves(waiting: bool, delayMs: int, askedAt: int, now: int): bool =
  delayMs <= 0 implies not(moveAdmitted(waiting, delayMs, askedAt, now))
pure def lawAMovedReminderIsStillAhead(waiting: bool, delayMs: int, askedAt: int, now: int): bool =
  moveAdmitted(waiting, delayMs, askedAt, now) implies movedDueAt(askedAt, delayMs) > now
```

### A stated time moves a waiting reminder to that time, and a time already passed changes nothing

A move may instead name when the reminder goes off, as a create names
it: an instant, a wall time on a day of the owner's clock, a day alone, or
a repeat. The reminder then goes off at that time, or on that repeat, as
long as it is still waiting and a one-off time is ahead of now.

```quint
pure def moveToAdmitted(waiting: bool, dueAt: int, now: int): bool = waiting and dueAt > now
pure def lawAStatedTimeAlreadyPassedNeverMoves(waiting: bool, dueAt: int, now: int): bool = dueAt <= now implies not(moveToAdmitted(waiting, dueAt, now))
pure def lawAReminderThatWentOffIsNeverMovedToATime(dueAt: int, now: int): bool = not(moveToAdmitted(false, dueAt, now))
```

## Story: Hear and rename the reminders I keep

> As an owner, I want to ask what reminders I have and hear each with when
> it comes, and to rename one by its title without anything else about it
> changing.

### Listing reminders changes nothing, and a rename changes the title of the one reminder named

A list tells every live reminder with its next time or its repeat on the
owner's clock. A rename names a reminder as [names](./names.md) says and
gives a nonblank new title; it applies only when exactly one live reminder is
named, and keeps its time, delivery choices and escalation plan.

```quint
pure def renameAdmitted(matches: int, newTitle: str): bool = matches == 1 and newTitle != ""
pure def lawOnlyOneNamedReminderIsRenamed(matches: int, newTitle: str): bool = renameAdmitted(matches, newTitle) implies matches == 1
pure def lawABlankTitleNeverRenames(matches: int): bool = not(renameAdmitted(matches, ""))
```

## Story: Answer or put off a reminder I keep

> As an owner, I want to mark a reminder done, dismiss it, acknowledge
> it, skip its next occurrence, or snooze it for some minutes, until
> tonight or until tomorrow morning.

### A skip passes over one occurrence of a repeating reminder, and a reminder that does not repeat is not skipped

Each of these names its reminder among the live ones as [names](./names.md)
says. Skipping a repeating reminder settles the occurrence it waits for, or the
one that just fired, and the reminder comes again at the occurrence after
it ([scheduled tasks](../agent/schedule/scheduledTasks.md)). A reminder
that comes once has no later occurrence, so a skip changes nothing and the
reply says to dismiss it instead.

```quint
pure def skipAdmitted(named: int, repeats: bool): bool = named == 1 and repeats
pure def lawAOneOffReminderIsNeverSkipped(named: int): bool = not(skipAdmitted(named, false))
pure def lawASkipNamesOneReminder(named: int, repeats: bool): bool = skipAdmitted(named, repeats) implies named == 1
```

### A snooze until tonight comes at 20:00, and one until tomorrow morning at 08:00, on the owner's clock

A snooze lasts the minutes the owner gave, ten when they gave none, or
until a named time: tonight is the next 20:00 on the owner's clock, today
when it is still ahead and tomorrow otherwise, and tomorrow morning is
08:00 on the next day.

```quint
pure val tonightMinute = 1200
pure val morningMinute = 480
pure val minuteOfDayValues = Set(0, 479, 480, 1199, 1200, 1439)
pure def minutesUntilTonight(minuteOfDay: int): int =
  if (minuteOfDay < tonightMinute) tonightMinute - minuteOfDay else tonightMinute + 1440 - minuteOfDay
pure def minutesUntilTomorrowMorning(minuteOfDay: int): int = 1440 - minuteOfDay + morningMinute
pure def lawTonightIsAheadAndWithinADay(minuteOfDay: int): bool =
  (minuteOfDay >= 0 and minuteOfDay < 1440) implies (minutesUntilTonight(minuteOfDay) > 0 and minutesUntilTonight(minuteOfDay) <= 1440)
pure def lawTonightLandsAtTwenty(minuteOfDay: int): bool =
  (minuteOfDay >= 0 and minuteOfDay < 1440) implies (minuteOfDay + minutesUntilTonight(minuteOfDay)) % 1440 == tonightMinute
pure def lawTomorrowMorningIsTheNextDayAtEight(minuteOfDay: int): bool =
  minuteOfDay + minutesUntilTomorrowMorning(minuteOfDay) == 1440 + morningMinute
```

## Story: Propose a reminder or alarm on my phone only as I asked

> As an owner, I want a chat request about my phone's reminders or Clock to
> become a phone review only for the phone reminder I mean, at the time my
> own words give, and never to cancel one I did not ask to cancel.

### A phone reminder is proposed only when the assistant keeps no reminders here or the phone's reminder is selected

Where the assistant keeps the owner's reminders itself (`OWNER_REMINDERS`),
an ordinary reminder is saved here, and a phone reminder is proposed only
when the turn's nonsensitive screen selects a phone reminder or a phone
reminder list. A reminder named from Home is no exception. Otherwise the
proposal is refused before anything is offered, naming `OWNER_REMINDERS`.
The turn's note that says so also says an alarm is never made a reminder,
so a wake-up or alarm the owner asks for stays the alarm it is, as the old
phone's agent was told; which tool a request needs stays the model's to
decide.

```quint
pure def phoneReminderProposed(assistantKeepsReminders: bool, phoneReminderSelected: bool): bool =
  not(assistantKeepsReminders) or phoneReminderSelected
pure def lawTheAssistantsRemindersStayHere(assistantKeepsReminders: bool): bool =
  assistantKeepsReminders implies not(phoneReminderProposed(assistantKeepsReminders, false))
```

### A selected or named phone reminder is the one the owner gave, and a change to it is only proposed for the owner's review

A read, edit, completion, snooze or cancel of a selected reminder names
exactly the reminder selected on the phone, with its source, occurrence,
revisions and timing version. A named edit or cancel names a reminder
whose name is in the owner's own words. Which change the owner asked for,
however they put it, and whether they turned it down, is the planner's
reading of their message, never a list of words: the planner is told to
propose an edit, completion, snooze or cancel only when the owner asks for
it and never one they turned down. Whatever it proposes is only a review
on the phone, which changes nothing until the owner approves it there.

```quint
pure def reminderTargetGrounded(selectionKnown: bool, sameAsSelected: bool): bool = selectionKnown and sameAsSelected
pure def lawAnUnselectedReminderIsNeverProposed(sameAsSelected: bool): bool = not(reminderTargetGrounded(false, sameAsSelected))
```

### A new phone reminder is due when the owner's words say, counted from the turn's start for a relative time

A relative time the owner states ("in 20 minutes", "in an hour") is
counted from the instant the turn started, never from an instant the model
calculated, repeats nothing, and alerts at its due time or not at all. A
stated day and clock time is placed on the phone's clock ([Owner time
zone](./timezone.md)), and a repeat the reminder carries is set to that
day, time, zone and alert lead. With neither, the model's reviewed instant
stands, for the owner to check on the phone. The alert comes the stated
number of minutes before the due time, and with no alert the reminder is
pending at its due time. A reminder whose due time, or whose alert, has
passed by the clock when it is proposed is refused. Its title uses the
owner's own words, and a note the owner did not state is left empty.

```quint
pure def relativeDueAt(startedAt: int, afterMs: int): int = startedAt + afterMs
pure def reminderLead(relative: bool, proposedMinutes: int): int = if (relative) 0 else proposedMinutes
pure def alertAt(dueAt: int, alertMinutes: int, alerts: bool): int = if (alerts) dueAt - alertMinutes * 60000 else dueAt
pure def reminderTimeAdmitted(dueAt: int, alertsAt: int, alerts: bool, checkedAt: int): bool =
  dueAt > checkedAt and (not(alerts) or alertsAt > checkedAt)
pure def newReminderStated(titleInOwnerWords: bool, timeAdmitted: bool): bool = titleInOwnerWords and timeAdmitted
pure def reminderWordsKept(stated: bool, proposed: str): str = if (stated) proposed else ""
pure def lawARelativeReminderAlertsWhenDue(startedAt: int, afterMs: int, proposedMinutes: int): bool =
  alertAt(relativeDueAt(startedAt, afterMs), reminderLead(true, proposedMinutes), true) == relativeDueAt(startedAt, afterMs)
pure def lawAnAdmittedAlertIsInTheFuture(dueAt: int, alertMinutes: int, checkedAt: int): bool =
  reminderTimeAdmitted(dueAt, alertAt(dueAt, alertMinutes, true), true, checkedAt) implies alertAt(dueAt, alertMinutes, true) > checkedAt
pure def lawAnAdmittedReminderIsInTheFuture(dueAt: int, alertsAt: int, alerts: bool, checkedAt: int): bool =
  reminderTimeAdmitted(dueAt, alertsAt, alerts, checkedAt) implies dueAt > checkedAt
pure def lawASilentReminderIsDueWhenItFires(dueAt: int, alertMinutes: int): bool = alertAt(dueAt, alertMinutes, false) == dueAt
pure def lawUnstatedNotesAreNeverKept(proposed: str): bool = reminderWordsKept(false, proposed) == ""
```
