/**
 * Browser-safe workflow device contract: the reviewed read scopes a typed phone
 * workflow step may ask an enrolled phone to perform, the exact result shapes
 * the phone may return, and the phone-side check that an incoming step request
 * still matches the run the owner reviewed.
 *
 * These are data scopes, never executable code or implicit grants. The agent
 * (`plugin-assistant` device actions) applies the same shapes on its side and
 * every request still needs its own device approval.
 */
import { calendarEventOverlapsRange } from "./device-reviews.ts";
import { workflowApprovalNoticeIdentity } from "./notice-routes.ts";
import {
  isPhoneWorkflowLocalDay,
  isPhoneWorkflowTimeZone,
  type PhoneWorkflowSpec,
  phoneWorkflowLocalDay,
  phoneWorkflowLocalDayBounds,
  SELECTED_REMINDERS_WINDOW,
  validatePhoneSelectedRemindersScope,
  validatePhoneWorkflowSpec,
} from "./phone-workflow.ts";

export { SELECTED_REMINDERS_WINDOW };

export interface WorkflowDeviceBinding {
  workflowId: string;
  versionId: string;
  runId: string;
  stepId: string;
  specDigest: string;
}
export interface WorkflowDeviceTarget {
  installationId: string;
  enrollmentId: string;
}
export interface WorkflowNotesReadOperation {
  type: "read_selected_notes";
  /** 1..16 explicitly selected IDs. Revision is SHA-256 of JSON.stringify([title,text]). */
  notes: Array<{ id: string; revision: string }>;
}
export interface WorkflowCalendarReadOperation {
  type: "read_calendar_range";
  calendarIds: string[];
  start: string;
  end: string;
  timeZone: string;
  maximumEvents: number;
}
/**
 * Reminders open by the end of the owner's local `day` (overdue included) plus
 * reminders completed during it. `day` is the run's current local day in the
 * reviewed zone; the reviewed step stores only window, zone and bound.
 */
export interface WorkflowReminderReadOperation {
  type: "read_selected_reminders";
  window: typeof SELECTED_REMINDERS_WINDOW;
  day: string;
  timeZone: string;
  maximumItems: number;
}
export type WorkflowReadOperation =
  | WorkflowNotesReadOperation
  | WorkflowCalendarReadOperation
  | WorkflowReminderReadOperation;
export type WorkflowPresentationOperation =
  | { type: "post_notification"; title: string; body: string }
  | { type: "speak_text"; text: string };
export interface WorkflowReminderRow {
  id: string;
  /** SHA-256 of JSON.stringify([id,title,dueAt,status,completedAt ?? null]). */
  revision: string;
  title: string;
  dueAt: string;
  status: "open" | "completed";
  completedAt?: string;
}
export interface WorkflowCalendarRow {
  id: string;
  calendarId: string;
  revision: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}
export interface WorkflowNoteRow {
  id: string;
  revision: string;
  title: string;
  text: string;
}
export type WorkflowReadResult =
  | { kind: "notes"; notes: WorkflowNoteRow[] }
  | { kind: "calendar"; events: WorkflowCalendarRow[] }
  | { kind: "reminders"; reminders: WorkflowReminderRow[] };

/** Every read and its result are bounded to this encoded size; nothing is truncated. */
export const WORKFLOW_READ_RESULT_MAX_BYTES = 65_536;

