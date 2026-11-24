# Personal assistance

`@elizaos/plugin-personal-assistant` helps one owner with their own time:
reminders, goals, to-dos and routines, follow-ups on approvals they left
open, check-in summaries, a daily dossier, and the owner's local time zone
that all of them fire in, including while the owner says they are away.
It runs inside the owner's agent, on the owner's
device, and it stores the owner's records in the agent's database. It
never limits how much a model may write: every model call it makes names
no output limit, so an answer is never cut short.

The scheduled-task runner, the agent's approvals and the device's native
reminders are owned elsewhere ([agent scheduled tasks](../agent/schedule/scheduledTasks.md),
[device action custody](../agent/deviceActions/execution.md),
[device reminder alarms](../os/android/deepLinks.md)); the specs here say what
the assistant asks of them and what it keeps itself. Guided bill evidence
belongs to this package. Household, family, travel, health and blocking
services belong to their domain owners.

| Area | Specification |
| --- | --- |
| Creating reminders the owner asked for | [Reminders](./reminders.md), [reminder presentation](./reminderPresentation.md) |
| Nudging again about an unanswered reminder, outside quiet hours and as persistently as the owner asked | [Reminder escalation](./reminderEscalation.md) |
| Naming a reminder or a goal by its title or some of its words | [Names](./names.md) |
| The owner's local time zone | [Time zone](./timezone.md) |
| Trips the owner tells the assistant about | [Travel](./travel.md) |
| Follow-ups on open approvals | [Follow-ups](./followups.md) |
| Check-in summaries, the times they come, and briefs on request | [Check-ins](./checkin.md) |
| Goals, their check-ins and their reviews | [Goals](./goals.md) |
| To-dos | [To-dos](./todos.md) |
| Routines and their occurrences | [Routines](./routines.md) |
| The daily dossier | [Scheduled dossiers](./scheduledDossiers.md) |
| On-demand briefs and prioritization | [Owner briefs](./ownerBrief.md) |
| Evidence for bills the owner submits | [Guided bill evidence](./billEvidence.md) |
| What the owner hears about the assistant's work | [Replies](./replies.md) |
| Evaluating finished turns in batches | [Evaluator runner](./evaluatorRunner.md), [durable progress](./evaluatorProgress.md), [evidence pages](./evaluatorEvidencePages.md) |
