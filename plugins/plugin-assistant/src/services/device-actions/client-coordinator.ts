/**
 * Browser-safe phone half of the canonical device-action queue.
 *
 * The server owns proposals, claims and receipts (`service.ts`). This module is
 * the client coordinator every mobile brand shares: it parses and admits
 * pending proposals for the negotiated capabilities, binds each review to the
 * exact screen it was shown on, and runs approve → claim → execute → receipt
 * with a durable journal reserved before any device effect.
 *
 * Invariants:
 * - Only authenticated structured proposals enter; reply prose never does.
 * - A journal reservation precedes dispatch; an existing reservation refuses
 *   a second effect for the same proposal.
 * - An effect whose outcome is not confirmed is recorded as `unknown` and is
 *   never repeated automatically. Receipt upload retries only replay the exact
 *   journaled result; recovery reads durable native evidence, never dispatches.
 * - Cancellation retires the renderer attempt; a result already produced by the
 *   journaled native attempt is still recorded.
 *
 * Product hosts supply ports: the authenticated request transport, the durable
 * journal store, executors and recovery readers, and a small profile with the
 * owner-facing product name, record copy and view admission policy.
 */
import { createDeviceActionExecution } from "@elizaos/contracts/device-action-execution";
import {
  isNativeNotesQuery,
  isOriginalDeviceReadOperationType,
  type NativeNotesQueryOperation,
  type NativeNotesReadReply,
  type NativeNotesReadReplyHint,
  type NativeNotesReadReplyOrigin,
  NOTES_QUERY_CAPABILITY,
  validateNativeNotesQuery,
  validateNativeNotesReadReply,
  validateNativeNotesReadReplyHint,
  validateNativeNotesReadReplyOrigin,
} from "@elizaos/contracts/native-notes-query";
import {
  isSmsSend,
  SMS_SEND_CAPABILITY,
  type SmsSendOperation,
  type SmsSendResult,
  smsBindingText,
  smsReceiptOutcome,
  validateSmsResult,
  validateSmsSend,
} from "@elizaos/contracts/sms-send";
import {
  CALENDAR_AGENDA_CAPABILITY,
  type CalendarOperation,
  type CalendarResult,
  type CalendarSource,
  calendarCapabilityAvailable,
  calendarSource,
  isCalendarOperation,
  validateCalendarOperation,
  validateCalendarResult,
} from "./calendar-contract.ts";
import {
  CAMERA_CAPTURE_CAPABILITY,
  type CameraCaptureOperation,
  type CameraCaptureResult,
  isCameraCapture,
  validateCameraCapture,
  validateCameraCaptureResult,
} from "./camera-contract.ts";
import type {
  ClockHandoffOperation,
  ClockHandoffResult,
} from "./clock-contract.ts";
import {
  assertClockHandoffTimeZone,
  clockHandoffReceipt,
  describeClockHandoff,
  isClockHandoffOperation,
  validateClockHandoffDispatch,
} from "./clock-handoff.ts";
import { formatDeviceRecordDateTime } from "./device-record-presentation.ts";
import {
  type ForegroundReviewOperation,
  type ForegroundReviewResult,
  foregroundReviewOperationAvailable,
  isForegroundReviewOperation,
  validateForegroundReviewOperation,
  validateForegroundReviewResult,
} from "./foreground-review-contract.ts";
import {
  isMapsOperation,
  type MapsOperation,
  type MapsResult,
  type MapsTarget,
  validateMapsOperation,
  validateMapsResult,
} from "./maps-contract.ts";
import {
  isNotesOperation,
  type NotesOperation,
  type NotesResult,
  type NotesTarget,
  validateNotesOperation,
  validateNotesResult,
} from "./notes-contract.ts";
import {
  type NotesQueryResult,
  validateNotesQueryResult,
} from "./notes-query-result.ts";
import {
  describeLibraryOperation,
  isLibraryOperation,
  type LibraryAgentOperation,
  type LibraryAgentResult,
  PHOTO_LIBRARY_CAPABILITY,
  validateLibraryOperation,
  validateLibraryResult,
} from "./photo-library-contract.ts";
import {
  isReminderOperation,
  type ReminderOperation,
  type ReminderResult,
  validateReminderOperation,
  validateReminderResult,
} from "./reminder-contract.ts";
import {
  isReminderCreate,
  type ReminderCreateOperation,
  type ReminderCreateResult,
  validateReminderCreate,
  validateReminderCreateResult,
} from "./reminder-create-contract.ts";
import type {
  WorkflowDeviceBinding,
  WorkflowDeviceTarget,
  WorkflowPresentationOperation,
  WorkflowReadOperation,
  WorkflowReadResult,
} from "./workflow-contract.ts";

export type {
  WorkflowDeviceBinding,
  WorkflowPresentationOperation,
  WorkflowReadOperation,
  WorkflowReadResult,
};

// ── Wire-facing client types ────────────────────────────────────────────────

/** Server-verified session the phone is bound to. Never user-entered. */
export interface DeviceClientSession {
  ownerId: string;
  agentId: string;
  sessionId: string;
  origin: string;
}
/** The exact screen a review was shown on. Opaque provider IDs only. */
export interface DeviceContextEnvelope {
  view: string;
  timeZone?: string;
  selectedObject?: {
    kind: string;
    id: string;
    revision?: string;
    accountId?: string;
    sourceRevision?: string;
    occurrenceId?: string;
    timingVersion?: 2;
  };
  sensitive?: boolean;
  revision: number;
}
/** One owner-facing review card. Display only; execution stays bound to the stored proposal. */
export interface DeviceActionProposalCard {
  id: string;
  readReply?: { origin: NativeNotesReadReplyOrigin; digest: string };
  privateNotesRead?: true;
  reviewDestination?: "home" | "notes" | "calendar";
  reviewNoteTarget?: NotesTarget;
  title: string;
  description: string;
  reviewScope?: string;
  reviewIdentity?: string;
  expiresAt: number;
  contextRevision: number;
}
export type DeviceCommittedChange = "calendar" | "notes" | "reminders";
export interface DeviceOperationReceipt {
  proposalId: string;
  status: "succeeded" | "denied" | "cancelled" | "failed" | "unknown";
  summary: string;
  readReply?: NativeNotesReadReplyHint;
  committedChanges?: ReadonlyArray<DeviceCommittedChange>;
}
export interface DeviceCredential {
  installationId: string;
  key: string;
  enrollmentId?: string;
  capabilities?: readonly string[];
}

export type LegacyDeviceOperation =
  | { type: "create_note"; title: string; body: string }
  | { type: "create_reminder"; title: string; dueAt: string }
  | { type: "open_view"; view: string }
  | { type: "browser_navigate"; url: string };
export type DeviceOperation =
  | CameraCaptureOperation
  | SmsSendOperation
  | ReminderCreateOperation
  | WorkflowPresentationOperation
  | ClockHandoffOperation
  | MapsOperation
  | LibraryAgentOperation
  | ReminderOperation
  | NotesOperation
  | NativeNotesQueryOperation
  | CalendarOperation
  | WorkflowReadOperation
  | LegacyDeviceOperation;
/** Every operation a proposal may carry. Foreground reviews run through their own executor. */
export type ReviewableDeviceOperation =
  | DeviceOperation
  | ForegroundReviewOperation;

// ── Durable journal port ────────────────────────────────────────────────────

export interface DeviceJournalEntry {
  scope: string;
  proposalId: string;
  operationId: string;
  operationHash: string;
  record: Record<string, unknown>;
  phase: "reserved" | "applying" | "terminal";
  attemptId?: string;
  status?: "succeeded" | "failed" | "unknown" | "cancelled";
  summary?: string;
  result?: Record<string, unknown>;
}
/**
 * Durable, owner-scoped journal. `reserve` must be atomic: a second reservation
 * for the same scope+proposal returns `created: false` and the existing entry.
 * Optional recovery readers return newer durable native evidence only.
 */
export interface DeviceActionJournal {
  reserve(
    input: Omit<DeviceJournalEntry, "phase">,
  ): Promise<{ created: boolean; entry: DeviceJournalEntry }>;
  markApplying(input: {
    scope: string;
    proposalId: string;
    attemptId: string;
  }): Promise<unknown>;
  finish(input: {
    scope: string;
    proposalId: string;
    status: NonNullable<DeviceJournalEntry["status"]>;
    summary: string;
    result?: Record<string, unknown>;
  }): Promise<unknown>;
  recoverNotification?(input: {
    scope: string;
    proposalId: string;
    bindingHash: string;
  }): Promise<{ entry: DeviceJournalEntry | null }>;
  recoverDeletion?(input: {
    scope: string;
    proposalId: string;
  }): Promise<{ entry: DeviceJournalEntry | null }>;
  recoverReminder?(input: {
    scope: string;
    proposalId: string;
    bindingHash: string;
  }): Promise<{ entry: DeviceJournalEntry | null }>;
  get(input: {
    scope: string;
    proposalId: string;
  }): Promise<{ entry: DeviceJournalEntry | null }>;
  list(input: { scope: string }): Promise<{ entries: DeviceJournalEntry[] }>;
}

// ── Executor ports ──────────────────────────────────────────────────────────

export interface WorkflowNoticeRoute {
  scope: string;
  origin: string;
  ownerId: string;
  agentId: string;
  workflowId: string;
  runId: string;
  versionId: string;
}
export interface DeviceJournalIdentity {
  scope: string;
  proposalId: string;
}
export interface DeviceExecutionResult {
  status: "succeeded" | "failed" | "unknown";
  summary: string;
  readResult?: WorkflowReadResult;
  calendarResult?: CalendarResult;
  notesResult?: NotesResult | NotesQueryResult;
  reminderResult?: ReminderResult | ReminderCreateResult;
  mapsResult?: MapsResult;
  clockResult?: ClockHandoffResult;
  photoLibraryResult?: LibraryAgentResult;
  cameraResult?: CameraCaptureResult;
  smsResult?: SmsSendResult;
  /** Local Browser presentation only; never persisted or uploaded. */
  presentBrowser?: () => void;
}
export type DeviceExecutor<
  C extends DeviceContextEnvelope = DeviceContextEnvelope,
> = (
  operation: DeviceOperation,
  operationId: string,
  context: C,
  signal: AbortSignal,
  bindingHash: string,
  workflowRoute?: WorkflowNoticeRoute,
  journalIdentity?: DeviceJournalIdentity,
  agendaSource?: CalendarSource,
) => Promise<DeviceExecutionResult>;
/** Runs the phone's local review and any resulting exact-target effect. */
export type ForegroundReviewExecutor<
  C extends DeviceContextEnvelope = DeviceContextEnvelope,
> = (
  operation: ForegroundReviewOperation,
  operationId: string,
  context: C,
  signal: AbortSignal,
  bindingHash: string,
  journalIdentity: DeviceJournalIdentity,
  capabilities: readonly string[],
) => Promise<{
  status: "succeeded" | "failed" | "unknown";
  summary: string;
  foregroundResult?: ForegroundReviewResult;
}>;
/** Reads durable native evidence for an earlier attempt. Must never dispatch. */
export type DeviceRecovery = (
  operation: DeviceOperation,
  operationId: string,
  bindingHash: string,
  signal: AbortSignal,
) => Promise<{
  status: string;
  reminderResult?: ReminderResult | ReminderCreateResult;
  smsResult?: SmsSendResult;
}>;

// ── Product profile ─────────────────────────────────────────────────────────

