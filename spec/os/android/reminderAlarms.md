# Reminder alarms, Done, Snooze and the store's bounds

How one dated reminder of the Android reminder store (`android/reminders/`,
`ReminderStore`) reaches the owner at its time: the alarm the store arms
for it, the notice the alarm posts, what Android drops at a reboot, and what
recovery puts back. Recovery runs when the device finishes booting, when the
app is replaced, when the time or time zone changes and when the reminders
plugin loads. Done and Snooze are the store's own decisions: which taps it
acts on, when a snoozed reminder returns, which repeat of a repeating
reminder comes next, how much history a reminder keeps and how many
reminders the store holds. The store then writes the row and replaces the
alarm and the notice. The delay before a deletion is the
[deletion window](./deletionWindow.md); a tap reports its result in the
words of the [notice routes](./noticeRoutes.md). Reminders without an alert
and undated to-dos never get an alarm; their alarms are not modelled.

The store serializes every event under one lock. A row's revision is the
digest of the stored row, so any write of the row gives a new revision.

## Story: Get my reminder at its time, even after a reboot

> As an owner, I want a reminder to ring at its exact time when my device
> lets the app schedule exact alarms, close to it otherwise, and still to
> ring, or its unhandled notice to come back, after the phone restarts, so
> that nothing is skipped, repeated or asked of me by the reminder itself.

### An exact alarm needs the capability at check and at arm, and the store never asks for it

The store checks Android's exact-alarm capability and then makes the alarm
call; Android can withdraw the capability in between, and the call then
fails and an inexact alarm replaces it. Only Android, through the owner's
settings, grants the capability. Withdrawing it drops every exact alarm of
the app, and the reminder waits without an alarm until the next recovery.

```quint
import noticeRoutes as NR from "./noticeRoutes"
type AlarmKind = NoAlarm | ExactAlarm | InexactAlarm
type StoredStatus = StoredScheduled | StoredPosted | StoredPermissionDenied | StoredClosed
type DeletionMark = NotDeleting | DeletionPending
type ReminderAlarm = { status: StoredStatus, deletion: DeletionMark, alarm: AlarmKind, exactCapability: bool, noticeShown: bool,
  revision: int, noticeRevision: int, boot: int, markedBoot: int }
pure val initial: ReminderAlarm = { status: StoredScheduled, deletion: NotDeleting, alarm: NoAlarm, exactCapability: false, noticeShown: false,
  revision: 1, noticeRevision: 0, boot: 1, markedBoot: 0 }
pure def armKind(capability: bool, withdrawnBeforeArm: bool): AlarmKind = if (capability and not(withdrawnBeforeArm)) ExactAlarm else InexactAlarm
pure def canGrantExactCapability(s: ReminderAlarm): bool = not(s.exactCapability)
pure def grantExactCapability(s: ReminderAlarm): ReminderAlarm = { ...s, exactCapability: true }
pure def canWithdrawExactCapability(s: ReminderAlarm): bool = s.exactCapability
pure def withdrawExactCapability(s: ReminderAlarm): ReminderAlarm =
  { ...s, exactCapability: false, alarm: if (s.alarm == ExactAlarm) NoAlarm else s.alarm }
pure def alwaysExactAlarmHoldsTheCapability(s: ReminderAlarm): bool = s.alarm == ExactAlarm implies s.exactCapability
pure def stepExactAlarmNeedsCapabilityAtCheckAndArm(before: ReminderAlarm, after: ReminderAlarm): bool =
  after.alarm == ExactAlarm implies (before.exactCapability and after.exactCapability)
pure def stepOnlyAndroidGrantsTheCapability(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  (not(before.exactCapability) and after.exactCapability) implies via == "grantExactCapability"
pure def sometimesExactAlarm(s: ReminderAlarm): bool = s.alarm == ExactAlarm
pure def sometimesInexactAlarm(s: ReminderAlarm): bool = s.alarm == InexactAlarm
```

### A firing alarm posts the notice for the stored row, or records why it could not

