# Routines

A routine is a habit the owner keeps on a cadence, such as brushing teeth
morning and night or stretching in the afternoon. Each due time is an
occurrence: pending until its window opens, then shown to the owner, who
completes it, skips it or snoozes it; an occurrence nobody answered
expires when its window ends. The owner may mute a routine. During
onboarding the assistant offers starter routines from its templates. This
machine follows the offered templates and the current occurrence of one
routine.

## Story: Keep my habits on their cadence

> As an owner, I want each routine to show up when it is due, to accept
> my answer once, and never to offer me the same starter twice.

### A starter routine is created at most once for each template

```quint
type OccurrencePhase = OccurrencePending | OccurrenceVisible | OccurrenceSnoozed | OccurrenceCompleted | OccurrenceSkipped | OccurrenceExpired
type Routines = { seeded: Set[str], occurrence: OccurrencePhase, shown: bool, snoozes: int, occurrences: int, muted: bool }
pure val initial: Routines = { seeded: Set(), occurrence: OccurrencePending, shown: false, snoozes: 0, occurrences: 1, muted: false }
pure val templateKeyValues = Set("brush-teeth", "stretch", "drink-water")
pure def canSeedRoutine(s: Routines, templateKey: str): bool = not(s.seeded.contains(templateKey))
pure def seedRoutine(s: Routines, templateKey: str): Routines = { ...s, seeded: s.seeded.union(Set(templateKey)) }
pure def stepSeedingAddsOneNewTemplate(before: Routines, via: str, after: Routines): bool =
  before.seeded.subseteq(after.seeded) and (via == "seedRoutine" implies after.seeded.size() == before.seeded.size() + 1)
```

### An occurrence is answered only after it was shown

A pending occurrence is shown when its window opens, and a showing
occurrence was shown. The owner completes, skips or snoozes a shown
occurrence; a snoozed one is shown again later.

```quint
pure def answerable(phase: OccurrencePhase): bool = phase == OccurrenceVisible
pure def canShowOccurrence(s: Routines): bool = not(s.muted) and (s.occurrence == OccurrencePending or s.occurrence == OccurrenceSnoozed)
pure def showOccurrence(s: Routines): Routines = { ...s, occurrence: OccurrenceVisible, shown: true }
pure def canCompleteOccurrence(s: Routines): bool = answerable(s.occurrence)
pure def completeOccurrence(s: Routines): Routines = { ...s, occurrence: OccurrenceCompleted }
pure def canSkipOccurrence(s: Routines): bool = answerable(s.occurrence)
pure def skipOccurrence(s: Routines): Routines = { ...s, occurrence: OccurrenceSkipped }
pure def canSnoozeOccurrence(s: Routines): bool = answerable(s.occurrence)
pure def snoozeOccurrence(s: Routines): Routines = { ...s, occurrence: OccurrenceSnoozed, snoozes: s.snoozes + 1 }
pure def alwaysAnsweredOccurrencesWereShown(s: Routines): bool =
  (s.occurrence == OccurrenceCompleted or s.occurrence == OccurrenceSkipped or s.occurrence == OccurrenceSnoozed) implies s.shown
pure def alwaysShowingOccurrenceWasShown(s: Routines): bool = s.occurrence == OccurrenceVisible implies s.shown
```

### An unanswered occurrence expires when its window ends

```quint
pure def canExpireOccurrence(s: Routines): bool =
  s.occurrence == OccurrencePending or s.occurrence == OccurrenceVisible or s.occurrence == OccurrenceSnoozed
pure def expireOccurrence(s: Routines): Routines = { ...s, occurrence: OccurrenceExpired }
```

### A settled occurrence keeps its outcome until the next occurrence begins

```quint
pure def resolved(phase: OccurrencePhase): bool = phase == OccurrenceCompleted or phase == OccurrenceSkipped or phase == OccurrenceExpired
pure def canNextOccurrence(s: Routines): bool = resolved(s.occurrence)
pure def nextOccurrence(s: Routines): Routines = { ...s, occurrence: OccurrencePending, shown: false, snoozes: 0, occurrences: s.occurrences + 1 }
pure def stepSettledOutcomeIsKept(before: Routines, via: str, after: Routines): bool =
  (resolved(before.occurrence) and via != "nextOccurrence") implies after.occurrence == before.occurrence
```

### A muted routine shows nothing until it is unmuted

Muting takes back an occurrence that is showing or snoozed, so it waits
unanswered; a settled outcome stays as it was.

```quint
pure def canMuteRoutine(s: Routines): bool = not(s.muted)
pure def muteRoutine(s: Routines): Routines =
  { ...s, muted: true, occurrence: if (s.occurrence == OccurrenceVisible or s.occurrence == OccurrenceSnoozed) OccurrencePending else s.occurrence }
pure def canUnmuteRoutine(s: Routines): bool = s.muted
pure def unmuteRoutine(s: Routines): Routines = { ...s, muted: false }
pure def alwaysMutedRoutineShowsNothing(s: Routines): bool = s.muted implies s.occurrence != OccurrenceVisible
```

### An occurrence can be completed after a snooze, expire unseen, and a routine can be muted

```quint
pure def sometimesCompletedAfterSnooze(s: Routines): bool = s.occurrence == OccurrenceCompleted and s.snoozes > 0
pure def sometimesExpiredUnseen(s: Routines): bool = s.occurrence == OccurrenceExpired and not(s.shown)
pure def sometimesMutedAfterSeeding(s: Routines): bool = s.muted and s.shown and s.seeded.size() > 0
```
