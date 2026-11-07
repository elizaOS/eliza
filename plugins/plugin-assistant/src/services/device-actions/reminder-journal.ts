/**
 * Device-local write-ahead journals for reminder creations and selected-reminder
 * actions, shared by every phone host that schedules reminders on its own store.
 *
 * A host records a request before it asks the native reminder engine to act, and
 * clears it only after a readback or a durable receipt proves the outcome. Nothing
 * here schedules, completes or cancels a reminder: reconciliation only reads the
 * host's reminder rows and receipts, so an unknown outcome stays journaled instead
 * of being retried.
 *
 * Hosts supply storage (`ReminderJournalStore`), which must apply an edit as one
 * compare-and-set and fail when the stored value changed underneath it.
 */
import {
  type ReminderOperation,
  type ReminderRepeat,
  type ReminderTarget,
  reminderFields,
  reminderTiming,
  validateReminderOperation,
  validateReminderResult,
} from "./reminder-contract.ts";

/** One durable JSON slot. `edit` applies `update` atomically or throws. */
export interface ReminderJournalStore<T> {
  read(): Promise<T | null>;
  edit(update: (raw: T | null) => T | null): Promise<void>;
}

/** The reminder row fields a journal reads back. Hosts may carry more. */
export interface ReminderJournalRow {
  id: string;
  title: string;
  body: string;
  at: number;
  status: string;
  dueAt?: number;
  alertMinutes?: number | null;
  mode?: string;
  recurrence?: ReminderRepeat | null;
  occurrenceId?: string;
  createdAt?: number;
  undated?: boolean;
}

export const REMINDER_JOURNAL_LIMIT_BYTES = 128 * 1024;
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function change<R>(
  store: ReminderJournalStore<Record<string, R>>,
  validate: (raw: Record<string, R> | null) => Record<string, R>,
  id: string,
  expected: R | null,
  value: R | null,
  changed: string,
  trim?: (next: Record<string, R>) => void,
): Promise<void> {
  if (value === null && !validate(await store.read())[id]) return;
  await store.edit((raw) => {
    const all = validate(raw);
    if (value === null && !all[id]) return raw;
    if (!same(all[id], expected)) throw Error(changed);
    const next = { ...all };
    if (value) next[id] = value;
    else delete next[id];
    trim?.(next);
    return validate(next);
  });
  if (!same(validate(await store.read())[id], value))
    throw Error(`${changed.replace(/ changed$/, "")} save unconfirmed`);
}

// ---- Creations ----

export interface ReminderCreationRequest {
  id: string;
  title: string;
  body: string;
  at: number;
  recurrence?: ReminderRepeat | null;
  dueAt?: number;
  alertMinutes?: number | null;
}
export interface ReminderCreation {
  id: string;
  request: ReminderCreationRequest;
  state: "pending" | "found";
}
export type ReminderCreationStore = Record<string, ReminderCreation>;
export const REMINDER_CREATION_LIMIT = 32;

const REQUEST_KEYS = [
  "id",
  "title",
  "body",
  "at",
  "recurrence",
  "dueAt",
  "alertMinutes",
];

/** Validates a saved creation journal; null is an empty journal. */
export function validateReminderCreations(
  value: ReminderCreationStore | null,
): ReminderCreationStore {
  if (value === null) return {};
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > REMINDER_CREATION_LIMIT ||
    bytes(value) > REMINDER_JOURNAL_LIMIT_BYTES
  )
    throw Error("Reminder creation history is full or unavailable");
  for (const [id, row] of Object.entries(value)) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
      !row ||
      typeof row !== "object" ||
      row.id !== id ||
      row.request?.id !== id ||
      !["pending", "found"].includes(row.state) ||
      Object.keys(row).some((k) => !["id", "request", "state"].includes(k)) ||
      Object.keys(row.request).some((k) => !REQUEST_KEYS.includes(k))
    )
      throw Error("Invalid reminder creation history");
    reminderFields({
      title: row.request.title,
      body: row.request.body,
      schedule: {
        at: row.request.at,
        recurrence: row.request.recurrence || null,
        ...(row.request.dueAt !== undefined ||
        row.request.alertMinutes !== undefined
          ? { dueAt: row.request.dueAt, alertMinutes: row.request.alertMinutes }
          : {}),
      },
    });
  }
  return value;
}