The alarm fires only for a scheduled reminder that is not being deleted.
With notices refused, the reminder waits for an explicit change. A post that
fails leaves the row scheduled and unwritten, so recovery arms it again and
nothing reports a delivery that did not happen.

```quint
type FireResult = NoticesRefused | PostFailed | PostShown
pure def canFireAlarm(s: ReminderAlarm): bool = s.alarm != NoAlarm and s.status == StoredScheduled and s.deletion == NotDeleting
pure def fireAlarm(s: ReminderAlarm, result: FireResult): ReminderAlarm =
  if (result == NoticesRefused) { ...s, alarm: NoAlarm, status: StoredPermissionDenied, revision: s.revision + 1 }
  else if (result == PostFailed) { ...s, alarm: NoAlarm }
  else { ...s, alarm: NoAlarm, status: StoredPosted, noticeShown: true, revision: s.revision + 1, noticeRevision: s.revision + 1 }
pure def alwaysNoticeOnlyWhilePosted(s: ReminderAlarm): bool = s.noticeShown implies (s.status == StoredPosted and s.deletion == NotDeleting)
pure def sometimesNoticePosted(s: ReminderAlarm): bool = s.status == StoredPosted and s.noticeShown
pure def sometimesWaitingForPermission(s: ReminderAlarm): bool = s.status == StoredPermissionDenied
```

### A reminder has at most one alarm, only while it is scheduled and not being deleted

The alarm's identity is the reminder's, so arming again replaces the alarm.
A change of the reminder (Done, Snooze, a reschedule or a cancel) rewrites
the row, cancels its alarm and notice, and arms it again only when it stays
scheduled. Staging a deletion cancels both; a cancellation Android fails
still delivers nothing, because the stored mark refuses the alarm. Undo
puts back the alarm or the notice of the unchanged row, and the deletion
closes the row.

```quint
type ReminderChange = RearmReminder | CloseReminder
pure def canChangeReminder(s: ReminderAlarm): bool = s.deletion == NotDeleting
pure def changeReminder(s: ReminderAlarm, change: ReminderChange, notifyAllowed: bool, withdrawnBeforeArm: bool): ReminderAlarm = {
  val rewritten = { ...s, alarm: NoAlarm, noticeShown: false, revision: s.revision + 1 }
  if (change == CloseReminder) { ...rewritten, status: StoredClosed }
  else if (notifyAllowed)
    { ...rewritten, status: StoredScheduled, alarm: armKind(s.exactCapability, withdrawnBeforeArm), exactCapability: s.exactCapability and not(withdrawnBeforeArm) }
  else { ...rewritten, status: StoredPermissionDenied }
}
pure def canStageDeletion(s: ReminderAlarm): bool = s.deletion == NotDeleting and s.status != StoredClosed
pure def stageDeletion(s: ReminderAlarm): ReminderAlarm = { ...s, deletion: DeletionPending, alarm: NoAlarm, noticeShown: false }
pure def canSettleDeletion(s: ReminderAlarm): bool = s.deletion == DeletionPending
pure def settleDeletion(s: ReminderAlarm, undo: bool, withdrawnBeforeArm: bool, repostSucceeds: bool): ReminderAlarm =
  if (not(undo)) { ...s, deletion: NotDeleting, status: StoredClosed, revision: s.revision + 1 }
  else if (s.status == StoredScheduled)
    { ...s, deletion: NotDeleting, alarm: armKind(s.exactCapability, withdrawnBeforeArm), exactCapability: s.exactCapability and not(withdrawnBeforeArm) }
  else { ...s, deletion: NotDeleting, noticeShown: s.status == StoredPosted and repostSucceeds }
pure def alwaysAlarmOnlyWhileScheduled(s: ReminderAlarm): bool = s.alarm != NoAlarm implies (s.status == StoredScheduled and s.deletion == NotDeleting)
pure def sometimesDeletionPending(s: ReminderAlarm): bool = s.deletion == DeletionPending
pure def sometimesClosed(s: ReminderAlarm): bool = s.status == StoredClosed
```

### A shown notice opens the exact row it was posted for, and a tap from before a later change opens nothing

