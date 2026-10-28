/**
 * Typed phone workflow specification shared by the agent's reviewed compiler
 * (`plugin-workflow`) and phone authoring clients. Pure and browser-safe: no
 * Node crypto, compiler, storage or service imports, so a phone renderer and the
 * agent normalize the exact same bytes.
 *
 * A specification is reviewed data, never execution authority. Every phone read
 * or effect still needs its own device approval when a run reaches it, and a
 * scheduled trigger only admits an occurrence while the agent host is running:
 * an occurrence that passes while the host is off is recorded once as missed and
 * is never run later.
 */

export const PHONE_WORKFLOW_SPEC_VERSION = 1 as const;
export const PHONE_WORKFLOW_MAX_STEPS = 32;
export const PHONE_WORKFLOW_MAX_SPEC_BYTES = 65_536;
/** Operations that read or change phone data through the reviewed device bridge. */
export const PHONE_WORKFLOW_DEVICE_OPERATIONS: readonly string[] =
  Object.freeze([
    "selected_notes",
    "calendar_range",
    "save_note",
    "app_notification",
    "read_aloud",
  ]);
/** Device operations that need the foreground presentation protocol (workflow device protocol 2). */
export const PHONE_WORKFLOW_PRESENTATION_OPERATIONS: readonly string[] =
  Object.freeze(["app_notification", "read_aloud"]);
/**
 * A scheduled occurrence admitted later than this after its local time is
 * recorded as missed. It is never run late and never replayed as a backlog.
 */
export const PHONE_SCHEDULE_ADMISSION_WINDOW_MS = 120_000;

export interface PhoneDeviceTarget {
  installationId: string;
  enrollmentId: string;
}
export interface PhoneCalendarRange {
  calendarIds: string[];
  start: string;
  end: string;
  timeZone: string;
  maximumEvents: number;
}
export type PhoneStep =
  | {
      id: string;
      kind: "Notify";
      operation: "app_notification";
      source: string;
      title: string;
    }
  | { id: string; kind: "Speak"; operation: "read_aloud"; source: string }
  | {
      id: string;
      kind: "Read";
      operation: "selected_notes";
      notes: Array<{ id: string; revision: string }>;
    }
  | {
      id: string;
      kind: "Read";
      operation: "calendar_range";
      range: PhoneCalendarRange;
    }
  | {
      id: string;
      kind: "Write";
      operation: "save_note";
      source: string;
      title: string;
    }
  | { id: string; kind: "Read"; operation: "supplied_text"; text: string }
  | {
      id: string;
      kind: "If";
      operation: "contains";
      source: string;
      text: string;
      caseSensitive: boolean;
    }
  | {
      id: string;
      kind: "Write";
      operation: "compose_draft";
      source: string;
      prefix: string;
      suffix: string;
    }
  | {
      id: string;
      kind: "Write";
      operation: "model_draft";
      source: string;
      instruction: string;
    };
/** Runs only when the owner explicitly starts it. */
export interface PhoneManualTrigger {
  kind: "manual";
}
/**
 * Runs at one local wall-clock time on the selected weekdays (0 = Sunday,
 * strictly ascending), in an explicit IANA time zone, while the agent host runs.
 */
export interface PhoneTimeTrigger {
  kind: "time";
  localTime: string;
  timeZone: string;
  days: number[];
}
export type PhoneWorkflowTrigger = PhoneManualTrigger | PhoneTimeTrigger;
export interface PhoneWorkflowSpec {
  version: 1;
  name: string;
  description: string;
  trigger: PhoneWorkflowTrigger;
  steps: PhoneStep[];
  device?: PhoneDeviceTarget;
}

/** A specification, catalog or receipt failed the shared contract. Messages are owner-presentable. */
export class PhoneWorkflowSpecError extends Error {
  override name = "PhoneWorkflowSpecError";
}

