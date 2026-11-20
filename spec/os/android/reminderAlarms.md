# Reminder alarms

How one dated reminder of the Android reminder store (`android/reminders/`,
`ReminderStore`) reaches the owner at its time: the alarm the store arms
for it, the notice the alarm posts, what Android drops at a reboot, and what
recovery puts back. Recovery runs when the device finishes booting, when the
app is replaced, when the time or time zone changes and when the reminders
plugin loads. Which occurrence comes next after Done or Snooze is the
assistant's decision; the store only writes it and replaces the alarm and
the notice. The delay before a deletion is the
[deletion window](./deletionWindow.md); a tap reports its result in the
words of the [notice routes](./noticeRoutes.md). Reminders without an alert
and undated to-dos never get an alarm and are not modelled.

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

### Recovery re-arms scheduled reminders and re-posts unhandled notices once per boot without writing the row

Android drops alarms and notices at a reboot, and the owner can dismiss a
notice. Recovery never writes the row, so the occurrence, the revision and
the tap stay the same. It removes the alarm and notice of a reminder being
deleted, arms a scheduled one again under the same capability check, and
posts the notice of a posted one again once per boot. The boot marker
advances only when that notice was posted again, so a notice that could not
be posted, because notices are refused or the post failed, is retried at
the next recovery. Each reminder is recovered on its own, so one damaged
record does not stop the others.

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