const SAVED_STATUSES = [
  "pending",
  "scheduled",
  "posted",
  "completed",
  "cancelled",
  "permission-denied",
  "scheduling-failed",
];
const REPEAT_KEYS = ["rule", "zone", "date", "time", "leadMinutes"] as const;

/** True when a saved reminder row is exactly the journaled creation. */
export function reminderCreationMatches(
  creation: ReminderCreation,
  saved: ReminderJournalRow,
): boolean {
  const request = creation.request;
  const alertOk =
    request.alertMinutes === undefined ||
    (request.alertMinutes === null
      ? saved.mode === "none" &&
        ["pending", "completed", "cancelled"].includes(saved.status)
      : saved.mode === "inexact" && saved.status !== "pending");
  const repeatOk =
    saved.recurrence && request.recurrence
      ? REPEAT_KEYS.every(
          (k) => saved.recurrence?.[k] === request.recurrence?.[k],
        )
      : !saved.recurrence && !request.recurrence;
  return (
    saved.id === creation.id &&
    saved.title === request.title &&
    saved.body === request.body &&
    saved.at === request.at &&
    alertOk &&
    same(reminderTiming(saved), reminderTiming(request)) &&
    repeatOk &&
    !!saved.occurrenceId &&
    SAVED_STATUSES.includes(saved.status)
  );
}

/** Definite native refusals: nothing was scheduled for the request. */
export const REMINDER_REFUSALS = [
  "past",
  "permission-denied",
  "storage-full",
  "failed",
] as const;
export type ReminderRefusal = (typeof REMINDER_REFUSALS)[number];
export const isReminderRefusal = (status: unknown): status is ReminderRefusal =>
  REMINDER_REFUSALS.includes(status as ReminderRefusal);

export interface ReminderCreationJournalPorts {
  store: ReminderJournalStore<ReminderCreationStore>;
  /** Reads the host's saved reminder rows. Never schedules. */
  list(): Promise<ReminderJournalRow[]>;
}

export function createReminderCreationJournal(
  ports: ReminderCreationJournalPorts,
) {
  const all = async () => validateReminderCreations(await ports.store.read());
  const edit = (
    id: string,
    expected: ReminderCreation | null,
    value: ReminderCreation | null,
  ) =>
    change(
      ports.store,
      validateReminderCreations,
      id,
      expected,
      value,
      "Reminder creation changed",
      value
        ? (next) => {
            // Retire confirmed creations first when the journal is full.
            while (
              Object.keys(next).length > REMINDER_CREATION_LIMIT ||
              bytes(next) > REMINDER_JOURNAL_LIMIT_BYTES
            ) {
              const retire = Object.keys(next).find(
                (k) => k !== id && next[k].state === "found",
              );
              if (!retire) break;
              delete next[retire];
            }
          }
        : undefined,
    );
  async function check(id: string, rows?: ReminderJournalRow[]) {
    const row = (await all())[id];
    if (!row) return "unknown" as const;
    if (row.state === "found") return "found" as const;
    const saved = (rows || (await ports.list())).find((r) => r.id === id);
    if (!saved || !reminderCreationMatches(row, saved))
      return "unknown" as const;
    await edit(id, row, { ...row, state: "found" });
    return "found" as const;
  }
  return {
    all,
    /** Journal a creation before the host invokes its scheduler. */
    retain: (row: ReminderCreation) => edit(row.id, null, row),
    /** Only the creating handler, before the scheduler was invoked. */
    discardUndispatched: (row: ReminderCreation) => edit(row.id, row, null),
    check,
    /**
     * Retire a pending creation only after a definite refusal AND a readback
     * that confirms the ID is absent. A saved row is never retired here.
     */
    async retireRefused(
      id: string,
      status: unknown,
      rows?: ReminderJournalRow[],
    ): Promise<boolean> {
      if (!isReminderRefusal(status)) return false;
      const row = (await all())[id];
      if (!row || row.state !== "pending") return false;
      if ((rows || (await ports.list())).some((r) => r.id === id)) return false;
      await edit(id, row, null);
      return true;
    },
    /** Marks readback-confirmed creations found; returns how many stay pending. */
    async reconcile(): Promise<number> {
      const pending = Object.values(await all()).filter(
        (r) => r.state === "pending",
      );
      if (pending.length) {
        const rows = await ports.list();
        for (const row of pending)
          try {
            await check(row.id, rows);
          } catch {
            // Retain unknown; never schedule here.
          }
      }
      return Object.values(await all()).filter((r) => r.state === "pending")
        .length;
    },
  };
}
export type ReminderCreationJournal = ReturnType<
  typeof createReminderCreationJournal