const fail = (message: string): never => {
  throw new PhoneWorkflowSpecError(message);
};
const encoder = new TextEncoder();
/** UTF-8 size of a JSON value, as the agent and phone both measure it. */
export function phoneWorkflowBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").byteLength;
}
function record(value: unknown, message = "Expected a typed workflow object") {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail(message);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("Unsupported workflow field");
}
function text(value: unknown, maximum: number, empty = false): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    value.length > maximum ||
    (!empty && !value.trim())
  )
    return fail("Complete the workflow text fields within their stated limits");
  return value;
}
/** Stable device, note and calendar identity accepted by the workflow device bridge. */
export function phoneWorkflowIdentifier(value: unknown): string {
  const id = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
    return fail("Invalid device or source identity");
  return id;
}
function canonicalUtc(value: unknown): string {
  const result = text(value, 30);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    return fail("Use canonical UTC times with milliseconds");
  return result;
}
/** True when the runtime's Intl data knows this IANA time zone. */
export function isPhoneWorkflowTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Exact trigger shapes; anything else (cron text, events, places, messages) is unavailable. */
export function validatePhoneWorkflowTrigger(
  value: unknown,
): PhoneWorkflowTrigger {
  const trigger = record(value, "Choose when this workflow runs");
  if (trigger.kind === "manual") {
    keys(trigger, ["kind"]);
    return { kind: "manual" };
  }
  if (trigger.kind !== "time")
    return fail("This workflow trigger is unavailable");
  keys(trigger, ["kind", "localTime", "timeZone", "days"]);
  const invalid = "Choose a local time, a valid time zone and at least one day";
  if (
    typeof trigger.localTime !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trigger.localTime) ||
    !isPhoneWorkflowTimeZone(trigger.timeZone) ||
    !Array.isArray(trigger.days) ||
    trigger.days.length < 1 ||
    trigger.days.length > 7
  )
    return fail(invalid);
  const days = trigger.days as unknown[];
  for (let index = 0; index < days.length; index++) {
    const day = days[index];
    if (
      typeof day !== "number" ||
      !Number.isInteger(day) ||
      day < 0 ||
      day > 6 ||
      (index > 0 && day <= (days[index - 1] as number))
    )
      return fail(invalid);
  }
  return {
    kind: "time",
    localTime: trigger.localTime,
    timeZone: trigger.timeZone,
    days: [...(days as number[])],
  };
}

/**
 * The single normalizer for typed phone workflows. The agent validates every
 * save, validation and generation through it, and phone clients use it before
 * review, so both sides bind the same canonical bytes and digest.
 */