/** Minimum a workflow phone review must expose to the coordinator. */
export interface DeviceWorkflowReview {
  runId: string;
  workflowId: string;
  versionId: string;
  specDigest: string;
  finished: boolean;
  cancellationRequestedAt: string | null;
}
/** Host workflow binding validators (browser-safe digests). */
export interface DeviceWorkflowPort<R extends DeviceWorkflowReview> {
  parseBinding(value: unknown): WorkflowDeviceBinding;
  parseRead(value: unknown): WorkflowReadOperation;
  validateResult(
    operation: WorkflowReadOperation,
    value: unknown,
  ): Promise<WorkflowReadResult>;
  assertOperation(
    review: R,
    binding: WorkflowDeviceBinding,
    target: WorkflowDeviceTarget,
    operation: { type: string; [key: string]: unknown },
  ): void;
}
/** Operation admission policy. Views a product does not ship are refused. */
export interface DeviceOperationPolicy {
  admitView(view: string): boolean;
  parseWorkflowRead(value: unknown): WorkflowReadOperation;
}
export interface DeviceActionClientProfile<
  C extends DeviceContextEnvelope = DeviceContextEnvelope,
  R extends DeviceWorkflowReview = DeviceWorkflowReview,
> {
  /** Owner-facing product name used in Clock and Photos review text. */
  appName: string;
  operations: DeviceOperationPolicy;
  workflow: DeviceWorkflowPort<R>;
  /** Review copy for record writes; undefined falls back to generic text. */
  presentRecord(
    operation: DeviceOperation,
    timeZone: string | undefined,
  ): { title: string; description: string } | undefined;
  browserNavigationSummary(url: string): string;
  /** True only while the exact map selection is still published by the host. */
  mapsSelectionCurrent(target: MapsTarget): boolean;
  /** Readiness of a selected Calendar event for a named read; undefined when none. */
  namedCalendarReadTarget(context: C): unknown;
  /** True when the host foreground is hidden (for example `document.hidden`). */
  foregroundHidden(): boolean;
}

// ── Pure validation ─────────────────────────────────────────────────────────

