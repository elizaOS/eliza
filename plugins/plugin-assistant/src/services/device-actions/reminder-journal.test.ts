import { describe, expect, it } from "vitest";
import type { ReminderTarget } from "./reminder-contract.ts";
import {
  createReminderActionJournal,
  createReminderCreationJournal,
  isReminderRefusal,
  overdueReminders,
  type PendingReminderAction,
  type ReminderCreation,
  type ReminderJournalRow,
  type ReminderJournalStore,
  reminderCreationMatches,
  reminderRefusalMessage,
  reopenReminderSchedule,
  undatedTodos,
  validatePendingReminderActions,
  validateReminderCreations,
} from "./reminder-journal.ts";

function memoryStore<T>(initial: T | null = null) {
  let value: T | null = initial === null ? null : structuredClone(initial);
  let writes = 0;
  const store: ReminderJournalStore<T> = {
    async read() {
      return value === null ? null : structuredClone(value);
    },
    async edit(update) {
      const raw = value === null ? null : structuredClone(value);
      const next = update(raw);
      if (next === raw) return;
      writes++;
      value = next === null ? null : structuredClone(next);
    },
  };
  return { store, writes: () => writes, peek: () => value };
}

const AT = Date.UTC(2026, 9, 29, 9);
const creation = (id = "r1", extra = {}): ReminderCreation => ({
  id,
  request: { id, title: "Call", body: "Dentist", at: AT, ...extra },
  state: "pending",
});
const saved = (
  extra: Partial<ReminderJournalRow> = {},
): ReminderJournalRow => ({
  id: "r1",
  title: "Call",
  body: "Dentist",
  at: AT,
  status: "scheduled",
  occurrenceId: "o1",
  ...extra,
});

describe("reminder creation journal", () => {
  it("marks a creation found only after a matching readback", async () => {
    let rows: ReminderJournalRow[] = [];
    const mem = memoryStore<Record<string, ReminderCreation>>();
    const journal = createReminderCreationJournal({
      store: mem.store,
      list: async () => rows,
    });
    await journal.retain(creation());
    expect(await journal.check("r1")).toBe("unknown");
    rows = [saved({ title: "Other" })];
    expect(await journal.reconcile()).toBe(1);
    rows = [saved()];
    expect(await journal.reconcile()).toBe(0);
    expect((await journal.all()).r1.state).toBe("found");
    expect(await journal.check("missing")).toBe("unknown");
  });

  it("retires a refused creation only when the ID is absent", async () => {
    let rows: ReminderJournalRow[] = [saved({ status: "permission-denied" })];
    const mem = memoryStore<Record<string, ReminderCreation>>();
    const journal = createReminderCreationJournal({
      store: mem.store,
      list: async () => rows,
    });
    await journal.retain(creation());
    expect(await journal.retireRefused("r1", "scheduled")).toBe(false);
    expect(await journal.retireRefused("r1", "permission-denied")).toBe(false);
    rows = [];
    expect(await journal.retireRefused("r1", "storage-full")).toBe(true);
    expect(await journal.all()).toEqual({});
  });

  it("refuses to overwrite a changed creation and to discard a different one", async () => {
    const mem = memoryStore<Record<string, ReminderCreation>>();
    const journal = createReminderCreationJournal({
      store: mem.store,
      list: async () => [],
    });
    await journal.retain(creation());
    await expect(journal.retain(creation())).rejects.toThrow(
      "Reminder creation changed",
    );
    await expect(
      journal.discardUndispatched(creation("r1", { title: "X" })),
    ).rejects.toThrow("Reminder creation changed");
    await journal.discardUndispatched(creation());
    const before = mem.writes();
    await journal.discardUndispatched(creation());
    expect(mem.writes()).toBe(before);
  });

  it("retires found creations first when the journal is full", async () => {
    const full: Record<string, ReminderCreation> = {};
    for (let i = 0; i < 32; i++)
      full[`f${i}`] = { ...creation(`f${i}`), state: "found" };
    const mem = memoryStore(full);
    const journal = createReminderCreationJournal({
      store: mem.store,
      list: async () => [],
    });
    await journal.retain(creation("new"));
    const all = await journal.all();
    expect(Object.keys(all)).toHaveLength(32);
    expect(all.new.state).toBe("pending");
    expect(all.f0).toBeUndefined();
  });

  it("rejects a corrupt journal", () => {
    expect(validateReminderCreations(null)).toEqual({});
    expect(() =>
      validateReminderCreations({ r1: { ...creation(), extra: 1 } as never }),
    ).toThrow("Invalid reminder creation history");
    expect(() => validateReminderCreations({ r2: creation("r1") })).toThrow(
      "Invalid reminder creation history",
    );
  });

  it("matches timing, silent alerts and repeats exactly", () => {
    const silent = creation("r1", { dueAt: AT, alertMinutes: null });
    expect(
      reminderCreationMatches(
        silent,
        saved({
          dueAt: AT,
          alertMinutes: null,
          mode: "none",
          status: "pending",
        }),
      ),
    ).toBe(true);
    expect(
      reminderCreationMatches(
        silent,
        saved({ dueAt: AT, alertMinutes: null, mode: "inexact" }),
      ),
    ).toBe(false);
    const recurrence = {
      rule: "daily" as const,
      zone: "Europe/London",
      date: "2026-10-29",
      time: "09:00",
      leadMinutes: 0,
    };
    const repeat = creation("r1", { recurrence });
    expect(reminderCreationMatches(repeat, saved({ recurrence }))).toBe(true);
    expect(
      reminderCreationMatches(
        repeat,
        saved({ recurrence: { ...recurrence, rule: "weekly" } }),
      ),
    ).toBe(false);
    expect(reminderCreationMatches(repeat, saved())).toBe(false);
    expect(
      reminderCreationMatches(creation(), saved({ occurrenceId: undefined })),
    ).toBe(false);
  });
});