A notice's tap names the row's revision at posting. It opens the reminder
only while the row has that revision and is not being deleted. Revisions
only grow, so a tap that went stale never opens again; Undo restores the row
it suspended, so its notice opens again.

```quint
pure def reminderTap(s: ReminderAlarm, tapped: int): NR::TapResolution =
  if (tapped == 0) NR::NoTap
  else if (s.deletion == DeletionPending or tapped != s.revision) NR::TapUnavailable
  else NR::TapReady
pure def alwaysPostedNoticeNamesTheRow(s: ReminderAlarm): bool = s.status == StoredPosted implies s.noticeRevision == s.revision
pure def alwaysShownNoticeOpensItsReminder(s: ReminderAlarm): bool = s.noticeShown implies reminderTap(s, s.noticeRevision) == NR::TapReady
pure def stepRevisionsOnlyGrow(before: ReminderAlarm, after: ReminderAlarm): bool = after.revision >= before.revision
pure def sometimesStaleTap(s: ReminderAlarm): bool = s.noticeRevision > 0 and reminderTap(s, s.noticeRevision) == NR::TapUnavailable
```

### Recovery re-arms scheduled reminders and restores posted notices for the current boot without writing the row

Android drops alarms and notices at a reboot, and the owner can dismiss a
notice. Recovery never writes the row, so the occurrence, the revision and
the tap stay the same. It removes the alarm and notice of a reminder being
deleted, arms a scheduled one again under the same capability check, and
re-posts the notice of a posted one until recovery for that boot is complete.
The model follows one reminder and records its completed recovery. Android
stores a single boot marker for the whole sweep. If a posted notice cannot
be restored, the next sweep can post an already restored notice again
under the same notification ID and tap route. Posting with that ID
replaces any notice still shown. One damaged record does not stop the
sweep from attempting the others.

```quint
pure def reboot(s: ReminderAlarm): ReminderAlarm = { ...s, alarm: NoAlarm, noticeShown: false, boot: s.boot + 1 }
pure def canDismissNotice(s: ReminderAlarm): bool = s.noticeShown
pure def dismissNotice(s: ReminderAlarm): ReminderAlarm = { ...s, noticeShown: false }
pure def recover(s: ReminderAlarm, withdrawnBeforeArm: bool, repostSucceeds: bool): ReminderAlarm =
  if (s.deletion == DeletionPending) { ...s, alarm: NoAlarm, noticeShown: false, markedBoot: s.boot }
  else if (s.status == StoredScheduled)
    { ...s, alarm: armKind(s.exactCapability, withdrawnBeforeArm), exactCapability: s.exactCapability and not(withdrawnBeforeArm), markedBoot: s.boot }
  else if (s.status == StoredPosted and s.markedBoot != s.boot)
    { ...s, noticeShown: s.noticeShown or repostSucceeds, markedBoot: if (repostSucceeds) s.boot else s.markedBoot }
  else { ...s, markedBoot: s.boot }
pure val weight_recover = 3
pure def alwaysCountersKnown(s: ReminderAlarm): bool =
  s.boot >= 1 and s.markedBoot >= 0 and s.markedBoot <= s.boot and s.revision >= 1 and s.noticeRevision >= 0 and s.noticeRevision <= s.revision
pure def stepRecoveryKeepsTheRow(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  (via == "recover" or via == "reboot") implies
    (after.status == before.status and after.deletion == before.deletion and after.revision == before.revision and after.noticeRevision == before.noticeRevision)
pure def stepNoticeRepostedAtMostOncePerBoot(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  (via == "recover" and before.markedBoot == before.boot and before.deletion == NotDeleting) implies after.noticeShown == before.noticeShown
pure def stepMarkerAdvancesOnlyWithTheNotice(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  (via == "recover" and before.status == StoredPosted and before.deletion == NotDeleting and before.markedBoot != before.boot and after.markedBoot == after.boot)
    implies after.noticeShown
pure def sometimesRearmedAfterReboot(s: ReminderAlarm): bool = s.boot > 1 and s.alarm != NoAlarm
pure def sometimesNoticeBackAfterReboot(s: ReminderAlarm): bool = s.boot > 1 and s.status == StoredPosted and s.noticeShown and s.markedBoot == s.boot
```

