# Scheduled dossiers

The daily dossier is a managed scheduled task that prepares the owner's
day. It fires automatically at most once per owner day, and only after the
owner was actually active that day: the owner's device reports a
foreground or unlock signal, the server authenticates it as the owner's,
and the signal is admitted against the dossier's control state. The
control state is written in the same conditional write as each edit,
dismissal or reopening of the task, and the automatic fire
consumes the admission in the same claim that fires it. A manual refresh
or a read consumes nothing.

The owner day is the civil day in the owner's zone with its own boundary
minute: activity before the boundary counts for the day before. Times
here are minutes on the owner's clock, and days are numbered from 1.
This spec owns when the daily digest fires; [hosted digests](../workflow/hostedDigest.md)
own its delivery and the offer of a missed run.

## Story: Prepare my day once, after I am up

> As an owner, I want my daily dossier ready once a day after I first use
> my device, never fired by a signal that was not mine, and never twice
> for the same day.

### A change of the dossier's control starts a new generation and drops any admission

The dossier is enabled unless its trigger is manual or the task was
dismissed. Turning it on or off, changing the day boundary, or reopening
a finished task starts a new generation from now. The admission of the
old generation is dropped, and the last consumed day is kept.

```quint
pure val dayMinutes = 1440
type DossierControl = { dossierOn: bool, generation: int, enabledAt: int, boundary: int, admittedDay: int, admittedAt: int, consumedDay: int, now: int, fires: int }
pure val initial: DossierControl = { dossierOn: false, generation: 0, enabledAt: 0, boundary: 0, admittedDay: 0, admittedAt: 0, consumedDay: 0, now: 0, fires: 0 }
pure def ownerDay(at: int, boundary: int): int = (at + dayMinutes - boundary) / dayMinutes
pure val boundaryValues = Set(0, 360)
pure def canSetDossierControl(s: DossierControl, turnOn: bool, boundary: int, reopened: bool): bool =
  boundary >= 0 and boundary < dayMinutes and (s.generation == 0 or turnOn != s.dossierOn or boundary != s.boundary or reopened)
pure def setDossierControl(s: DossierControl, turnOn: bool, boundary: int, reopened: bool): DossierControl =
  { ...s, dossierOn: turnOn, boundary: boundary, generation: s.generation + 1, enabledAt: s.now, admittedDay: 0, admittedAt: 0 }
pure val minutesValues = Set(60, 600, 1440)
pure def canPassTime(s: DossierControl, minutes: int): bool = minutes > 0
pure def passTime(s: DossierControl, minutes: int): DossierControl = { ...s, now: s.now + minutes }
pure def alwaysTimeIsOrdered(s: DossierControl): bool =
  s.now >= 0 and s.enabledAt >= 0 and s.enabledAt <= s.now and s.boundary >= 0 and s.boundary < dayMinutes and s.consumedDay >= 0
```

### Only the owner's own foreground or unlock activity is admitted, once per owner day

The activity must be authenticated as the owner's, be a foreground or
unlock signal, arrive while the dossier is enabled and not before its
generation began, and fall on an owner day later than both the consumed
day and any day already admitted.

```quint
type ActivityKind = ForegroundActivity | UnlockActivity | OtherActivity
pure def canAdmitActivity(s: DossierControl, fromOwner: bool, kind: ActivityKind): bool =
  s.dossierOn and fromOwner and kind != OtherActivity and s.now >= s.enabledAt and
  ownerDay(s.now, s.boundary) > s.consumedDay and ownerDay(s.now, s.boundary) > s.admittedDay
pure def admitActivity(s: DossierControl, fromOwner: bool, kind: ActivityKind): DossierControl =
  { ...s, admittedDay: ownerDay(s.now, s.boundary), admittedAt: s.now }
pure def alwaysAdmissionMatchesItsControl(s: DossierControl): bool =
  s.admittedDay != 0 implies (s.dossierOn and s.admittedAt >= s.enabledAt and s.admittedAt <= s.now and ownerDay(s.admittedAt, s.boundary) == s.admittedDay and s.admittedDay > s.consumedDay)
```

### The dossier fires automatically only on the day of a current admission, and consumes it

```quint
pure def canFireDossier(s: DossierControl): bool =
  s.dossierOn and s.admittedDay != 0 and s.admittedDay == ownerDay(s.now, s.boundary) and s.admittedAt <= s.now
pure def fireDossier(s: DossierControl): DossierControl = { ...s, consumedDay: s.admittedDay, admittedDay: 0, admittedAt: 0, fires: s.fires + 1 }
pure def stepFiresOncePerOwnerDay(before: DossierControl, via: str, after: DossierControl): bool =
  after.consumedDay >= before.consumedDay and (via == "fireDossier" implies after.consumedDay > before.consumedDay)
```

### A dossier can fire on two days, and a control change can drop a pending admission

```quint
pure def sometimesFiredOnTwoDays(s: DossierControl): bool = s.fires == 2
pure def sometimesAdmissionDroppedByControlChange(s: DossierControl): bool = s.generation >= 2 and s.dossierOn and s.admittedDay == 0 and s.consumedDay == 0 and s.now > s.enabledAt
pure def sometimesDisabledAfterFiring(s: DossierControl): bool = not(s.dossierOn) and s.consumedDay > 0
```
