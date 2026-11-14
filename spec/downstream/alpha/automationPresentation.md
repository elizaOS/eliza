# Alpha automation feed and reminder presentation

Alpha's `prototype/automations-adapter.ts` and
`runtime/automations-protocol.ts` consume pinned Eliza UI utilities
`automation-feed-filter.ts`, `cron-format.ts`, and
`reminder-presentation.ts`. These helpers are pure presentation policy.
[Workflow lifecycle](../workflow.md) and [reminder custody](../reminderCustody.md)
own scheduling, persistence and mutations. Labels and filters never
authorize those effects.

## Story: Find the right automation and see an honest schedule and delivery status

### The unified list retains type and enabled status independently

The shared filters are all, reminders, prompts, workflows, active and
inactive. The shared two-kind filter admits task as prompt and workflow
as workflow, and returns no rows for reminders. Alpha adds schedules and
adapts its own reminder, device reminder, schedule and routine rows:
Reminders shows the two reminder kinds; Schedules shows schedules;
Prompts excludes those, routines and workflows. Active and Inactive
select by enabled flag across Alpha row kinds. Empty or partially failed
provider reads cannot be used as evidence that an effect was applied.
Retained intent reconciliation belongs to the effect owner.

```quint
type AutomationKind = Prompt | Workflow | Reminder | DeviceReminder | Schedule | Routine
type FeedFilter = AllRows | RemindersOnly | PromptsOnly | WorkflowsOnly | SchedulesOnly | ActiveRows | InactiveRows
pure def inAlphaFilter(kind: AutomationKind, isEnabled: bool, mode: FeedFilter): bool = match mode {
  | AllRows => true
  | RemindersOnly => kind == Reminder or kind == DeviceReminder
  | PromptsOnly => kind == Prompt
  | WorkflowsOnly => kind == Workflow
  | SchedulesOnly => kind == Schedule
  | ActiveRows => isEnabled
  | InactiveRows => not(isEnabled)
}
pure def lawActiveAndInactivePartition(kind: AutomationKind, isEnabled: bool): bool =
  inAlphaFilter(kind, isEnabled, ActiveRows) == not(inAlphaFilter(kind, isEnabled, InactiveRows))
pure def lawPromptsExcludeNonPrompts(kind: AutomationKind, isEnabled: bool): bool =
  inAlphaFilter(kind, isEnabled, PromptsOnly) == (kind == Prompt)
pure def lawReminderAndScheduleDoNotOverlap(kind: AutomationKind, isEnabled: bool): bool =
  not(inAlphaFilter(kind, isEnabled, RemindersOnly) and inAlphaFilter(kind, isEnabled, SchedulesOnly))
```

### A reminder label follows exact terminal and delivery precedence

Due display picks snoozedUntil, then occurrence due, then the once
definition's local due value, using nullish rather than truthy precedence.
Archived, paused and completed definitions take precedence over
occurrence and attempt. A terminal occurrence supplies its own label.
An unrecognized occurrence is unknown before reading the attempt.
For pending or visible occurrences, or where none is offered, a
delivered/blocked attempt prefix names that outcome, skipped_duplicate
names duplicate, and an unknown nonempty attempt stays unknown. With
no attempt, distinguish scheduled occurrence and unscheduled definition.
Snooze is available only while active with pending, visible or snoozed
occurrence and no acknowledgement. The source must still admit
authority at mutation time.

```quint
type DefinitionStatus = DefActive | DefArchived | DefPaused | DefCompleted | DefOther
type OccurrenceStatus = NoOccurrence | Pending | Visible | Snoozed | Completed | Skipped | Expired | Muted | OccurrenceUnknown
type AttemptStatus = NoAttempt | AttemptDelivered | AttemptBlocked | AttemptDuplicate | AttemptUnknown
type DeliveryLabel = CancelledLabel | PausedLabel | CompletedLabel | SnoozedLabel | SkippedLabel | ExpiredLabel | MutedLabel | UnknownLabel | DeliveredLabel | BlockedLabel | DuplicateLabel | ScheduledLabel | UnscheduledLabel
pure def deliveryLabel(definition: DefinitionStatus, occurrence: OccurrenceStatus, attempt: AttemptStatus): DeliveryLabel =
  if (definition == DefArchived) CancelledLabel else if (definition == DefPaused) PausedLabel else if (definition == DefCompleted) CompletedLabel else
  if (occurrence == Snoozed) SnoozedLabel else if (occurrence == Completed) CompletedLabel else if (occurrence == Skipped) SkippedLabel else
  if (occurrence == Expired) ExpiredLabel else if (occurrence == Muted) MutedLabel else if (occurrence == OccurrenceUnknown) UnknownLabel else
  if (attempt == AttemptDelivered) DeliveredLabel else if (attempt == AttemptBlocked) BlockedLabel else if (attempt == AttemptDuplicate) DuplicateLabel else
  if (attempt == AttemptUnknown) UnknownLabel else if (occurrence == NoOccurrence) UnscheduledLabel else ScheduledLabel
pure def offersSnooze(definition: DefinitionStatus, occurrence: OccurrenceStatus, acknowledged: bool): bool =
  definition == DefActive and not(acknowledged) and (occurrence == Pending or occurrence == Visible or occurrence == Snoozed)
pure def lawAcknowledgedCannotOfferSnooze(definition: DefinitionStatus, occurrence: OccurrenceStatus): bool =
  not(offersSnooze(definition, occurrence, true))
pure def lawArchivedPrecedesDelivery(occurrence: OccurrenceStatus, attempt: AttemptStatus): bool =
  deliveryLabel(DefArchived, occurrence, attempt) == CancelledLabel
pure def lawPendingWithoutAttemptIsScheduled(definition: DefinitionStatus): bool =
  definition == DefActive implies deliveryLabel(definition, Pending, NoAttempt) == ScheduledLabel
```

### Friendly cron labels require the exact supported cadence

The helper accepts five-field expressions with a wildcard month for
friendly formatting; unsupported values are displayed unchanged.
A wildcard cadence step can be described as every N minutes only
if the step is positive and divides 60, because scheduling resets at
each hour. An hour step at minute zero similarly needs a positive
divisor of 24. It recognizes clock-hour cadence at minute zero, and
numeric hour/minute recurring daily, weekdays, weekends or one
weekday. Validate bounded integers and full field syntax before
describing: a range/list must not become a single daily time. The five
published presets are hourly, 9am every day, weekdays at 9am, Monday
at 9am, and every 15 minutes. Parsed fields and locale-specific
formatting require adapter fixtures; this model checks the admitted
clock/cadence values.

```quint
pure def evenMinuteCadence(minutes: int): bool = minutes > 0 and minutes <= 60 and 60 % minutes == 0
pure def evenHourCadence(hours: int): bool = hours > 0 and hours <= 24 and 24 % hours == 0
pure def exactClock(minute: int, hour: int, singleFields: bool): bool =
  singleFields and minute >= 0 and minute <= 59 and hour >= 0 and hour <= 23
pure def lawUnevenMinuteStepsKeepRaw(minutes: int): bool = (minutes == 45 or minutes <= 0) implies not(evenMinuteCadence(minutes))
pure def lawUnevenHourStepsKeepRaw(hours: int): bool = (hours == 5 or hours <= 0) implies not(evenHourCadence(hours))
pure def lawRangeCannotBecomeClock(minute: int, hour: int): bool = not(exactClock(minute, hour, false))
```