>;

// ---- Selected-reminder actions (cancel, complete, snooze, update) ----

export interface PendingReminderAction {
  operationId: string;
  bindingHash: string;
  operation:
    | Extract<ReminderOperation, { type: "reminder_update" }>
    | {
        type: "reminder_cancel" | "reminder_complete" | "reminder_snooze";
        target: ReminderTarget;
      };
}
export type PendingReminderActions = Record<string, PendingReminderAction>;
export const REMINDER_ACTION_LIMIT = 100;
const ACTION_TYPES = [
  "reminder_cancel",
  "reminder_complete",
  "reminder_snooze",
  "reminder_update",
];

export function validatePendingReminderActions(
  raw: PendingReminderActions | null,
): PendingReminderActions {
  if (raw === null) return {};
  if (bytes(raw) > REMINDER_JOURNAL_LIMIT_BYTES)
    throw Error("Pending reminder action store is full");
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length > REMINDER_ACTION_LIMIT
  )
    throw Error("Invalid pending reminder action store");
  for (const [id, input] of Object.entries(raw)) {
    const op = validateReminderOperation(input?.operation);
    if (
      !ACTION_TYPES.includes(op.type) ||
      input.operationId !== id ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId) ||
      !/^[a-f0-9]{64}$/.test(input.bindingHash)
    )
      throw Error("Invalid pending reminder action");
  }
  return raw;
}

/**
 * Checks that a native result is the reviewed outcome of the journaled action.
 * Throws for a mismatched outcome, which keeps the action journaled.
 */
export function assertReminderActionOutcome(
  input: PendingReminderAction,
  result: unknown,
): void {
  const checked = validateReminderResult(input.operation, result);
  const op = input.operation;
  if (op.type === "reminder_update") {
    const schedule = op.fields.schedule;
    if (
      schedule &&
      (![
        "pending",
        "scheduled",
        "permission-denied",
        "scheduling-failed",
      ].includes(checked.status) ||
        checked.at !== schedule.at ||
        checked.occurrenceId === op.target.occurrenceId ||
        (schedule.alertMinutes !== undefined &&
          (checked.dueAt !== schedule.dueAt ||
            checked.alertMinutes !== schedule.alertMinutes)))
    )
      throw Error("Invalid reschedule outcome");
    if (
      !schedule &&
      (checked.status === "cancelled" ||
        checked.occurrenceId !== op.target.occurrenceId)
    )
      throw Error("Invalid metadata edit outcome");
  }
  if (
    op.type === "reminder_snooze" &&
    !["scheduled", "permission-denied", "scheduling-failed"].includes(
      checked.status,
    )
  )
    throw Error("Invalid snooze outcome");
  if (
    op.type === "reminder_complete" &&
    ![
      "completed",
      "pending",
      "scheduled",
      "permission-denied",
      "scheduling-failed",
    ].includes(checked.status)
  )
    throw Error("Invalid completion outcome");
}

export interface ReminderActionReceipt {
  status: string;
  result?: unknown;
}
export interface ReminderActionJournalPorts {
  store: ReminderJournalStore<PendingReminderActions>;
  /** Reads the host's durable receipt for an action. Never executes it. */
  receipt(input: PendingReminderAction): Promise<ReminderActionReceipt>;
}

export function createReminderActionJournal(ports: ReminderActionJournalPorts) {
  const all = async () =>
    validatePendingReminderActions(await ports.store.read());
  const edit = (
    id: string,
    expected: PendingReminderAction | null,
    value: PendingReminderAction | null,
  ) =>
    change(
      ports.store,
      validatePendingReminderActions,
      id,
      expected,
      value,
      "Pending reminder action changed",
    );
  async function acknowledge(input: PendingReminderAction, result: unknown) {
    assertReminderActionOutcome(input, result);
    await edit(input.operationId, input, null);
  }
  return {
    all,
    retain: (input: PendingReminderAction) =>
      edit(input.operationId, null, input),
    /** Only the creating live handler, before it invoked the native action. */
    discardUndispatched: (input: PendingReminderAction) =>
      edit(input.operationId, input, null),
    acknowledge,
    /** Clears actions with a succeeded receipt; returns how many stay pending. */
    async reconcile(): Promise<number> {
      for (const input of Object.values(await all()))
        try {
          const receipt = await ports.receipt(input);
          if (receipt.status === "succeeded" && receipt.result)
            await acknowledge(input, receipt.result);
        } catch {
          // Keep unknown records; reconciliation never executes a mutation.
        }
      return Object.keys(await all()).length;
    },
  };
}
export type ReminderActionJournal = ReturnType<
  typeof createReminderActionJournal
