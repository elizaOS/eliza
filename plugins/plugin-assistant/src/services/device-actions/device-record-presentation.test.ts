import { expect, test } from "vitest";
import type { CalendarOperation } from "./calendar-contract.ts";
import { presentDeviceRecordOperation } from "./device-record-presentation.ts";
import type { ReminderCreateOperation } from "./reminder-create-contract.ts";

const event: Extract<CalendarOperation, { type: "calendar_create" }> = {
  type: "calendar_create",
  source: { sourceId: "private-source-id", sourceRevision: "private-revision" },
  fields: {
    title: "Calendar QA MAPLE-51",
    description: "Bring the blue folder.",
    location: "",
    start: "2026-10-08T16:00:00.000Z",
    end: "2026-10-08T16:15:00.000Z",
    timeZone: "America/Los_Angeles",
  },
};

test("Calendar review and receipt use the event zone and omit empty fields and identifiers", () => {
  const before = structuredClone(event);
  const presentation = presentDeviceRecordOperation(event, "Asia/Tokyo");
  expect(presentation.title).toBe("Create event");
  expect(presentation.description).toContain("Calendar QA MAPLE-51");
  expect(presentation.description).toContain("October 8, 2026 at 9:00 AM PDT");
  expect(presentation.description).toContain("9:15 AM PDT");
  expect(presentation.description).toContain("America/Los_Angeles");
  expect(presentation.description).toContain("Bring the blue folder.");
  expect(presentation.description).not.toMatch(
    /Location:|private-source|private-revision|2026-10-08T|\{|\}/,
  );
  expect(presentation.appliedSummary).toContain(
    "Created event “Calendar QA MAPLE-51”",
  );
  expect(event).toEqual(before);
});

test("Calendar fall-back hour distinguishes the two exact instants", () => {
  const presentation = presentDeviceRecordOperation({
    ...event,
    fields: {
      ...event.fields,
      start: "2026-11-01T08:30:00.000Z",
      end: "2026-11-01T09:30:00.000Z",
    },
  });
  expect(presentation.description).toContain("1:30 AM PDT");
  expect(presentation.description).toContain("1:30 AM PST");
});

test("Reminder review preserves message, due time, no-alert state and recurrence zone", () => {
  const reminder: ReminderCreateOperation = {
    type: "reminder_create",
    fields: {
      title: "Bring the folder",
      body: "Bring the blue folder.",
      schedule: {
        dueAt: Date.parse("2026-10-08T16:00:00.000Z"),
        at: Date.parse("2026-10-08T16:00:00.000Z"),
        alertMinutes: null,
        recurrence: null,
      },
    },
  };
  const before = structuredClone(reminder);
  const oneShot = presentDeviceRecordOperation(reminder, "America/Los_Angeles");
  expect(oneShot.description).toContain("Bring the blue folder.");
  expect(oneShot.description).toContain("9:00 AM PDT (America/Los_Angeles)");
  expect(oneShot.description).toContain("No alert; saved task only.");
  expect(oneShot.description).toContain("Does not repeat.");
  expect(oneShot.description).not.toMatch(/Alert October|\{|\}/);
  expect(reminder).toEqual(before);
  const repeated = presentDeviceRecordOperation(
    {
      ...reminder,
      fields: {
        ...reminder.fields,
        schedule: {
          ...reminder.fields.schedule,
          at: Date.parse("2026-10-08T15:45:00.000Z"),
          alertMinutes: 15,
          recurrence: {
            rule: "weekdays",
            zone: "America/Los_Angeles",
            date: "2026-10-08",
            time: "09:00",
            leadMinutes: 15,
          },
        },
      },
    },
    "UTC",
  );
  expect(repeated.description).toContain("Due October 8, 2026 at 9:00 AM PDT");
  expect(repeated.description).toContain(
    "Alert October 8, 2026 at 8:45 AM PDT",
  );
  expect(repeated.description).toContain(
    "Repeats on weekdays at 09:00 (America/Los_Angeles).",
  );
});

test("Notes review and receipt preserve exact title and body without record identifiers", () => {
  const fields = {
    title: "  Blue folder  ",
    body:
      "\n  First line.\n\n" +
      "Keep this exact text. ".repeat(100) +
      "\nLast line.  \n",
  };
  const target = {
    sourceId: "private-source",
    sourceRevision: "private-source-revision",
    noteId: "private-note",
    revision: "private-note-revision",
  };
  const before = structuredClone({ fields, target });
  for (const operation of [
    { type: "create_note" as const, ...fields },
    { type: "notes_update" as const, fields, target },
  ]) {
    const presentation = presentDeviceRecordOperation(operation);
    const creating = operation.type === "create_note";
    expect(presentation.description).toBe(
      `${creating ? "Create" : "Update"} note\n“${fields.title}”\n${fields.body}`,
    );
    expect(presentation.appliedSummary).toBe(
      `${creating ? "Saved" : "Updated"} note “${fields.title}”\n${fields.body}`,
    );
  }
  const shared = presentDeviceRecordOperation({
    type: "notes_read_selected",
    target,
  });
  expect(shared.description).toBe(
    "Share selected note\nSend this note’s exact title and text to the connected agent.",
  );
  const deleted = presentDeviceRecordOperation({
    type: "notes_delete",
    target,
  });
  expect(deleted.description).toContain("Attached audio files are retained.");
  expect(shared.description + deleted.description).not.toMatch(
    /private-source|private-note|\{|\}/,
  );
  expect({ fields, target }).toEqual(before);
});