export function validatePhoneWorkflowSpec(input: unknown): PhoneWorkflowSpec {
  if (phoneWorkflowBytes(input) > PHONE_WORKFLOW_MAX_SPEC_BYTES)
    fail("Workflow draft exceeds 64 KiB");
  const p = record(input);
  keys(p, ["version", "name", "description", "trigger", "steps", "device"]);
  if (p.version !== PHONE_WORKFLOW_SPEC_VERSION)
    fail("Unsupported workflow version");
  const trigger = validatePhoneWorkflowTrigger(p.trigger);
  const rawSteps = p.steps;
  if (
    !Array.isArray(rawSteps) ||
    rawSteps.length < 1 ||
    rawSteps.length > PHONE_WORKFLOW_MAX_STEPS
  )
    return fail("Add between 1 and 32 steps");
  const seen = new Set<string>();
  const steps: PhoneStep[] = rawSteps.map((value: unknown) => {
    const s = record(value),
      id = text(s.id, 80);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || seen.has(id))
      fail("Step identity is invalid");
    let step: PhoneStep;
    if (s.kind === "Read" && s.operation === "supplied_text") {
      keys(s, ["id", "kind", "operation", "text"]);
      step = {
        id,
        kind: "Read",
        operation: "supplied_text",
        text: text(s.text, 16000, true),
      };
    } else if (s.kind === "Read" && s.operation === "selected_notes") {
      keys(s, ["id", "kind", "operation", "notes"]);
      if (!Array.isArray(s.notes) || !s.notes.length || s.notes.length > 16)
        return fail("Select 1 to 16 Notes");
      const notes = s.notes.map((raw) => {
        const note = record(raw);
        keys(note, ["id", "revision"]);
        const noteId = phoneWorkflowIdentifier(note.id),
          revision = text(note.revision, 64);
        if (!/^[a-f0-9]{64}$/.test(revision))
          return fail("A selected note changed. Select it again");
        return { id: noteId, revision };
      });
      if (new Set(notes.map((note) => note.id)).size !== notes.length)
        return fail("Select each note once");
      step = { id, kind: "Read", operation: "selected_notes", notes };
    } else if (s.kind === "Read" && s.operation === "calendar_range") {
      keys(s, ["id", "kind", "operation", "range"]);
      const r = record(s.range);
      keys(r, ["calendarIds", "start", "end", "timeZone", "maximumEvents"]);
      if (
        !Array.isArray(r.calendarIds) ||
        !r.calendarIds.length ||
        r.calendarIds.length > 16
      )
        return fail("Select 1 to 16 calendars");
      const calendarIds = r.calendarIds.map(phoneWorkflowIdentifier),
        start = canonicalUtc(r.start),
        end = canonicalUtc(r.end),
        timeZone = text(r.timeZone, 100);
      if (
        new Set(calendarIds).size !== calendarIds.length ||
        Date.parse(end) <= Date.parse(start) ||
        Date.parse(end) - Date.parse(start) > 7 * 86_400_000
      )
        return fail("Choose distinct calendars and a range of at most 7 days");
      if (!isPhoneWorkflowTimeZone(timeZone))
        return fail("Choose a valid calendar time zone");
      if (
        typeof r.maximumEvents !== "number" ||
        !Number.isInteger(r.maximumEvents) ||
        r.maximumEvents < 1 ||
        r.maximumEvents > 200
      )
        return fail("Choose between 1 and 200 events");
      step = {
        id,
        kind: "Read",
        operation: "calendar_range",
        range: {
          calendarIds,
          start,
          end,
          timeZone,
          maximumEvents: r.maximumEvents,
        },
      };
    } else {
      const source = text(s.source, 80);
      if (!seen.has(source)) fail("Choose an earlier step as the input");
      if (s.kind === "If" && s.operation === "contains") {
        keys(s, ["id", "kind", "operation", "source", "text", "caseSensitive"]);
        if (typeof s.caseSensitive !== "boolean")
          fail("Choose whether letter case must match");
        step = {
          id,
          kind: "If",
          operation: "contains",
          source,
          text: text(s.text, 1000),
          caseSensitive: s.caseSensitive as boolean,
        };
      } else if (s.kind === "Write" && s.operation === "compose_draft") {
        keys(s, ["id", "kind", "operation", "source", "prefix", "suffix"]);
        step = {
          id,
          kind: "Write",
          operation: "compose_draft",
          source,
          prefix: text(s.prefix, 4000, true),
          suffix: text(s.suffix, 4000, true),
        };
      } else if (s.kind === "Write" && s.operation === "model_draft") {
        keys(s, ["id", "kind", "operation", "source", "instruction"]);
        step = {
          id,
          kind: "Write",
          operation: "model_draft",
          source,
          instruction: text(s.instruction, 4000),
        };
      } else if (s.kind === "Write" && s.operation === "save_note") {
        keys(s, ["id", "kind", "operation", "source", "title"]);
        step = {
          id,
          kind: "Write",
          operation: "save_note",
          source,
          title: text(s.title, 256),
        };
      } else if (s.kind === "Notify" && s.operation === "app_notification") {
        keys(s, ["id", "kind", "operation", "source", "title"]);
        step = {
          id,
          kind: "Notify",
          operation: "app_notification",
          source,
          title: text(s.title, 200),
        };
      } else if (s.kind === "Speak" && s.operation === "read_aloud") {
        keys(s, ["id", "kind", "operation", "source"]);
        step = { id, kind: "Speak", operation: "read_aloud", source };
      } else return fail("This workflow operation is unavailable");
    }
    seen.add(id);
    return step;
  });
  let device: PhoneDeviceTarget | undefined;
  if (p.device !== undefined) {
    const d = record(p.device);
    keys(d, ["installationId", "enrollmentId"]);
    device = {
      installationId: phoneWorkflowIdentifier(d.installationId),
      enrollmentId: phoneWorkflowIdentifier(d.enrollmentId),
    };
  }
  if (
    steps.some((step) =>
      PHONE_WORKFLOW_DEVICE_OPERATIONS.includes(step.operation),
    ) &&
    !device
  )
    fail("A verified phone enrollment is required");
  const spec: PhoneWorkflowSpec = {
    ...(device ? { device } : {}),
    version: PHONE_WORKFLOW_SPEC_VERSION,
    name: text(p.name, 200),
    description: text(p.description ?? "", 4000, true),
    trigger,
    steps,
  };
  if (phoneWorkflowBytes(spec) > PHONE_WORKFLOW_MAX_SPEC_BYTES)
    fail("Workflow draft exceeds 64 KiB");
  return spec;
}

