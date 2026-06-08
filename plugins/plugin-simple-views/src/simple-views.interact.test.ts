// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { CALENDAR_CURSOR_KEY, CALENDAR_EVENTS_KEY, NOTES_KEY } from "./storage";
import { interact } from "./simple-views.interact";

describe("simple views interact capabilities", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates and reads sticky notes with structured title and body params", async () => {
    const created = (await interact("create-note", {
      title: "codex live note",
      body: "created from chat routing",
      color: "blue",
    })) as {
      success: boolean;
      text: string;
      note: { title: string; body: string; color: string };
    };

    expect(created).toMatchObject({
      success: true,
      text: 'Created sticky note "codex live note".',
      note: {
        title: "codex live note",
        body: "created from chat routing",
        color: "blue",
      },
    });

    const stored = JSON.parse(window.localStorage.getItem(NOTES_KEY) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      title: "codex live note",
      body: "created from chat routing",
      color: "blue",
    });

    const listed = (await interact("get-notes")) as {
      success: boolean;
      text: string;
      notes: Array<{ title: string; body: string }>;
    };
    expect(listed.success).toBe(true);
    expect(listed.text).toContain("codex live note: created from chat routing");
    expect(listed.notes[0]).toMatchObject({
      title: "codex live note",
      body: "created from chat routing",
    });
  });

  it("deletes sticky notes by title or query without requiring an opaque id", async () => {
    await interact("create-note", {
      title: "nubby nubs",
      body: "soft wind whispers",
    });
    await interact("create-note", {
      title: "wake up",
      body: "i need to wake up at 3am",
    });

    const deleted = (await interact("delete-note", {
      query: "nubby",
    })) as { success: boolean; deleted: boolean; text: string };

    expect(deleted).toMatchObject({
      success: true,
      deleted: true,
      text: 'Deleted sticky note "nubby nubs".',
    });

    const listed = (await interact("get-notes")) as {
      notes: Array<{ title: string; body: string }>;
    };
    expect(listed.notes.map((note) => note.title)).toEqual(["wake up"]);
  });

  it("creates calendar events and selects their date for later reads", async () => {
    const created = (await interact("create-calendar-event", {
      title: "codex live event",
      date: "2026-06-08",
      time: "17:00",
      notes: "created from chat routing",
      color: "pink",
    })) as {
      success: boolean;
      text: string;
      event: {
        title: string;
        date: string;
        time: string;
        notes: string;
        color: string;
      };
    };

    expect(created).toMatchObject({
      success: true,
      text: 'Created calendar event "codex live event" for 2026-06-08 at 17:00.',
      event: {
        title: "codex live event",
        date: "2026-06-08",
        time: "17:00",
        notes: "created from chat routing",
        color: "pink",
      },
    });

    expect(window.localStorage.getItem(CALENDAR_CURSOR_KEY)).toBe("2026-06-08");
    const stored = JSON.parse(
      window.localStorage.getItem(CALENDAR_EVENTS_KEY) ?? "[]",
    );
    expect(stored).toHaveLength(1);

    const listed = (await interact("get-calendar-state")) as {
      success: boolean;
      text: string;
      selectedDate: string;
      events: Array<{ title: string; date: string; time: string }>;
    };
    expect(listed.success).toBe(true);
    expect(listed.selectedDate).toBe("2026-06-08");
    expect(listed.text).toContain(
      "2026-06-08 17:00 - codex live event: created from chat routing",
    );
    expect(listed.events[0]).toMatchObject({
      title: "codex live event",
      date: "2026-06-08",
      time: "17:00",
    });
  });

  it("reads calendar state for an explicit date instead of only the selected cursor", async () => {
    await interact("create-calendar-event", {
      title: "first event",
      date: "2026-06-08",
      time: "10:00",
    });
    await interact("create-calendar-event", {
      title: "second event",
      date: "2026-06-09",
      time: "11:00",
    });

    expect(window.localStorage.getItem(CALENDAR_CURSOR_KEY)).toBe("2026-06-09");

    const listed = (await interact("get-calendar-state", {
      date: "2026-06-08",
    })) as {
      success: boolean;
      text: string;
      selectedDate: string;
      events: Array<{ title: string; date: string }>;
    };

    expect(listed.success).toBe(true);
    expect(listed.selectedDate).toBe("2026-06-08");
    expect(listed.text).toContain("2026-06-08 10:00 - first event");
    expect(listed.text).not.toContain("second event");
    expect(listed.events).toHaveLength(2);
  });

  it("rejects invalid calendar dates before mutating stored state", async () => {
    const selected = (await interact("select-calendar-date", {
      date: "2026-13-40",
    })) as { success: boolean; selected: boolean; text: string };
    expect(selected).toMatchObject({
      success: false,
      selected: false,
      text: "Date must be YYYY-MM-DD.",
    });
    expect(window.localStorage.getItem(CALENDAR_CURSOR_KEY)).toBeNull();

    const created = (await interact("create-calendar-event", {
      title: "bad date",
      date: "tomorrow",
    })) as { success: boolean; created: boolean; text: string };
    expect(created).toMatchObject({
      success: false,
      created: false,
      text: "Date must be YYYY-MM-DD.",
    });
    expect(window.localStorage.getItem(CALENDAR_EVENTS_KEY)).toBeNull();
  });
});
