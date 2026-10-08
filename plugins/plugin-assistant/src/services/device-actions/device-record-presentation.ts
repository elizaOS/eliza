/** Human-readable device review and receipt text. Presentation grants no authority. */
import type { CalendarOperation } from "./calendar-contract.ts";
import type { NotesOperation } from "./notes-contract.ts";
import type {
  ReminderOperation,
  ReminderSchedule,
} from "./reminder-contract.ts";
import type { ReminderCreateOperation } from "./reminder-create-contract.ts";

function formatDateTime(value: string | number, timeZone: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(date.getUTCSeconds() || date.getUTCMilliseconds()
      ? { second: "2-digit" as const }
      : {}),
    ...(date.getUTCMilliseconds()
      ? { fractionalSecondDigits: 3 as const }
      : {}),
    timeZoneName: "short",
  }).format(date);
}

function presentReminderTiming(
  schedule: ReminderSchedule,
  timeZone: string,
): { description: string; summary: string } {
  const zone = schedule.recurrence?.zone ?? timeZone;
  const lines = [
    `Due ${formatDateTime(schedule.dueAt ?? schedule.at, zone)} (${zone}).`,
  ];
  if (schedule.alertMinutes === null) lines.push("No alert; saved task only.");
  else {
    lines.push(
      `Alert ${formatDateTime(schedule.at, zone)}. Notification delivery may be approximate.`,
    );
  }
  const summary = lines.join(" ");
  lines.push(
    schedule.recurrence
      ? `Repeats ${schedule.recurrence.rule === "weekdays" ? "on weekdays" : schedule.recurrence.rule} at ${schedule.recurrence.time} (${zone}).`
      : "Does not repeat.",
  );
  return { description: lines.join("\n"), summary };
}

/** Use appliedSummary only after the existing native receipt proves application. */
export function presentDeviceRecordOperation(
  operation:
    | CalendarOperation
    | NotesOperation
    | ReminderOperation
    | ReminderCreateOperation
    | { type: "create_reminder"; title: string; dueAt: string }
    | { type: "create_note"; title: string; body: string },
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { title: string; description: string; appliedSummary: string } {
  let title: string;
  let applied: string;
  let details = "";
  let summaryDetails = "";
  switch (operation.type) {
    case "create_note":
    case "notes_update": {
      const fields =
        operation.type === "create_note" ? operation : operation.fields;
      title = operation.type === "create_note" ? "Create note" : "Update note";
      applied =
        operation.type === "create_note" ? "Saved note" : "Updated note";
      details = `“${fields.title}”\n${fields.body}`;
      summaryDetails = fields.title.trim() ? `“${fields.title}”.` : "";
      break;
    }
    case "notes_read_selected":
      title = "Share selected note";
      applied = "Shared selected note";
      details = "Send this note’s exact title and text to the connected agent.";
      break;
    case "notes_delete":
      title = "Delete selected note";
      applied = "Deleted selected note";
      details =
        "Delete this note from this phone. Attached audio files are retained.";
      break;
    case "calendar_create":
    case "calendar_update": {
      const fields = operation.fields;
      title =
        operation.type === "calendar_create" ? "Create event" : "Update event";
      applied =
        operation.type === "calendar_create"
          ? "Created event"
          : "Updated event";
      const timing = `${formatDateTime(fields.start, fields.timeZone)} – ${formatDateTime(fields.end, fields.timeZone)} (${fields.timeZone})`;
      summaryDetails = `“${fields.title}” — ${timing}.`;
      details = [
        `“${fields.title}”`,
        timing,
        ...(fields.location.trim() ? [`Location: ${fields.location}`] : []),
        ...(fields.description.trim() ? [fields.description] : []),
      ].join("\n");
      break;
    }
    case "calendar_read_selected":
      title = "Share selected event";
      applied = "Shared selected event";
      details =
        "Send this event’s title, details, location and time to the connected agent.";
      break;
    case "calendar_delete":
      title = "Delete selected event";
      applied = "Deleted selected event";
      details = "Delete this event from this phone. This cannot be undone.";
      break;
    case "reminder_create":
    case "reminder_update": {
      const fields = operation.fields;
      title =
        operation.type === "reminder_create"
          ? "Create reminder"
          : "Update reminder";
      applied =
        operation.type === "reminder_create"
          ? "Created reminder"
          : "Updated reminder";
      const timing = fields.schedule
        ? presentReminderTiming(fields.schedule, timeZone)
        : undefined;
      details = [
        `“${fields.title}”`,
        ...(fields.body.trim() ? [fields.body] : []),
        timing?.description ?? "Timing unchanged.",
      ].join("\n");
      summaryDetails = `“${fields.title}”. ${timing?.summary ?? "Timing unchanged."}`;
      break;
    }
    case "create_reminder":
      title = "Create reminder";
      applied = "Created reminder";
      details = `“${operation.title}”\nDue ${formatDateTime(operation.dueAt, timeZone)} (${timeZone}).\nNotification delivery may be approximate.`;
      summaryDetails = `“${operation.title}”. Due ${formatDateTime(operation.dueAt, timeZone)} (${timeZone}). Alert requested; notification delivery may be approximate.`;
      break;
    case "reminder_read_selected":
      title = "Share selected reminder";
      applied = "Shared selected reminder";
      details =
        "Send this reminder’s title, details and schedule to the connected agent.";
      break;
    case "reminder_complete":
      title = "Complete selected reminder";
      applied = "Completed selected reminder";
      details =
        "Complete this occurrence. A repeating reminder advances to its next future occurrence.";
      break;
    case "reminder_snooze":
      title = "Snooze selected reminder";
      applied = "Snoozed selected reminder";
      details = "Snooze this occurrence for ten minutes.";
      break;
    case "reminder_cancel":
      title = "Cancel selected reminder";
      applied = "Cancelled selected reminder";
      details = "Cancel this reminder and all its future repeats.";
      break;
  }
  return {
    title,
    description: `${title}\n${details}`,
    appliedSummary: summaryDetails
      ? `${applied} ${summaryDetails}`
      : `${applied}.`,
  };
}