const target: ReminderTarget = {
  sourceId: "s",
  sourceRevision: "1".repeat(64),
  reminderId: "r1",
  occurrenceId: "o1",
  revision: "1".repeat(64),
};
const action = (
  type: "reminder_cancel" | "reminder_complete" | "reminder_snooze",
): PendingReminderAction => ({
  operationId: "op1",
  bindingHash: "a".repeat(64),
  operation: { type, target },
});
const result = (kind: string, status: string, extra = {}) => ({
  version: 1,
  kind,
  sourceId: "s",
  reminderId: "r1",
  occurrenceId: "o1",
  revision: "2".repeat(64),
  status,
  at: AT,
  ...extra,
});

describe("reminder action journal", () => {
  it("clears an action only for its reviewed outcome", async () => {
    const mem = memoryStore<Record<string, PendingReminderAction>>();
    const receipts: Record<string, { status: string; result?: unknown }> = {};
    const journal = createReminderActionJournal({
      store: mem.store,
      receipt: async (input) =>
        receipts[input.operationId] ?? { status: "unknown" },
    });
    const snooze = action("reminder_snooze");
    await journal.retain(snooze);
    await expect(
      journal.acknowledge(snooze, result("reminder_snooze", "completed")),
    ).rejects.toThrow("Invalid snooze outcome");
    expect(await journal.reconcile()).toBe(1);
    receipts.op1 = {
      status: "succeeded",
      result: result("reminder_snooze", "scheduled"),
    };
    expect(await journal.reconcile()).toBe(0);
  });

  it("keeps an action when its receipt read fails", async () => {
    const mem = memoryStore<Record<string, PendingReminderAction>>();
    const journal = createReminderActionJournal({
      store: mem.store,
      receipt: async () => {
        throw Error("offline");
      },
    });
    await journal.retain(action("reminder_cancel"));
    expect(await journal.reconcile()).toBe(1);
    await journal.discardUndispatched(action("reminder_cancel"));
    expect(await journal.all()).toEqual({});
  });

  it("validates the saved store", () => {
    expect(validatePendingReminderActions(null)).toEqual({});
    expect(() =>
      validatePendingReminderActions({
        op1: { ...action("reminder_cancel"), bindingHash: "bad" },
      }),
    ).toThrow("Invalid pending reminder action");
  });
});

describe("reminder list decisions", () => {
  it("lists overdue reminders oldest first", () => {
    const rows = [
      saved({ id: "b", at: 30, status: "posted" }),
      saved({ id: "a", at: 10, dueAt: 20, status: "scheduled" }),
      saved({ id: "c", at: 5, status: "completed" }),
      saved({ id: "d", at: 5, status: "posted", undated: true }),
    ];
    expect(overdueReminders(rows, 100).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("orders undated to-dos open first", () => {
    const rows = [
      saved({ id: "x", undated: true, status: "completed", createdAt: 1 }),
      saved({ id: "y", undated: true, status: "todo", createdAt: 3 }),
      saved({ id: "z", undated: true, status: "todo", createdAt: 2 }),
      saved({ id: "w", status: "todo" }),
    ];
    expect(undatedTodos(rows).map((r) => r.id)).toEqual(["z", "y", "x"]);
  });

  it("reopens a completed one-off reminder", () => {
    const now = new Date(2026, 9, 28, 12, 0, 30).getTime();
    const due = new Date(2026, 9, 28, 9, 15).getTime();
    expect(
      reopenReminderSchedule({ dueAt: due, alertMinutes: 10 }, "open", now),
    ).toEqual({
      at: new Date(2026, 9, 28, 12, 2).getTime(),
      recurrence: null,
      dueAt: new Date(2026, 9, 28, 12, 2).getTime(),
      alertMinutes: null,
    });
    const tomorrow = new Date(2026, 9, 29, 9, 15).getTime();
    expect(
      reopenReminderSchedule({ dueAt: due, alertMinutes: 10 }, "tomorrow", now),
    ).toEqual({
      at: tomorrow - 600_000,
      recurrence: null,
      dueAt: tomorrow,
      alertMinutes: 10,
    });
  });

  it("explains refusals with the host's names", () => {
    expect(isReminderRefusal("past")).toBe(true);
    expect(isReminderRefusal("scheduled")).toBe(false);
    expect(
      reminderRefusalMessage("permission-denied", {
        appName: "Eliza",
        settingsName: "Android settings",
      }),
    ).toBe(
      "Notifications are off for Eliza. Enable them in Android settings, then save again. Nothing was saved.",
    );
  });
});