## Story: Finish or put off a reminder without losing track of it

> As an owner, I want Done to finish a one-off reminder and move a repeating
> one to its next date still ahead, Snooze to bring a reminder back ten
> minutes later, and the store to keep a short history and a bounded number
> of reminders, so that a late or repeated tap changes nothing and nothing I
> have not dealt with is dropped.

### Done or Snooze acts only on the current occurrence of an active dated reminder

A tap names the reminder and the occurrence it was shown for. A reminder
that is unknown, being deleted, cancelled or completed, or that has moved to
another occurrence, answers stale and is left as it is. An undated to-do is
changed from the to-do list, and a reminder without an alert cannot be
snoozed; both are refused. Snoozing a scheduled reminder that is already
snoozed changes nothing. Otherwise Snooze puts the occurrence off, Done on a
repeating reminder advances it, and Done on a one-off reminder completes
it. Only an explicit Done moves a repeat; time passing never does.

```quint
type ReminderChoice = ChoseDone | ChoseSnooze
type TappedReminder = { occurrenceCurrent: bool, undated: bool, alerts: bool, scheduled: bool, snoozed: bool, repeats: bool }
type Decision = DecisionStale | DecisionRefused | DecisionUnchanged | DecisionSnoozed | DecisionAdvanced | DecisionCompleted
pure def reminderDecision(choice: ReminderChoice, pressed: TappedReminder): Decision =
  if (not(pressed.occurrenceCurrent)) DecisionStale
  else if (pressed.undated or (choice == ChoseSnooze and not(pressed.alerts))) DecisionRefused
  else if (choice == ChoseSnooze) (if (pressed.scheduled and pressed.snoozed) DecisionUnchanged else DecisionSnoozed)
  else if (pressed.repeats) DecisionAdvanced
  else DecisionCompleted
pure def decisionRewrites(decision: Decision): bool =
  decision == DecisionSnoozed or decision == DecisionAdvanced or decision == DecisionCompleted
pure val pressedValues = Set(
  { occurrenceCurrent: true, undated: false, alerts: true, scheduled: true, snoozed: false, repeats: false },
  { occurrenceCurrent: true, undated: false, alerts: true, scheduled: true, snoozed: true, repeats: true },
  { occurrenceCurrent: true, undated: false, alerts: true, scheduled: false, snoozed: true, repeats: true },
  { occurrenceCurrent: true, undated: false, alerts: false, scheduled: false, snoozed: false, repeats: false },
  { occurrenceCurrent: true, undated: true, alerts: false, scheduled: false, snoozed: false, repeats: false },
  { occurrenceCurrent: false, undated: false, alerts: true, scheduled: true, snoozed: false, repeats: true }
)
pure def lawAStaleTapChangesNothing(choice: ReminderChoice, pressed: TappedReminder): bool =
  not(pressed.occurrenceCurrent) implies not(decisionRewrites(reminderDecision(choice, pressed)))
pure def lawOnlyDoneFinishesOrAdvances(choice: ReminderChoice, pressed: TappedReminder): bool =
  (reminderDecision(choice, pressed) == DecisionCompleted or reminderDecision(choice, pressed) == DecisionAdvanced) implies choice == ChoseDone
pure def lawSnoozeNeedsAnAlert(pressed: TappedReminder): bool =
  reminderDecision(ChoseSnooze, pressed) == DecisionSnoozed implies (pressed.alerts and not(pressed.undated))
pure def lawDoneCompletesOnlyAOneOffReminder(pressed: TappedReminder): bool =
  reminderDecision(ChoseDone, pressed) == DecisionCompleted implies not(pressed.repeats)
```

### A snoozed reminder returns ten minutes after the tap

Snooze sets the alert to `snoozeMillis` after the tap, whatever the
reminder's own time was, and marks the occurrence snoozed.