const OPENABLE_VIEWS = new Set([
  "home",
  "notes",
  "reminders",
  "browser",
  "calendar",
  "files",
  "photos",
  "camera",
  "maps",
  "inbox",
  "settings",
  "workflows",
]);
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid device action response");
  return value as Record<string, any>;
}
function text(value: unknown, max = 128): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new Error("Invalid device action field");
  return value;
}
function id(value: unknown): string {
  const valueText = text(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(valueText))
    throw new Error("Invalid device action identifier");
  return valueText;
}
/** SHA-256 hex of a UTF-8 string through WebCrypto. */
export async function actionScope(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function smsAgentHash(
  operation: SmsSendOperation,
): Promise<string> {
  return actionScope(smsBindingText(operation));
}
export function smsDeviceStatus(
  result: SmsSendResult,
): "succeeded" | "failed" | "unknown" {
  const outcome = smsReceiptOutcome(result);
  return outcome === "applied"
    ? "succeeded"
    : outcome === "failed"
      ? "failed"
      : "unknown";
}
export function validateDeviceOperation(
  value: unknown,
  policy: DeviceOperationPolicy,
): DeviceOperation {
  const p = object(value);
  if (isCameraCapture(p)) return validateCameraCapture(p);
  if (isSmsSend(p)) return validateSmsSend(p);
  if (isReminderCreate(p)) return validateReminderCreate(p);
  if (isClockHandoffOperation(p)) return validateClockHandoffDispatch(p);
  if (isMapsOperation(p)) return validateMapsOperation(p);
  if (isLibraryOperation(p)) return validateLibraryOperation(p);
  if (isReminderOperation(p)) return validateReminderOperation(p);
  if (isNotesOperation(p)) return validateNotesOperation(p);
  if (isCalendarOperation(p)) return validateCalendarOperation(p);
  if (p.type === "notes_query") return validateNativeNotesQuery(p);
  if (p.type === "read_selected_notes" || p.type === "read_calendar_range")
    return policy.parseWorkflowRead(p);
  if (p.type === "post_notification") {
    if (Object.keys(p).some((k) => !["type", "title", "body"].includes(k)))
      throw Error("Invalid notification fields");
    return {
      type: p.type,
      title: text(p.title, 200),
      body: text(p.body, 2000),
    };
  }
  if (p.type === "speak_text") {
    if (Object.keys(p).some((k) => !["type", "text"].includes(k)))
      throw Error("Invalid speech fields");
    return { type: p.type, text: text(p.text, 5000) };
  }
  if (p.type === "create_note") {
    if (
      typeof p.body !== "string" ||
      p.body.length > 32000 ||
      p.body.includes("\0")
    )
      throw new Error("Invalid note");
    return { type: p.type, title: text(p.title, 256), body: p.body };
  }
  if (p.type === "create_reminder") {
    if (
      Object.keys(p).length !== 3 ||
      Object.keys(p).some((k) => !["type", "title", "dueAt"].includes(k))
    )
      throw Error("Unexpected legacy reminder fields");
    const dueAt = text(p.dueAt, 40),
      time = Date.parse(dueAt);
    if (
      !Number.isFinite(time) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(dueAt) ||
      new Date(time).toISOString().replace(".000Z", "Z") !==
        dueAt.replace(".000Z", "Z")
    )
      throw new Error("Invalid reminder time");
    return { type: p.type, title: text(p.title, 200), dueAt };
  }
  if (
    p.type === "open_view" &&
    typeof p.view === "string" &&
    OPENABLE_VIEWS.has(p.view) &&
    policy.admitView(p.view)
  )
    return { type: p.type, view: p.view };
  if (p.type === "browser_navigate") {
    const url = new URL(text(p.url, 4096));
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid browser destination");
    return { type: p.type, url: url.href };
  }
  throw new Error("Unsupported device operation");
}
/** Every proposal operation, including foreground reviews. */
export function validateReviewableDeviceOperation(
  value: unknown,
  policy: DeviceOperationPolicy,
): ReviewableDeviceOperation {
  const p = object(value);
  return isForegroundReviewOperation(p)
    ? validateForegroundReviewOperation(p)
    : validateDeviceOperation(p, policy);
}

// ── Screen binding ──────────────────────────────────────────────────────────

export const CAMERA_CONTEXT_NOTICE = "Open Camera to take the requested photo.";
/** A pending proposal that does not fit the current screen. Its message is shown to the owner. */
export class ContextNotice extends Error {
  override readonly name = "ContextNotice";
}
type ScreenPorts<C extends DeviceContextEnvelope> = Pick<
  DeviceActionClientProfile<C, DeviceWorkflowReview>,
  "mapsSelectionCurrent" | "namedCalendarReadTarget" | "foregroundHidden"
>;
function contextKey(value: DeviceContextEnvelope): string {
  const selected = value.selectedObject;
  return JSON.stringify([
    value.view,
    value.sensitive === true,
    value.revision,
    value.timeZone ?? null,
    selected
      ? [
          selected.kind,
          selected.id,
          selected.revision ?? null,
          selected.accountId ?? null,
          selected.sourceRevision ?? null,
          selected.occurrenceId ?? null,
        ]
      : null,
  ]);
}
function assertCalendarContext(
  operation: CalendarOperation,
  context: DeviceContextEnvelope,
) {
  if (
    operation.type === "calendar_create_local" ||
    operation.type === "calendar_read_next"
  ) {
    if (context.sensitive)
      throw Error("Return to the unlocked phone and review Calendar access");
    return;
  }
  const selected = context.selectedObject;
  if (context.view !== "calendar" || context.sensitive || !selected)
    throw Error("Open the selected calendar source or event");
  if (operation.type === "calendar_create") {
    if (
      selected.kind !== "calendar-source" ||
      selected.id !== operation.source.sourceId ||
      selected.revision !== operation.source.sourceRevision
    )
      throw Error("Calendar source changed");
  } else if (
    selected.kind !== "calendar-event" ||
    selected.id !== operation.target.eventId ||
    selected.revision !== operation.target.revision ||
    selected.accountId !== operation.target.sourceId ||
    selected.sourceRevision !== operation.target.sourceRevision
  )
    throw Error("Selected calendar event changed");
}
function assertMapsContext(
  operation: MapsOperation,
  context: DeviceContextEnvelope,
  ports: Pick<ScreenPorts<DeviceContextEnvelope>, "mapsSelectionCurrent">,
) {
  const selected = context.selectedObject,
    t = operation.target;
  if (
    context.sensitive ||
    context.view !== "maps" ||
    !selected ||
    selected.kind !== t.kind ||
    selected.id !== t.id ||
    selected.revision !== t.revision ||
    !ports.mapsSelectionCurrent(t)
  )
    throw Error("Selected Maps context changed");
}
/** Device library operations run only where the owner sees Photos on the unlocked phone. */
function assertLibraryContext(context: DeviceContextEnvelope) {
  if (context.sensitive || context.view !== "photos")
    throw Error("Open Photos to review this library action");
}
function assertReminderContext(
  operation: ReminderOperation,
  context: DeviceContextEnvelope,
) {
  const s = context.selectedObject,
    t = operation.target;
  if (
    context.sensitive ||
    context.view !== "calendar" ||
    !s ||
    s.kind !== "reminder" ||
    s.id !== t.reminderId ||
    s.revision !== t.revision ||
    s.accountId !== t.sourceId ||
    s.sourceRevision !== t.sourceRevision ||
    s.occurrenceId !== t.occurrenceId ||
    s.timingVersion !== t.timingVersion
  )
    throw Error("Selected reminder context changed");
}
function assertNotesQueryContext(context: DeviceContextEnvelope) {
  if (context.sensitive || !["home", "notes"].includes(context.view))
    throw Error("Review this Notes query from Home or Notes");
}
function assertNotesContext(
  operation: NotesOperation,
  context: DeviceContextEnvelope,
) {
  const s = context.selectedObject,
    t = operation.target;
  if (
    context.sensitive ||
    context.view !== "notes" ||
    !s ||
    s.kind !== "note" ||
    s.id !== t.noteId ||
    s.revision !== t.revision ||
    s.accountId !== t.sourceId ||
    s.sourceRevision !== t.sourceRevision
  )
    throw Error("Selected note context changed");
}
/** Foreground reviews resolve locally; they are offered only where the owner can see the result. */
function assertForegroundContext<C extends DeviceContextEnvelope>(
  operation: ForegroundReviewOperation,
  context: C,
  ports: Pick<ScreenPorts<C>, "namedCalendarReadTarget">,
) {
  if (context.sensitive)
    throw new ContextNotice("Unlock the phone to review this action.");
  if (operation.type === "calendar_availability") {
    if (!["home", "calendar"].includes(context.view))
      throw new ContextNotice(
        "Open Home or Calendar to review this availability check.",
      );
    // All-day events block the owner's local days, so the check must use this phone's time zone.
    if (operation.timeZone !== context.timeZone)
      throw new ContextNotice(
        "This availability check used a different time zone. Ask again from this phone.",
      );
    return;
  }
  if (operation.type === "calendar_named" && operation.action === "read") {
    if (!ports.namedCalendarReadTarget(context))
      throw new ContextNotice(
        "Choose the matching event in Calendar before sharing it.",
      );
    return;
  }
  if (operation.type === "notes_search") {
    if (!["home", "notes"].includes(context.view))
      throw new ContextNotice(
        "Open Home or Notes to review this Notes search.",
      );
    return;
  }
  // Name-targeted edits are requested from Home and resolved by a local choice, never by a selection elsewhere.
  if (context.view !== "home")
    throw new ContextNotice(
      "Return to Home to choose the record for this action.",
    );
}
/** Every screen rule for a proposal; throws when the current screen cannot review it. */
export function assertProposalContext<C extends DeviceContextEnvelope>(
  operation: ReviewableDeviceOperation,
  context: C,
  ports: ScreenPorts<C>,
) {
  if (
    operation.type === "read_calendar_range" &&
    (context.sensitive || ports.foregroundHidden())
  )
    throw new ContextNotice(
      "Unlock this foreground Calendar read before approving it.",
    );
  if (
    isCameraCapture(operation) &&
    (context.sensitive || context.view !== "camera")
  )
    throw new ContextNotice(CAMERA_CONTEXT_NOTICE);
  if (isForegroundReviewOperation(operation))
    assertForegroundContext(operation, context, ports);
  if (
    isSmsSend(operation) &&
    (context.sensitive ||
      context.view !== "messages" ||
      context.selectedObject?.kind !== "sms-subscription" ||
      context.selectedObject.id !== String(operation.subscriptionId))
  )
    throw new ContextNotice(
      "Open Messages and select the reviewed SIM before approving SMS.",
    );
  if (isClockHandoffOperation(operation))
    assertClockHandoffTimeZone(operation, context.timeZone);
  if (isMapsOperation(operation)) assertMapsContext(operation, context, ports);
  if (isLibraryOperation(operation)) assertLibraryContext(context);
  if (isReminderOperation(operation)) assertReminderContext(operation, context);
  if (isNativeNotesQuery(operation)) assertNotesQueryContext(context);
  if (isNotesOperation(operation)) assertNotesContext(operation, context);
  if (isCalendarOperation(operation)) assertCalendarContext(operation, context);
}
/** Owner-facing reason a pending proposal cannot be reviewed from this screen, or undefined. */
export function proposalContextNotice<C extends DeviceContextEnvelope>(
  operation: ReviewableDeviceOperation,
  context: C,
  ports: ScreenPorts<C>,
): string | undefined {
  try {
    assertProposalContext(operation, context, ports);
    return undefined;
  } catch (error) {
    if (error instanceof ContextNotice) return error.message;
    if (context.sensitive) return "Unlock the phone to review this action.";
    if (isClockHandoffOperation(operation))
      return "This Clock request used a different time zone. Ask again from this phone.";
    if (isMapsOperation(operation))
      return "Open the selected place or route in Maps to review this action.";
    if (isLibraryOperation(operation))
      return "Open Photos > Device library to review this action.";
    if (isReminderOperation(operation))
      return "Open the selected reminder in Calendar to review this action.";
    if (isNativeNotesQuery(operation))
      return "Open Home or Notes to review this Notes search.";
    if (isNotesOperation(operation))
      return "Open the selected note to review this action.";
    if (isCalendarOperation(operation))
      return operation.type === "calendar_create"
        ? "Open the selected calendar to review this action."
        : "Open the selected calendar event to review this action.";
    return "Return to the screen this action was requested from to review it.";
  }
}

// ── Review copy ─────────────────────────────────────────────────────────────

const quoted = (value: string) => `“${value}”`;
export function describeForegroundReview(
  op: ForegroundReviewOperation,
  timeZone?: string,
): { title: string; description: string } {
  if (op.type === "calendar_availability") {
    const zone = timeZone ?? op.timeZone;
    return {
      title: "Check availability",
      description: `Check whether you are free from ${formatDeviceRecordDateTime(op.start, zone)} to ${formatDeviceRecordDateTime(op.end, zone)} (${zone}).\nYou choose which calendars this phone reads. Only busy times are shared with the agent, not event titles or details. Events marked free are ignored; all-day events count as busy.`,
    };
  }
  if (op.type === "calendar_named" && op.action === "read")
    return {
      title: "Share matching event",
      description: `Choose the event named ${quoted(op.name)} in Calendar, then review the details to share. The edit needs a separate confirmation.`,
    };
  if (op.type === "notes_search")
    return op.query.kind === "content"
      ? {
          title: "Search notes",
          description: `Search your notes for ${quoted(op.query.text)} on this phone.\nChoose and review one note before its text is shared. Other notes stay on this phone.`,
        }
      : {
          title: "List note titles",
          description: `List up to ${op.query.limit} note titles on this phone.\nReview the exact titles before they are shared. Note text is not shared.`,
        };
  const noun =
    op.type === "notes_named"
      ? "note"
      : op.type === "calendar_named"
        ? "event"
        : "reminder";
  const verb =
    op.action === "update"
      ? "Edit"
      : op.action === "delete"
        ? "Delete"
        : "Cancel";
  const where =
    op.type === "notes_named"
      ? "Notes"
      : op.type === "calendar_named"
        ? "Calendar"
        : "Reminders";
  let change = "";
  if (op.action === "update") {
    if (op.type === "notes_named")
      change = `\nNew title: ${quoted(op.fields.title)}\n${op.fields.body}`;
    else if (op.type === "calendar_named")
      change = `\nNew title: ${quoted(op.fields.title)}\n${formatDeviceRecordDateTime(op.fields.start, op.fields.timeZone)} to ${formatDeviceRecordDateTime(op.fields.end, op.fields.timeZone)} (${op.fields.timeZone})`;
    else
      change = `\nNew title: ${quoted(op.fields.title)}${op.fields.body ? `\n${op.fields.body}` : ""}`;
  }
  return {
    title: `${verb} ${noun} by name`,
    description: `Find ${quoted(op.name)} in ${where} on this phone. You choose the exact ${noun}, then review this ${verb.toLowerCase()} again before anything changes.${change}`,
  };
}

// ── Committed-change publication ────────────────────────────────────────────

/** The host client state the publication queue observes. */
export interface DeviceRefreshClient {
  getState(): {
    connection: string;
    pending: boolean;
    session: DeviceClientSession | null;
  };
  subscribe(listener: () => void): () => void;
}
const publishedDeviceReceipts = new WeakSet<DeviceOperationReceipt>();
const pendingDeviceChanges = new WeakMap<
  DeviceRefreshClient,
  {
    entries: Map<
      string,
      {
        receipt: DeviceOperationReceipt;
        session: DeviceClientSession;
        publish: (view: DeviceCommittedChange) => void;
      }
    >;
    unsubscribe: () => void;
    flushing: boolean;
    flush: () => void;
  }
>();
/** Queue only delivered receipts; publish when the same owner session is idle. */
export function publishCommittedDeviceChanges(
  receipt: DeviceOperationReceipt,
  client: DeviceRefreshClient,
  session: DeviceClientSession,
  publish: (view: DeviceCommittedChange) => void,
): void {
  if (
    receipt.status !== "succeeded" ||
    !receipt.committedChanges?.length ||
    publishedDeviceReceipts.has(receipt)
  )
    return;
  let pending = pendingDeviceChanges.get(client);
  const item = { receipt, session: { ...session }, publish };
  if (pending) {
    pending.entries.set(receipt.proposalId, item);
    pending.flush();
    return;
  }
  const queue = {
    entries: new Map([[receipt.proposalId, item]]),
    unsubscribe: () => {},
    flushing: false,
    flush: () => {},
  };
  pending = queue;
  pendingDeviceChanges.set(client, queue);
  queue.flush = () => {
    if (queue.flushing) return;
    queue.flushing = true;
    try {
      for (const [entryId, entry] of queue.entries) {
        const state = client.getState();
        if (
          state.connection !== "ready" ||
          JSON.stringify(state.session) !== JSON.stringify(entry.session)
        ) {
          queue.entries.delete(entryId);
          continue;
        }
        if (state.pending) break;
        queue.entries.delete(entryId);
        publishedDeviceReceipts.add(entry.receipt);
        for (const view of new Set(entry.receipt.committedChanges))
          if (["calendar", "notes", "reminders"].includes(view))
            entry.publish(view);
      }
    } finally {
      queue.flushing = false;
      if (!queue.entries.size) {
        queue.unsubscribe();
        pendingDeviceChanges.delete(client);
      }
    }
  };
  queue.unsubscribe = client.subscribe(queue.flush);
  queue.flush();
}

// ── Coordinator ─────────────────────────────────────────────────────────────

export interface PendingReviewItem {
  /** Reviewable from the current screen; null when only a notice can be shown. */
  proposal: DeviceActionProposalCard | null;
  /** Why a pending proposal cannot be reviewed here, for example "Open the selected note". */
  notice?: string;
}
export interface DeviceProposal {
  calendarAgendaSource?: CalendarSource;
  providerReceipt?: unknown;
  requestMessageId?: string;
  id: string;
  digest: string;
  state: string;
  expiresAt: number;
  operation: ReviewableDeviceOperation;
  workflow?: WorkflowDeviceBinding;
  attemptId?: string;
  providerIdempotencyKey?: string;
  readReplyOrigin?: NativeNotesReadReplyOrigin;
}
export interface DeviceActionCoordinatorPorts<
  C extends DeviceContextEnvelope = DeviceContextEnvelope,
  R extends DeviceWorkflowReview = DeviceWorkflowReview,
> {
  session: DeviceClientSession;
  credential: DeviceCredential;
  /** Owner/agent/origin-scoped journal namespace (64 hex chars). */
  scope: string;
  /** Authenticated `/api/client-devices/*` transport. */
  request(
    path: string,
    body: unknown | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
  journal: DeviceActionJournal;
  execute: DeviceExecutor<C>;
  recover?: DeviceRecovery;
  executeForeground?: ForegroundReviewExecutor<C>;
  /** The agent negotiated timing-version-2 reminder targets and alert edits. */
  reminderTimingV2?: boolean;
  /** The agent negotiated reviewed reminder creation. */
  reminderCreate?: boolean;
  profile: DeviceActionClientProfile<C, R>;
}
type ExecutionResult = DeviceExecutionResult & {
  foregroundResult?: ForegroundReviewResult;
};
type CommittedReceiptResult = { result: unknown } | Record<string, never>;

/** Authenticated structured actions only. Neither reply prose nor restored history
 * can enter this boundary. A durable journal gates every device effect. */
export class DeviceActionCoordinator<
  C extends DeviceContextEnvelope = DeviceContextEnvelope,
  R extends DeviceWorkflowReview = DeviceWorkflowReview,
> {
  readonly session: DeviceClientSession;
  readonly credential: DeviceCredential;
  readonly scope: string;
  private proposals = new Map<
    string,
    { proposal: DeviceProposal; context: C; workflowReview?: R }
  >();
  private readReplies = new Map<
    string,
    {
      digest: string;
      origin: NativeNotesReadReplyOrigin;
      hint?: NativeNotesReadReplyHint;
      consumed?: boolean;
    }
  >();
  private busy = false;
  private readonly ports: DeviceActionCoordinatorPorts<C, R>;
  constructor(ports: DeviceActionCoordinatorPorts<C, R>) {
    this.ports = ports;
    this.session = ports.session;
    this.credential = ports.credential;
    this.scope = ports.scope;
  }
  get supportsCalendarAgenda(): boolean {
    return this.capability(CALENDAR_AGENDA_CAPABILITY);
  }
  private capability(name: string): boolean {
    return this.credential.capabilities?.includes(name) === true;
  }
  private get profile(): DeviceActionClientProfile<C, R> {
    return this.ports.profile;
  }
  private request(path: string, body: unknown, signal: AbortSignal) {
    return this.ports.request(path, body, signal);
  }
  private get journal(): DeviceActionJournal {
    return this.ports.journal;
  }
  private workflowTarget(): WorkflowDeviceTarget {
    return {
      installationId: this.credential.installationId,
      enrollmentId: this.credential.enrollmentId as string,
    };
  }
  private bindingHash(
    sessionId: string,
    proposal: Pick<DeviceProposal, "id" | "digest">,
    operationId: string,
  ): Promise<string> {
    return actionScope(
      JSON.stringify([
        this.scope,
        this.session.ownerId,
        this.session.agentId,
        sessionId,
        this.session.origin,
        this.credential.installationId,
        this.credential.enrollmentId,
        proposal.id,
        proposal.digest,
        operationId,
      ]),
    );
  }
  /** The journal entry was written by this owner, agent, origin and enrollment for this proposal. */
  private ownEntry(entry: DeviceJournalEntry, p: DeviceProposal): boolean {
    return (
      entry.record.digest === p.digest &&
      entry.record.ownerId === this.session.ownerId &&
      entry.record.agentId === this.session.agentId &&
      entry.record.origin === this.session.origin
    );
  }
  private ownDevice(entry: DeviceJournalEntry): boolean {
    return (
      entry.record.installationId === this.credential.installationId &&
      entry.record.enrollmentId === this.credential.enrollmentId
    );
  }
  private parse(value: unknown): DeviceProposal {
    const p = object(value),
      payload = object(p.payload);
    if (
      p.subjectUserId !== this.session.ownerId ||
      p.requestedBy !== this.session.agentId ||
      p.action !== "device_action" ||
      payload.action !== "device_action" ||
      payload.version !== 1 ||
      payload.installationId !== this.credential.installationId ||
      payload.enrollmentId !== this.credential.enrollmentId
    )
      throw new Error("Device action belongs to another identity");
    const expiresAt = Date.parse(text(p.expiresAt, 40)),
      digest = text(p.digest, 64);
    if (!Number.isFinite(expiresAt) || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid action expiry or digest");
    const workflow =
        payload.workflow === undefined
          ? undefined
          : this.profile.workflow.parseBinding(payload.workflow),
      op = validateReviewableDeviceOperation(
        payload.operation,
        this.profile.operations,
      );
    if (isCameraCapture(op) && !this.capability(CAMERA_CAPTURE_CAPABILITY))
      throw Error("Camera capture was not negotiated with this agent");
    if (isSmsSend(op) && !this.capability(SMS_SEND_CAPABILITY))
      throw Error("Native SMS was not negotiated with this phone");
    if (
      isCalendarOperation(op) &&
      (op.type === "calendar_create_local" ||
        op.type === "calendar_read_next") &&
      !calendarCapabilityAvailable(op.type, this.credential.capabilities)
    )
      throw Error(
        "This agent has not negotiated native Calendar creation or discovery. Reconnect to a compatible agent.",
      );
    if (isNativeNotesQuery(op) && !this.capability(NOTES_QUERY_CAPABILITY))
      throw Error("Notes discovery was not negotiated with this agent");
    if (isLibraryOperation(op) && !this.capability(PHOTO_LIBRARY_CAPABILITY))
      throw Error("Device library access was not negotiated with this agent");
    if (
      isForegroundReviewOperation(op) &&
      (!foregroundReviewOperationAvailable(op, this.credential.capabilities) ||
        !this.ports.executeForeground)
    )
      throw Error(
        "This action was not negotiated with this agent. Reconnect to a compatible agent.",
      );
    if (isReminderCreate(op) && !this.ports.reminderCreate)
      throw Error(
        "This agent does not support reviewed reminder creation. Reconnect to a compatible agent.",
      );
    if (
      isReminderOperation(op) &&
      (op.target.timingVersion === 2 ||
        (op.type === "reminder_update" &&
          op.fields.schedule?.alertMinutes !== undefined)) &&
      !this.ports.reminderTimingV2
    )
      throw Error(
        "This agent does not support this reminder timing. Reconnect to a compatible agent.",
      );
    const agendaSource =
      payload.calendarAgendaSource === undefined
        ? undefined
        : calendarSource(payload.calendarAgendaSource);
    if (
      agendaSource &&
      (op.type !== "read_calendar_range" ||
        workflow ||
        !payload.requestMessageId ||
        op.calendarIds.length !== 1 ||
        op.calendarIds[0] !== agendaSource.sourceId ||
        !this.capability(CALENDAR_AGENDA_CAPABILITY))
    )
      throw Error("Standalone Calendar read was not negotiated or bound");
    if (
      [
        "read_selected_notes",
        "read_calendar_range",
        "post_notification",
        "speak_text",
      ].includes(op.type) &&
      !workflow &&
      !(op.type === "read_calendar_range" && agendaSource)
    )
      throw new Error("Workflow binding required for phone reads");
    const readReplyOrigin =
      p.readReplyOrigin === undefined
        ? undefined
        : validateNativeNotesReadReplyOrigin(p.readReplyOrigin);
    if (
      readReplyOrigin &&
      (workflow || !isOriginalDeviceReadOperationType(op.type))
    )
      throw Error("Unexpected original Notes reply");
    return {
      ...(agendaSource ? { calendarAgendaSource: agendaSource } : {}),
      providerReceipt: p.execution?.providerReceipt,
      ...(payload.requestMessageId === undefined
        ? {}
        : { requestMessageId: id(payload.requestMessageId) }),
      id: id(p.id),
      digest,
      state: text(p.state, 32),
      expiresAt,
      operation: op,
      ...(workflow ? { workflow } : {}),
      ...(p.execution?.providerIdempotencyKey
        ? { providerIdempotencyKey: id(p.execution.providerIdempotencyKey) }
        : {}),
      ...(p.execution?.attemptId
        ? { attemptId: id(p.execution.attemptId) }
        : {}),
      ...(readReplyOrigin ? { readReplyOrigin } : {}),
    };
  }
  /** Each proposal is parsed on its own: one invalid proposal never hides valid siblings. */
  private async listing(signal: AbortSignal): Promise<{
    valid: DeviceProposal[];
    invalid: { pending: boolean; error: Error }[];
  }> {
    const response = object(
      await this.request("/api/client-devices/proposals", undefined, signal),
    );
    if (!Array.isArray(response.proposals))
      throw new Error("Invalid device action list");
    const valid: DeviceProposal[] = [],
      invalid: { pending: boolean; error: Error }[] = [];
    for (const value of response.proposals) {
      try {
        valid.push(this.parse(value));
      } catch (error) {
        const raw =
          value && typeof value === "object"
            ? (value as { state?: unknown; expiresAt?: unknown })
            : {};
        // An invalid proposal that is finished or has expired is history, not a pending notice.
        const expiresAt =
          typeof raw.expiresAt === "string"
            ? Date.parse(raw.expiresAt)
            : Number.NaN;
        invalid.push({
          pending:
            (raw.state === undefined || raw.state === "pending") &&
            !(expiresAt <= Date.now()),
          error:
            error instanceof Error ? error : new Error("Invalid device action"),
        });
      }
    }
    return { valid, invalid };
  }
  async list(signal: AbortSignal): Promise<DeviceProposal[]> {
    return (await this.listing(signal)).valid;
  }
  private notice(operation: ReviewableDeviceOperation, context: C) {
    return proposalContextNotice(operation, context, this.profile);
  }
  private card(proposal: DeviceProposal, context: C): DeviceActionProposalCard {
    const op = proposal.operation;
    const readReply = proposal.readReplyOrigin
      ? {
          readReply: {
            origin: structuredClone(proposal.readReplyOrigin),
            digest: proposal.digest,
          },
        }
      : {};
    const base = {
      id: proposal.id,
      expiresAt: proposal.expiresAt,
      contextRevision: context.revision,
    };
    if (isForegroundReviewOperation(op)) {
      const namedReadReady =
        op.type === "calendar_named" &&
        op.action === "read" &&
        !!this.profile.namedCalendarReadTarget(context);
      return {
        ...(op.type === "calendar_named" &&
        op.action === "read" &&
        !context.sensitive &&
        ["home", "calendar"].includes(context.view) &&
        !namedReadReady
          ? { reviewDestination: "calendar" as const }
          : {}),
        id: proposal.id,
        ...describeForegroundReview(op, context.timeZone),
        expiresAt: proposal.expiresAt,
        contextRevision: context.revision,
        ...((op.type === "calendar_availability" || namedReadReady) &&
          readReply),
      };
    }
    if (isSmsSend(op))
      return {
        ...base,
        title: "Review SMS",
        description: `To: ${op.recipients.join(", ")}\nSIM subscription: ${op.subscriptionId}\n\n${op.body}\n\nConfirm again in Android. Submission does not prove delivery.`,
      };
    if (isCameraCapture(op))
      return {
        ...base,
        title: "Take photo",
        description:
          "Use the current camera and save one photo in Photos. The photo stays on this device.",
      };
    if (isLibraryOperation(op))
      return { ...base, ...describeLibraryOperation(op, this.profile.appName) };
    const notesDestination =
      (op.type === "notes_delete" || op.type === "notes_update") &&
      !context.sensitive &&
      ["home", "notes"].includes(context.view) &&
      this.notice(op, context)
        ? {
            reviewDestination: "notes" as const,
            reviewNoteTarget: structuredClone(op.target),
          }
        : {};
    const record =
      isReminderCreate(op) ||
      isReminderOperation(op) ||
      isNotesOperation(op) ||
      isCalendarOperation(op) ||
      op.type === "create_note" ||
      op.type === "create_reminder"
        ? this.profile.presentRecord(op, context.timeZone)
        : undefined;
    const agenda = op.type === "read_calendar_range" && !proposal.workflow;
    const description = agenda
      ? `Share this app Calendar from ${formatDeviceRecordDateTime(op.start, op.timeZone)} to ${formatDeviceRecordDateTime(op.end, op.timeZone)} (end not included), in ${op.timeZone}. Only this range is shared; other calendars, descriptions, locations and guests stay private.`
      : isNativeNotesQuery(op)
        ? op.query.kind === "title"
          ? `Look for the title “${op.query.text}” locally. Choose and review one note before sharing its text.`
          : `Find the latest ${op.query.by} note locally. Unknown dates or ties require your choice; only the chosen note is shared.`
        : (record?.description ??
          (isClockHandoffOperation(op)
            ? describeClockHandoff(op, this.profile.appName)
            : isMapsOperation(op)
              ? "Send the exact selected place location or route endpoints, mode and distance to the connected agent. This shares location information. It does not start navigation."
              : op.type === "open_view"
                ? `Open ${op.view} on this phone`
                : op.type === "browser_navigate"
                  ? `Open browser destination ${op.url}`
                  : "Workflow phone read"));
    return {
      ...base,
      title: agenda
        ? "Share Calendar agenda"
        : (record?.title ?? op.type.replaceAll("_", " ")),
      description,
      ...notesDestination,
      ...(isNativeNotesQuery(op) && !["home", "notes"].includes(context.view)
        ? { reviewDestination: "home" as const }
        : {}),
      ...(isNativeNotesQuery(op) || op.type === "notes_read_selected"
        ? { privateNotesRead: true as const }
        : {}),
      ...readReply,
    };
  }
  private async review(
    context: C,
    signal: AbortSignal,
  ): Promise<{ items: PendingReviewItem[]; failures: Error[] }> {
    const { valid, invalid } = await this.listing(signal);
    signal.throwIfAborted();
    this.proposals.clear();
    const items: PendingReviewItem[] = [];
    for (const proposal of valid) {
      if (
        proposal.workflow ||
        proposal.state !== "pending" ||
        proposal.expiresAt <= Date.now()
      )
        continue;
      const card = this.card(proposal, context),
        notice =
          (isNativeNotesQuery(proposal.operation) && !context.sensitive) ||
          card.reviewDestination === "notes" ||
          card.reviewDestination === "calendar"
            ? undefined
            : this.notice(proposal.operation, context);
      if (notice) {
        items.push({ proposal: null, notice: `${card.title}: ${notice}` });
        continue;
      }
      this.proposals.set(proposal.id, {
        proposal,
        context: structuredClone(context),
      });
      if (proposal.readReplyOrigin && !this.readReplies.has(proposal.id))
        this.readReplies.set(proposal.id, {
          digest: proposal.digest,
          origin: proposal.readReplyOrigin,
        });
      items.push({ proposal: card });
    }
    const failures = invalid
      .filter((item) => item.pending)
      .map((item) => item.error);
    for (const error of failures)
      items.push({
        proposal: null,
        notice: `An agent action could not be shown on this phone. ${error.message.slice(0, 300)}`,
      });
    return { items, failures };
  }
  /** Reviewable proposals plus owner-visible notices for pending ones that do not fit this screen. */
  async pendingReview(
    context: C,
    signal: AbortSignal,
  ): Promise<PendingReviewItem[]> {
    return (await this.review(context, signal)).items;
  }
  /** Reviewable proposals only. An invalid proposal fails the call only when nothing else is reviewable. */
  async pending(
    context: C,
    signal: AbortSignal,
  ): Promise<DeviceActionProposalCard[]> {
    const { items, failures } = await this.review(context, signal);
    const proposals = items.flatMap((item) =>
      item.proposal ? [item.proposal] : [],
    );
    if (!proposals.length && failures.length) throw failures[0];
    return proposals;
  }
  /** Only proposals bound by the host to this exact freshly sent user message may run.
   * Only reversible local actions bypass the optional review. Sends, deletes, private
   * reads and Calendar/reminder writes retain their recorded separate review policy.
   * Recovery, workflows and old hosts remain review-only; ordinary OS permissions still apply. */
  async performRequested(
    messageId: string,
    context: C,
    signal: AbortSignal,
    allowed: () => Promise<boolean>,
    operationType?: ReviewableDeviceOperation["type"],
  ): Promise<DeviceOperationReceipt[]> {
    const directTypes: readonly ReviewableDeviceOperation["type"][] = [
      "create_note",
      "open_view",
      "browser_navigate",
      "camera_capture_photo",
      "photo_library_select",
    ];
    const results: DeviceOperationReceipt[] = [];
    for (const [proposalId, entry] of [...this.proposals]) {
      if (
        results.length >= 4 ||
        !directTypes.includes(entry.proposal.operation.type) ||
        entry.proposal.workflow ||
        entry.proposal.requestMessageId !== messageId ||
        (operationType !== undefined &&
          entry.proposal.operation.type !== operationType)
      )
        continue;
      // A navigation-only card is not an executable read/write, even in direct-request mode.
      if (this.card(entry.proposal, context).reviewDestination) continue;
      if (!(await allowed())) break;
      signal.throwIfAborted();
      const result = await this.approve(proposalId, context, signal);
      results.push(result);
      if (result.status !== "succeeded" || signal.aborted) break;
    }
    return results;
  }
  private assertWorkflow(review: R, p: DeviceProposal) {
    this.profile.workflow.assertOperation(
      review,
      p.workflow as WorkflowDeviceBinding,
      this.workflowTarget(),
      p.operation as { type: string; [key: string]: unknown },
    );
  }
  /** Notice restoration validates pending metadata without creating an executable foreground review. */
  async pendingWorkflowNotice(
    review: R,
    signal: AbortSignal,
  ): Promise<Array<{ id: string; expiresAt: number }>> {
    if (review.finished || review.cancellationRequestedAt) return [];
    const pending = (await this.list(signal)).filter(
      (p) =>
        p.workflow?.runId === review.runId &&
        p.state === "pending" &&
        p.expiresAt > Date.now(),
    );
    signal.throwIfAborted();
    return pending.map((p) => {
      this.assertWorkflow(review, p);
      return { id: p.id, expiresAt: p.expiresAt };
    });
  }
  async pendingForWorkflow(
    review: R,
    context: C,
    signal: AbortSignal,
  ): Promise<DeviceActionProposalCard[]> {
    if (
      context.view !== "workflows" ||
      context.sensitive ||
      context.selectedObject?.kind !== "workflow-run" ||
      context.selectedObject.id !== review.runId ||
      context.selectedObject.revision !== review.versionId
    )
      throw new Error(
        "Open this exact workflow execution before reviewing phone steps",
      );
    const pending = (await this.list(signal)).filter(
      (p) =>
        p.workflow?.runId === review.runId &&
        p.state === "pending" &&
        p.expiresAt > Date.now(),
    );
    signal.throwIfAborted();
    this.proposals.clear();
    return pending.map((p) => {
      this.assertWorkflow(review, p);
      this.proposals.set(p.id, {
        proposal: p,
        context: structuredClone(context),
        workflowReview: structuredClone(review),
      });
      const op = p.operation;
      const w = p.workflow as WorkflowDeviceBinding;
      const scope =
        op.type === "read_selected_notes"
          ? `Read only ${op.notes.length} selected Notes at the recorded revisions. Text and titles will be sent to this agent.\nSelected IDs: ${op.notes.map((n: { id: string }) => n.id).join(", ")}`
          : op.type === "read_calendar_range"
            ? `Read calendars ${op.calendarIds.join(", ")} from ${op.start} up to (excluding) ${op.end}, shown in ${op.timeZone}. At most ${op.maximumEvents} events; overflow fails. Event titles, times and IDs will be sent; descriptions, locations and attendees are excluded.`
            : op.type === "create_note"
              ? `Save one note “${op.title}” on this phone:\n${op.body}`
              : op.type === "post_notification"
                ? `Post this notification on this device: ${op.title}\n${op.body}`
                : op.type === "speak_text"
                  ? `Read this exact text aloud on this device:\n${op.text}`
                  : "Unsupported phone step";
      const identity = `Owner: ${this.session.ownerId}\nWorkflow: ${w.workflowId}\nRun: ${w.runId}\nVersion: ${w.versionId}\nStep: ${w.stepId}\nSpec: ${w.specDigest}`;
      return {
        id: p.id,
        title: op.type.replaceAll("_", " "),
        reviewScope: `${scope}\nAgent: ${this.session.origin}`,
        reviewIdentity: identity,
        description: `Agent: ${this.session.origin}\n${identity}\n${scope}`,
        expiresAt: p.expiresAt,
        contextRevision: context.revision,
      };
    });
  }
  private async mutation(
    p: DeviceProposal,
    suffix: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<DeviceProposal> {
    if (
      isMapsOperation(p.operation) &&
      (suffix === "receipt" || suffix === "reconciliation") &&
      !this.profile.mapsSelectionCurrent(p.operation.target)
    )
      throw Error("Maps selection changed before upload");
    const response = object(
      await this.request(
        `/api/client-devices/proposals/${p.id}/${suffix}`,
        { digest: p.digest, ...body },
        signal,
      ),
    );
    const result = this.parse({
      ...object(response.proposal),
      digest: response.digest,
    });
    if (result.id !== p.id || result.digest !== p.digest)
      throw new Error("Device action changed during review");
    return result;
  }
  /** Validates an executor result against the reviewed operation before it is journaled. */
  private async typedResults(
    p: DeviceProposal,
    result: ExecutionResult,
    operationId: string,
    context: C,
  ) {
    const op = p.operation;
    let smsResult: SmsSendResult | undefined;
    if (isSmsSend(op)) {
      if (result.smsResult !== undefined) {
        smsResult = validateSmsResult(
          op,
          result.smsResult,
          operationId,
          await smsAgentHash(op),
        );
        if (smsDeviceStatus(smsResult) !== result.status)
          throw Error("SMS outcome mismatch");
      } else if (result.status !== "unknown")
        throw Error("Missing SMS evidence");
    } else if (result.smsResult !== undefined)
      throw Error("Unexpected SMS result");
    let clockResult: ClockHandoffResult | undefined;
    if (isClockHandoffOperation(op)) {
      if (result.clockResult !== undefined) {
        clockResult = clockHandoffReceipt(op, result.clockResult);
        const expected =
          clockResult.status === "opened"
            ? "succeeded"
            : clockResult.status === "unknown"
              ? "unknown"
              : "failed";
        if (result.status !== expected)
          throw Error("Clock handoff outcome mismatch");
      } else if (result.status === "succeeded")
        throw Error("Missing Clock handoff result");
    } else if (result.clockResult !== undefined)
      throw Error("Unexpected Clock handoff result");
    let mapsResult: MapsResult | undefined;
    if (isMapsOperation(op)) {
      if (result.status === "succeeded")
        mapsResult = validateMapsResult(op, result.mapsResult);
      else if (result.mapsResult !== undefined)
        throw Error("Failed Maps read cannot return content");
    } else if (result.mapsResult !== undefined)
      throw Error("Unexpected Maps result");
    let cameraResult: CameraCaptureResult | undefined;
    if (isCameraCapture(op)) {
      if (result.status === "succeeded")
        cameraResult = validateCameraCaptureResult(
          result.cameraResult,
          operationId,
        );
      else if (result.cameraResult !== undefined)
        throw Error("Unconfirmed camera capture cannot return a saved photo");
    } else if (result.cameraResult !== undefined)
      throw Error("Unexpected camera result");
    let photoLibraryResult: LibraryAgentResult | undefined;
    if (isLibraryOperation(op)) {
      if (result.status === "succeeded")
        photoLibraryResult = validateLibraryResult(
          op,
          result.photoLibraryResult,
        );
      else if (result.photoLibraryResult !== undefined)
        throw Error("Failed library action cannot return content");
    } else if (result.photoLibraryResult !== undefined)
      throw Error("Unexpected library result");
    let reminderResult: ReminderResult | ReminderCreateResult | undefined;
    if (isReminderCreate(op)) {
      if (result.status === "succeeded")
        reminderResult = validateReminderCreateResult(
          op,
          result.reminderResult,
          operationId,
        );
      else if (result.reminderResult !== undefined)
        throw Error("Unconfirmed creation cannot return a result");
    } else if (isReminderOperation(op)) {
      if (result.status === "succeeded")
        reminderResult = validateReminderResult(op, result.reminderResult);
      else if (result.reminderResult !== undefined)
        throw Error("Unconfirmed reminder cannot return a result");
    } else if (result.reminderResult !== undefined)
      throw Error("Unexpected reminder result");
    if (isReminderOperation(op)) assertReminderContext(op, context);
    let notesResult: NotesResult | NotesQueryResult | undefined;
    if (isNativeNotesQuery(op)) {
      if (result.status === "succeeded")
        notesResult = validateNotesQueryResult(op, result.notesResult);
      else if (result.notesResult !== undefined)
        throw Error("Unconfirmed Notes query cannot return content");
    } else if (isNotesOperation(op)) {
      if (result.status === "succeeded")
        notesResult = validateNotesResult(op, result.notesResult);
      else if (result.notesResult !== undefined)
        throw Error("Failed Notes action cannot return content");
    } else if (result.notesResult !== undefined)
      throw Error("Unexpected Notes result");
    let calendarResult: CalendarResult | undefined;
    if (isCalendarOperation(op)) {
      if (result.status === "succeeded")
        calendarResult = validateCalendarResult(op, result.calendarResult);
      else if (result.calendarResult !== undefined)
        throw Error("Failed Calendar action cannot return content");
    } else if (result.calendarResult !== undefined)
      throw Error("Unexpected Calendar result");
    let foregroundResult: ForegroundReviewResult | undefined;
    if (isForegroundReviewOperation(op)) {
      if (result.status === "succeeded")
        foregroundResult = validateForegroundReviewResult(
          op,
          result.foregroundResult,
        );
      else if (result.foregroundResult !== undefined)
        throw Error("An unconfirmed review cannot return a result");
    } else if (result.foregroundResult !== undefined)
      throw Error("Unexpected foreground review result");
    let readResult: WorkflowReadResult | undefined;
    if (
      op.type === "read_selected_notes" ||
      op.type === "read_calendar_range"
    ) {
      if (result.status === "succeeded")
        readResult = await this.profile.workflow.validateResult(
          op,
          result.readResult,
        );
      else if (result.readResult !== undefined)
        throw new Error("Failed read cannot return content");
    } else if (result.readResult !== undefined)
      throw new Error("Unexpected read content");
    // Journal field order is part of the stored record shape; keep it stable.
    return {
      smsResult,
      clockResult,
      mapsResult,
      photoLibraryResult,
      cameraResult,
      readResult,
      calendarResult,
      notesResult,
      reminderResult,
      foregroundResult,
    };
  }
  async approve(
    proposalId: string,
    context: C,
    signal: AbortSignal,
  ): Promise<DeviceOperationReceipt> {
    if (this.busy) throw new Error("Another device action is being reviewed");
    const reviewed = this.proposals.get(proposalId);
    if (
      !reviewed ||
      contextKey(reviewed.context) !== contextKey(context) ||
      context.sensitive ||
      reviewed.proposal.expiresAt <= Date.now()
    )
      throw new Error("Review this action again from the current screen");
    if (isClockHandoffOperation(reviewed.proposal.operation))
      assertClockHandoffTimeZone(reviewed.proposal.operation, context.timeZone);
    if (isNativeNotesQuery(reviewed.proposal.operation))
      assertNotesQueryContext(context);
    this.busy = true;
    this.proposals.delete(proposalId);
    const p = reviewed.proposal,
      operationId = isSmsSend(p.operation) ? p.id : crypto.randomUUID();
    let execution: ReturnType<typeof createDeviceActionExecution> | undefined;
    try {
      execution = createDeviceActionExecution(
        { scope: this.scope, proposalId, operationId },
        signal,
        () => assertProposalContext(p.operation, context, this.profile),
      );
      if (p.workflow) {
        if (!reviewed.workflowReview)
          throw new Error("Workflow step must be reviewed from its execution");
        this.assertWorkflow(reviewed.workflowReview, p);
      }
      execution.assertPrepared();
      const reserved = await this.journal.reserve({
        scope: this.scope,
        proposalId,
        operationId,
        operationHash: await actionScope(JSON.stringify(p.operation)),
        record: {
          digest: p.digest,
          operation: p.operation,
          context,
          expiresAt: p.expiresAt,
          installationId: this.credential.installationId,
          enrollmentId: this.credential.enrollmentId,
          sessionId: this.session.sessionId,
          ownerId: this.session.ownerId,
          agentId: this.session.agentId,
          origin: this.session.origin,
          ...(p.workflow ? { workflow: p.workflow } : {}),
        },
      });
      if (!reserved.created)
        return {
          proposalId,
          status: "unknown",
          summary:
            "This action already has a device journal entry. Review action history; it was not repeated.",
        };
      execution.assertIdentity(reserved.entry);
      execution.assertPrepared();
      await this.mutation(p, "decision", { decision: "approve" }, signal);
      const claimed = await this.mutation(p, "claim", {}, signal);
      if (
        isSmsSend(p.operation) &&
        claimed.providerIdempotencyKey !== operationId
      )
        throw Error("SMS execution claim identity changed");
      if (!claimed.attemptId || claimed.state !== "executing")
        throw new Error("The server did not grant an execution claim");
      execution.assertPrepared();
      await this.journal.markApplying({
        scope: this.scope,
        proposalId,
        attemptId: claimed.attemptId,
      });
      let result: ExecutionResult;
      try {
        signal.throwIfAborted();
        if (p.expiresAt <= Date.now()) throw new Error("Expired action");
        const bindingHash = await this.bindingHash(
          this.session.sessionId,
          p,
          operationId,
        );
        execution.markDispatched(reserved.entry);
        const journalIdentity = { scope: this.scope, proposalId: p.id };
        if (isForegroundReviewOperation(p.operation)) {
          if (!this.ports.executeForeground)
            throw Error("Foreground review is unavailable");
          result = await this.ports.executeForeground(
            p.operation,
            operationId,
            context,
            signal,
            bindingHash,
            journalIdentity,
            this.credential.capabilities ?? [],
          );
        } else
          result = await this.ports.execute(
            p.operation,
            operationId,
            context,
            signal,
            bindingHash,
            p.workflow
              ? {
                  scope: this.scope,
                  origin: this.session.origin,
                  ownerId: this.session.ownerId,
                  agentId: this.session.agentId,
                  workflowId: p.workflow.workflowId,
                  runId: p.workflow.runId,
                  versionId: p.workflow.versionId,
                }
              : undefined,
            journalIdentity,
            p.calendarAgendaSource,
          );
      } catch {
        result = {
          status: "unknown",
          summary:
            "Action outcome needs review. It will not be repeated automatically.",
        };
      }
      const typed = await this.typedResults(p, result, operationId, context);
      await this.journal.finish({
        scope: this.scope,
        proposalId,
        status: result.status,
        summary: result.summary,
        result: { operationId, ...definedResults(typed) },
      });
      if (execution.dispatched) execution.settle(reserved.entry);
      // A completed device effect is journaled even if the UI epoch was cancelled.
      // Receipt upload is retried only by the explicit history control.
      const committedChanges: DeviceCommittedChange[] = [];
      if (result.status === "succeeded") {
        const op = p.operation;
        if (
          isCalendarOperation(op) &&
          op.type !== "calendar_read_selected" &&
          op.type !== "calendar_read_next"
        )
          committedChanges.push("calendar");
        if (isNotesOperation(op)) committedChanges.push("notes");
        if (
          isReminderOperation(op) ||
          isReminderCreate(op) ||
          op.type === "create_reminder"
        )
          committedChanges.push("reminders");
        const fg = typed.foregroundResult;
        if (
          fg &&
          "operation" in fg &&
          !(fg.kind === "calendar_named" && fg.action === "read")
        )
          committedChanges.push(
            fg.kind === "notes_named"
              ? "notes"
              : fg.kind === "calendar_named"
                ? "calendar"
                : "reminders",
          );
      }
      // Presentation changes the foreground context and cancels its approval.
      // Run it only after this exact action's receipt attempt, never as a retry.
      const presentBrowser = () => {
        if (
          p.operation.type === "browser_navigate" &&
          result.status === "succeeded"
        ) {
          try {
            result.presentBrowser?.();
          } catch {
            /* A retired foreground must not replace a journaled outcome. */
          }
        }
      };
      let confirmed: DeviceProposal;
      try {
        if (isMapsOperation(p.operation))
          assertMapsContext(p.operation, context, this.profile);
        confirmed = await this.mutation(
          p,
          "receipt",
          {
            attemptId: claimed.attemptId,
            receipt: {
              outcome: receiptOutcome(result.status),
              operationId,
              ...receiptResult(typed),
            },
          },
          signal,
        );
      } catch {
        presentBrowser();
        return {
          proposalId,
          status: result.status,
          summary: `${result.summary} Server receipt is pending; check action history.`,
          committedChanges,
        };
      }
      presentBrowser();
      const retained = this.readReplies.get(proposalId);
      const fg = typed.foregroundResult;
      const readReply =
        result.status === "succeeded" &&
        isOriginalDeviceReadOperationType(p.operation.type) &&
        (typed.notesResult ||
          typed.calendarResult ||
          typed.reminderResult ||
          typed.mapsResult ||
          typed.readResult ||
          fg?.kind === "calendar_availability" ||
          (fg?.kind === "calendar_named" && fg.action === "read")) &&
        p.readReplyOrigin &&
        confirmed.state === "done" &&
        confirmed.attemptId === claimed.attemptId &&
        retained &&
        !retained.consumed &&
        retained.digest === p.digest &&
        JSON.stringify(retained.origin) === JSON.stringify(p.readReplyOrigin)
          ? validateNativeNotesReadReplyHint({
              ...p.readReplyOrigin,
              proposalId,
              digest: p.digest,
              attemptId: claimed.attemptId,
            })
          : undefined;
      if (readReply && retained) retained.hint = readReply;
      return {
        proposalId,
        status: result.status,
        summary: result.summary,
        committedChanges,
        ...(readReply ? { readReply } : {}),
      };
    } catch {
      return {
        proposalId,
        status: "unknown",
        summary:
          "Action did not reach a confirmed result. Check action history before requesting it again.",
      };
    } finally {
      execution?.retire();
      this.busy = false;
    }
  }
  async completeReadReply(
    hint: NativeNotesReadReplyHint,
    signal: AbortSignal,
  ): Promise<NativeNotesReadReply> {
    const valid = validateNativeNotesReadReplyHint(hint),
      retained = this.readReplies.get(valid.proposalId);
    if (
      !retained ||
      retained.consumed ||
      JSON.stringify(retained.hint) !== JSON.stringify(valid)
    )
      throw Error(
        "This original Notes answer is unavailable. Check conversation history.",
      );
    signal.throwIfAborted();
    retained.consumed = true;
    const response = object(
      await this.request(
        `/api/client-devices/proposals/${valid.proposalId}/read-completion`,
        valid,
        signal,
      ),
    );
    signal.throwIfAborted();
    const reply = validateNativeNotesReadReply(response.reply);
    if (
      reply.requestId !== valid.requestId ||
      reply.conversationId !== valid.conversationId ||
      reply.inReplyTo !== valid.inReplyTo ||
      reply.messageId === valid.inReplyTo
    )
      throw Error(
        "The original Notes answer changed. Check conversation history.",
      );
    return reply;
  }
  async cancelReadReply(
    proposalId: string,
    digest: string,
    signal: AbortSignal,
  ): Promise<void> {
    const retained = this.readReplies.get(proposalId);
    if (!retained || retained.digest !== digest) return;
    retained.consumed = true;
    signal.throwIfAborted();
    await this.request(
      `/api/client-devices/proposals/${proposalId}/cancel-read-completion`,
      { digest },
      signal,
    );
  }
  async reject(proposalId: string, signal: AbortSignal): Promise<void> {
    const p = (await this.list(signal)).find((item) => item.id === proposalId);
    if (!p || p.state !== "pending")
      throw new Error("This proposal can no longer be rejected");
    await this.mutation(p, "decision", { decision: "reject" }, signal);
    this.proposals.delete(proposalId);
  }
  /** Reconstruct only committed Notes-create, calendar-write and browser-open acknowledgments for fetched user messages.
   * Both the authenticated server receipt and this device's exact journal must agree. */
  async conversationReceipts(
    requestMessageIds: ReadonlySet<string>,
    signal: AbortSignal,
  ): Promise<
    Array<{
      id: string;
      requestMessageId: string;
      summary: string;
      browserDestination?: string;
    }>
  > {
    if (!requestMessageIds.size) return [];
    const proposals = await this.list(signal);
    signal.throwIfAborted();
    const results: Array<{
      id: string;
      requestMessageId: string;
      summary: string;
      browserDestination?: string;
    }> = [];
    for (const p of proposals) {
      const op = p.operation;
      if (
        p.workflow ||
        p.state !== "done" ||
        !p.requestMessageId ||
        !requestMessageIds.has(p.requestMessageId) ||
        !(
          op.type === "create_note" ||
          op.type === "browser_navigate" ||
          ([
            "calendar_create",
            "calendar_create_local",
            "calendar_update",
            "calendar_delete",
          ].includes(op.type) &&
            isCalendarOperation(op))
        )
      )
        continue;
      try {
        const receipt = object(p.providerReceipt),
          { entry } = await this.journal.get({
            scope: this.scope,
            proposalId: p.id,
          });
        signal.throwIfAborted();
        if (
          receipt.outcome !== "applied" ||
          !entry ||
          entry.scope !== this.scope ||
          entry.phase !== "terminal" ||
          entry.status !== "succeeded" ||
          !p.attemptId ||
          entry.attemptId !== p.attemptId ||
          !this.ownEntry(entry, p) ||
          typeof entry.record.sessionId !== "string" ||
          !this.ownDevice(entry) ||
          receipt.operationId !== entry.operationId ||
          entry.result?.operationId !== entry.operationId ||
          entry.operationHash !== (await actionScope(JSON.stringify(op)))
        )
          continue;
        if (isCalendarOperation(op)) {
          const server = validateCalendarResult(op, receipt.result),
            saved = validateCalendarResult(op, entry.result?.calendarResult);
          if (JSON.stringify(server) !== JSON.stringify(saved)) continue;
        } else if (
          op.type === "create_note" ||
          op.type === "browser_navigate"
        ) {
          // These operations return no typed record result. Restore only
          // this exact terminal journal's acknowledgment, never infer a new effect.
          if (
            JSON.stringify(entry.record.operation) !== JSON.stringify(op) ||
            receipt.result !== undefined ||
            entry.result?.notesResult !== undefined
          )
            continue;
        } else continue;
        results.push({
          id: `device-receipt:${p.id}`,
          requestMessageId: p.requestMessageId,
          summary:
            op.type === "browser_navigate"
              ? this.profile.browserNavigationSummary(op.url)
              : text(entry.summary, 2000),
          ...(op.type === "browser_navigate"
            ? { browserDestination: op.url }
            : {}),
        });
      } catch {
        /* An incomplete, foreign or contradictory receipt is not a success. */
      }
    }
    signal.throwIfAborted();
    return results;
  }
  async history(signal: AbortSignal) {
    const proposals = await this.list(signal),
      local = await this.journal.list({ scope: this.scope });
    return proposals.map((p) => ({
      id: p.id,
      state: p.state,
      operation: p.operation,
      local: local.entries.find((entry) => entry.proposalId === p.id),
    }));
  }
  private async recoverNotification(
    p: DeviceProposal,
    entry: DeviceJournalEntry,
    signal: AbortSignal,
  ): Promise<DeviceJournalEntry> {
    if (p.operation.type !== "post_notification") return entry;
    if (!p.workflow) throw Error("Notification workflow binding is missing");
    if (
      entry.scope !== this.scope ||
      entry.proposalId !== p.id ||
      entry.attemptId !== p.attemptId ||
      !this.ownEntry(entry, p) ||
      !this.ownDevice(entry) ||
      typeof entry.record.sessionId !== "string" ||
      JSON.stringify(entry.record.workflow) !== JSON.stringify(p.workflow) ||
      (await actionScope(JSON.stringify(p.operation))) !== entry.operationHash
    )
      throw Error("Notification recovery identity changed");
    const bindingHash = await this.bindingHash(
      entry.record.sessionId,
      p,
      entry.operationId,
    );
    if (
      !this.journal.recoverNotification ||
      entry.status === "succeeded" ||
      !entry.attemptId ||
      (entry.phase !== "applying" &&
        !(entry.phase === "terminal" && entry.status === "unknown"))
    )
      return entry;
    signal.throwIfAborted();
    const recovered = await this.journal.recoverNotification({
      scope: this.scope,
      proposalId: p.id,
      bindingHash,
    });
    signal.throwIfAborted();
    const next = recovered.entry;
    if (!next) return entry;
    assertSameAttempt(next, entry, "Recovered notification identity changed");
    if (
      next.status === "succeeded" &&
      (next.phase !== "terminal" ||
        next.result?.operationId !== entry.operationId)
    )
      throw Error("Recovered notification result changed");
    return next;
  }
  private async recoverDeletion(
    p: DeviceProposal,
    entry: DeviceJournalEntry,
    signal: AbortSignal,
  ): Promise<DeviceJournalEntry> {
    if (
      !this.journal.recoverDeletion ||
      !["calendar_delete", "reminder_cancel"].includes(p.operation.type) ||
      entry.status === "succeeded" ||
      entry.status === "failed" ||
      !entry.attemptId ||
      !this.ownEntry(entry, p) ||
      !this.ownDevice(entry)
    )
      return entry;
    signal.throwIfAborted();
    const { entry: next } = await this.journal.recoverDeletion({
      scope: this.scope,
      proposalId: p.id,
    });
    signal.throwIfAborted();
    if (!next) return entry;
    assertSameAttempt(next, entry, "Recovered deletion identity changed");
    if (next.status === "succeeded") {
      if (
        next.phase !== "terminal" ||
        next.result?.operationId !== entry.operationId
      )
        throw Error("Recovered deletion result changed");
      if (isReminderOperation(p.operation))
        validateReminderResult(p.operation, next.result?.reminderResult);
      else if (isCalendarOperation(p.operation))
        validateCalendarResult(p.operation, next.result?.calendarResult);
    }
    return next;
  }
  private async recoverReminder(
    p: DeviceProposal,
    entry: DeviceJournalEntry,
    signal: AbortSignal,
  ): Promise<DeviceJournalEntry> {
    const op = p.operation;
    if (
      !this.ports.recover ||
      !(isReminderOperation(op) || isReminderCreate(op)) ||
      entry.status === "succeeded" ||
      !entry.attemptId ||
      !this.ownEntry(entry, p) ||
      !this.ownDevice(entry) ||
      typeof entry.record.sessionId !== "string"
    )
      return entry;
    const bindingHash = await this.bindingHash(
      entry.record.sessionId,
      p,
      entry.operationId,
    );
    signal.throwIfAborted();
    const result = await this.ports.recover(
      op,
      entry.operationId,
      bindingHash,
      signal,
    );
    signal.throwIfAborted();
    if (result.status !== "succeeded") return entry;
    const validate = (value: unknown) =>
      isReminderCreate(op)
        ? validateReminderCreateResult(op, value, entry.operationId)
        : validateReminderResult(op as ReminderOperation, value);
    validate(result.reminderResult);
    if (!this.journal.recoverReminder) return entry;
    const recovered = await this.journal.recoverReminder({
      scope: this.scope,
      proposalId: p.id,
      bindingHash,
    });
    if (recovered.entry?.status === "succeeded")
      validate(recovered.entry.result?.reminderResult);
    return recovered.entry ?? entry;
  }
  private async recoverEntry(
    p: DeviceProposal,
    entry: DeviceJournalEntry,
    signal: AbortSignal,
  ): Promise<DeviceJournalEntry> {
    let next = await this.recoverDeletion(p, entry, signal);
    next = await this.recoverNotification(p, next, signal);
    return this.recoverReminder(p, next, signal);
  }
  /** Uploads exact journaled receipts. Never re-executes; unknown stays unknown. */
  async syncReceipts(
    signal: AbortSignal,
    workflow?: { runId: string; versionId: string; specDigest: string },
  ): Promise<void> {
    const proposals = await this.list(signal),
      local = await this.journal.list({ scope: this.scope });
    const otherWorkflow = (p: DeviceProposal) =>
      !!p.workflow &&
      (!workflow ||
        p.workflow.runId !== workflow.runId ||
        p.workflow.versionId !== workflow.versionId ||
        p.workflow.specDigest !== workflow.specDigest);
    for (let entry of local.entries) {
      signal.throwIfAborted();
      const p = proposals.find((item) => item.id === entry.proposalId);
      if (p) {
        if (otherWorkflow(p)) continue;
        entry = await this.recoverEntry(p, entry, signal);
      }
      if (
        p &&
        isSmsSend(p.operation) &&
        entry.status === "unknown" &&
        ["done", "retryable"].includes(p.state)
      )
        continue;
      if (
        !p ||
        entry.phase !== "terminal" ||
        !entry.attemptId ||
        entry.record.digest !== p.digest ||
        !entry.status
      )
        continue;
      if (otherWorkflow(p)) continue;
      const saved = await this.savedResults(p, entry);
      if (
        p.state === "reconciliation_required" &&
        entry.status === "succeeded" &&
        (((isReminderOperation(p.operation) || isReminderCreate(p.operation)) &&
          saved.reminderResult) ||
          p.operation.type === "post_notification")
      ) {
        await this.mutation(
          p,
          "reconciliation",
          {
            attemptId: entry.attemptId,
            resolution: {
              confirmed: true,
              outcome: "applied",
              operationId: entry.operationId,
              ...(saved.reminderResult ? { result: saved.reminderResult } : {}),
            },
          },
          signal,
        );
      } else
        await this.mutation(
          p,
          "receipt",
          {
            attemptId: entry.attemptId,
            receipt: {
              outcome: receiptOutcome(entry.status),
              operationId: entry.operationId,
              ...receiptResult(saved),
            },
          },
          signal,
        );
    }
  }
  private async savedResults(p: DeviceProposal, entry: DeviceJournalEntry) {
    return {
      smsResult: await this.savedSmsResult(p, entry),
      clockResult: await this.savedClockResult(p, entry),
      mapsResult: await this.savedMapsResult(p, entry),
      cameraResult: await this.savedCameraResult(p, entry),
      photoLibraryResult: await this.savedLibraryResult(p, entry),
      readResult: await this.savedReadResult(p, entry),
      calendarResult: await this.savedCalendarResult(p, entry),
      notesResult: await this.savedNotesResult(p, entry),
      reminderResult: await this.savedReminderResult(p, entry),
      foregroundResult: await this.savedForegroundResult(p, entry),
    };
  }
  /** Exact terminal journal entry for this proposal and attempt, or a refusal. */
  private async savedEntry(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
    refusal: string,
    rules: { succeeded?: boolean; device?: boolean; session?: boolean } = {},
  ): Promise<DeviceJournalEntry> {
    const { entry } = await this.journal.get({
      scope: this.scope,
      proposalId: p.id,
    });
    if (
      !entry ||
      entry.phase !== "terminal" ||
      (rules.succeeded && entry.status !== "succeeded") ||
      entry.operationId !== summary.operationId ||
      !this.ownEntry(entry, p) ||
      (rules.device && !this.ownDevice(entry)) ||
      (rules.session && entry.record.sessionId !== this.session.sessionId)
    )
      throw Error(refusal);
    return entry;
  }
  private async savedSmsResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<SmsSendResult | undefined> {
    const op = p.operation;
    if (!isSmsSend(op)) return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved SMS receipt; the message will not be repeated",
      { device: true },
    );
    if (
      entry.operationId !== p.id ||
      p.providerIdempotencyKey !== entry.operationId
    )
      throw Error(
        "No exact saved SMS receipt; the message will not be repeated",
      );
    if (entry.result?.smsResult === undefined) {
      if (entry.status !== "unknown") throw Error("Missing saved SMS evidence");
      return undefined;
    }
    const result = validateSmsResult(
      op,
      entry.result.smsResult,
      entry.operationId,
      await smsAgentHash(op),
    );
    if (entry.status !== smsDeviceStatus(result))
      throw Error("Saved SMS outcome mismatch");
    return result;
  }
  /** Explicit owner reconciliation may read newer durable native evidence, never dispatch again. */
  private async smsReconciliationResult(
    p: DeviceProposal,
    entry: DeviceJournalEntry,
    signal: AbortSignal,
  ): Promise<SmsSendResult | undefined> {
    const op = p.operation;
    if (!isSmsSend(op)) return undefined;
    if (
      entry.operationId !== p.id ||
      p.providerIdempotencyKey !== p.id ||
      entry.attemptId !== p.attemptId ||
      !this.ownEntry(entry, p) ||
      !this.ownDevice(entry) ||
      entry.operationHash !== (await actionScope(JSON.stringify(op)))
    )
      throw Error("SMS reconciliation identity changed");
    const historical =
      entry.phase === "terminal"
        ? await this.savedSmsResult(p, entry)
        : undefined;
    if (historical && smsDeviceStatus(historical) !== "unknown")
      return historical;
    if (!this.ports.recover) return historical;
    signal.throwIfAborted();
    const read = await this.ports.recover(
      op,
      entry.operationId,
      await smsAgentHash(op),
      signal,
    );
    signal.throwIfAborted();
    if (read.smsResult === undefined) return historical;
    const result = validateSmsResult(
      op,
      read.smsResult,
      entry.operationId,
      await smsAgentHash(op),
    );
    if (read.status !== smsDeviceStatus(result))
      throw Error("Reconciled SMS outcome mismatch");
    return result;
  }
  private async savedClockResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<ClockHandoffResult | undefined> {
    const op = p.operation;
    if (!isClockHandoffOperation(op)) return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved Clock receipt; handoff will not be repeated",
      { device: true },
    );
    if (entry.result?.clockResult === undefined) {
      if (entry.status === "succeeded") throw Error("Missing Clock receipt");
      return undefined;
    }
    const result = clockHandoffReceipt(op, entry.result.clockResult);
    const status =
      result.status === "opened"
        ? "succeeded"
        : result.status === "unknown"
          ? "unknown"
          : "failed";
    if (entry.status !== status) throw Error("Saved Clock outcome mismatch");
    return result;
  }
  private async savedCameraResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<CameraCaptureResult | undefined> {
    if (!isCameraCapture(p.operation) || summary.status !== "succeeded")
      return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved photo receipt; capture will not be repeated",
      { succeeded: true, device: true },
    );
    return validateCameraCaptureResult(
      entry.result?.cameraResult,
      entry.operationId,
    );
  }
  private async savedMapsResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<MapsResult | undefined> {
    const op = p.operation;
    if (!isMapsOperation(op) || summary.status !== "succeeded")
      return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved Maps receipt; the selection will not be read again",
      { succeeded: true, device: true, session: true },
    );
    // Replay only the already approved snapshot while its current capability is
    // still valid. Reload/leave does not authorize a fresh read or late upload.
    assertMapsContext(
      op,
      entry.record.context as DeviceContextEnvelope,
      this.profile,
    );
    return validateMapsResult(op, entry.result?.mapsResult);
  }
  private async savedLibraryResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<LibraryAgentResult | undefined> {
    const op = p.operation;
    if (!isLibraryOperation(op) || summary.status !== "succeeded")
      return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved library receipt; the library will not be read again",
      { succeeded: true },
    );
    return validateLibraryResult(op, entry.result?.photoLibraryResult);
  }
  private async savedCalendarResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<CalendarResult | undefined> {
    const op = p.operation;
    if (!isCalendarOperation(op) || summary.status !== "succeeded")
      return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved Calendar receipt; operation will not be repeated",
      { succeeded: true },
    );
    return validateCalendarResult(op, entry.result?.calendarResult);
  }
  private async savedReminderResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<ReminderResult | ReminderCreateResult | undefined> {
    const op = p.operation;
    if (
      !(isReminderOperation(op) || isReminderCreate(op)) ||
      summary.status !== "succeeded"
    )
      return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved Reminder receipt; operation will not be repeated",
      { succeeded: true },
    );
    return isReminderCreate(op)
      ? validateReminderCreateResult(
          op,
          entry.result?.reminderResult,
          entry.operationId,
        )
      : validateReminderResult(
          op as ReminderOperation,
          entry.result?.reminderResult,
        );
  }
  private async savedNotesResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<NotesResult | NotesQueryResult | undefined> {
    const op = p.operation;
    if (
      (!isNotesOperation(op) && !isNativeNotesQuery(op)) ||
      summary.status !== "succeeded"
    )
      return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved Notes receipt; operation will not be repeated",
      { succeeded: true },
    );
    return isNativeNotesQuery(op)
      ? validateNotesQueryResult(op, entry.result?.notesResult)
      : validateNotesResult(op as NotesOperation, entry.result?.notesResult);
  }
  private async savedForegroundResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<ForegroundReviewResult | undefined> {
    const op = p.operation;
    if (!isForegroundReviewOperation(op) || summary.status !== "succeeded")
      return undefined;
    const entry = await this.savedEntry(
      p,
      summary,
      "No exact saved review receipt; the phone will not read or change anything again",
      { succeeded: true },
    );
    return validateForegroundReviewResult(op, entry.result?.foregroundResult);
  }
  private async savedReadResult(
    p: DeviceProposal,
    summary: DeviceJournalEntry,
  ): Promise<WorkflowReadResult | undefined> {
    const op = p.operation;
    if (op.type !== "read_selected_notes" && op.type !== "read_calendar_range")
      return undefined;
    if (summary.status !== "succeeded") return undefined;
    const refusal =
      "No exact saved read receipt is available; the source will not be read again";
    const entry = await this.savedEntry(p, summary, refusal, {
      succeeded: true,
    });
    if (JSON.stringify(entry.record.workflow) !== JSON.stringify(p.workflow))
      throw new Error(refusal);
    return this.profile.workflow.validateResult(op, entry.result?.readResult);
  }
  /** Owner-confirmed reconciliation of a dispatched action from exact saved evidence. */
  async reconcile(
    proposalId: string,
    outcome: "applied" | "not_applied",
    signal: AbortSignal,
  ): Promise<void> {
    const p = (await this.list(signal)).find((item) => item.id === proposalId);
    if (!p?.attemptId) throw new Error("No dispatched action to reconcile");
    const op = p.operation;
    let { entry } = await this.journal.get({ scope: this.scope, proposalId });
    const applied = outcome === "applied";
    if (entry && applied) entry = await this.recoverEntry(p, entry, signal);
    if (
      applied &&
      op.type === "post_notification" &&
      (!entry || entry.phase !== "terminal" || entry.status !== "succeeded")
    )
      throw Error(
        "Applied notification reconciliation requires its exact saved delivery receipt",
      );
    const smsResult = entry
      ? await this.smsReconciliationResult(p, entry, signal)
      : undefined;
    if (
      isSmsSend(op) &&
      (!smsResult ||
        smsDeviceStatus(smsResult) === "unknown" ||
        applied !== (smsDeviceStatus(smsResult) === "succeeded"))
    )
      throw Error(
        "SMS reconciliation requires exact saved evidence; unknown or partial sends cannot be called not sent",
      );
    const clockResult = entry
      ? await this.savedClockResult(p, entry)
      : undefined;
    if (
      isClockHandoffOperation(op) &&
      (!clockResult ||
        clockResult.status === "unknown" ||
        applied !== (clockResult.status === "opened"))
    )
      throw Error(
        "Clock reconciliation requires the exact saved handoff result; alarm state cannot be inferred",
      );
    const saved = <T>(read: () => Promise<T>) =>
      applied && entry ? read() : Promise.resolve(undefined);
    const e = entry as DeviceJournalEntry;
    const mapsResult = await saved(() => this.savedMapsResult(p, e));
    if (applied && isMapsOperation(op) && !mapsResult)
      throw Error("Applied Maps read requires exact saved receipt");
    const cameraResult = await saved(() => this.savedCameraResult(p, e));
    if (applied && isCameraCapture(op) && !cameraResult)
      throw Error(
        "Applied camera capture requires its exact saved photo receipt",
      );
    const photoLibraryResult = await saved(() => this.savedLibraryResult(p, e));
    if (applied && isLibraryOperation(op) && !photoLibraryResult)
      throw Error("Applied library action requires its exact saved receipt");
    const readResult = await saved(() => this.savedReadResult(p, e));
    const calendarResult = await saved(() => this.savedCalendarResult(p, e));
    const notesResult = await saved(() => this.savedNotesResult(p, e));
    const reminderResult = await saved(() => this.savedReminderResult(p, e));
    const foregroundResult = await saved(() =>
      this.savedForegroundResult(p, e),
    );
    if (applied && isForegroundReviewOperation(op) && !foregroundResult)
      throw Error(
        "Applied review reconciliation requires its exact saved receipt",
      );
    if (
      applied &&
      (isReminderOperation(op) || isReminderCreate(op)) &&
      !reminderResult
    )
      throw Error(
        "Applied reminder reconciliation requires exact saved receipt",
      );
    if (
      applied &&
      (isNotesOperation(op) || isNativeNotesQuery(op)) &&
      !notesResult
    )
      throw Error(
        "Applied Notes reconciliation requires its exact saved receipt",
      );
    if (applied && isCalendarOperation(op) && !calendarResult)
      throw Error(
        "Applied Calendar reconciliation requires exact saved provider receipt",
      );
    if (
      applied &&
      (op.type === "read_selected_notes" ||
        op.type === "read_calendar_range") &&
      !readResult
    )
      throw new Error("Applied read requires its exact saved result");
    await this.mutation(
      p,
      "reconciliation",
      {
        attemptId: p.attemptId,
        resolution: {
          confirmed: true,
          outcome,
          ...((applied || isClockHandoffOperation(op) || isSmsSend(op)) && entry
            ? { operationId: entry.operationId }
            : {}),
          ...receiptResult({
            smsResult,
            foregroundResult,
            clockResult,
            mapsResult,
            cameraResult,
            photoLibraryResult,
            readResult,
            calendarResult,
            notesResult,
            reminderResult,
          }),
        },
      },
      signal,
    );
  }
}

