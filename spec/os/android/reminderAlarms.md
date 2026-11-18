# Reminder alarms

How one stored reminder of the Android reminder store reaches the owner at
its time: the alarm the store arms for it, what Android drops at a reboot,
and what recovery puts back. The store is `ReminderStore.java` of the
reminders plugin; its receiver runs recovery when the device finishes
booting, when the app is replaced, when the time or time zone changes and
when the plugin loads. Done and Snooze, and every change of occurrence they
make, belong to the assistant; nothing here moves an occurrence. The tap on
a reminder notice follows the notice routes of this directory.

## Story: Get my reminder at its time, even after a reboot

> As an owner, I want a reminder to ring at its exact time when my device
> lets the app schedule exact alarms, close to it otherwise, and still to
> ring, or its unhandled notice to come back, after the phone restarts, so
> that nothing is skipped, repeated or asked of me by the reminder itself.

### An exact alarm needs the capability at check and at arm, and the store never asks for it

Arming happens under the store lock. The store checks Android's exact-alarm
capability, and Android can withdraw it before the alarm call; the alarm is
exact only when the capability was held at both points, and inexact
otherwise. The store has no step that requests the capability.

```quint
type AlarmKind = NoAlarm | ExactAlarm | InexactAlarm
type StoredStatus = StoredScheduled | StoredPosted | StoredPermissionDenied | StoredDeletionPending
type ReminderAlarm = { keptStatus: StoredStatus, occurrence: int, alarm: AlarmKind, noticeShown: bool, boot: int, restoredBoot: int }
pure val initial: ReminderAlarm = { keptStatus: StoredScheduled, occurrence: 1, alarm: NoAlarm, noticeShown: false, boot: 1, restoredBoot: 1 }
pure def alarmKind(heldAtCheck: bool, heldAtArm: bool): AlarmKind = if (heldAtCheck and heldAtArm) ExactAlarm else InexactAlarm
pure def lawExactAlarmNeedsCapabilityThroughout(heldAtCheck: bool, heldAtArm: bool): bool =
  (alarmKind(heldAtCheck, heldAtArm) == ExactAlarm iff (heldAtCheck and heldAtArm)) and alarmKind(heldAtCheck, heldAtArm) != NoAlarm
pure def sometimesExactAlarm(s: ReminderAlarm): bool = s.alarm == ExactAlarm
pure def sometimesInexactAlarm(s: ReminderAlarm): bool = s.alarm == InexactAlarm
```

### A reminder has one alarm at a time, and only while it is scheduled

The alarm's identity is the reminder's, so arming again replaces the alarm
instead of adding one. Firing posts the notice and consumes the alarm; a
reminder whose notice permission was refused waits for an explicit
reschedule; staging its deletion cancels the alarm.

```quint
pure def canArmReminder(s: ReminderAlarm): bool = s.keptStatus == StoredScheduled
pure def armReminder(s: ReminderAlarm, heldAtCheck: bool, heldAtArm: bool): ReminderAlarm = { ...s, alarm: alarmKind(heldAtCheck, heldAtArm) }
pure def canFireAlarm(s: ReminderAlarm): bool = s.keptStatus == StoredScheduled and s.alarm != NoAlarm
pure def fireAlarm(s: ReminderAlarm): ReminderAlarm = { ...s, keptStatus: StoredPosted, alarm: NoAlarm, noticeShown: true }
pure def canRefuseNotices(s: ReminderAlarm): bool = s.keptStatus == StoredScheduled
pure def refuseNotices(s: ReminderAlarm): ReminderAlarm = { ...s, keptStatus: StoredPermissionDenied, alarm: NoAlarm }
pure def canReschedule(s: ReminderAlarm): bool = s.keptStatus == StoredPermissionDenied
pure def reschedule(s: ReminderAlarm, heldAtCheck: bool, heldAtArm: bool): ReminderAlarm =
  { ...s, keptStatus: StoredScheduled, alarm: alarmKind(heldAtCheck, heldAtArm) }
pure def canStageDeletion(s: ReminderAlarm): bool = s.keptStatus != StoredDeletionPending
pure def stageDeletion(s: ReminderAlarm): ReminderAlarm = { ...s, keptStatus: StoredDeletionPending, alarm: NoAlarm }
pure def alwaysAlarmOnlyWhileScheduled(s: ReminderAlarm): bool = s.alarm != NoAlarm implies s.keptStatus == StoredScheduled
pure def sometimesNoticePosted(s: ReminderAlarm): bool = s.keptStatus == StoredPosted and s.noticeShown
pure def sometimesWaitingForReschedule(s: ReminderAlarm): bool = s.keptStatus == StoredPermissionDenied
```

### Recovery re-arms scheduled reminders and re-posts unhandled notices once per boot without advancing any occurrence

Android drops alarms and notices at a reboot. Recovery arms a scheduled
reminder again under the same capability check, removes the alarm and
notice of one whose deletion is pending, and posts an unhandled notice again
with the same occurrence, target and tap route, once per boot: the boot
marker advances only when the notice was posted again, so a notice that
could not be posted is retried at the next recovery. Each reminder is
recovered on its own, so one damaged record does not stop the others.

```quint
pure def reboot(s: ReminderAlarm): ReminderAlarm = { ...s, alarm: NoAlarm, noticeShown: false, boot: s.boot + 1 }
pure def recover(s: ReminderAlarm, heldAtCheck: bool, heldAtArm: bool, notifyAllowed: bool, repostSucceeds: bool): ReminderAlarm =
  if (s.keptStatus == StoredDeletionPending) { ...s, alarm: NoAlarm, noticeShown: false, restoredBoot: s.boot }
  else if (s.keptStatus == StoredScheduled) { ...s, alarm: alarmKind(heldAtCheck, heldAtArm), restoredBoot: s.boot }
  else if (s.keptStatus == StoredPosted and s.restoredBoot != s.boot)
    (if (notifyAllowed and repostSucceeds) { ...s, noticeShown: true, restoredBoot: s.boot } else s)
  else { ...s, restoredBoot: if (s.keptStatus == StoredPosted) s.restoredBoot else s.boot }
pure def stepNoTransitionMovesTheOccurrence(before: ReminderAlarm, after: ReminderAlarm): bool = after.occurrence == before.occurrence
pure def stepRecoveryKeepsTheStoredStatus(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  via == "recover" implies after.keptStatus == before.keptStatus
pure def stepNoticeRepostedAtMostOncePerBoot(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  (via == "recover" and before.restoredBoot == before.boot and before.keptStatus == StoredPosted) implies after.noticeShown == before.noticeShown
pure def stepMarkerAdvancesOnlyWithTheNotice(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  (via == "recover" and before.keptStatus == StoredPosted and before.restoredBoot != before.boot and after.restoredBoot == after.boot) implies after.noticeShown
pure def stepDeletionPendingLosesAlarmAndNotice(before: ReminderAlarm, via: str, after: ReminderAlarm): bool =
  (via == "recover" and before.keptStatus == StoredDeletionPending) implies (after.alarm == NoAlarm and not(after.noticeShown))
pure def alwaysRestoredBootIsKnown(s: ReminderAlarm): bool = s.boot >= 1 and s.restoredBoot >= 1 and s.restoredBoot <= s.boot
pure def sometimesRearmedAfterReboot(s: ReminderAlarm): bool = s.boot > 1 and s.alarm != NoAlarm
pure def sometimesNoticeBackAfterReboot(s: ReminderAlarm): bool = s.boot > 1 and s.keptStatus == StoredPosted and s.noticeShown and s.restoredBoot == s.boot
```
