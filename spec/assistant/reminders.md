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
reminder, the clock it names, and any delivery choices it states.

```quint
type ReminderPhase = NoReminderIntent | IntentPending | IntentReady | IntentRejected | IntentCancelled | ReminderSaved
type ReminderClock = UtcClock | OwnerLocalClock
type DeliveryChoice = UnknownChoice | FirstChoice | SecondChoice
type ReminderIntent = { reminderPhase: ReminderPhase, requested: bool, checked: bool, writes: int,
  plannedClock: ReminderClock, extractedClock: ReminderClock, savedClock: ReminderClock,
  plannedDestination: DeliveryChoice, extractedDestination: DeliveryChoice, savedDestination: DeliveryChoice,
  plannedAlert: DeliveryChoice, extractedAlert: DeliveryChoice, savedAlert: DeliveryChoice }
pure val initial: ReminderIntent = { reminderPhase: NoReminderIntent, requested: false, checked: false, writes: 0,
  plannedClock: UtcClock, extractedClock: UtcClock, savedClock: UtcClock,
  plannedDestination: UnknownChoice, extractedDestination: UnknownChoice, savedDestination: UnknownChoice,
  plannedAlert: UnknownChoice, extractedAlert: UnknownChoice, savedAlert: UnknownChoice }
pure def canProposeReminder(s: ReminderIntent): bool = s.reminderPhase == NoReminderIntent
pure def proposeReminder(s: ReminderIntent, requested: bool, plannedClock: ReminderClock, extractedClock: ReminderClock, plannedDestination: DeliveryChoice, extractedDestination: DeliveryChoice, plannedAlert: DeliveryChoice, extractedAlert: DeliveryChoice): ReminderIntent =
  { ...s, reminderPhase: IntentPending, requested: requested, plannedClock: plannedClock, extractedClock: extractedClock,
    plannedDestination: plannedDestination, extractedDestination: extractedDestination, plannedAlert: plannedAlert, extractedAlert: extractedAlert }
```

### The original message is checked before a reminder is written

A check that finds the message asked for the reminder makes it ready; one
that finds it did not, or a check that cannot run, rejects it. The owner
may cancel before it is written.

```quint
pure def canCheckRequest(s: ReminderIntent): bool = s.reminderPhase == IntentPending
pure def checkRequest(s: ReminderIntent): ReminderIntent = { ...s, checked: true, reminderPhase: if (s.requested) IntentReady else IntentRejected }
pure def canCheckUnavailable(s: ReminderIntent): bool = s.reminderPhase == IntentPending
pure def checkUnavailable(s: ReminderIntent): ReminderIntent = { ...s, reminderPhase: IntentRejected }
pure def canCancelReminder(s: ReminderIntent): bool = s.reminderPhase == IntentPending or s.reminderPhase == IntentReady
pure def cancelReminder(s: ReminderIntent): ReminderIntent = { ...s, reminderPhase: IntentCancelled }
pure def alwaysCheckedBeforeWrite(s: ReminderIntent): bool = s.writes > 0 implies (s.checked and s.requested)
```

### A reminder is written at most once, and a refusal writes nothing

```quint
pure def recoveredChoice(planned: DeliveryChoice, extracted: DeliveryChoice): DeliveryChoice = if (planned != UnknownChoice) planned else extracted
pure def canSaveReminder(s: ReminderIntent): bool = s.reminderPhase == IntentReady and s.checked and s.requested
pure def saveReminder(s: ReminderIntent): ReminderIntent =
  { ...s, reminderPhase: ReminderSaved, writes: s.writes + 1, savedClock: s.plannedClock,
    savedDestination: recoveredChoice(s.plannedDestination, s.extractedDestination), savedAlert: recoveredChoice(s.plannedAlert, s.extractedAlert) }
pure def alwaysWrittenAtMostOnce(s: ReminderIntent): bool = s.writes >= 0 and s.writes <= 1 and ((s.writes == 1) == (s.reminderPhase == ReminderSaved))
pure def alwaysRefusalWritesNothing(s: ReminderIntent): bool = (s.reminderPhase == IntentRejected or s.reminderPhase == IntentCancelled) implies s.writes == 0
```

### The written reminder keeps the planned clock

The clock the message names never overrides the clock of a complete plan.

```quint
pure def alwaysPlannedClockKept(s: ReminderIntent): bool = s.writes > 0 implies s.savedClock == s.plannedClock
```

### A known delivery choice is kept, and only an unknown one is taken from the message

```quint
pure def alwaysDeliveryChoicesKept(s: ReminderIntent): bool =
  s.writes > 0 implies (s.savedDestination == recoveredChoice(s.plannedDestination, s.extractedDestination) and s.savedAlert == recoveredChoice(s.plannedAlert, s.extractedAlert))
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

### Reminders survive the move to their own store

Reminders that an earlier version kept in the shared assistant store are
copied once into the reminders store, under the
[goals' rule for such moves](./goals.md).

```quint
import goals as G from "./goals"
pure def reminderMove(sourcePresent: bool, targetEmpty: bool, moveReceipt: bool): G::MoveOutcome = G::moveOutcome(sourcePresent, targetEmpty, moveReceipt)
pure def lawReminderMoveNeverOverwrites(sourcePresent: bool, targetEmpty: bool, moveReceipt: bool): bool =
  reminderMove(sourcePresent, targetEmpty, moveReceipt) == G::MovedCopied implies (targetEmpty and not(moveReceipt))
```