/** A workflow scope, result or review failed the shared contract. */
export class WorkflowDeviceScopeError extends Error {
  override name = "WorkflowDeviceScopeError";
  constructor(message = "Workflow phone scope could not be verified") {
    super(message);
  }
}
const fail = (message?: string): never => {
  throw new WorkflowDeviceScopeError(message);
};
export function workflowObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in value))
  )
    fail();
}
function text(value: unknown, maximum: number, empty = false): string {
  return typeof value === "string" &&
    value.length <= maximum &&
    !value.includes("\0") &&
    (empty || !!value.trim())
    ? value
    : fail();
}
/** Opaque workflow, run, step, note or device identity. */
export function workflowId(value: unknown): string {
  const id = text(value, 128);
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) ? id : fail();
}
/** Opaque Calendar provider identity (may contain `.`, `:`). */
export function workflowCalendarId(value: unknown): string {
  const id = text(value, 128);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) ? id : fail();
}
function digest(value: unknown): string {
  const result = text(value, 64);
  return /^[a-f0-9]{64}$/.test(result) ? result : fail();
}
function utc(value: unknown): string {
  const result = text(value, 30);
  return Number.isFinite(Date.parse(result)) &&
    new Date(result).toISOString() === result
    ? result
    : fail();
}
function list(value: unknown, maximum: number): unknown[] {
  return Array.isArray(value) && value.length > 0 && value.length <= maximum
    ? value
    : fail();
}
function bound(value: unknown, maximum: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= maximum
    ? value
    : fail();
}
function zone(value: unknown): string {
  return isPhoneWorkflowTimeZone(value) ? value : fail();
}
/** UTF-8 size of a JSON value, as the agent and phone both measure it. */
export function workflowBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
}
/** Lower-case hex SHA-256 of the JSON encoding (Web Crypto; browser and Node). */
export async function workflowSha(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A calendar range that ends no later than the same local wall time `days` days
 * after it starts, measured in the reviewed zone so DST days are neither cut
 * short nor stretched.
 */
export function workflowCalendarRangeFitsLocalDays(
  start: string,
  end: string,
  timeZone: string,
  days = 7,
): boolean {
  const first = Date.parse(start),
    last = Date.parse(end);
  if (
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    last <= first ||
    last - first > (days + 1) * 86_400_000 ||
    !isPhoneWorkflowTimeZone(timeZone)
  )
    return false;
  const startDay = phoneWorkflowLocalDay(first, timeZone);
  const limitDay = new Date(
    Date.parse(`${startDay}T00:00:00Z`) + days * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const { start: limitStart } = phoneWorkflowLocalDayBounds(limitDay, timeZone);
  const { start: dayStart } = phoneWorkflowLocalDayBounds(startDay, timeZone);
  // Same local time-of-day offset into the limit day, resolved in the reviewed zone.
  return last <= limitStart + (first - dayStart);
}

export function parseWorkflowBinding(value: unknown): WorkflowDeviceBinding {
  const p = workflowObject(value);
  exact(p, ["workflowId", "versionId", "runId", "stepId", "specDigest"]);
  return {
    workflowId: workflowId(p.workflowId),
    versionId: workflowId(p.versionId),
    runId: workflowId(p.runId),
    stepId: workflowId(p.stepId),
    specDigest: digest(p.specDigest),
  };
}

export function parseWorkflowReminderRead(
  value: unknown,
): WorkflowReminderReadOperation {
  const p = workflowObject(value);
  if (p.type !== "read_selected_reminders") fail();
  exact(p, ["type", "window", "day", "timeZone", "maximumItems"]);
  if (!isPhoneWorkflowLocalDay(p.day)) fail();
  let scope: ReturnType<typeof validatePhoneSelectedRemindersScope>;
  try {
    scope = validatePhoneSelectedRemindersScope({
      window: p.window,
      timeZone: p.timeZone,
      maximumItems: p.maximumItems,
    });
  } catch {
    return fail();
  }
  return {
    type: "read_selected_reminders",
    window: scope.window,
    day: p.day as string,
    timeZone: scope.timeZone,
    maximumItems: scope.maximumItems,
  };
}

/** Exact read operation shapes; anything else is refused. */
export function parseWorkflowRead(value: unknown): WorkflowReadOperation {
  const p = workflowObject(value);
  if (p.type === "read_selected_notes") {
    exact(p, ["type", "notes"]);
    const notes = list(p.notes, 16).map((raw) => {
      const note = workflowObject(raw);
      exact(note, ["id", "revision"]);
      return { id: workflowId(note.id), revision: digest(note.revision) };
    });
    if (new Set(notes.map((note) => note.id)).size !== notes.length) fail();
    return { type: "read_selected_notes", notes };
  }
  if (p.type === "read_calendar_range") {
    exact(p, [
      "type",
      "calendarIds",
      "start",
      "end",
      "timeZone",
      "maximumEvents",
    ]);
    const calendarIds = list(p.calendarIds, 16).map(workflowCalendarId),
      start = utc(p.start),
      end = utc(p.end),
      timeZone = zone(p.timeZone);
    if (
      new Set(calendarIds).size !== calendarIds.length ||
      !workflowCalendarRangeFitsLocalDays(start, end, timeZone)
    )
      fail();
    return {
      type: "read_calendar_range",
      calendarIds,
      start,
      end,
      timeZone,
      maximumEvents: bound(p.maximumEvents, 200),
    };
  }
  if (p.type === "read_selected_reminders") return parseWorkflowReminderRead(p);
  return fail();
}

/**
 * The local day a reminder read may name at `now`: the current owner day, or
 * the previous one while a request raised just before local midnight is still
 * waiting for review (at most `graceMs`).
 */
export function workflowReminderDayIsCurrent(
  operation: Pick<WorkflowReminderReadOperation, "day" | "timeZone">,
  now = Date.now(),
  graceMs = 15 * 60_000,
): boolean {
  return (
    operation.day === phoneWorkflowLocalDay(now, operation.timeZone) ||
    operation.day === phoneWorkflowLocalDay(now - graceMs, operation.timeZone)
  );
}

/** Revision input of one reminder row; both hosts hash exactly these values. */
export function workflowReminderRevisionInput(
  row: Omit<WorkflowReminderRow, "revision">,
): unknown[] {
  return [row.id, row.title, row.dueAt, row.status, row.completedAt ?? null];
}
/** Revision input of one calendar row. */
export function workflowCalendarRevisionInput(
  row: Omit<WorkflowCalendarRow, "revision">,
): unknown[] {
  return [row.id, row.calendarId, row.title, row.start, row.end, row.allDay];
}

/**
 * Structural check of a reminder read result against its reviewed window,
 * without the revision hash (each host hashes `workflowReminderRevisionInput`
 * with its own SHA-256). Rows outside the owner day, extra fields (a reminder
 * body or notes), duplicates and overflow are refused.
 */
export function checkWorkflowReminderRows(
  operation: WorkflowReminderReadOperation,
  value: unknown,
): WorkflowReminderRow[] {
  if (workflowBytes(value) > WORKFLOW_READ_RESULT_MAX_BYTES) fail();
  const p = workflowObject(value);
  exact(p, ["kind", "reminders"]);
  if (
    p.kind !== "reminders" ||
    !Array.isArray(p.reminders) ||
    p.reminders.length > operation.maximumItems
  )
    fail();
  const { start, end } = phoneWorkflowLocalDayBounds(
    operation.day,
    operation.timeZone,
  );
  const rows = (p.reminders as unknown[]).map((raw) => {
    const r = workflowObject(raw);
    const completed = r.status === "completed";
    if (r.status !== "open" && !completed) fail();
    exact(
      r,
      completed
        ? ["id", "revision", "title", "dueAt", "status", "completedAt"]
        : ["id", "revision", "title", "dueAt", "status"],
    );
    const row: WorkflowReminderRow = {
      id: workflowId(r.id),
      revision: digest(r.revision),
      title: text(r.title, 1000, true),
      dueAt: utc(r.dueAt),
      status: completed ? "completed" : "open",
      ...(completed ? { completedAt: utc(r.completedAt) } : {}),
    };
    if (
      completed
        ? Date.parse(row.completedAt as string) < start ||
          Date.parse(row.completedAt as string) >= end
        : Date.parse(row.dueAt) >= end
    )
      fail();
    return row;
  });
  if (
    new Set(rows.map((row) => JSON.stringify([row.id, row.dueAt, row.status])))
      .size !== rows.length
  )
    fail();
  return rows;
}

/** Validates a phone read result against its reviewed scope before any model sees it. */
export async function validateWorkflowReadResult(
  operation: WorkflowReadOperation,
  value: unknown,
): Promise<WorkflowReadResult> {
  if (workflowBytes(value) > WORKFLOW_READ_RESULT_MAX_BYTES) fail();
  const p = workflowObject(value);
  if (operation.type === "read_selected_reminders") {
    const reminders = checkWorkflowReminderRows(operation, value);
    for (const row of reminders) {
      const { revision, ...rest } = row;
      if ((await workflowSha(workflowReminderRevisionInput(rest))) !== revision)
        fail();
    }
    return { kind: "reminders", reminders };
  }
  if (operation.type === "read_selected_notes") {
    exact(p, ["kind", "notes"]);
    if (
      p.kind !== "notes" ||
      !Array.isArray(p.notes) ||
      p.notes.length !== operation.notes.length
    )
      fail();
    const notes: WorkflowNoteRow[] = [];
    for (let index = 0; index < operation.notes.length; index++) {
      const n = workflowObject((p.notes as unknown[])[index]);
      exact(n, ["id", "revision", "title", "text"]);
      const item = {
        id: workflowId(n.id),
        revision: digest(n.revision),
        title: text(n.title, 256, true),
        text: text(n.text, 32_000, true),
      };
      if (
        item.id !== operation.notes[index].id ||
        item.revision !== operation.notes[index].revision ||
        (await workflowSha([item.title, item.text])) !== item.revision
      )
        fail();
      notes.push(item);
    }
    return { kind: "notes", notes };
  }
  exact(p, ["kind", "events"]);
  if (
    p.kind !== "calendar" ||
    !Array.isArray(p.events) ||
    p.events.length > operation.maximumEvents
  )
    fail();
  const events: WorkflowCalendarRow[] = [];
  for (const raw of p.events as unknown[]) {
    const e = workflowObject(raw);
    exact(e, [
      "id",
      "calendarId",
      "revision",
      "title",
      "start",
      "end",
      "allDay",
    ]);
    if (typeof e.allDay !== "boolean") fail();
    const item: WorkflowCalendarRow = {
      id: workflowCalendarId(e.id),
      calendarId: workflowCalendarId(e.calendarId),
      revision: digest(e.revision),
      title: text(e.title, 1000, true),
      start: utc(e.start),
      end: utc(e.end),
      allDay: e.allDay as boolean,
    };
    const { revision, ...rest } = item;
    if (
      !operation.calendarIds.includes(item.calendarId) ||
      !calendarEventOverlapsRange(operation, item) ||
      (await workflowSha(workflowCalendarRevisionInput(rest))) !== revision
    )
      fail();
    events.push(item);
  }
  if (
    new Set(
      events.map((event) =>
        JSON.stringify([event.calendarId, event.id, event.start]),
      ),
    ).size !== events.length
  )
    fail();
  return { kind: "calendar", events };
}

/** The phone-side copy of a run's reviewed specification (`GET …/phone-review`). */
export interface WorkflowPhoneReview {
  runId: string;
  workflowId: string;
  versionId: string;
  specDigest: string;
  spec: PhoneWorkflowSpec & { device: WorkflowDeviceTarget };
  status: string;
  finished: boolean;
  cancellationRequestedAt: string | null;
}
export interface WorkflowPhoneReviewOptions {
  /** Host spec normalizer (defaults to the shared validator). */
  normalizePhoneSpec?: (value: unknown) => PhoneWorkflowSpec;
}
/**
 * Accepts a run's phone review only for the expected run, workflow and version,
 * with a spec whose digest matches exactly. A forged or swapped review fails.
 */
export async function parseWorkflowPhoneReview(
  value: unknown,
  expected: { id: string; workflowId: string; versionId: string },
  options: WorkflowPhoneReviewOptions = {},
): Promise<WorkflowPhoneReview> {
  const p = workflowObject(value);
  if (
    p.runId !== expected.id ||
    p.workflowId !== expected.workflowId ||
    p.versionId !== expected.versionId ||
    typeof p.finished !== "boolean" ||
    !(
      p.cancellationRequestedAt === null ||
      typeof p.cancellationRequestedAt === "string"
    )
  )
    fail();
  const spec = workflowObject(p.spec);
  if (workflowBytes(spec) > WORKFLOW_READ_RESULT_MAX_BYTES) fail();
  let canonical: PhoneWorkflowSpec;
  try {
    canonical = (options.normalizePhoneSpec ?? validatePhoneWorkflowSpec)(spec);
  } catch {
    return fail();
  }
  if (!canonical.device) fail();
  const specDigest = digest(p.specDigest);
  if ((await workflowSha(spec)) !== specDigest) fail();
  return {
    runId: workflowId(p.runId),
    workflowId: workflowId(p.workflowId),
    versionId: workflowId(p.versionId),
    specDigest,
    spec: {
      ...canonical,
      device: canonical.device as WorkflowDeviceTarget,
    },
    status: text(p.status, 100),
    finished: p.finished as boolean,
    cancellationRequestedAt: p.cancellationRequestedAt as string | null,
  };
}

/**
 * Throws unless `operation` is exactly what the reviewed step allows for this
 * still-running run, version, digest and enrolled phone.
 */
export function assertWorkflowOperation(
  review: WorkflowPhoneReview,
  binding: WorkflowDeviceBinding,
  target: WorkflowDeviceTarget,
  operation: { type: string; [key: string]: unknown },
  now = Date.now(),
): void {
  if (
    review.finished ||
    review.cancellationRequestedAt ||
    review.runId !== binding.runId ||
    review.workflowId !== binding.workflowId ||
    review.versionId !== binding.versionId ||
    review.specDigest !== binding.specDigest ||
    review.spec.device.installationId !== target.installationId ||
    review.spec.device.enrollmentId !== target.enrollmentId
  )
    fail();
  const step = review.spec.steps.find((s) => s.id === binding.stepId);
  if (!step) {
    fail();
    return;
  }
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  switch (operation.type) {
    case "read_selected_notes":
      if (
        step.operation !== "selected_notes" ||
        !same(
          parseWorkflowRead({ type: operation.type, notes: step.notes }),
          parseWorkflowRead(operation),
        )
      )
        fail();
      return;
    case "read_calendar_range":
      if (
        step.operation !== "calendar_range" ||
        !same(
          parseWorkflowRead({ type: operation.type, ...step.range }),
          parseWorkflowRead(operation),
        )
      )
        fail();
      return;
    case "read_selected_reminders": {
      if (step.operation !== "selected_reminders") {
        fail();
        return;
      }
      const parsed = parseWorkflowReminderRead(operation);
      if (
        !same(
          {
            window: parsed.window,
            timeZone: parsed.timeZone,
            maximumItems: parsed.maximumItems,
          },
          step.scope,
        ) ||
        !workflowReminderDayIsCurrent(parsed, now)
      )
        fail();
      return;
    }
    case "create_note":
      if (
        step.operation !== "save_note" ||
        step.title !== operation.title ||
        typeof operation.body !== "string"
      )
        fail();
      return;
    case "post_notification":
      if (
        step.operation !== "app_notification" ||
        step.title !== operation.title ||
        typeof operation.body !== "string" ||
        !operation.body.trim() ||
        operation.body.length > 2000 ||
        operation.body.includes("\0") ||
        Object.keys(operation).some(
          (key) => !["type", "title", "body"].includes(key),
        )
      )
        fail();
      return;
    case "speak_text":
      if (
        step.operation !== "read_aloud" ||
        typeof operation.text !== "string" ||
        !operation.text.trim() ||
        operation.text.length > 5000 ||
        operation.text.includes("\0") ||
        Object.keys(operation).some((key) => !["type", "text"].includes(key))
      )
        fail();
      return;
    default:
      fail();
  }
}

/**
 * Opaque identity of one pending phone-step approval notice. The ID and binding
 * reveal nothing about the step; the route stays in the host's private storage.
 */
export const workflowApprovalNotice = workflowApprovalNoticeIdentity;
