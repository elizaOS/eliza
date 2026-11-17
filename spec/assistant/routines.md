# Routines

A routine is a habit the owner keeps on a cadence, such as brushing teeth
morning and night or stretching in the afternoon. Each due time is an
occurrence: pending until its window opens, then shown to the owner, who
completes it, skips it or snoozes it; an occurrence nobody answered
expires when its window ends. The owner may mute a routine. During
onboarding the assistant offers starter routines from its templates. The
owner's client creates, changes and deletes a routine's definition through
the agent's routes. This machine follows the offered templates, the current
occurrence of one routine and the definitions the owner created.

## Story: Keep my habits on their cadence

> As an owner, I want each routine to show up when it is due, to accept
> my answer once, and never to offer me the same starter twice.

### A starter routine is created at most once for each template

```quint
type OccurrencePhase = OccurrencePending | OccurrenceVisible | OccurrenceSnoozed | OccurrenceCompleted | OccurrenceSkipped | OccurrenceExpired
type DefinitionStatus = DefinitionAbsent | DefinitionActive | DefinitionPaused | DefinitionArchived
type DefinitionReply = NoDefinitionReply | DefinitionSaved | DefinitionDeleted
type Routines = { seeded: Set[str], occurrence: OccurrencePhase, shown: bool, snoozes: int, occurrences: int, muted: bool,
  createKeys: Set[str], definitions: int, definition: DefinitionStatus, replied: DefinitionReply, repliedStatus: DefinitionStatus }
pure val initial: Routines = { seeded: Set(), occurrence: OccurrencePending, shown: false, snoozes: 0, occurrences: 1, muted: false,
  createKeys: Set(), definitions: 0, definition: DefinitionAbsent, replied: NoDefinitionReply, repliedStatus: DefinitionAbsent }
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

## Story: Create, change and delete a routine from my own client

> As the owner, a routine I create from my client is created once even if
> my request is retried, a change answers with exactly what was saved, and a
> deletion says it deleted.

### A creation with an idempotency key creates at most one definition

Creating a definition needs a nonblank idempotency key. The first creation
with a key creates one active definition; a repeat with the same key answers
with the definition as it is and creates nothing.

```quint
pure val idempotencyKeyValues = Set("create-1", "create-2", "")
pure def canCreateDefinition(s: Routines, idempotencyKey: str): bool = idempotencyKey != ""
pure def createDefinition(s: Routines, idempotencyKey: str): Routines =
  if (s.createKeys.contains(idempotencyKey)) { ...s, replied: DefinitionSaved, repliedStatus: s.definition }
  else { ...s, createKeys: s.createKeys.union(Set(idempotencyKey)), definitions: s.definitions + 1, definition: DefinitionActive, replied: DefinitionSaved, repliedStatus: DefinitionActive }
pure def stepRepeatedKeyCreatesNothing(before: Routines, via: str, after: Routines): bool =
  via == "createDefinition" implies (after.definitions == before.definitions or after.definitions == before.definitions + 1) and
    (before.createKeys.subseteq(after.createKeys)) and
    (after.definitions == before.definitions + 1 implies not(after.createKeys.subseteq(before.createKeys)))
pure def alwaysOneDefinitionPerKey(s: Routines): bool = s.definitions == s.createKeys.size()
pure def sometimesRepeatedCreation(s: Routines): bool = s.definitions == 1 and s.replied == DefinitionSaved and s.definition == DefinitionPaused
```

### A change answers with the definition as saved, and a deletion answers deleted

A change to an existing definition sets its status to active, paused or
archived, and answers with the saved definition, whose status is the one
asked for. Deleting an existing definition removes it and answers deleted;
a definition that does not exist can be neither changed nor deleted.

```quint
pure val statusValues = Set(DefinitionActive, DefinitionPaused, DefinitionArchived, DefinitionAbsent)
pure def canUpdateDefinition(s: Routines, status: DefinitionStatus): bool = s.definition != DefinitionAbsent and status != DefinitionAbsent
pure def updateDefinition(s: Routines, status: DefinitionStatus): Routines = { ...s, definition: status, replied: DefinitionSaved, repliedStatus: status }
pure def canDeleteDefinition(s: Routines): bool = s.definition != DefinitionAbsent
pure def deleteDefinition(s: Routines): Routines = { ...s, definition: DefinitionAbsent, replied: DefinitionDeleted, repliedStatus: DefinitionAbsent }
pure def alwaysReplyIsTheSavedDefinition(s: Routines): bool =
  (s.replied == DefinitionSaved implies s.repliedStatus == s.definition) and (s.replied == DefinitionDeleted implies s.definition == DefinitionAbsent)
pure def sometimesDeletedAfterChange(s: Routines): bool = s.replied == DefinitionDeleted and s.definitions > 0
```