/** True when any step reads or changes phone data through the device bridge. */
export function phoneWorkflowUsesDevice(spec: PhoneWorkflowSpec): boolean {
  return spec.steps.some((step) =>
    PHONE_WORKFLOW_DEVICE_OPERATIONS.includes(step.operation),
  );
}

/** Five-field cron for the durable runtime scheduler, evaluated in `trigger.timeZone`. */
export function phoneTimeTriggerCron(trigger: PhoneTimeTrigger): string {
  const checked = validatePhoneWorkflowTrigger(trigger);
  if (checked.kind !== "time") return fail("This workflow has no schedule");
  const [hour, minute] = checked.localTime.split(":").map(Number);
  return `${minute} ${hour} * * ${checked.days.length === 7 ? "*" : checked.days.join(",")}`;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Plain owner-facing summary such as "Weekdays at 07:30 (Europe/Paris)". */
export function describePhoneWorkflowTrigger(
  trigger: PhoneWorkflowTrigger,
): string {
  if (trigger.kind === "manual") return "Only when you choose Run now";
  const days = trigger.days.join(",");
  const when =
    days === "0,1,2,3,4,5,6"
      ? "Every day"
      : days === "1,2,3,4,5"
        ? "Weekdays"
        : days === "0,6"
          ? "Weekends"
          : trigger.days.map((day) => WEEKDAY_LABELS[day]).join(", ");
  return `${when} at ${trigger.localTime} (${trigger.timeZone})`;
}

export interface PhoneWorkflowTriggerCapability {
  kind: string;
  available: boolean;
  label?: string;
  reason?: string;
}
export interface PhoneWorkflowOperationCapability {
  id: string;
  label?: string;
  available: boolean;
  reason?: string;
}
export interface PhoneWorkflowCatalog {
  generationProtocol?: 1;
  catalogRevision: string;
  compilerRevision: string;
  maximumSteps: number;
  maximumSpecBytes: number;
  triggers: PhoneWorkflowTriggerCapability[];
  palette: Array<{
    kind: string;
    operations: PhoneWorkflowOperationCapability[];
  }>;
}
function optionalText(value: unknown, maximum: number) {
  return value === undefined || value === null || value === ""
    ? undefined
    : text(value, maximum);
}
/** Client-side reading of the agent's typed catalog. Unknown or oversized shapes disable authoring. */
export function parsePhoneWorkflowCatalog(
  value: unknown,
): PhoneWorkflowCatalog {
  const p = record(value, "Unsupported workflow capabilities");
  if (
    p.specVersion !== PHONE_WORKFLOW_SPEC_VERSION ||
    p.maximumSteps !== PHONE_WORKFLOW_MAX_STEPS ||
    p.maximumSpecBytes !== PHONE_WORKFLOW_MAX_SPEC_BYTES ||
    !Array.isArray(p.palette) ||
    p.palette.length > 16 ||
    !Array.isArray(p.triggers) ||
    p.triggers.length > 16
  )
    fail("Unsupported workflow capabilities");
  return {
    ...(p.generationProtocol === 1 ? { generationProtocol: 1 as const } : {}),
    catalogRevision: text(p.catalogRevision, 100),
    compilerRevision: text(p.compilerRevision, 100),
    maximumSteps: PHONE_WORKFLOW_MAX_STEPS,
    maximumSpecBytes: PHONE_WORKFLOW_MAX_SPEC_BYTES,
    triggers: (p.triggers as unknown[]).map((raw) => {
      const t = record(raw, "Invalid trigger capability");
      if (typeof t.available !== "boolean") fail("Invalid trigger capability");
      const label = optionalText(t.label, 200),
        reason = optionalText(t.reason, 1000);
      return {
        kind: text(t.kind, 50),
        available: t.available as boolean,
        ...(label ? { label } : {}),
        ...(reason ? { reason } : {}),
      };
    }),
    palette: (p.palette as unknown[]).map((raw) => {
      const row = record(raw, "Invalid operation catalog");
      if (!Array.isArray(row.operations) || row.operations.length > 32)
        fail("Invalid operation catalog");
      return {
        kind: text(row.kind, 30),
        operations: (row.operations as unknown[]).map((rawOperation) => {
          const op = record(rawOperation, "Invalid operation capability");
          if (typeof op.available !== "boolean")
            fail("Invalid operation capability");
          const label = optionalText(op.label, 200),
            reason = optionalText(op.reason, 1000);
          return {
            id: text(op.id, 100),
            available: op.available as boolean,
            ...(label ? { label } : {}),
            ...(reason ? { reason } : {}),
          };
        }),
      };
    }),
  };
}
/** The reviewed trigger and every step must still be offered by the selected agent. */
export function assertPhoneWorkflowCapabilities(
  spec: PhoneWorkflowSpec,
  catalog: PhoneWorkflowCatalog,
): void {
  if (
    !catalog.triggers.some(
      (trigger) => trigger.kind === spec.trigger.kind && trigger.available,
    ) ||
    spec.steps.some(
      (step) =>
        !catalog.palette.some(
          (row) =>
            row.kind === step.kind &&
            row.operations.some(
              (operation) =>
                operation.id === step.operation && operation.available,
            ),
        ),
    )
  )
    fail("Agent capabilities changed. Review the available steps again.");
}

export interface PhoneWorkflowSaveReceipt {
  mutationId: string;
  workflowId: string;
  operation: "create" | "edit";
  previousVersionId: string | null;
  versionId: string;
  specDigest: string;
  compilerRevision: string;
  appliedAt: string;
}
/** Accepts only the receipt for this exact save identity, digest, compiler and version. */
export function parsePhoneWorkflowSaveReceipt(
  value: unknown,
  expected: {
    mutationId: string;
    specDigest: string;
    compilerRevision: string;
    workflowId?: string;
    versionId?: string;
  },
): PhoneWorkflowSaveReceipt {
  const p = record(value, "Saved workflow receipt identity mismatch");
  if (
    p.mutationId !== expected.mutationId ||
    p.specDigest !== expected.specDigest ||
    p.compilerRevision !== expected.compilerRevision ||
    p.operation !== (expected.workflowId ? "edit" : "create") ||
    p.previousVersionId !== (expected.versionId ?? null) ||
    (expected.workflowId && p.workflowId !== expected.workflowId)
  )
    fail("Saved workflow receipt identity mismatch");
  return {
    mutationId: expected.mutationId,
    workflowId: phoneWorkflowIdentifier(p.workflowId),
    operation: p.operation as "create" | "edit",
    previousVersionId: (p.previousVersionId as string | null) ?? null,
    versionId: phoneWorkflowIdentifier(p.versionId),
    specDigest: expected.specDigest,
    compilerRevision: expected.compilerRevision,
    appliedAt: text(p.appliedAt, 40),
  };
}

/** Scheduled-occurrence state recorded on each scheduled run (`execution.input.typedSchedule`). */
export interface PhoneScheduledOccurrence {
  scheduledAt: string;
  trigger: PhoneTimeTrigger;
  status: "ready" | "missed" | "overlap";
  text: string;
}
/** Reads a run's scheduled-occurrence record; absent for manual runs. */
export function parsePhoneScheduledOccurrence(
  value: unknown,
): PhoneScheduledOccurrence | undefined {
  if (value === undefined || value === null) return undefined;
  const p = record(value, "Invalid scheduled occurrence");
  keys(p, ["scheduledAt", "trigger", "status", "text"]);
  const trigger = validatePhoneWorkflowTrigger(p.trigger);
  if (
    trigger.kind !== "time" ||
    !["ready", "missed", "overlap"].includes(String(p.status))
  )
    return fail("Invalid scheduled occurrence");
  return {
    scheduledAt: canonicalUtc(p.scheduledAt),
    trigger,
    status: p.status as PhoneScheduledOccurrence["status"],
    text: text(p.text, 1000, true),
  };
}
