import { beforeEach, describe, expect, it } from "vitest";

import { interact } from "./simple-views.interact.js";
import {
  CALENDAR_CURSOR_KEY,
  CALENDAR_EVENTS_KEY,
  NOTES_KEY,
  readEvents,
  readNotes,
  readSelectedDate,
} from "./storage.js";

function clearSimpleViewsStorage(): void {
  localStorage.removeItem(NOTES_KEY);
  localStorage.removeItem(CALENDAR_EVENTS_KEY);
  localStorage.removeItem(CALENDAR_CURSOR_KEY);
}

describe("simple views interaction capabilities", () => {
  beforeEach(() => {
    clearSimpleViewsStorage();
  });

  it("creates, lists, and deletes sticky notes", async () => {
    const created = await interact("create-note", {
      title: "QA note",
      body: "Check split panes",
      color: "green",
    });

    expect(created.success).toBe(true);
    expect(readNotes()).toMatchObject([
      {
        title: "QA note",
        body: "Check split panes",
        color: "green",
      },
    ]);

    const listed = await interact("get-notes");
    expect(listed.text).toContain("QA note: Check split panes");

    const deleted = await interact("delete-note", { query: "split panes" });
    expect(deleted).toMatchObject({ success: true, deleted: true });
    expect(readNotes()).toEqual([]);
  });

  it("requires a delete target for notes", async () => {
    const result = await interact("delete-note", {});

    expect(result).toMatchObject({
      success: false,
      deleted: false,
      reason: "target is required",
    });
  });

  it("creates calendar events and keeps the selected date in sync", async () => {
    const created = await interact("create-calendar-event", {
      title: "View QA",
      date: "2026-06-25",
      time: "14:30",
      notes: "Open notes and simple calendar side by side",
      color: "rose",
    });

    expect(created.success).toBe(true);
    expect(readSelectedDate()).toBe("2026-06-25");
    expect(readEvents()).toMatchObject([
      {
        title: "View QA",
        date: "2026-06-25",
        time: "14:30",
        notes: "Open notes and simple calendar side by side",
        color: "rose",
      },
    ]);

    const state = await interact("get-calendar-state", {
      date: "2026-06-25",
    });
    expect(state.text).toContain("2026-06-25 14:30 - View QA");

    const eventId = readEvents()[0]?.id;
    expect(eventId).toBeTruthy();

    const deleted = await interact("delete-calendar-event", { id: eventId });
    expect(deleted).toMatchObject({ success: true, deleted: true });
    expect(readEvents()).toEqual([]);
  });

  it("rejects invalid calendar dates", async () => {
    await expect(
      interact("select-calendar-date", { date: "2026-02-31" }),
    ).resolves.toMatchObject({
      success: false,
      selected: false,
      reason: "date must be YYYY-MM-DD",
    });

    await expect(
      interact("get-calendar-state", { date: "not a date" }),
    ).resolves.toMatchObject({
      success: false,
      reason: "date must be YYYY-MM-DD",
    });
  });

  it("throws for unknown capabilities", async () => {
    await expect(interact("launch-confetti")).rejects.toThrow(
      'Simple views do not support capability "launch-confetti".',
    );
  });
});