>;

// ---- Pure reminder list decisions ----

export const reminderDueAt = (r: { dueAt?: number; at: number }) =>
  r.dueAt ?? r.at;
/** Undated to-dos have no instant, alarm or calendar day. */
export const isUndatedReminder = (r: object): boolean =>
  (r as { undated?: unknown }).undated === true;

/** Due and not done: posted, or still scheduled after its due instant. Oldest first. */
export function overdueReminders<R extends ReminderJournalRow>(
  rows: R[],
  now = Date.now(),
): R[] {
  return rows
    .filter(
      (r) =>
        !isUndatedReminder(r) &&
        Number.isFinite(reminderDueAt(r)) &&
        reminderDueAt(r) < now &&
        (r.status === "posted" || r.status === "scheduled"),
    )
    .sort((a, b) => reminderDueAt(a) - reminderDueAt(b));
}

/** Open and completed undated to-dos, open first, in creation order. */
export function undatedTodos<R extends ReminderJournalRow>(rows: R[]): R[] {
  return rows
    .filter(
      (r) =>
        isUndatedReminder(r) &&
        (r.status === "todo" || r.status === "completed"),
    )
    .sort(
      (a, b) =>
        Number(a.status === "completed") - Number(b.status === "completed") ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
}

/**
 * The requested civil day offset and hour in the phone's current zone, or null
 * when that local time does not exist (a DST gap).
 */
export function reminderWallTime(
  off: number,
  hours: number,
  today = new Date(),
): Date | null {
  if (!Number.isSafeInteger(off) || !Number.isFinite(hours)) return null;
  const minutes = Math.round(hours * 60);
  const target = new Date(
    Date.UTC(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + off,
      0,
      minutes,
    ),
  );
  const date = new Date(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
    target.getUTCHours(),
    target.getUTCMinutes(),
  );
  return date.getFullYear() === target.getUTCFullYear() &&
    date.getMonth() === target.getUTCMonth() &&
    date.getDate() === target.getUTCDate() &&
    date.getHours() === target.getUTCHours() &&
    date.getMinutes() === target.getUTCMinutes()
    ? date
    : null;
}

/**
 * Reviewed reopen schedule for a completed one-off reminder. 'open' keeps it open
 * with no alert (its due instant, or the next minute if that has passed);
 * 'tomorrow' alerts at the original local clock time tomorrow. Null when that
 * local time is missing or its alert would already have passed.
 */
export function reopenReminderSchedule(
  reminder: { dueAt: number; alertMinutes: number | null },
  mode: "open" | "tomorrow",
  now = Date.now(),
): {
  at: number;
  recurrence: null;
  dueAt: number;
  alertMinutes: number | null;
} | null {
  if (mode === "open") {
    const dueAt = Math.max(
      reminder.dueAt,
      Math.ceil((now + 60_000) / 60_000) * 60_000,
    );
    return { at: dueAt, recurrence: null, dueAt, alertMinutes: null };
  }
  const original = new Date(reminder.dueAt);
  const date = reminderWallTime(
    1,
    original.getHours() + original.getMinutes() / 60,
    new Date(now),
  );
  if (!date) return null;
  const lead = reminder.alertMinutes ?? 0;
  const dueAt = date.getTime();
  if (dueAt - lead * 60_000 <= now) return null;
  return {
    at: dueAt - lead * 60_000,
    recurrence: null,
    dueAt,
    alertMinutes: lead,
  };
}

/** Specific, stable reason for a definite refusal. Nothing was saved in every case. */
export function reminderRefusalMessage(
  status: ReminderRefusal,
  host: { appName: string; settingsName: string },
): string {
  switch (status) {
    case "past":
      return "This reminder time has passed. Choose a future time. Nothing was saved.";
    case "permission-denied":
      return `Notifications are off for ${host.appName}. Enable them in ${host.settingsName}, then save again. Nothing was saved.`;
    case "storage-full":
      return "Reminder storage is full. Complete or delete a reminder, then save again. Nothing was saved.";
    default:
      return "This reminder could not be saved. Check its title and time, then save again. Nothing was saved.";
  }
}