type TypedResults = {
  smsResult?: SmsSendResult;
  clockResult?: ClockHandoffResult;
  mapsResult?: MapsResult;
  cameraResult?: CameraCaptureResult;
  photoLibraryResult?: LibraryAgentResult;
  readResult?: WorkflowReadResult;
  calendarResult?: CalendarResult;
  notesResult?: NotesResult | NotesQueryResult;
  reminderResult?: ReminderResult | ReminderCreateResult;
  foregroundResult?: ForegroundReviewResult;
};
function receiptOutcome(
  status: NonNullable<DeviceJournalEntry["status"]>,
): "applied" | "failed" | "unknown" {
  return status === "succeeded"
    ? "applied"
    : status === "failed"
      ? "failed"
      : "unknown";
}
/** The one typed result a receipt carries, in a fixed precedence. */
function receiptResult(results: TypedResults): CommittedReceiptResult {
  const value =
    results.smsResult ??
    results.foregroundResult ??
    results.clockResult ??
    results.mapsResult ??
    results.cameraResult ??
    results.photoLibraryResult ??
    results.readResult ??
    results.calendarResult ??
    results.notesResult ??
    results.reminderResult;
  return value === undefined ? {} : { result: value };
}
/** Journal result fields; undefined entries are omitted. */
function definedResults(results: TypedResults): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(results).filter(([, value]) => value !== undefined),
  );
}
function assertSameAttempt(
  next: DeviceJournalEntry,
  entry: DeviceJournalEntry,
  message: string,
) {
  if (
    next.operationId !== entry.operationId ||
    next.operationHash !== entry.operationHash ||
    next.attemptId !== entry.attemptId ||
    JSON.stringify(next.record) !== JSON.stringify(entry.record)
  )
    throw Error(message);
}