```quint
pure val snoozeMillis = 600000
pure def snoozedUntil(tappedAt: int): int = tappedAt + snoozeMillis
pure val tappedAtValues = Set(0, 1, 1000)
pure def lawSnoozeIsTenMinutesAfterTheTap(tappedAt: int): bool =
  snoozedUntil(tappedAt) - tappedAt == snoozeMillis and snoozedUntil(tappedAt) > tappedAt
```

### Done moves a repeating reminder to its first repeat whose alert is still ahead, and counts the dates it skipped

A repeat is daily, on weekdays or weekly, at its civil time in the zone it
was saved with; the store walks those dates from the saved one, a weekday
repeat stepping over Saturday and Sunday, a time a zone change skips moving
to the first valid instant after the gap and a repeated one taking the
earlier instant. Done takes the first repeat whose alert, the due time less
its lead, is after now, so the next alert is never already due, and records
with the finished occurrence how many repeat dates it passed over. The new
occurrence is neither snoozed nor posted.

```quint
pure def repeatsAhead(passedRepeats: int): int = (if (passedRepeats > 0) passedRepeats else 0) + 1
pure def skippedDates(passedRepeats: int): int = repeatsAhead(passedRepeats) - 1
pure val passedRepeatsValues = Set(-1, 0, 1, 3)
pure def lawDoneAlwaysMovesToALaterRepeat(passedRepeats: int): bool =
  repeatsAhead(passedRepeats) >= 1 and repeatsAhead(passedRepeats) > passedRepeats
pure def lawEveryPassedRepeatIsCountedAsSkipped(passedRepeats: int): bool =
  skippedDates(passedRepeats) >= 0 and (passedRepeats >= 0 implies skippedDates(passedRepeats) == passedRepeats)
```

### A reminder keeps its newest 32 finished occurrences

Each Done appends the finished occurrence, with its due time, when it was
finished and the dates skipped, to the reminder's history; once the history
holds `historyLimit` entries the oldest is dropped.

```quint
pure val historyLimit = 32
pure def keepHistory(history: List[int], finished: int): List[int] =
  if (history.length() >= historyLimit) history.tail().append(finished) else history.append(finished)
pure val historyValues = Set(List(), List(1, 2),
  List(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32))
pure val finishedValues = Set(40, 41)
pure def lawHistoryStaysWithinItsLimit(history: List[int], finished: int): bool =
  history.length() <= historyLimit implies keepHistory(history, finished).length() <= historyLimit
pure def lawTheNewestFinishedOccurrenceIsKept(history: List[int], finished: int): bool =
  keepHistory(history, finished).nthOr(keepHistory(history, finished).length() - 1, finished - 1) == finished
```

### The store holds at most 250 reminders, and a new one replaces only the oldest closed one

Saving a reminder the store already holds needs no room. A new one is
stored while fewer than `maxReminders` are held. At the limit it takes the
place of the cancelled or completed reminder that was closed longest ago
and is not being deleted; when every stored reminder is still unresolved,
or damaged, the new one is refused as storage full and nothing is dropped.

```quint
type StoreRoom = RoomFree | RoomReclaimed | RoomFull
pure val maxReminders = 250
pure def roomFor(alreadyStored: bool, heldReminders: int, closedReminders: int): StoreRoom =
  if (alreadyStored or heldReminders < maxReminders) RoomFree
  else if (closedReminders > 0) RoomReclaimed
  else RoomFull
pure def storedAfter(alreadyStored: bool, heldReminders: int, closedReminders: int): int =
  if (not(alreadyStored) and roomFor(alreadyStored, heldReminders, closedReminders) == RoomFree) heldReminders + 1 else heldReminders
pure val heldRemindersValues = Set(0, 249, 250)
pure val closedRemindersValues = Set(0, 1)
pure def lawTheStoreNeverGrowsPastItsLimit(alreadyStored: bool, heldReminders: int, closedReminders: int): bool =
  heldReminders <= maxReminders implies storedAfter(alreadyStored, heldReminders, closedReminders) <= maxReminders
pure def lawAnUnresolvedReminderIsNeverDropped(heldReminders: int): bool =
  roomFor(false, heldReminders, 0) != RoomReclaimed and (heldReminders >= maxReminders implies roomFor(false, heldReminders, 0) == RoomFull)
```
