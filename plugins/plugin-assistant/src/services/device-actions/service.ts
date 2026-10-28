import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CALENDAR_AVAILABILITY_CAPABILITY,
  CALENDAR_NAMED_READ_CAPABILITY,
  NAMED_TARGET_CAPABILITY,
  NOTES_SEARCH_CAPABILITY,
} from "@elizaos/contracts";
import type { NativeNotesDeferredRead } from "@elizaos/contracts/native-notes-query";
import {
  isNativeNotesQuery,
  type NativeNotesReadReply,
  type NativeNotesReadReplyOrigin,
  NOTES_QUERY_CAPABILITY,
  validateNativeNotesQuery,
  validateNativeNotesReadReply,
} from "@elizaos/contracts/native-notes-query";
import type { ContextObject, IAgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  conversationClientUserMemoryId,
  getStreamingContext,
  getTurnActionConstraint,
  readDurableConversationChatMarker,
  registerDirectActionRoutingRule,
  stableStringify,
  withActionGatePolicy,
} from "@elizaos/core";
import { originalAvailabilityWindow } from "../../../../plugin-calendar/src/internal/original-availability.ts";
import {
  type ReviewedAvailabilityRequest,
  validateReviewedAvailabilityRequest,
} from "../../../../plugin-calendar/src/internal/reviewed-availability.ts";
import {
  executeRawSqlTx,
  sqlText,
  type TransactionalDb,
} from "../approval/sql.ts";
import { PgApprovalQueue } from "../approval/store.ts";
import type {
  ApprovalEnqueueResult,
  ApprovalRequest,
} from "../approval/types.ts";
import type { CalendarFields } from "./calendar-contract.ts";
import {
  CALENDAR_AGENDA_CAPABILITY,
  CALENDAR_CAPABILITY,
  CALENDAR_CREATE_CAPABILITY,
  CALENDAR_NEXT_CAPABILITY,
  type CalendarSource,
  calendarCapabilityAvailable,
  calendarSource,
  isCalendarOperation,
  validateCalendarOperation,
  validateCalendarResult,
} from "./calendar-contract.ts";
import {
  calendarTimeUpdateAfterReadPlan,
  calendarUpdateAfterReadPlan,
  originalRequestsCalendarTimeUpdate,
  wholeSelectedCalendarTimeRequest,
} from "./calendar-update-continuation.ts";
import {
  CAMERA_CAPTURE_CAPABILITY,
  isCameraCapture,
  validateCameraCaptureResult,
} from "./camera-contract.ts";
import {
  assertClockObservation,
  CLOCK_ALARMS_CAPABILITY,
  CLOCK_CAPABILITY,
  CLOCK_REPEAT_CAPABILITY,
  clockCapabilityAvailable,
  isClockOperation,
  validateClockResult,
} from "./clock-contract.ts";
import {
  DeviceActionError,
  type DeviceActionPayload,
  deviceOperationSupportedByCapabilities,
  exactKeys,
  identifier,
  object,
  text,
  validateDeviceOperation,
  validateDevicePayload,
} from "./contract.ts";
import {
  FOREGROUND_REVIEW_TYPES,
  foregroundReviewOperationAvailable,
  isForegroundReviewOperation,
  validateForegroundReviewResult,
  validateForegroundReviewOperation as validateNamedCalendarRead,
} from "./foreground-review-contract.ts";
import {
  assertMapsObservation,
  isMapsOperation,
  MAPS_CAPABILITY,
  validateMapsResult,
} from "./maps-contract.ts";
import {
  isNotesOperation,
  NOTES_CAPABILITY,
  notesSelectionTarget,
  notesSource,
  validateNotesOperation,
  validateNotesResult,
} from "./notes-contract.ts";
import { notesDeleteAfterReadPlan } from "./notes-delete-continuation.ts";
import { originalRequestsNotesDeletion } from "./notes-delete-intent.ts";
import { validateNotesQueryResult } from "./notes-query-result.ts";
import { notesUpdateAfterReadPlan } from "./notes-update-continuation.ts";
import {
  assertDeviceReadCompletionCurrent,
  bindDeviceCompletion,
  captureDeviceReadReplyOrigin,
  completionHint,
  completionOrigin,
  completionReplyId,
  type DeviceReadCompletion,
  type DeviceReadCompletionHint,
  deviceReadHostContextRevision,
  deviceReadResult,
  isCompletableDeviceRead,
  isCompletableNotesRead,
  originalReadRequestMatches,
  readDeviceCompletion,
  synthesizeDeviceReadReply,
  transitionDeviceCompletion,
  withDeviceReadModelUsage,
} from "./read-completion.ts";
import {
  isReminderOperation,
  REMINDER_CAPABILITY,
  REMINDER_TIMING_CAPABILITY,
  reminderCapabilityAvailable,
  reminderTarget,
  validateReminderResult,
} from "./reminder-contract.ts";
import {
  isReminderCreate,
  REMINDER_CREATE_CAPABILITY,
  validateReminderCreateResult,
} from "./reminder-create-contract.ts";
import {
  isSmsSend,
  SMS_SEND_CAPABILITY,
  smsBindingText,
  smsReceiptOutcome,
  validateSmsResult,
} from "./sms-contract.ts";
import { requireTurnObservation, turnObservation } from "./turn-observation.ts";
import {
  type DeviceViewProfile,
  enabledDeviceViews,
  storedDeviceViewProfile,
} from "./view-profile.ts";
import {
  validateWorkflowBinding,
  validateWorkflowReadOperation,
  validateWorkflowReadResult,
  type WorkflowDeviceBinding,
  type WorkflowDeviceDispatch,
} from "./workflow-contract.ts";

export interface DeviceCredential {
  subjectUserId: string;
  installationId: string;
  deviceKey: string;
  capabilities?: readonly string[];
}
interface TransactionDatabase extends TransactionalDb {
  transaction<T>(fn: (tx: TransactionalDb) => Promise<T>): Promise<T>;
}
const NOTES_UPDATE_HOST = Symbol("original selected Notes update");
const CALENDAR_UPDATE_HOST = Symbol("original selected Calendar update");
const CALENDAR_AVAILABILITY_HOST = Symbol(
  "original device Calendar availability read",
);
const CALENDAR_AGENDA_HOST = Symbol("canonical Calendar feed read");
interface DeviceTurn {
  readonly isCurrent: () => boolean;
  requestPolicy?: {
    mode: "initial-gmail-send-v1" | "review-gmail-send-v1";
    clientMessageId: string;
  };
  readonly startedAt: number;
  runtime: IAgentRuntime;
  credential: DeviceCredential;
  active: boolean;
  viewProfile: DeviceViewProfile | null;
  requestCaller?: { subjectUserId: string; entityId: UUID; role: string };
  requestMessage?: {
    message: Memory;
    id: string;
    roomId: UUID;
    agentId: UUID;
    entityId: UUID;
  };
  replyContext?: { message: Memory; context: ContextObject };
  replyConversation?: { id: string; roomId: UUID };
  retainNotesRead?: (binding: NativeNotesDeferredRead) => void;
}
const turn = new AsyncLocalStorage<DeviceTurn>();
/** Guidance follows declared single-operation device tools; discovery still owns admission. */
export function deviceActionToolGuidance(
  runtime: Pick<IAgentRuntime, "actions">,
  capabilities: readonly string[] | undefined,
  message?: Memory,
): string {
  const currentTurn = getDeviceActionTurn();
  const notesRecords =
    currentTurn?.runtime === runtime
      ? currentAppRecordSource(currentTurn.runtime, "notes", message)
      : "runtime";
  const canonicalNotes = runtime.actions.some(
    (action) => action.name === "NOTES",
  );
  const calendarRecords =
    currentTurn?.runtime === runtime
      ? currentAppRecordSource(currentTurn.runtime, "calendar", message)
      : "runtime";
  const canonicalCalendar = runtime.actions.some(
    (action) => action.name === "CALENDAR",
  );
  const canonicalCalendarGuidance =
    canonicalCalendar && calendarRecords === "runtime"
      ? " Ordinary app Calendar requests use the canonical CALENDAR service, runtime store and conversation context. Enrolled Calendar capabilities do not redirect app records into a device proposal. "
      : "";
  const canonicalNotesGuidance =
    canonicalNotes && notesRecords === "runtime"
      ? " Ordinary app Notes use the canonical NOTES service and owner-scoped runtime store. Device note capabilities do not redirect ordinary Notes reads, creates, edits or deletions. "
      : "";
  const specialized = runtime.actions.flatMap((action) => {
    if (!action.egress?.includes("owner-device")) return [];
    const schema = action.parameters?.find(
      (parameter) => parameter.name === "operation",
    )?.schema;
    const branches = schema?.anyOf;
    if (!Array.isArray(branches) || branches.length !== 1) return [];
    const types = branches[0]?.properties?.type?.enum;
    return Array.isArray(types) &&
      types.length === 1 &&
      typeof types[0] === "string"
      ? [{ name: action.name, operation: types[0] }]
      : [];
  });
  const deviceActionTurn = getDeviceActionTurn();
  const current = specialized
    .filter(
      (item) =>
        deviceOperationSupportedByCapabilities(item.operation, capabilities) &&
        (!(
          item.operation === "create_note" ||
          item.operation.startsWith("notes_")
        ) ||
          !canonicalNotes ||
          notesRecords === "device") &&
        (!isCalendarOperation({ type: item.operation }) ||
          !canonicalCalendar ||
          calendarRecords === "device") &&
        (!isNotesOperation({ type: item.operation }) ||
          capabilities?.includes(NOTES_CAPABILITY)) &&
        (item.operation !== "notes_query" ||
          (capabilities?.includes(NOTES_QUERY_CAPABILITY) &&
            capabilities.includes(NOTES_CAPABILITY))) &&
        (!isCalendarOperation({ type: item.operation }) ||
          capabilities?.includes(CALENDAR_CAPABILITY)) &&
        (!item.operation.startsWith("reminder_") ||
          !runtime.actions.some(
            (action) => action.name === "OWNER_REMINDERS",
          ) ||
          (deviceActionTurn?.runtime === runtime &&
            currentReminderRecordSource(deviceActionTurn.runtime) ===
              "device")) &&
        (item.operation !== "reminder_create" ||
          capabilities?.includes(REMINDER_CREATE_CAPABILITY)) &&
        (![
          "reminder_read_selected",
          "reminder_update",
          "reminder_complete",
          "reminder_snooze",
          "reminder_cancel",
        ].includes(item.operation) ||
          capabilities?.some(
            (value) =>
              value === REMINDER_CAPABILITY ||
              value === REMINDER_TIMING_CAPABILITY,
          )),
    )
    .map((item) => item.name);
  if (current.length) {
    const namedNotesMutation =
      notesRecords === "device" &&
      runtime.actions.some(
        (action) =>
          action.name === "PROPOSE_DEVICE_ACTION" &&
          action.egress?.includes("owner-device"),
      ) &&
      deviceOperationSupportedByCapabilities("notes_named", capabilities)
        ? " For an explicit edit or delete of a device note named by the owner, use the existing PROPOSE_DEVICE_ACTION operation notes_named with action update or delete and that exact name. This canonical operation resolves the current local record and asks the owner to choose the exact target and approve its current revision. For updates, the host prepares the exact title lookup itself, then derives the requested patch from the original request and owner-shared current body before a separate update review. Do not invent full replacement fields or ask the owner to repeat the edit. Do not replace an outstanding mutation with a read-only reply or ask the owner to repeat the request. If the original reference has no unambiguous name or selected target, ask which note; never derive an opaque ID or revision. This permits only a proposal: user review and the native receipt still own the effect."
        : "";
    const selectedNotesEdit =
      notesRecords === "device" && current.includes("DEVICE_NOTE_UPDATE")
        ? " When the current typed selection kind is note and the owner asks to edit or append to it, use DEVICE_NOTE_UPDATE with only operation.type=notes_update. It reads that exact selected record after approval and prepares a separate requested-change review; do not replace this edit with an old-title lookup or a read-only answer. A read-only selected-note request still uses DEVICE_NOTE_READ."
        : "";
    const notesLookup =
      notesRecords === "device" &&
      current.includes("DEVICE_NOTES_QUERY") &&
      current.includes("DEVICE_NOTE_READ")
        ? " For a note requested by title without its exact selected note identity/revision, first discover DEVICE_NOTES_QUERY by exact name and query that title; then read using the returned selected source/record fields. Never guess note IDs or revisions or replace the available lookup with a manual-search request. A lookup result is metadata, not note body content."
        : "";
    return (
      "This host declares capability-specific device tools: " +
      JSON.stringify(current) +
      ". Choose the exact matching operation; if it is not loaded, discover that exact name or search by the requested operation. Do not substitute PROPOSE_DEVICE_ACTION for one of these declared single-operation tools. Discovery and execution still verify current capabilities and permissions." +
      canonicalNotesGuidance +
      selectedNotesEdit +
      notesLookup +
      namedNotesMutation +
      canonicalCalendarGuidance +
      (runtime.actions.some((action) => action.name === "OWNER_REMINDERS")
        ? " Ordinary reminders use the canonical OWNER_REMINDERS runtime-owned definition/occurrence store; the phone is a delivery surface. Device reminder tools apply only to an explicitly selected native reminder source/record. A phone capability alone does not change the store."
        : "") +
      (current.some((name) => name.startsWith("DEVICE_REMINDER_"))
        ? " Reminder tools act only on this device store. Selected operations require current typed source/record/occurrence IDs and revisions; preserve timingVersion. Never invent IDs or substitute backend reminder records. For update/cancel by title with missing IDs, use an available canonical reminder_named helper for owner selection, otherwise ask the owner to select the exact reminder. Proposal creation is not proof of saving or scheduling; use the native receipt status."
        : "")
    );
  }
  return (
    canonicalNotesGuidance +
    canonicalCalendarGuidance +
    (runtime.actions.some(
      (action) =>
        action.name === "PROPOSE_DEVICE_ACTION" &&
        action.egress?.includes("owner-device"),
    )
      ? "Only for explicit separate OS/device operations, use the currently authorized PROPOSE_DEVICE_ACTION schema for supported device operations; discover its exact name if needed. Discovery and execution still verify current capabilities and permissions."
      : "No native device operation tool is declared by this host. Use current authorized discovery; do not invent PROPOSE_DEVICE_ACTION availability.")
  );
}
export function getDeviceActionTurn(): DeviceTurn | undefined {
  const current = turn.getStore();
  return current?.active ? current : undefined;
}
/** Only the authenticated foreground HTTP parser may bind this command.
 * It is deliberately not read from persisted message metadata or model output. */
export function bindDeviceRequestedActionPolicy(
  runtime: IAgentRuntime,
  policy: unknown,
  clientMessageId: unknown,
): boolean {
  const current = getDeviceActionTurn();
  if (
    !current ||
    current.runtime !== runtime ||
    !current.isCurrent() ||
    current.requestPolicy ||
    !current.credential.capabilities?.includes("gmail.request-policy.v1") ||
    (policy !== "initial-gmail-send-v1" && policy !== "review-gmail-send-v1") ||
    typeof clientMessageId !== "string" ||
    !clientMessageId.trim() ||
    clientMessageId.length > 128
  )
    return false;
  current.requestPolicy = { mode: policy, clientMessageId };
  return true;
}
/** Current-turn authority is checked again immediately before the durable consent claim. */
export async function deviceGmailRequestConsent(
  runtime: IAgentRuntime,
  message: Memory,
  digest?: string,
): Promise<"legacy" | "review" | "denied"> {
  const current = turn.getStore(),
    policy = current?.requestPolicy;
  if (!policy) return "legacy";
  if (
    !current ||
    !current.active ||
    current.runtime !== runtime ||
    !current.isCurrent() ||
    !current.replyContext ||
    !current.replyConversation
  )
    return "denied";
  const original = current.replyContext.message;
  const marker = readDurableConversationChatMarker(
    original.content.chatIdempotency,
  );
  if (
    message.id !== original.id ||
    message.agentId !== runtime.agentId ||
    original.agentId !== runtime.agentId ||
    message.entityId !== original.entityId ||
    message.roomId !== original.roomId ||
    message.roomId !== current.replyConversation.roomId ||
    message.entityId !== current.credential.subjectUserId ||
    message.content.text !== original.content.text ||
    !message.createdAt ||
    message.createdAt < current.startedAt ||
    !marker ||
    marker.clientMessageId !== policy.clientMessageId ||
    conversationClientUserMemoryId(marker.scope, marker.clientMessageId) !==
      message.id
  )
    return "denied";
  await new DeviceActionService(runtime).viewProfile(current.credential);
  if (
    !current.active ||
    !current.isCurrent() ||
    getDeviceActionTurn() !== current
  )
    return "denied";
  // Generic preferences and model-produced constraints cannot authorize a send.
  // A trusted effect-origin producer does not exist for this transport yet.
  const effect = digest
    ? getTurnActionConstraint(
        {
          messageId: message.id ?? "",
          roomId: message.roomId,
          actorId: message.entityId,
          action: "MESSAGE",
        },
        `gmail-send:${digest}`,
      )
    : undefined;
  if (effect?.disposition === "deny") return "denied";
  return "review";
}
/** Use only this active authenticated request's typed selection to select the
 * native store. A capability advertises a bridge; it does not migrate ownership. */
export function currentReminderRecordSource(
  runtime: IAgentRuntime,
): "device" | "runtime" {
  const current = getDeviceActionTurn();
  if (
    !current ||
    current.runtime !== runtime ||
    !current.active ||
    !current.isCurrent()
  )
    return "runtime";
  const message = current.replyContext?.message;
  if (
    !message ||
    message.agentId !== runtime.agentId ||
    message.entityId !== current.credential.subjectUserId
  )
    return "runtime";
  const context = turnObservation(message.content.metadata);
  if (!context || context.sensitive) return "runtime";
  const selected = context.selectedObject;
  if (!selected) return "runtime";
  if (Reflect.get(selected, "kind") === "reminder-source")
    return typeof Reflect.get(selected, "id") === "string" &&
      typeof Reflect.get(selected, "revision") === "string"
      ? "device"
      : "runtime";
  if (Reflect.get(selected, "kind") !== "reminder") return "runtime";
  try {
    reminderTarget({
      sourceId: Reflect.get(selected, "accountId"),
      sourceRevision: Reflect.get(selected, "sourceRevision"),
      reminderId: Reflect.get(selected, "id"),
      occurrenceId: Reflect.get(selected, "occurrenceId"),
      revision: Reflect.get(selected, "revision"),
      ...(Reflect.get(selected, "timingVersion") === 2
        ? { timingVersion: 2 }
        : {}),
    });
    return "device";
  } catch {
    return "runtime";
  }
}

/** App capabilities advertise a bridge, not ownership of canonical Notes or
 * Calendar records. Only the active owner's typed native selection
 * constrains this turn to the separate device store. This is a dispatch fence,
 * not target/read/write authorization; native validators still own those gates.
 * Keep a malformed native selection fenced rather than switching stores. */
export function currentAppRecordSource(
  runtime: IAgentRuntime,
  domain: "notes" | "calendar",
  message?: Memory,
): "device" | "runtime" | "unavailable" {
  const current = getDeviceActionTurn();
  if (!current || current.runtime !== runtime) return "runtime";
  if (!current.active || !current.isCurrent()) return "unavailable";
  message ??= current.requestMessage?.message ?? current.replyContext?.message;
  const bound = current.requestMessage;
  if (
    bound &&
    (!message ||
      message !== bound.message ||
      message.id !== bound.id ||
      message.roomId !== bound.roomId ||
      message.agentId !== bound.agentId ||
      message.entityId !== bound.entityId)
  )
    return "unavailable";
  if (
    !message ||
    message.agentId !== runtime.agentId ||
    !current.requestCaller ||
    current.requestCaller.subjectUserId !== current.credential.subjectUserId ||
    current.requestCaller.role !== "OWNER" ||
    message.entityId !== current.requestCaller.entityId
  )
    return "unavailable";
  if (
    (current.replyContext && current.replyContext.message.id !== message.id) ||
    (current.replyConversation &&
      current.replyConversation.roomId !== message.roomId)
  )
    return "unavailable";
  const context = turnObservation(message.content.metadata);
  if (!context || context.sensitive) return "unavailable";
  if (context.view !== domain) return "runtime";
  const selected = context.selectedObject;
  if (!selected) return "runtime";
  const kind = Reflect.get(selected, "kind");
  if (
    domain === "notes"
      ? kind === "note-source" || kind === "note"
      : kind === "calendar-source" || kind === "calendar-event"
  ) {
    try {
      if (domain === "notes") {
        if (kind === "note") notesSelectionTarget(selected);
        else
          notesSource({
            sourceId: Reflect.get(selected, "id"),
            sourceRevision: Reflect.get(selected, "revision"),
          });
      } else if (kind === "calendar-source")
        calendarSource({
          sourceId: Reflect.get(selected, "id"),
          sourceRevision: Reflect.get(selected, "revision"),
        });
      else
        validateCalendarOperation({
          type: "calendar_read_selected",
          target: {
            sourceId: Reflect.get(selected, "accountId"),
            sourceRevision: Reflect.get(selected, "sourceRevision"),
            eventId: Reflect.get(selected, "id"),
            revision: Reflect.get(selected, "revision"),
          },
        });
      return "device";
    } catch {
      return "unavailable";
    }
  }
  if (
    domain === "notes"
      ? kind === "canonical-note-source" || kind === "canonical-note"
      : kind === "canonical-calendar-source" ||
        kind === "canonical-calendar-event"
  )
    return "runtime";
  return "unavailable";
}

/** Availability is the same domain fence as enqueue; capability alone never owns records. */
export function deviceAppRecordOperationAvailable(
  runtime: IAgentRuntime,
  operation: unknown,
  message?: Memory,
  options?: { requestBound?: boolean },
): boolean {
  if (!operation || typeof operation !== "object" || Array.isArray(operation))
    return false;
  const type = Reflect.get(operation, "type");
  if (typeof type !== "string") return false;
  const domain =
    isNotesOperation(operation) ||
    isNativeNotesQuery({ type }) ||
    [
      "create_note",
      "read_selected_notes",
      "notes_named",
      "notes_search",
      "notes_titles",
    ].includes(type)
      ? "notes"
      : isCalendarOperation(operation) ||
          [
            "read_calendar_range",
            "calendar_availability",
            "calendar_named",
          ].includes(type)
        ? "calendar"
        : undefined;
  if (!domain) return true;
  const current = getDeviceActionTurn();
  // Workflow/system hosts outside an authenticated client turn keep their existing admission.
  if (!current || current.runtime !== runtime)
    return options?.requestBound !== true;
  return (
    current.active &&
    current.isCurrent() &&
    currentAppRecordSource(runtime, domain, message) === "device"
  );
}

/** Bind only the authenticated request identity before catalogs/discovery.
 * This is not a reply ContextObject or permission to execute any operation. */
export function setDeviceActionRequestMessage(
  runtime: IAgentRuntime,
  message: Memory,
): void {
  const current = getDeviceActionTurn();
  if (!current) return;
  if (
    current.runtime !== runtime ||
    !current.active ||
    !current.isCurrent() ||
    typeof message.id !== "string" ||
    !message.id ||
    typeof message.roomId !== "string" ||
    !message.roomId ||
    message.agentId !== runtime.agentId ||
    !current.requestCaller ||
    current.requestCaller.subjectUserId !== current.credential.subjectUserId ||
    current.requestCaller.role !== "OWNER" ||
    message.entityId !== current.requestCaller.entityId ||
    message.entityId === runtime.agentId ||
    message.content.role === "system" ||
    message.content.source === "voice_lifecycle" ||
    (current.replyConversation &&
      current.replyConversation.roomId !== message.roomId)
  )
    throw new DeviceActionError(
      "Authenticated device request identity is unavailable",
    );
  const bound = current.requestMessage;
  if (
    (bound &&
      (bound.message !== message ||
        bound.id !== message.id ||
        bound.roomId !== message.roomId ||
        bound.agentId !== message.agentId ||
        bound.entityId !== message.entityId)) ||
    (current.replyContext && current.replyContext.message !== message)
  )
    throw new DeviceActionError(
      "Authenticated device request identity changed",
    );
  current.requestMessage ??= Object.freeze({
    message,
    id: message.id,
    roomId: message.roomId,
    agentId: message.agentId,
    entityId: message.entityId,
  });
}

/** Called by the owning conversation host after canonical room admission. */
export function setDeviceReadReplyConversation(
  runtime: IAgentRuntime,
  id: string,
  roomId: UUID,
): void {
  const current = getDeviceActionTurn();
  if (!current || current.runtime !== runtime) return;
  if (
    current.replyConversation &&
    (current.replyConversation.id !== id ||
      current.replyConversation.roomId !== roomId)
  )
    throw new DeviceActionError("Original read conversation changed");
  if (current.requestMessage && current.requestMessage.roomId !== roomId)
    throw new DeviceActionError("Original request room changed");
  current.replyConversation = { id, roomId };
}
/** Called only by the canonical authenticated OWNER message pipeline. */
export function setDeviceReadReplyContext(
  runtime: IAgentRuntime,
  message: Memory,
  context: ContextObject,
): void {
  const current = getDeviceActionTurn();
  if (!current || current.runtime !== runtime) return;
  setDeviceActionRequestMessage(runtime, message);
  if (current.replyContext && current.replyContext.message.id !== message.id)
    throw new DeviceActionError("Device read origin changed");
  current.replyContext = { message, context };
}
async function freshRequestedMessageId(
  runtime: IAgentRuntime,
  credential: DeviceCredential,
): Promise<{ messageId: string; assertCurrent(): void } | undefined> {
  const current = getDeviceActionTurn();
  const original = current?.replyContext?.message;
  const metadata = original?.content.metadata;
  if (
    !current ||
    current.runtime !== runtime ||
    !original?.id ||
    !current.replyConversation ||
    original.agentId !== runtime.agentId ||
    original.entityId === runtime.agentId ||
    original.content.role === "system" ||
    original.content.source === "voice_lifecycle" ||
    original.roomId !== current.replyConversation.roomId ||
    current.credential.subjectUserId !== credential.subjectUserId ||
    current.credential.installationId !== credential.installationId ||
    typeof original.createdAt !== "number" ||
    !Number.isFinite(original.createdAt) ||
    original.createdAt < current.startedAt ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !("agentActionMode" in metadata) ||
    metadata.agentActionMode !== "direct-request-v1"
  )
    return;
  const marker = readDurableConversationChatMarker(
    original.content.chatIdempotency,
  );
  if (
    !marker ||
    conversationClientUserMemoryId(marker.scope, marker.clientMessageId) !==
      original.id
  )
    return;
  const signal = getStreamingContext()?.abortSignal;
  const subject = credential.subjectUserId,
    installation = credential.installationId;
  const deviceKey = credential.deviceKey,
    originalId = original.id;
  const originalActor = original.entityId,
    originalRoom = original.roomId;
  const originalText = original.content.text;
  const assertCurrent = () => {
    if (
      !current.active ||
      !current.isCurrent() ||
      getDeviceActionTurn() !== current ||
      current.runtime !== runtime ||
      current.replyContext?.message !== original ||
      original.id !== originalId ||
      original.entityId !== originalActor ||
      original.roomId !== originalRoom ||
      original.content.text !== originalText ||
      credential.subjectUserId !== subject ||
      credential.installationId !== installation ||
      credential.deviceKey !== deviceKey ||
      current.credential.subjectUserId !== subject ||
      current.credential.installationId !== installation ||
      current.credential.deviceKey !== deviceKey ||
      signal?.aborted ||
      getStreamingContext()?.abortSignal?.aborted
    ) {
      throw new DeviceActionError(
        "Original foreground request ended; proposal cancelled",
      );
    }
  };
  assertCurrent();
  // Read before the queue transaction: no nested query against a held adapter mutex.
  const stored = await runtime.getMemoryById(original.id);
  assertCurrent();
  const storedMarker = readDurableConversationChatMarker(
    stored?.content.chatIdempotency,
  );
  if (
    !stored ||
    stored.agentId !== runtime.agentId ||
    stored.entityId !== original.entityId ||
    stored.roomId !== original.roomId ||
    typeof stored.createdAt !== "number" ||
    !Number.isFinite(stored.createdAt) ||
    stored.createdAt < current.startedAt ||
    stored.content.text !== original.content.text ||
    !storedMarker ||
    storedMarker.scope !== marker.scope ||
    storedMarker.clientMessageId !== marker.clientMessageId ||
    storedMarker.fingerprint !== marker.fingerprint ||
    !current.active ||
    getDeviceActionTurn() !== current ||
    getStreamingContext()?.abortSignal?.aborted
  )
    return;
  return { messageId: originalId, assertCurrent };
}

export async function currentRequestedActionOrigin(
  runtime: IAgentRuntime,
  message: Memory,
) {
  const current = getDeviceActionTurn();
  if (!current || current.replyContext?.message !== message) return undefined;
  const origin = await freshRequestedMessageId(runtime, current.credential);
  if (!origin || origin.messageId !== message.id) return undefined;
  origin.assertCurrent();
  return Object.freeze({ ...origin, startedAt: current.startedAt });
}

export async function withDeviceActionTurn<T>(
  runtime: IAgentRuntime,
  credential: DeviceCredential,
  fn: () => Promise<T>,
  options: {
    isCurrent?: () => boolean;
    retainNotesRead?: (binding: NativeNotesDeferredRead) => void;
    requestCaller?: { subjectUserId: string; entityId: UUID; role: string };
  } = {},
): Promise<T> {
  const caller = options.requestCaller;
  if (
    caller &&
    (caller.subjectUserId !== credential.subjectUserId ||
      typeof caller.entityId !== "string" ||
      !caller.entityId ||
      !["OWNER", "ADMIN", "USER", "GUEST"].includes(caller.role))
  )
    throw new DeviceActionError(
      "Authenticated conversation caller binding is invalid",
    );
  const requestCaller = caller ? Object.freeze({ ...caller }) : undefined;
  const startedAt = Date.now();
  const viewProfile = await new DeviceActionService(runtime).viewProfile(
    credential,
  );
  const context: DeviceTurn = {
    runtime,
    credential,
    requestCaller,
    active: true,
    viewProfile,
    startedAt,
    isCurrent: options.isCurrent ?? (() => true),
    retainNotesRead: options.retainNotesRead,
  };
  try {
    return await turn.run(context, () =>
      withActionGatePolicy((action) => {
        if (action.name === "PROPOSE_DEVICE_ACTION") return;
        const capabilities = credential.capabilities ?? [];
        const tags = action.tags ?? [];
        const calendarRecords = currentAppRecordSource(runtime, "calendar");
        const notesRecords = currentAppRecordSource(runtime, "notes");
        if (tags.includes("resource:notes") && notesRecords === "unavailable")
          return "The current Notes request context is unavailable. No note records were accessed.";
        if (
          tags.includes("resource:calendar-records") &&
          calendarRecords === "unavailable"
        )
          return "The current Calendar request context is unavailable. No calendar records were accessed.";
        const nativeDomain =
          notesRecords === "device" && tags.includes("resource:notes")
            ? "Notes"
            : calendarRecords === "device" &&
                tags.includes("resource:calendar-records")
              ? "Calendar"
              : currentReminderRecordSource(runtime) === "device" &&
                  (capabilities.includes(REMINDER_CAPABILITY) ||
                    capabilities.includes(REMINDER_TIMING_CAPABILITY) ||
                    capabilities.includes(REMINDER_CREATE_CAPABILITY)) &&
                  tags.includes("resource:reminders-records")
                ? "reminders"
                : undefined;
        if (nativeDomain)
          return `This authenticated phone owns ${nativeDomain} records. ${deviceActionToolGuidance(runtime, capabilities)} Native approval and a device receipt are required. Backend-store actions cannot substitute for device records.`;
      }, fn),
    );
  } finally {
    context.active = false;
  }
}
function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
function keyHash(key: string): string {
  if (!/^[a-f0-9]{64}$/.test(key))
    throw new DeviceActionError("Invalid device credential");
  return createHash("sha256").update(key).digest("hex");
}
function scope(c: DeviceCredential, agentId: string): string {
  return `agent_id = ${sqlText(agentId)} AND subject_user_id = ${sqlText(text(c.subjectUserId, 256))} AND installation_id = ${sqlText(identifier(c.installationId))}`;
}
function transactionRuntime(
  runtime: IAgentRuntime,
  tx: TransactionalDb,
): IAgentRuntime {
  const adapter = new Proxy(runtime.adapter, {
    get(target, property) {
      return property === "db" ? tx : Reflect.get(target, property);
    },
  });
  return new Proxy(runtime, {
    get(target, property) {
      if (property === "adapter") return adapter;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export function deviceProposalDigest(request: ApprovalRequest): string {
  return digest({
    id: request.id,
    subjectUserId: request.subjectUserId,
    payload: request.payload,
    expiresAt: request.expiresAt.toISOString(),
  });
}
const readReplyControllers = new WeakMap<
  IAgentRuntime,
  Map<
    string,
    {
      ownerId: string;
      installationId: string;
      enrollmentId: string;
      digest: string;
      controller: AbortController;
    }
  >
>();
export class DeviceActionService {
  constructor(private readonly runtime: IAgentRuntime) {}
  private database(): TransactionDatabase {
    const db = this.runtime.adapter.db as TransactionDatabase;
    if (!db || typeof db.transaction !== "function")
      throw new DeviceActionError(
        "Transactional device store unavailable",
        "DEVICE_STORE_UNAVAILABLE",
      );
    return db;
  }
  /** Insert original-read binding in the SAME transaction as a new proposal. */
  private async bindNewReadCompletion(
    tx: TransactionalDb,
    row: Record<string, unknown>,
    c: DeviceCredential,
    outcome: ApprovalEnqueueResult,
    parameters: Record<string, unknown>,
    calendarUpdate?: typeof CALENDAR_UPDATE_HOST,
    notesUpdate?: typeof NOTES_UPDATE_HOST,
    availability?: ReviewedAvailabilityRequest,
  ): Promise<NativeNotesDeferredRead | undefined> {
    const active = getDeviceActionTurn();
    if (
      outcome.reused ||
      !active?.replyContext ||
      !active.replyConversation ||
      active.replyConversation.roomId !== active.replyContext.message.roomId ||
      active.runtime !== this.runtime ||
      active.credential !== c ||
      !isCompletableDeviceRead(outcome.request)
    )
      return;
    const origin = captureDeviceReadReplyOrigin(
      this.runtime,
      active.replyContext.message,
      active.replyContext.context,
      {
        id: `approved-read:${outcome.request.id}`,
        name: "PROPOSE_DEVICE_ACTION",
        params: parameters,
      },
      active.replyConversation.id,
    );
    if (!origin) return;
    // The durable original owner request determines the continuation. The model's
    // optional hint can be validated, but omission must not erase an admitted deletion.
    const originalNotesDeletion =
      active.isCurrent() &&
      validateDevicePayload(outcome.request.payload).operation.type ===
        "notes_query" &&
      originalRequestsNotesDeletion(active.replyContext.message);
    if (parameters.afterRead !== undefined) {
      const spec = object(parameters.afterRead);
      exactKeys(spec, ["kind"]);
      if (spec.kind !== "notes_delete" || !originalNotesDeletion)
        throw new DeviceActionError("Invalid original Notes continuation");
    }
    if (originalNotesDeletion) origin.afterRead = { kind: "notes_delete" };
    // A title lookup may be an intermediate step of the original edit. Resolve
    // it only against the fresh owner-shared exact snapshot using Notes' patch
    // interpreter; an empty patch preserves the existing read-only reply path.
    if (
      !originalNotesDeletion &&
      active.isCurrent() &&
      c.capabilities?.includes(NOTES_CAPABILITY) &&
      validateDevicePayload(outcome.request.payload).operation.type ===
        "notes_query"
    ) {
      const operation = validateDevicePayload(
        outcome.request.payload,
      ).operation;
      if (operation.type === "notes_query" && operation.query.kind === "title")
        origin.afterRead = { kind: "notes_query_resolution" };
    }

    const originalCalendarTimeUpdate =
      active.isCurrent() &&
      validateDevicePayload(outcome.request.payload).operation.type ===
        "calendar_read_selected" &&
      originalRequestsCalendarTimeUpdate(active.replyContext.message);
    if (originalCalendarTimeUpdate) {
      const metadata = active.replyContext.message.content.metadata,
        context = requireTurnObservation(metadata);
      if (typeof context.timeZone !== "string")
        throw new DeviceActionError("Original Calendar timezone unavailable");
      new Intl.DateTimeFormat("en-US", { timeZone: context.timeZone });
      origin.afterRead = {
        kind: "calendar_time_update",
        timeZone: context.timeZone,
      };
    }
    if (calendarUpdate === CALENDAR_UPDATE_HOST) {
      const operation = validateDevicePayload(
        outcome.request.payload,
      ).operation;
      if (
        !active.isCurrent() ||
        !(
          operation.type === "calendar_read_selected" ||
          (operation.type === "calendar_named" && operation.action === "read")
        )
      )
        throw new DeviceActionError("Original Calendar update read changed");
      const metadata = active.replyContext.message.content.metadata,
        context = requireTurnObservation(metadata);
      if (typeof context.timeZone !== "string")
        throw new DeviceActionError("Original Calendar timezone unavailable");
      new Intl.DateTimeFormat("en-US", { timeZone: context.timeZone });
      origin.afterRead = {
        kind: "calendar_update",
        timeZone: context.timeZone,
      };
    }
    if (notesUpdate === NOTES_UPDATE_HOST) {
      if (
        !active.isCurrent() ||
        validateDevicePayload(outcome.request.payload).operation.type !==
          "notes_read_selected"
      )
        throw new DeviceActionError("Original Notes update read changed");
      origin.afterRead = { kind: "notes_update" };
    }
    if (availability) {
      if (
        !active.isCurrent() ||
        !["read_calendar_range", "calendar_availability"].includes(
          validateDevicePayload(outcome.request.payload).operation.type,
        )
      )
        throw new DeviceActionError(
          "Original Calendar availability read changed",
        );
      origin.afterRead = validateReviewedAvailabilityRequest(availability);
    }
    const request = outcome.request,
      payload = validateDevicePayload(request.payload);
    if (
      request.state !== "pending" ||
      request.subjectUserId !== c.subjectUserId ||
      request.requestedBy !== this.runtime.agentId ||
      payload.installationId !== c.installationId ||
      payload.enrollmentId !== row.enrollment_id ||
      request.expiresAt.getTime() <= Date.now()
    )
      throw new DeviceActionError("Original read proposal changed");
    await bindDeviceCompletion(tx, {
      version: 1,
      purpose:
        origin.afterRead?.kind === "notes_query_resolution"
          ? "original_notes_query_after_read"
          : origin.afterRead?.kind === "calendar_availability"
            ? "original_calendar_availability_reply"
            : origin.afterRead?.kind === "notes_update"
              ? "original_notes_update_after_read"
              : origin.afterRead?.kind === "calendar_update"
                ? "original_calendar_update_after_read"
                : origin.afterRead?.kind === "calendar_time_update"
                  ? "original_calendar_time_update_after_read"
                  : origin.afterRead
                    ? "original_notes_delete_after_read"
                    : isCompletableNotesRead(request)
                      ? "original_notes_read_reply"
                      : "original_device_read_reply",
      agentId: this.runtime.agentId,
      ownerId: c.subjectUserId,
      installationId: c.installationId,
      enrollmentId: payload.enrollmentId,
      proposalId: request.id,
      digest: deviceProposalDigest(request),
      expiresAt: request.expiresAt.toISOString(),
      origin,
      state: "pending",
    });
    return {
      version: 1,
      requestId: origin.requestId,
      conversationId: origin.conversationId,
      inReplyTo: origin.original.id,
      proposalId: request.id,
      digest: deviceProposalDigest(request),
      installationId: c.installationId,
      enrollmentId: payload.enrollmentId,
      expiresAt: request.expiresAt.getTime(),
    };
  }
  private async boundReadCompletion(
    q: PgApprovalQueue,
    row: Record<string, unknown>,
    tx: TransactionalDb,
    c: DeviceCredential,
    id: string,
    digest: string,
    attemptId: string,
  ) {
    const request = await this.proposal(q, row, c, id, digest);
    const binding = await readDeviceCompletion(
      tx,
      this.runtime.agentId,
      c.subjectUserId,
      id,
    );
    if (!binding) return null;
    if (
      binding.installationId !== c.installationId ||
      binding.enrollmentId !== row.enrollment_id ||
      binding.digest !== digest ||
      binding.expiresAt !== request.expiresAt.toISOString() ||
      binding.origin.original.agentId !== this.runtime.agentId ||
      binding.origin.hostContextRevision !==
        deviceReadHostContextRevision(this.runtime) ||
      request.execution?.attemptId !== attemptId
    )
      throw new DeviceActionError("Original read binding changed");
    deviceReadResult(request);
    return { request, binding };
  }
  async readReplyOrigin(
    c: DeviceCredential,
    id: string,
    digest: string,
  ): Promise<NativeNotesReadReplyOrigin | undefined> {
    return this.access(c, async (q, row, tx) => {
      await this.proposal(q, row, c, id, digest);
      const binding = await readDeviceCompletion(
        tx,
        this.runtime.agentId,
        c.subjectUserId,
        id,
      );
      return binding &&
        binding.state === "pending" &&
        binding.origin.hostContextRevision ===
          deviceReadHostContextRevision(this.runtime) &&
        Date.parse(binding.expiresAt) > Date.now()
        ? completionOrigin(binding)
        : undefined;
    });
  }
  /** Safe correlation only; never exposes private original context or credentials. */
  async readCompletionHint(
    c: DeviceCredential,
    id: string,
    digest: string,
    attemptId: string,
  ): Promise<DeviceReadCompletionHint | undefined> {
    return this.access(c, async (q, row, tx) => {
      const bound = await this.boundReadCompletion(
        q,
        row,
        tx,
        c,
        id,
        digest,
        attemptId,
      );
      if (
        !bound ||
        !["pending", "prepared", "delivered"].includes(bound.binding.state) ||
        Date.parse(bound.binding.expiresAt) <= Date.now()
      )
        return undefined;
      return completionHint(bound.binding, attemptId);
    });
  }
  async readCompletionRoom(
    c: DeviceCredential,
    hint: DeviceReadCompletionHint,
  ): Promise<UUID> {
    return this.access(c, async (q, row, tx) => {
      const current = await this.boundReadCompletion(
        q,
        row,
        tx,
        c,
        hint.proposalId,
        hint.digest,
        hint.attemptId,
      );
      if (
        !current ||
        !["pending", "prepared", "delivered"].includes(current.binding.state) ||
        current.binding.origin.requestId !== hint.requestId ||
        current.binding.origin.conversationId !== hint.conversationId ||
        current.binding.origin.original.id !== hint.inReplyTo ||
        Date.parse(current.binding.expiresAt) <= Date.now()
      )
        throw new DeviceActionError("Original read room changed");
      return current.binding.origin.original.roomId;
    });
  }
  /** Claim before inference. A lost/uncertain claim is never inferred again. */
  async prepareReadReply(
    c: DeviceCredential,
    hint: DeviceReadCompletionHint,
    signal: AbortSignal,
    recheck?: () => Promise<void>,
    assertHostCurrent?: () => void,
  ): Promise<DeviceReadCompletion["reply"]> {
    signal.throwIfAborted();
    const claimed = await this.access(c, async (q, row, tx) => {
      const bound = await this.boundReadCompletion(
        q,
        row,
        tx,
        c,
        hint.proposalId,
        hint.digest,
        hint.attemptId,
      );
      if (
        !bound ||
        bound.binding.origin.requestId !== hint.requestId ||
        bound.binding.origin.conversationId !== hint.conversationId ||
        bound.binding.origin.original.id !== hint.inReplyTo ||
        Date.parse(bound.binding.expiresAt) <= Date.now()
      )
        throw new DeviceActionError(
          "Original read completion expired or changed",
        );
      const { binding } = bound;
      if (binding.state === "prepared" || binding.state === "delivered")
        return { ...bound, cached: true };
      if (binding.state !== "pending")
        throw new DeviceActionError("Original read completion already claimed");
      signal.throwIfAborted();
      const next: DeviceReadCompletion = {
        ...binding,
        state: "claimed",
        attemptId: hint.attemptId,
      };
      await transitionDeviceCompletion(tx, binding, next);
      return { ...bound, binding: next, cached: false };
    });
    signal.throwIfAborted();
    if (claimed.cached) {
      const original = await this.runtime.getMemoryById(
        claimed.binding.origin.original.id,
      );
      await recheck?.();
      const assertCurrent = await this.assertReadReplyCurrent(
        c,
        hint,
        signal,
        assertHostCurrent,
      );
      assertCurrent();
      if (!originalReadRequestMatches(claimed.binding, original, this.runtime))
        throw new DeviceActionError("Original read request changed");
      return claimed.binding.reply;
    }
    let binding = claimed.binding;
    try {
      signal.throwIfAborted();
      const saved = await this.runtime.getMemoryById(
        binding.origin.original.id,
      );
      if (!originalReadRequestMatches(binding, saved, this.runtime))
        throw new DeviceActionError("Original read request changed");
      await this.access(c, async (q, row, tx) => {
        const current = await this.boundReadCompletion(
          q,
          row,
          tx,
          c,
          hint.proposalId,
          hint.digest,
          hint.attemptId,
        );
        if (
          !current ||
          current.binding.state !== "claimed" ||
          Date.parse(current.binding.expiresAt) <= Date.now()
        )
          throw new DeviceActionError("Original read completion retired");
      });
      signal.throwIfAborted();
      const notesMutation =
        binding.purpose === "original_notes_update_after_read" ||
        binding.purpose === "original_notes_query_after_read";
      const calendarMutation =
        binding.purpose === "original_calendar_time_update_after_read" ||
        binding.purpose === "original_calendar_update_after_read";
      if (notesMutation || calendarMutation) {
        await recheck?.();
        const current = await this.assertReadReplyCurrent(
          c,
          hint,
          signal,
          assertHostCurrent,
          ["claimed"],
        );
        current();
      }
      const mutationPlan = notesMutation
        ? await withDeviceReadModelUsage(this.runtime, binding, () =>
            notesUpdateAfterReadPlan(
              this.runtime,
              binding,
              claimed.request,
              saved,
              signal,
              assertHostCurrent,
            ),
          )
        : binding.purpose === "original_calendar_update_after_read"
          ? await withDeviceReadModelUsage(this.runtime, binding, () =>
              calendarUpdateAfterReadPlan(
                this.runtime,
                binding,
                claimed.request,
                saved,
                signal,
                assertHostCurrent,
              ),
            )
          : binding.purpose === "original_calendar_time_update_after_read"
            ? calendarTimeUpdateAfterReadPlan(
                this.runtime,
                binding,
                claimed.request,
                saved,
                signal,
                assertHostCurrent,
              )
            : binding.purpose === "original_notes_delete_after_read"
              ? notesDeleteAfterReadPlan(
                  this.runtime,
                  binding,
                  claimed.request,
                  saved,
                  signal,
                  assertHostCurrent,
                )
              : undefined;
      if (
        binding.purpose === "original_calendar_update_after_read" ||
        notesMutation
      ) {
        await recheck?.();
        const latest = await this.runtime.getMemoryById(
          binding.origin.original.id,
        );
        if (!originalReadRequestMatches(binding, latest, this.runtime))
          throw new DeviceActionError(
            "Original selected-record update request changed during extraction",
          );
        const current = await this.assertReadReplyCurrent(
          c,
          hint,
          signal,
          assertHostCurrent,
          ["claimed"],
        );
        current();
      }
      const text =
        mutationPlan?.text ??
        (await synthesizeDeviceReadReply(
          this.runtime,
          binding,
          claimed.request,
          signal,
          async () => {
            await recheck?.();
            await this.assertReadReplyCurrent(
              c,
              hint,
              signal,
              assertHostCurrent,
              ["claimed"],
            );
          },
          assertHostCurrent,
        ));
      assertDeviceReadCompletionCurrent(
        this.runtime,
        binding,
        signal,
        assertHostCurrent,
      );
      return await this.access(c, async (q, row, tx) => {
        const current = await this.boundReadCompletion(
          q,
          row,
          tx,
          c,
          hint.proposalId,
          hint.digest,
          hint.attemptId,
        );
        if (
          !current ||
          current.binding.state !== "claimed" ||
          Date.parse(current.binding.expiresAt) <= Date.now()
        )
          throw new DeviceActionError("Original read completion retired");
        signal.throwIfAborted();
        let continuation: NativeNotesReadReply["continuation"];
        if (mutationPlan?.payload) {
          if (
            !c.capabilities?.includes(
              calendarMutation ? CALENDAR_CAPABILITY : NOTES_CAPABILITY,
            )
          )
            throw new DeviceActionError(
              calendarMutation
                ? "Calendar update capability retired"
                : "Notes deletion capability retired",
            );
          const existing = await q.byIdempotencyKey(
            mutationPlan.idempotencyKey,
            c.subjectUserId,
          );
          const outcome = await q.enqueueTransactional(
            {
              requestedBy: this.runtime.agentId,
              subjectUserId: c.subjectUserId,
              action: "device_action",
              payload: mutationPlan.payload,
              channel: "phone",
              reason: calendarMutation
                ? "Original owner Calendar time change after approved selected read"
                : notesMutation
                  ? "Original owner Notes edit after approved selected read"
                  : "Original owner Notes deletion after approved target lookup",
              idempotencyKey: mutationPlan.idempotencyKey,
              expiresAt: existing?.expiresAt ?? new Date(binding.expiresAt),
            },
            tx,
          );
          signal.throwIfAborted();
          if (outcome.request.state !== "pending")
            throw new DeviceActionError(
              calendarMutation
                ? "Calendar update review already settled; inspect its canonical receipt"
                : "Notes deletion review already settled; inspect its canonical receipt",
            );
          continuation = {
            kind: calendarMutation
              ? "calendar_update_review"
              : notesMutation
                ? "notes_update_review"
                : "notes_delete_review",
            proposalId: outcome.request.id,
            digest: deviceProposalDigest(outcome.request),
          };
        }
        const reply = validateNativeNotesReadReply({
          ...completionOrigin(binding),
          messageId: completionReplyId(binding, hint.attemptId),
          text,
          ...(continuation ? { continuation } : {}),
        });
        const next: DeviceReadCompletion = {
          ...current.binding,
          state: "prepared",
          reply,
        };
        await transitionDeviceCompletion(tx, current.binding, next);
        binding = next;
        return reply;
      });
    } catch (cause) {
      try {
        await this.access(c, async (_q, _row, tx) => {
          const current = await readDeviceCompletion(
            tx,
            this.runtime.agentId,
            c.subjectUserId,
            hint.proposalId,
          );
          if (current?.state === "claimed")
            await transitionDeviceCompletion(tx, current, {
              ...current,
              state: signal.aborted ? "cancelled" : "unknown",
            });
        });
      } catch {
        this.runtime.reportError(
          "DeviceReadCompletion",
          new Error("Completion retirement could not be confirmed"),
          {
            code: "DEVICE_READ_COMPLETION_RETIREMENT_UNCONFIRMED",
            proposalId: hint.proposalId,
          },
        );
      }
      throw cause;
    }
  }
  /** Host callback carries the supplied synchronous fence through the canonical
   * same-room writer's lookup and room-lease waits, up to actual createMemory. */
  async completeReadReply(
    c: DeviceCredential,
    hint: DeviceReadCompletionHint,
    signal: AbortSignal,
    persist: (
      reply: NonNullable<DeviceReadCompletion["reply"]>,
      signal: AbortSignal,
      assertCurrent: () => void,
    ) => Promise<void>,
    recheck?: () => Promise<void>,
    assertHostCurrent?: () => void,
  ): Promise<NonNullable<DeviceReadCompletion["reply"]>> {
    await this.readCompletionRoom(c, hint);
    const enrollmentId = (await this.context(c)).enrollmentId;
    await recheck?.();
    signal.throwIfAborted();
    let controllers = readReplyControllers.get(this.runtime);
    if (!controllers) {
      controllers = new Map();
      readReplyControllers.set(this.runtime, controllers);
    }
    if (controllers.has(hint.proposalId))
      throw new DeviceActionError("Original read reply is already running");
    const owned = {
      ownerId: c.subjectUserId,
      installationId: c.installationId,
      enrollmentId,
      digest: hint.digest,
      controller: new AbortController(),
    };
    controllers.set(hint.proposalId, owned);
    const current = AbortSignal.any([signal, owned.controller.signal]);
    try {
      const reply = await this.prepareReadReply(
        c,
        hint,
        current,
        recheck,
        assertHostCurrent,
      );
      current.throwIfAborted();
      if (!reply)
        throw new DeviceActionError("Original read reply unavailable");
      await recheck?.();
      const assertCurrent = await this.assertReadReplyCurrent(
        c,
        hint,
        current,
        assertHostCurrent,
      );
      assertCurrent();
      await persist(reply, current, assertCurrent);
      current.throwIfAborted();
      await this.finishReadReply(c, hint, current);
      current.throwIfAborted();
      return reply;
    } finally {
      if (controllers.get(hint.proposalId) === owned)
        controllers.delete(hint.proposalId);
    }
  }
  async assertReadReplyCurrent(
    c: DeviceCredential,
    hint: DeviceReadCompletionHint,
    signal: AbortSignal,
    assertHostCurrent?: () => void,
    states: readonly DeviceReadCompletion["state"][] = [
      "prepared",
      "delivered",
    ],
  ): Promise<() => void> {
    const binding = await this.access(c, async (q, row, tx) => {
      const current = await this.boundReadCompletion(
        q,
        row,
        tx,
        c,
        hint.proposalId,
        hint.digest,
        hint.attemptId,
      );
      if (
        !current ||
        !states.includes(current.binding.state) ||
        current.binding.origin.requestId !== hint.requestId ||
        current.binding.origin.conversationId !== hint.conversationId ||
        current.binding.origin.original.id !== hint.inReplyTo ||
        Date.parse(current.binding.expiresAt) <= Date.now()
      )
        throw new DeviceActionError("Original read completion retired");
      signal.throwIfAborted();
      return current.binding;
    });
    const assertCurrent = () =>
      assertDeviceReadCompletionCurrent(
        this.runtime,
        binding,
        signal,
        assertHostCurrent,
      );
    assertCurrent();
    return assertCurrent;
  }
  async finishReadReply(
    c: DeviceCredential,
    hint: DeviceReadCompletionHint,
    signal: AbortSignal,
  ): Promise<void> {
    await this.access(c, async (q, row, tx) => {
      const current = await this.boundReadCompletion(
        q,
        row,
        tx,
        c,
        hint.proposalId,
        hint.digest,
        hint.attemptId,
      );
      if (
        !current ||
        !["prepared", "delivered"].includes(current.binding.state) ||
        Date.parse(current.binding.expiresAt) <= Date.now()
      )
        throw new DeviceActionError("Original read completion retired");
      signal.throwIfAborted();
      if (current.binding.state === "prepared")
        await transitionDeviceCompletion(tx, current.binding, {
          ...current.binding,
          state: "delivered",
        });
    });
  }
  async cancelReadReply(
    c: DeviceCredential,
    id: string,
    digest: string,
  ): Promise<void> {
    await this.access(c, async (q, row, tx) => {
      await this.proposal(q, row, c, id, digest);
      const current = await readDeviceCompletion(
        tx,
        this.runtime.agentId,
        c.subjectUserId,
        id,
      );
      if (
        current &&
        !["delivered", "cancelled", "unknown"].includes(current.state)
      )
        await transitionDeviceCompletion(tx, current, {
          ...current,
          state: "cancelled",
        });
    });
    const owned = readReplyControllers.get(this.runtime)?.get(id);
    if (owned?.ownerId === c.subjectUserId && owned.digest === digest)
      owned.controller.abort(new Error("Original read completion cancelled"));
  }
  async register(
    c: DeviceCredential,
    label: string,
    workflowProtocol: 0 | 1 | 2 = 0,
    workflowOwnerId: string = c.subjectUserId,
  ): Promise<{
    installationId: string;
    enrollmentId: string;
    capabilities: string[];
    viewProfileVersion: 1;
    userTextFormatVersion: 1;
  }> {
    if (
      workflowProtocol !== 0 &&
      workflowProtocol !== 1 &&
      workflowProtocol !== 2
    )
      throw new DeviceActionError("Unsupported workflow device protocol");
    const hash = keyHash(c.deviceKey);
    const registered = await this.database().transaction(async (tx) => {
      await executeRawSqlTx(
        tx,
        `INSERT INTO client_devices (agent_id, subject_user_id, installation_id, enrollment_id, key_hash, label) VALUES (${sqlText(this.runtime.agentId)}, ${sqlText(text(c.subjectUserId, 256))}, ${sqlText(identifier(c.installationId))}, ${sqlText(randomUUID())}, ${sqlText(hash)}, ${sqlText(text(label, 128))}) ON CONFLICT DO NOTHING`,
      );
      const row = await this.lock(tx, c);
      await executeRawSqlTx(
        tx,
        `UPDATE client_devices SET workflow_protocol=${workflowProtocol}, workflow_owner_id=${sqlText(text(workflowOwnerId, 256))} WHERE ${scope(c, this.runtime.agentId)}`,
      );
      return {
        installationId: c.installationId,
        enrollmentId: String(row.enrollment_id),
        viewProfileVersion: 1 as const,
        userTextFormatVersion: 1 as const,
        capabilities: [
          "gmail.request-policy.v1",
          CAMERA_CAPTURE_CAPABILITY,
          "calendar.local-event.v1",
          CALENDAR_CREATE_CAPABILITY,
          CALENDAR_NEXT_CAPABILITY,
          CALENDAR_AGENDA_CAPABILITY,
          "notes.local-record.v1",
          NOTES_QUERY_CAPABILITY,
          NOTES_SEARCH_CAPABILITY,
          CALENDAR_AVAILABILITY_CAPABILITY,
          NAMED_TARGET_CAPABILITY,
          CALENDAR_NAMED_READ_CAPABILITY,
          REMINDER_CAPABILITY,
          REMINDER_TIMING_CAPABILITY,
          REMINDER_CREATE_CAPABILITY,
          CLOCK_CAPABILITY,
          CLOCK_REPEAT_CAPABILITY,
          CLOCK_ALARMS_CAPABILITY,
          MAPS_CAPABILITY,
          SMS_SEND_CAPABILITY,
        ],
      };
    });
    // Idempotent registration preserves the same lease. A committed replacement
    // retires only the previous enrollment for this exact owner/installation.
    for (const held of readReplyControllers.get(this.runtime)?.values() ?? []) {
      if (
        held.ownerId === c.subjectUserId &&
        held.installationId === c.installationId &&
        held.enrollmentId !== registered.enrollmentId
      )
        held.controller.abort(new Error("Original read enrollment replaced"));
    }
    return registered;
  }
  private async lock(
    tx: TransactionalDb,
    c: DeviceCredential,
  ): Promise<Record<string, unknown>> {
    const hash = keyHash(c.deviceKey);
    const rows = await executeRawSqlTx(
      tx,
      `SELECT agent_id, subject_user_id, installation_id, enrollment_id, key_hash, revoked, workflow_protocol, view_profile FROM client_devices WHERE ${scope(c, this.runtime.agentId)} FOR UPDATE`,
    );
    const row = rows[0];
    if (
      row?.revoked !== false ||
      typeof row.key_hash !== "string" ||
      row.key_hash.length !== hash.length ||
      !timingSafeEqual(Buffer.from(hash), Buffer.from(row.key_hash))
    )
      throw new DeviceActionError("Device unavailable");
    return row;
  }
  private async access<T>(
    c: DeviceCredential,
    fn: (
      queue: PgApprovalQueue,
      row: Record<string, unknown>,
      tx: TransactionalDb,
    ) => Promise<T>,
    assertCurrent?: () => void,
  ): Promise<T> {
    assertCurrent?.();
    return this.database().transaction(async (tx) => {
      const row = await this.lock(tx, c);
      assertCurrent?.();
      const queue = new PgApprovalQueue(transactionRuntime(this.runtime, tx), {
        agentId: this.runtime.agentId,
      });
      const result = await fn(queue, row, tx);
      // Last owning callback check before the database commits its transaction.
      assertCurrent?.();
      return result;
    });
  }
  async authenticate(c: DeviceCredential): Promise<void> {
    await this.access(c, async () => {});
  }
  /** Canonical enrollment identity for a native journal, authenticated by the existing device store. */
  async context(c: DeviceCredential): Promise<{
    agentId: string;
    subjectUserId: string;
    installationId: string;
    enrollmentId: string;
    scope: string;
  }> {
    return this.access(c, async (_q, row) => {
      const identity = {
        agentId: identifier(row.agent_id),
        subjectUserId: text(row.subject_user_id, 256),
        installationId: identifier(row.installation_id),
        enrollmentId: identifier(row.enrollment_id),
      };
      return { ...identity, scope: digest(identity) };
    });
  }
  async viewProfile(c: DeviceCredential): Promise<DeviceViewProfile | null> {
    return this.access(c, async (_q, row) =>
      storedDeviceViewProfile(row.view_profile),
    );
  }
  async setViewProfile(
    c: DeviceCredential,
    input: unknown,
  ): Promise<DeviceViewProfile> {
    const value = object(input);
    exactKeys(value, ["version", "views", "expectedRevision"]);
    if (
      value.version !== 1 ||
      !(
        value.expectedRevision === null ||
        typeof value.expectedRevision === "string"
      )
    )
      throw new DeviceActionError("Unsupported view profile");
    const views = enabledDeviceViews(value.views);
    return this.access(c, async (_q, row, tx) => {
      const previous = storedDeviceViewProfile(row.view_profile);
      if ((previous?.revision ?? null) !== value.expectedRevision)
        throw new DeviceActionError("View profile changed");
      if (previous && JSON.stringify(previous.views) === JSON.stringify(views))
        return previous;
      const profile: DeviceViewProfile = {
        version: 1,
        revision: randomUUID(),
        views,
      };
      await executeRawSqlTx(
        tx,
        `UPDATE client_devices SET view_profile=${sqlText(JSON.stringify(profile))} WHERE ${scope(c, this.runtime.agentId)}`,
      );
      return profile;
    });
  }
  private assertViewProfile(
    row: Record<string, unknown>,
    payload: DeviceActionPayload,
  ): void {
    if (payload.operation.type !== "open_view") return;
    const profile = storedDeviceViewProfile(row.view_profile);
    if (
      profile
        ? profile.revision !== payload.viewProfileRevision ||
          !profile.views.includes(payload.operation.view)
        : payload.viewProfileRevision !== undefined
    )
      throw new DeviceActionError(
        "Enabled view profile changed or view unavailable",
      );
  }
  async revoke(c: DeviceCredential): Promise<void> {
    const enrollmentId = await this.access(c, async (_q, row, tx) => {
      await executeRawSqlTx(
        tx,
        `UPDATE client_devices SET revoked = TRUE WHERE ${scope(c, this.runtime.agentId)}`,
      );
      return String(row.enrollment_id);
    });
    // Retire after the canonical change commits, including a writer currently
    // held in its prewrite lookup. Never cancel a foreign or newer enrollment.
    for (const held of readReplyControllers.get(this.runtime)?.values() ?? []) {
      if (
        held.ownerId === c.subjectUserId &&
        held.installationId === c.installationId &&
        held.enrollmentId === enrollmentId
      )
        held.controller.abort(new Error("Original read enrollment revoked"));
    }
  }
  async propose(
    c: DeviceCredential,
    operation: unknown,
    operationKey: string,
    reason: string,
    observation?: unknown,
  ): Promise<ApprovalRequest> {
    return (
      await this.proposeWithOutcome(
        c,
        operation,
        operationKey,
        reason,
        observation,
      )
    ).request;
  }
  /** Replay identity comes from the same durable queue transaction as insertion. */
  async proposeWithOutcome(
    c: DeviceCredential,
    operation: unknown,
    operationKey: string,
    reason: string,
    observation?: unknown,
    afterRead?: unknown,
    agenda?: {
      token: typeof CALENDAR_AGENDA_HOST;
      source: CalendarSource;
      availability?: {
        token: typeof CALENDAR_AVAILABILITY_HOST;
        request: ReviewedAvailabilityRequest;
      };
    },
    calendarUpdate?: typeof CALENDAR_UPDATE_HOST,
    notesUpdate?: typeof NOTES_UPDATE_HOST,
    availabilityReview?: {
      token: typeof CALENDAR_AVAILABILITY_HOST;
      request: ReviewedAvailabilityRequest;
    },
  ): Promise<ApprovalEnqueueResult> {
    const validated = validateDeviceOperation(operation);
    if (!deviceAppRecordOperationAvailable(this.runtime, validated))
      throw new DeviceActionError(
        "Device Notes/Calendar record authority is not selected for this turn",
      );
    if (
      validated.type === "calendar_named" &&
      validated.action === "read" &&
      calendarUpdate !== CALENDAR_UPDATE_HOST
    )
      throw new DeviceActionError("Named Calendar update read is host-owned");
    if (
      validated.type === "read_calendar_range" &&
      (agenda?.token !== CALENDAR_AGENDA_HOST ||
        !c.capabilities?.includes(CALENDAR_AGENDA_CAPABILITY))
    )
      throw new DeviceActionError(
        "Standalone Calendar read requires its owned request port",
      );
    if (afterRead !== undefined) {
      const v = object(afterRead);
      exactKeys(v, ["kind"]);
      const active = getDeviceActionTurn();
      if (
        validated.type !== "notes_query" ||
        v.kind !== "notes_delete" ||
        active?.runtime !== this.runtime ||
        active.credential !== c ||
        !active.isCurrent() ||
        !originalRequestsNotesDeletion(active.replyContext?.message)
      )
        throw new DeviceActionError(
          "The original owner request did not admit Notes deletion",
        );
    }
    if (!deviceOperationSupportedByCapabilities(validated.type, c.capabilities))
      throw new DeviceActionError("Device operation capability unavailable");
    if (
      isClockOperation(validated) &&
      !clockCapabilityAvailable(validated, c.capabilities)
    )
      throw new DeviceActionError("Clock capability unavailable");
    if (isMapsOperation(validated)) {
      if (!c.capabilities?.includes(MAPS_CAPABILITY))
        throw new DeviceActionError("Maps capability unavailable");
    }
    if (
      isReminderCreate(validated) &&
      !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
    )
      throw new DeviceActionError("Reminder creation capability required");
    if (
      isReminderOperation(validated) &&
      !reminderCapabilityAvailable(validated, c.capabilities)
    )
      throw new DeviceActionError("Reminder capability unavailable");
    if (
      isForegroundReviewOperation(validated) &&
      !foregroundReviewOperationAvailable(validated, c.capabilities)
    )
      throw new DeviceActionError("Foreground review capability unavailable");
    if (
      isNativeNotesQuery(validated) &&
      (!c.capabilities?.includes(NOTES_QUERY_CAPABILITY) ||
        !c.capabilities.includes(NOTES_CAPABILITY))
    )
      throw new DeviceActionError("Notes query capability unavailable");
    if (
      isNotesOperation(validated) &&
      !c.capabilities?.includes(NOTES_CAPABILITY)
    )
      throw new DeviceActionError("Notes capability unavailable");
    if (
      isCalendarOperation(validated) &&
      !calendarCapabilityAvailable(validated.type, c.capabilities)
    )
      throw new DeviceActionError("Calendar capability unavailable");
    if (
      ![
        "camera_capture_photo",
        "sms_send",
        "clock_handoff",
        "clock_alarm",
        "create_note",
        "maps_read_selected",
        "notes_read_selected",
        "notes_query",
        "notes_update",
        "notes_delete",
        "create_reminder",
        "reminder_create",
        "reminder_read_selected",
        "reminder_update",
        "reminder_complete",
        "reminder_snooze",
        "reminder_cancel",
        "open_view",
        "browser_navigate",
        "calendar_create_local",
        "calendar_read_next",
        "read_calendar_range",
        "calendar_create",
        "calendar_read_selected",
        "calendar_update",
        "calendar_delete",
        ...FOREGROUND_REVIEW_TYPES,
      ].includes(validated.type)
    )
      throw new DeviceActionError("Workflow read requires bound dispatcher");
    const requestOrigin = await freshRequestedMessageId(this.runtime, c);
    requestOrigin?.assertCurrent();
    const originMessageId = requestOrigin?.messageId;
    if (
      agenda &&
      (!originMessageId ||
        getDeviceActionTurn()?.credential !== c ||
        getDeviceActionTurn()?.runtime !== this.runtime ||
        !getDeviceActionTurn()?.isCurrent())
    )
      throw new DeviceActionError("Current Calendar request unavailable");
    let deferredRead: NativeNotesDeferredRead | undefined;
    const result = await this.access(
      c,
      async (queue, row, tx) => {
        requestOrigin?.assertCurrent();
        const viewProfile = storedDeviceViewProfile(row.view_profile);
        if (
          validated.type === "open_view" &&
          viewProfile &&
          !viewProfile.views.includes(validated.view)
        )
          throw new DeviceActionError("View unavailable on this installation");
        const turn = getDeviceActionTurn();
        const metadata = turn?.replyContext?.message.content.metadata;
        const directRequest =
          turn?.runtime === this.runtime &&
          metadata &&
          typeof metadata === "object" &&
          !Array.isArray(metadata) &&
          "agentActionMode" in metadata &&
          metadata.agentActionMode === "direct-request-v1";
        const requestingMessage = directRequest
          ? requestOrigin?.messageId
          : undefined;
        const payload: DeviceActionPayload = {
          action: "device_action",
          version: 1,
          installationId: c.installationId,
          enrollmentId: String(row.enrollment_id),
          operation: validated,
          ...(agenda
            ? { calendarAgendaSource: calendarSource(agenda.source) }
            : {}),
          ...(requestingMessage && getDeviceActionTurn()?.active
            ? { requestMessageId: requestingMessage }
            : {}),
          ...(validated.type === "open_view" && viewProfile
            ? { viewProfileRevision: viewProfile.revision }
            : {}),
        };
        // This is the canonical queue's transaction API: no notification or effect before commit.
        const idempotencyKey = `device:${digest([c.subjectUserId, c.installationId, identifier(operationKey)])}`;
        const existing = await queue.byIdempotencyKey(
          idempotencyKey,
          c.subjectUserId,
        );
        if (isClockOperation(validated)) {
          const receipt = existing?.execution?.providerReceipt;
          const priorPayload = existing
            ? validateDevicePayload(existing.payload)
            : undefined;
          const historical =
            existing?.state === "done" &&
            priorPayload?.installationId === payload.installationId &&
            priorPayload?.enrollmentId === payload.enrollmentId &&
            stableStringify(priorPayload.operation) ===
              stableStringify(payload.operation) &&
            receipt?.outcome === "applied";
          try {
            if (historical) {
              validateClockResult(
                validated,
                receipt.result,
                "applied",
                typeof receipt.operationId === "string"
                  ? receipt.operationId
                  : undefined,
              );
              if (validated.type === "clock_alarm")
                payload.clockContextRevision =
                  priorPayload.clockContextRevision;
            } else {
              const context = assertClockObservation(validated, observation);
              if (context)
                payload.clockContextRevision = context.alarmsRevision;
            }
          } catch {
            throw new DeviceActionError(
              "Clock observation unavailable or changed",
            );
          }
        }
        if (isMapsOperation(validated)) {
          const receipt = existing?.execution?.providerReceipt;
          const historical =
            existing?.state === "done" &&
            stableStringify(existing.payload) === stableStringify(payload) &&
            receipt &&
            typeof receipt === "object" &&
            !Array.isArray(receipt) &&
            receipt.outcome === "applied";
          if (historical) {
            // Exact canonical duplicate: return the approved historical snapshot,
            // never demand or read a newly selected object. Queue idempotency below
            // still rejects changed immutable proposal fields.
            validateMapsResult(validated, receipt.result);
          } else {
            try {
              assertMapsObservation(validated, observation);
            } catch {
              throw new DeviceActionError(
                "Maps observation unavailable or changed",
              );
            }
          }
        }
        requestOrigin?.assertCurrent();
        if (!deviceAppRecordOperationAvailable(this.runtime, validated))
          throw new DeviceActionError(
            "Device Notes/Calendar record authority changed before enqueue",
          );
        const result = await queue.enqueueTransactional(
          {
            requestedBy: this.runtime.agentId,
            subjectUserId: c.subjectUserId,
            action: "device_action",
            payload,
            channel: "phone",
            reason: text(reason, 1000),
            idempotencyKey,
            expiresAt:
              existing?.expiresAt ?? new Date(Date.now() + 10 * 60_000),
          },
          tx,
        );
        requestOrigin?.assertCurrent();
        deferredRead = await this.bindNewReadCompletion(
          tx,
          row,
          c,
          result,
          {
            operation: validated,
            operationKey,
            reason: text(reason, 1000),
            ...(afterRead !== undefined ? { afterRead } : {}),
          },
          calendarUpdate,
          notesUpdate,
          agenda?.availability?.token === CALENDAR_AVAILABILITY_HOST
            ? agenda.availability.request
            : availabilityReview?.token === CALENDAR_AVAILABILITY_HOST
              ? availabilityReview.request
              : undefined,
        );
        requestOrigin?.assertCurrent();
        return result;
      },
      requestOrigin?.assertCurrent,
    );
    // Retain authority only after the proposal and original context committed.
    if (deferredRead) {
      requestOrigin?.assertCurrent();
      getDeviceActionTurn()?.retainNotesRead?.(deferredRead);
    }
    return result;
  }
  private async requireActiveWorkflow(
    tx: TransactionalDb,
    binding: WorkflowDeviceBinding,
  ): Promise<void> {
    const rows = await executeRawSqlTx(
      tx,
      `SELECT workflow_id, execution FROM workflow.embedded_executions WHERE agent_id = ${sqlText(this.runtime.agentId)} AND id = ${sqlText(binding.runId)} FOR UPDATE`,
    );
    const execution = object(rows[0]?.execution);
    if (
      rows[0]?.workflow_id !== binding.workflowId ||
      execution.workflowVersionId !== binding.versionId ||
      execution.finished === true ||
      execution.cancellationRequestedAt ||
      !["queued", "running", "waiting-approval"].includes(
        String(execution.status),
      )
    )
      throw new DeviceActionError(
        "Workflow is no longer accepting device decisions",
      );
  }
  async validateWorkflowTarget(
    subjectUserId: string,
    target: { installationId: string; enrollmentId: string },
    minimumProtocol = 1,
  ): Promise<void> {
    await this.database().transaction(async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `SELECT enrollment_id,revoked,workflow_protocol FROM client_devices WHERE agent_id=${sqlText(this.runtime.agentId)} AND COALESCE(workflow_owner_id, subject_user_id)=${sqlText(text(subjectUserId, 256))} AND installation_id=${sqlText(identifier(target.installationId))} AND enrollment_id=${sqlText(target.enrollmentId)}`,
      );
      if (
        rows.length !== 1 ||
        rows[0]?.revoked !== false ||
        Number(rows[0]?.workflow_protocol) < minimumProtocol ||
        rows[0]?.enrollment_id !== target.enrollmentId
      )
        throw new DeviceActionError("Workflow device enrollment unavailable");
    });
  }
  /** Server-only dispatcher: authority derives from a persisted admitted run and its pinned spec. */
  async proposeForWorkflow(
    subjectUserId: string,
    dispatch: WorkflowDeviceDispatch,
  ): Promise<ApprovalRequest> {
    const binding = validateWorkflowBinding(dispatch.binding);
    const operation = validateDeviceOperation(dispatch.operation);
    return this.database().transaction(async (tx) => {
      const rows = await executeRawSqlTx(
        tx,
        `SELECT subject_user_id, enrollment_id, revoked, workflow_protocol FROM client_devices WHERE agent_id = ${sqlText(this.runtime.agentId)} AND COALESCE(workflow_owner_id, subject_user_id) = ${sqlText(text(subjectUserId, 256))} AND installation_id = ${sqlText(identifier(dispatch.target.installationId))} AND enrollment_id = ${sqlText(dispatch.target.enrollmentId)} FOR UPDATE`,
      );
      if (
        rows.length !== 1 ||
        rows[0]?.revoked !== false ||
        Number(rows[0]?.workflow_protocol) <
          (["post_notification", "speak_text"].includes(operation.type)
            ? 2
            : 1) ||
        rows[0]?.enrollment_id !== dispatch.target.enrollmentId
      )
        throw new DeviceActionError("Workflow device enrollment unavailable");

      const executions = await executeRawSqlTx(
        tx,
        `SELECT workflow_id, execution FROM workflow.embedded_executions WHERE agent_id = ${sqlText(this.runtime.agentId)} AND id = ${sqlText(binding.runId)} FOR UPDATE`,
      );
      const execution = object(executions[0]?.execution);
      if (
        executions[0]?.workflow_id !== binding.workflowId ||
        execution.workflowVersionId !== binding.versionId ||
        execution.finished === true ||
        execution.cancellationRequestedAt ||
        !["queued", "running", "waiting-approval"].includes(
          String(execution.status),
        )
      )
        throw new DeviceActionError(
          "Workflow run is unavailable for device dispatch",
        );
      const versions = await executeRawSqlTx(
        tx,
        `SELECT workflow FROM workflow.embedded_workflows WHERE agent_id = ${sqlText(this.runtime.agentId)} AND id = ${sqlText(binding.workflowId)} AND version_id = ${sqlText(binding.versionId)} UNION ALL SELECT workflow FROM workflow.workflow_revisions WHERE agent_id = ${sqlText(this.runtime.agentId)} AND workflow_id = ${sqlText(binding.workflowId)} AND version_id = ${sqlText(binding.versionId)}`,
      );
      const definition = object(versions[0]?.workflow),
        metadata = object(definition.metadata);
      if (
        metadata.elizaOwnerEntityId !== subjectUserId ||
        typeof metadata.elizaPhoneWorkflowSpec !== "string"
      )
        throw new DeviceActionError("Workflow owner binding unavailable");
      const spec = object(JSON.parse(metadata.elizaPhoneWorkflowSpec));
      if (
        createHash("sha256").update(JSON.stringify(spec)).digest("hex") !==
        binding.specDigest
      )
        throw new DeviceActionError("Workflow specification changed");
      const target = object(spec.device);
      if (
        target.installationId !== dispatch.target.installationId ||
        target.enrollmentId !== dispatch.target.enrollmentId
      )
        throw new DeviceActionError("Workflow device binding changed");
      const steps = Array.isArray(spec.steps) ? spec.steps : [];
      const step = object(
        steps.find((raw) => object(raw).id === binding.stepId),
      );
      if (operation.type === "create_note") {
        if (
          step.kind !== "Write" ||
          step.operation !== "save_note" ||
          step.title !== operation.title
        )
          throw new DeviceActionError("Workflow write scope changed");
      } else if (operation.type === "read_selected_notes") {
        if (
          step.kind !== "Read" ||
          step.operation !== "selected_notes" ||
          stableStringify(step.notes) !== stableStringify(operation.notes)
        )
          throw new DeviceActionError("Workflow selected Notes scope changed");
      } else if (operation.type === "read_calendar_range") {
        const { type: _type, ...range } = operation;
        if (
          step.kind !== "Read" ||
          step.operation !== "calendar_range" ||
          stableStringify(step.range) !== stableStringify(range)
        )
          throw new DeviceActionError("Workflow Calendar scope changed");
      } else if (operation.type === "post_notification") {
        if (
          step.kind !== "Notify" ||
          step.operation !== "app_notification" ||
          step.title !== operation.title
        )
          throw new DeviceActionError("Workflow notification scope changed");
      } else if (operation.type === "speak_text") {
        if (step.kind !== "Speak" || step.operation !== "read_aloud")
          throw new DeviceActionError("Workflow speech scope changed");
      } else
        throw new DeviceActionError("Unsupported workflow device operation");
      // Workflow ownership stays canonical; phone approvals retain the authenticated device subject.
      const deviceSubjectUserId = text(rows[0].subject_user_id, 256);
      const queue = new PgApprovalQueue(transactionRuntime(this.runtime, tx), {
        agentId: this.runtime.agentId,
      });
      const idempotencyKey = `workflow-device:${digest([subjectUserId, binding.runId, binding.stepId])}`;
      const existing = await queue.byIdempotencyKey(
        idempotencyKey,
        deviceSubjectUserId,
      );
      return (
        await queue.enqueueTransactional(
          {
            requestedBy: this.runtime.agentId,
            subjectUserId: deviceSubjectUserId,
            action: "device_action",
            payload: {
              action: "device_action",
              version: 1,
              installationId: dispatch.target.installationId,
              enrollmentId: dispatch.target.enrollmentId,
              workflow: binding,
              operation,
            },
            channel: "phone",
            reason: `Workflow ${String(definition.name)}: explicit device step review`,
            idempotencyKey,
            expiresAt:
              existing?.expiresAt ?? new Date(Date.now() + 10 * 60_000),
          },
          tx,
        )
      ).request;
    });
  }
  /** Bounded durable outcomes; conversation/actor disclosure is checked by the context reader. */
  async recentCompletedNotes(c: DeviceCredential): Promise<ApprovalRequest[]> {
    return this.access(c, async (queue, row) =>
      (
        await queue.list({
          subjectUserId: c.subjectUserId,
          state: "done",
          action: "device_action",
          limit: 32,
        })
      ).filter((request) => {
        if (
          request.subjectUserId !== c.subjectUserId ||
          request.state !== "done" ||
          request.payload.action !== "device_action"
        )
          return false;
        const payload = validateDevicePayload(request.payload);
        return (
          payload.installationId === c.installationId &&
          payload.enrollmentId === row.enrollment_id &&
          !payload.workflow &&
          !!payload.requestMessageId &&
          ["create_note", "notes_update", "notes_delete"].includes(
            payload.operation.type,
          ) &&
          deviceOperationSupportedByCapabilities(
            payload.operation.type,
            c.capabilities,
          )
        );
      }),
    );
  }
  async list(c: DeviceCredential): Promise<ApprovalRequest[]> {
    return this.access(c, async (queue, row) =>
      (
        await queue.list({
          subjectUserId: c.subjectUserId,
          state: null,
          action: "device_action",
        })
      ).filter((request) => {
        if (
          request.payload.action !== "device_action" ||
          request.payload.installationId !== c.installationId ||
          request.payload.enrollmentId !== row.enrollment_id
        )
          return false;
        const operation = validateDevicePayload(request.payload).operation;
        const supported = deviceOperationSupportedByCapabilities(
          operation.type,
          c.capabilities,
        );
        if (
          (isCameraCapture(operation) ||
            isNativeNotesQuery(operation) ||
            isForegroundReviewOperation(operation) ||
            operation.type === "calendar_create_local" ||
            operation.type === "calendar_read_next") &&
          !supported
        )
          return false;
        return (
          deviceOperationSupportedByCapabilities("open_view", c.capabilities) ||
          supported
        );
      }),
    );
  }
  private async proposal(
    queue: PgApprovalQueue,
    row: Record<string, unknown>,
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    activeWorkflowTx?: TransactionalDb,
  ): Promise<ApprovalRequest> {
    const request = await queue.byId(identifier(id), c.subjectUserId);
    if (!request) throw new DeviceActionError("Proposal unavailable");
    const payload = validateDevicePayload(request.payload);
    if (
      payload.calendarAgendaSource &&
      !c.capabilities?.includes(CALENDAR_AGENDA_CAPABILITY)
    )
      throw new DeviceActionError(
        "Standalone Calendar read capability unavailable",
      );
    if (
      !deviceOperationSupportedByCapabilities(
        payload.operation.type,
        c.capabilities,
      )
    )
      throw new DeviceActionError("Device operation capability unavailable");
    if (
      isClockOperation(payload.operation) &&
      !clockCapabilityAvailable(payload.operation, c.capabilities)
    )
      throw new DeviceActionError("Clock capability unavailable");
    if (
      isMapsOperation(payload.operation) &&
      !c.capabilities?.includes(MAPS_CAPABILITY)
    )
      throw new DeviceActionError("Maps capability unavailable");
    if (
      isReminderCreate(payload.operation) &&
      !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
    )
      throw new DeviceActionError("Reminder creation capability required");
    if (
      isReminderOperation(payload.operation) &&
      !reminderCapabilityAvailable(payload.operation, c.capabilities)
    )
      throw new DeviceActionError("Reminder capability unavailable");
    if (
      isForegroundReviewOperation(payload.operation) &&
      !foregroundReviewOperationAvailable(payload.operation, c.capabilities)
    )
      throw new DeviceActionError("Foreground review capability unavailable");
    if (
      isNativeNotesQuery(payload.operation) &&
      (!c.capabilities?.includes(NOTES_QUERY_CAPABILITY) ||
        !c.capabilities.includes(NOTES_CAPABILITY))
    )
      throw new DeviceActionError("Notes query capability unavailable");
    if (
      isNotesOperation(payload.operation) &&
      !c.capabilities?.includes(NOTES_CAPABILITY)
    )
      throw new DeviceActionError("Notes capability unavailable");
    if (
      isCalendarOperation(payload.operation) &&
      !calendarCapabilityAvailable(payload.operation.type, c.capabilities)
    )
      throw new DeviceActionError("Calendar capability unavailable");
    if (
      payload.installationId !== c.installationId ||
      payload.enrollmentId !== row.enrollment_id ||
      deviceProposalDigest(request) !== expectedDigest
    )
      throw new DeviceActionError("Proposal binding changed");
    if (
      activeWorkflowTx &&
      payload.workflow &&
      Number(row.workflow_protocol) <
        (["post_notification", "speak_text"].includes(payload.operation.type)
          ? 2
          : 1)
    )
      throw new DeviceActionError("Workflow device protocol unavailable");
    if (activeWorkflowTx && payload.workflow)
      await this.requireActiveWorkflow(activeWorkflowTx, payload.workflow);
    return request;
  }
  async decide(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    approve: boolean,
  ): Promise<ApprovalRequest> {
    return this.access(c, async (q, row, tx) => {
      const request = await this.proposal(q, row, c, id, expectedDigest, tx);
      if (approve)
        this.assertViewProfile(row, validateDevicePayload(request.payload));
      const target = approve ? "approved" : "rejected";
      if (request.state === target) return request;
      if (
        request.state !== "pending" ||
        request.expiresAt.getTime() <= Date.now()
      )
        throw new DeviceActionError("Proposal is no longer pending");
      return q[approve ? "approve" : "reject"](id, c.subjectUserId, {
        resolvedBy: c.subjectUserId,
        resolutionReason: `Explicit device review:${expectedDigest}`,
      });
    });
  }
  async claim(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
  ): Promise<ApprovalRequest> {
    return this.access(c, async (q, row, tx) => {
      const request = await this.proposal(q, row, c, id, expectedDigest, tx);
      this.assertViewProfile(row, validateDevicePayload(request.payload));
      if (
        request.state !== "approved" ||
        request.expiresAt.getTime() <= Date.now() ||
        request.resolvedBy !== c.subjectUserId ||
        request.resolutionReason !== `Explicit device review:${expectedDigest}`
      )
        throw new DeviceActionError("Proposal cannot be claimed");
      const claimed = await q.claimExecution({
        requestId: id,
        subjectUserId: c.subjectUserId,
        provider: `device:${row.enrollment_id}`,
        providerIdempotencyKey: id,
      });
      if (!claimed.execution)
        throw new DeviceActionError(
          "Missing execution claim",
          "DEVICE_STORE_UNAVAILABLE",
        );
      // Commit dispatch before returning the permit. Lost responses require journal reconciliation, never another effect.
      return q.markDispatchStarted({
        requestId: id,
        subjectUserId: c.subjectUserId,
        attemptId: claimed.execution.attemptId,
      });
    });
  }
  async receipt(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    attemptId: string,
    raw: unknown,
  ): Promise<ApprovalRequest> {
    const value = object(raw);
    exactKeys(value, ["outcome", "operationId", "code", "result"]);
    if (
      value.outcome !== "applied" &&
      value.outcome !== "failed" &&
      value.outcome !== "unknown"
    )
      throw new DeviceActionError("Invalid receipt outcome");
    let receipt: Record<string, unknown> = {
      outcome: value.outcome,
      ...(value.operationId === undefined
        ? {}
        : { operationId: identifier(value.operationId) }),
      ...(value.code === undefined ? {} : { code: identifier(value.code) }),
    };
    if (receipt.outcome === "applied" && !receipt.operationId)
      throw new DeviceActionError(
        "Applied receipt needs a native operation identifier",
      );
    return this.access(c, async (q, row) => {
      const request = await this.proposal(q, row, c, id, expectedDigest);
      const payload = validateDevicePayload(request.payload);
      if (
        isSmsSend(payload.operation) &&
        !c.capabilities?.includes(SMS_SEND_CAPABILITY)
      )
        throw new DeviceActionError("SMS capability unavailable");
      if (
        isCalendarOperation(payload.operation) &&
        !calendarCapabilityAvailable(payload.operation.type, c.capabilities)
      )
        throw new DeviceActionError("Calendar capability unavailable");
      if (
        isClockOperation(payload.operation) &&
        !clockCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Clock capability unavailable");
      if (
        isMapsOperation(payload.operation) &&
        !c.capabilities?.includes(MAPS_CAPABILITY)
      )
        throw new DeviceActionError("Maps capability unavailable");
      if (
        isReminderCreate(payload.operation) &&
        !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
      )
        throw new DeviceActionError("Reminder creation capability required");
      if (
        isReminderOperation(payload.operation) &&
        !reminderCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Reminder capability unavailable");
      if (
        isNativeNotesQuery(payload.operation) &&
        (!c.capabilities?.includes(NOTES_QUERY_CAPABILITY) ||
          !c.capabilities.includes(NOTES_CAPABILITY))
      )
        throw new DeviceActionError("Notes query capability unavailable");
      if (
        isNotesOperation(payload.operation) &&
        !c.capabilities?.includes(NOTES_CAPABILITY)
      )
        throw new DeviceActionError("Notes capability unavailable");
      const read =
        payload.operation.type === "read_selected_notes" ||
        payload.operation.type === "read_calendar_range";
      if (isSmsSend(payload.operation)) {
        if (receipt.operationId !== request.execution?.providerIdempotencyKey)
          throw new DeviceActionError(
            "SMS journal identity differs from execution claim",
          );
        // Missing evidence can only preserve uncertainty, never prove a send or enable retry.
        if (receipt.outcome !== "unknown" || value.result !== undefined) {
          try {
            const result = validateSmsResult(
              payload.operation,
              value.result,
              identifier(receipt.operationId),
              createHash("sha256")
                .update(smsBindingText(payload.operation))
                .digest("hex"),
            );
            const outcome = smsReceiptOutcome(result);
            if (
              receipt.outcome !== outcome &&
              !(receipt.outcome === "not_applied" && outcome === "failed")
            )
              throw new DeviceActionError(
                "SMS receipt outcome conflicts with native evidence",
              );
            receipt = { ...receipt, result };
          } catch {
            throw new DeviceActionError("Invalid SMS receipt");
          }
        }
      } else if (isCameraCapture(payload.operation)) {
        if (receipt.outcome === "applied") {
          try {
            receipt = {
              ...receipt,
              result: validateCameraCaptureResult(
                value.result,
                identifier(receipt.operationId),
              ),
            };
          } catch {
            throw new DeviceActionError("Invalid Camera receipt");
          }
        } else if (value.result !== undefined) {
          throw new DeviceActionError(
            "Unconfirmed Camera capture cannot return a saved photo",
          );
        }
      } else if (isClockOperation(payload.operation)) {
        try {
          if (receipt.outcome !== "unknown" || value.result !== undefined)
            receipt = {
              ...receipt,
              result: validateClockResult(
                payload.operation,
                value.result,
                receipt.outcome,
                typeof receipt.operationId === "string"
                  ? receipt.operationId
                  : undefined,
              ),
            };
        } catch {
          throw new DeviceActionError("Invalid Clock receipt");
        }
      } else if (
        isMapsOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateMapsResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Maps receipt");
        }
      } else if (
        (isReminderOperation(payload.operation) ||
          isReminderCreate(payload.operation)) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: isReminderCreate(payload.operation)
              ? validateReminderCreateResult(
                  payload.operation,
                  value.result,
                  identifier(receipt.operationId),
                )
              : validateReminderResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid reminder receipt");
        }
      } else if (
        isNativeNotesQuery(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateNotesQueryResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Notes query receipt");
        }
      } else if (
        isNotesOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateNotesResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Notes receipt");
        }
      } else if (
        isCalendarOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateCalendarResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Calendar receipt");
        }
      } else if (
        isForegroundReviewOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateForegroundReviewResult(
              payload.operation,
              value.result,
              c.capabilities ?? [],
            ),
          };
        } catch {
          throw new DeviceActionError("Invalid foreground review receipt");
        }
      } else if (read && receipt.outcome === "applied") {
        receipt = {
          ...receipt,
          result: validateWorkflowReadResult(
            payload.operation as import("./workflow-contract.ts").WorkflowReadOperation,
            value.result,
          ),
        };
      } else if (value.result !== undefined)
        throw new DeviceActionError("Unexpected device read result");
      if (request.execution?.attemptId !== identifier(attemptId))
        throw new DeviceActionError("Execution attempt mismatch");
      if (
        request.state === "done" ||
        request.state === "reconciliation_required"
      ) {
        if (
          stableStringify(request.execution.providerReceipt) ===
          stableStringify(receipt)
        )
          return request;
        throw new DeviceActionError("Receipt conflicts with durable outcome");
      }
      const mutation = {
        requestId: id,
        subjectUserId: c.subjectUserId,
        attemptId,
        providerReceipt: receipt,
      };
      return receipt.outcome === "applied"
        ? q.markDone(mutation)
        : q.markReconciliationRequired({
            ...mutation,
            error: `Device outcome:${receipt.outcome}`,
          });
    });
  }
  /** A separate owner review settles uncertainty; it never re-dispatches. */
  async reconcile(
    c: DeviceCredential,
    id: string,
    expectedDigest: string,
    attemptId: string,
    raw: unknown,
  ): Promise<ApprovalRequest> {
    const value = object(raw);
    exactKeys(value, ["confirmed", "outcome", "operationId", "result"]);
    if (
      value.confirmed !== true ||
      (value.outcome !== "applied" && value.outcome !== "not_applied")
    )
      throw new DeviceActionError("Explicit outcome review required");
    let receipt: Record<string, unknown> = {
      outcome: value.outcome,
      ...(value.operationId === undefined
        ? {}
        : { operationId: identifier(value.operationId) }),
    };
    if (receipt.outcome === "applied" && !receipt.operationId)
      throw new DeviceActionError(
        "Applied outcome needs a native operation identifier",
      );
    return this.access(c, async (q, row) => {
      const request = await this.proposal(q, row, c, id, expectedDigest);
      const payload = validateDevicePayload(request.payload);
      if (
        isSmsSend(payload.operation) &&
        !c.capabilities?.includes(SMS_SEND_CAPABILITY)
      )
        throw new DeviceActionError("SMS capability unavailable");
      if (
        isCalendarOperation(payload.operation) &&
        !calendarCapabilityAvailable(payload.operation.type, c.capabilities)
      )
        throw new DeviceActionError("Calendar capability unavailable");
      if (
        isClockOperation(payload.operation) &&
        !clockCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Clock capability unavailable");
      if (
        isMapsOperation(payload.operation) &&
        !c.capabilities?.includes(MAPS_CAPABILITY)
      )
        throw new DeviceActionError("Maps capability unavailable");
      if (
        isReminderCreate(payload.operation) &&
        !c.capabilities?.includes(REMINDER_CREATE_CAPABILITY)
      )
        throw new DeviceActionError("Reminder creation capability required");
      if (
        isReminderOperation(payload.operation) &&
        !reminderCapabilityAvailable(payload.operation, c.capabilities)
      )
        throw new DeviceActionError("Reminder capability unavailable");
      if (
        isNativeNotesQuery(payload.operation) &&
        (!c.capabilities?.includes(NOTES_QUERY_CAPABILITY) ||
          !c.capabilities.includes(NOTES_CAPABILITY))
      )
        throw new DeviceActionError("Notes query capability unavailable");
      if (
        isNotesOperation(payload.operation) &&
        !c.capabilities?.includes(NOTES_CAPABILITY)
      )
        throw new DeviceActionError("Notes capability unavailable");
      if (isSmsSend(payload.operation)) {
        if (receipt.operationId !== request.execution?.providerIdempotencyKey)
          throw new DeviceActionError(
            "SMS journal identity differs from execution claim",
          );
        // Missing evidence can only preserve uncertainty, never prove a send or enable retry.
        if (receipt.outcome !== "unknown" || value.result !== undefined) {
          try {
            const result = validateSmsResult(
              payload.operation,
              value.result,
              identifier(receipt.operationId),
              createHash("sha256")
                .update(smsBindingText(payload.operation))
                .digest("hex"),
            );
            const outcome = smsReceiptOutcome(result);
            if (
              receipt.outcome !== outcome &&
              !(receipt.outcome === "not_applied" && outcome === "failed")
            )
              throw new DeviceActionError(
                "SMS receipt outcome conflicts with native evidence",
              );
            receipt = { ...receipt, result };
          } catch {
            throw new DeviceActionError("Invalid SMS receipt");
          }
        }
      } else if (isCameraCapture(payload.operation)) {
        if (receipt.outcome === "applied") {
          try {
            receipt = {
              ...receipt,
              result: validateCameraCaptureResult(
                value.result,
                identifier(receipt.operationId),
              ),
            };
          } catch {
            throw new DeviceActionError("Invalid Camera receipt");
          }
        } else if (value.result !== undefined) {
          throw new DeviceActionError(
            "Unconfirmed Camera capture cannot return a saved photo",
          );
        }
      } else if (isClockOperation(payload.operation)) {
        try {
          if (receipt.outcome !== "unknown" || value.result !== undefined)
            receipt = {
              ...receipt,
              result: validateClockResult(
                payload.operation,
                value.result,
                receipt.outcome,
                typeof receipt.operationId === "string"
                  ? receipt.operationId
                  : undefined,
              ),
            };
        } catch {
          throw new DeviceActionError("Invalid Clock receipt");
        }
      } else if (
        isMapsOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateMapsResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Maps receipt");
        }
      } else if (
        (isReminderOperation(payload.operation) ||
          isReminderCreate(payload.operation)) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: isReminderCreate(payload.operation)
              ? validateReminderCreateResult(
                  payload.operation,
                  value.result,
                  identifier(receipt.operationId),
                )
              : validateReminderResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid reminder receipt");
        }
      } else if (
        isNativeNotesQuery(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateNotesQueryResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Notes query receipt");
        }
      } else if (
        isNotesOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateNotesResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Notes receipt");
        }
      } else if (
        isCalendarOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateCalendarResult(payload.operation, value.result),
          };
        } catch {
          throw new DeviceActionError("Invalid Calendar receipt");
        }
      } else if (
        isForegroundReviewOperation(payload.operation) &&
        receipt.outcome === "applied"
      ) {
        try {
          receipt = {
            ...receipt,
            result: validateForegroundReviewResult(
              payload.operation,
              value.result,
              c.capabilities ?? [],
            ),
          };
        } catch {
          throw new DeviceActionError("Invalid foreground review receipt");
        }
      } else if (
        (payload.operation.type === "read_selected_notes" ||
          payload.operation.type === "read_calendar_range") &&
        receipt.outcome === "applied"
      ) {
        receipt = {
          ...receipt,
          result: validateWorkflowReadResult(payload.operation, value.result),
        };
      } else if (value.result !== undefined)
        throw new DeviceActionError("Unexpected reconciliation read result");
      if (request.execution?.attemptId !== identifier(attemptId))
        throw new DeviceActionError("Execution attempt mismatch");
      if (
        (request.state === "done" || request.state === "retryable") &&
        request.execution.reconciledBy === c.subjectUserId &&
        stableStringify(request.execution.providerReceipt) ===
          stableStringify(receipt)
      )
        return request;
      if (request.state !== "reconciliation_required")
        throw new DeviceActionError("No uncertain outcome to reconcile");
      return q.reconcileExecution({
        requestId: id,
        subjectUserId: c.subjectUserId,
        attemptId,
        outcome: receipt.outcome === "applied" ? "delivered" : "not_delivered",
        reconciledBy: c.subjectUserId,
        reconciliationReason:
          "Explicit owner review of native operation journal",
        providerReceipt: receipt,
      });
    });
  }
}

/** Existing CALENDAR feed delegates here; model parameters cannot create the host marker. */
export async function requestLocalCalendarAgenda(
  args: {
    runtime: IAgentRuntime;
    message: Memory;
    window: {
      start: string;
      end: string;
      timeZone: string;
      maximumEvents: number;
    };
  },
  availability?: {
    token: typeof CALENDAR_AVAILABILITY_HOST;
    request: ReviewedAvailabilityRequest;
  },
) {
  const unavailable = (
    reason:
      | "turn_unavailable"
      | "runtime_mismatch"
      | "message_mismatch"
      | "turn_expired"
      | "capability_missing"
      | "request_origin_unavailable",
  ) => ({
    success: false,
    text: "This request could not verify current requesting-device Calendar agenda access. Its local Calendar was not read.",
    data: {
      code: "CALENDAR_AGENDA_UNAVAILABLE",
      reason,
      localCalendarRead: false,
      retryable: false,
    },
    turnComplete: false,
    modelReplyRequired: true,
  });
  const active = getDeviceActionTurn();
  if (!active) return unavailable("turn_unavailable");
  if (active.runtime !== args.runtime) return unavailable("runtime_mismatch");
  if (active.replyContext?.message !== args.message)
    return unavailable("message_mismatch");
  if (!active.isCurrent()) return unavailable("turn_expired");
  if (!active.credential.capabilities?.includes(CALENDAR_AGENDA_CAPABILITY))
    return unavailable("capability_missing");
  // Authenticated subjects and mapped conversation entity UUIDs are different
  // identities. Reuse the canonical durable OWNER-request proof, which binds
  // this runtime, credential, installation, original message and stored actor.
  const origin = await currentRequestedActionOrigin(args.runtime, args.message);
  if (!origin) return unavailable("request_origin_unavailable");
  origin.assertCurrent();
  const metadata = object(args.message.content.metadata),
    device = object(metadata.clientDevice),
    context = requireTurnObservation(metadata);
  if (context.sensitive === true)
    throw new DeviceActionError("Calendar context is private");
  if (!device.calendarAgendaSource)
    return {
      success: false,
      text: "The requesting device Calendar source is unavailable. Its local agenda was not read; do not substitute another calendar.",
      data: {
        code: "CALENDAR_AGENDA_SOURCE_UNAVAILABLE",
        localCalendarRead: false,
      },
      turnComplete: false,
      modelReplyRequired: true,
    };
  const observed = calendarSource(device.calendarAgendaSource);
  const operation = validateWorkflowReadOperation({
    type: "read_calendar_range",
    calendarIds: [observed.sourceId],
    ...args.window,
  });
  const outcome = await new DeviceActionService(
    args.runtime,
  ).proposeWithOutcome(
    active.credential,
    operation,
    (availability?.token === CALENDAR_AVAILABILITY_HOST
      ? "availability_"
      : "agenda_") +
      digest([
        args.message.id,
        operation,
        observed,
        ...(availability?.token === CALENDAR_AVAILABILITY_HOST
          ? [availability.request]
          : []),
      ]),
    "Read the app Calendar from " +
      args.window.start +
      " to " +
      args.window.end +
      " (exclusive), in " +
      args.window.timeZone +
      ". Only this approved source/window is shared.",
    undefined,
    undefined,
    {
      token: CALENDAR_AGENDA_HOST,
      source: observed,
      ...(availability?.token === CALENDAR_AVAILABILITY_HOST
        ? { availability }
        : {}),
    },
  );
  origin.assertCurrent();
  return {
    success: true,
    text: "The exact local Calendar range read is pending on the requesting device. No event data has been read or shared yet; await its approved receipt.",
    data: {
      proposalId: outcome.request.id,
      state: outcome.request.state,
      executed: false,
      approvalRequired: outcome.request.state === "pending",
      localCalendarRead: false,
      calendarWindow: args.window,
    },
    turnComplete: false,
    modelReplyRequired: true,
  };
}

/** First-class Calendar and the narrow device tool share this existing selected-read path. */
export async function requestLocalCalendarUpdate(args: {
  runtime: IAgentRuntime;
  message: Memory;
  name?: string;
}) {
  const active = getDeviceActionTurn();
  if (!active || active.runtime !== args.runtime) return;
  if (args.name !== undefined) {
    const fail = (text: string) => ({
      success: false,
      text,
      data: { code: "CALENDAR_NAMED_UPDATE_UNAVAILABLE" },
      turnComplete: false,
      modelReplyRequired: true,
    });
    const metadata = args.message.content.metadata,
      context = requireTurnObservation(metadata);
    if (
      active.replyContext?.message !== args.message ||
      !active.isCurrent() ||
      deviceReadHostContextRevision(args.runtime) === null ||
      context.sensitive === true ||
      !["home", "calendar"].includes(String(context.view)) ||
      typeof context.timeZone !== "string" ||
      ![CALENDAR_CAPABILITY, CALENDAR_NAMED_READ_CAPABILITY].every((cap) =>
        active.credential.capabilities?.includes(cap),
      )
    )
      return fail(
        "Current named-event read access is unavailable. No event was read or changed.",
      );
    const origin = await currentRequestedActionOrigin(
      args.runtime,
      args.message,
    );
    if (!origin)
      return fail(
        "The original event edit request could not be verified. No event was read or changed.",
      );
    origin.assertCurrent();
    const operation = validateNamedCalendarRead({
      type: "calendar_named",
      action: "read",
      name: args.name,
    });
    const outcome = await new DeviceActionService(
      args.runtime,
    ).proposeWithOutcome(
      active.credential,
      operation,
      "calendar_update_named_" + digest([args.message.id, operation]),
      "Choose the exact matching event in Calendar, then Share its current snapshot for the original edit. Sharing does not approve any update.",
      context,
      undefined,
      undefined,
      CALENDAR_UPDATE_HOST,
    );
    origin.assertCurrent();
    return {
      success: true,
      text: "Choose the matching event in Calendar and share its current details to prepare the requested update review. No event has changed yet.",
      data: {
        proposalId: outcome.request.id,
        state: outcome.request.state,
        executed: false,
        approvalRequired: outcome.request.state === "pending",
        calendarUpdatePendingRead: outcome.request.state === "pending",
      },
      turnComplete: false,
      modelReplyRequired: true,
    };
  }
  const timeOnly = originalRequestsCalendarTimeUpdate(args.message);
  const metadata = args.message.content.metadata,
    context = requireTurnObservation(metadata),
    selected = context.selectedObject;
  if (context.view !== "calendar" || context.sensitive === true || !selected)
    return;
  const value = selected;
  if (value.kind !== "calendar-event") return;
  if (
    active.replyContext?.message !== args.message ||
    !active.isCurrent() ||
    !active.credential.capabilities?.includes(CALENDAR_CAPABILITY)
  )
    return {
      success: false,
      text: "The original selected-event update authority is unavailable. Nothing was read or changed.",
      data: { code: "CALENDAR_TIME_UPDATE_UNAVAILABLE" },
      turnComplete: false,
      modelReplyRequired: true,
    };
  if (deviceReadHostContextRevision(args.runtime) === null)
    return {
      success: false,
      text: "This host cannot retain the original selected-event update review. Nothing was read or changed.",
      data: { code: "CALENDAR_TIME_UPDATE_UNAVAILABLE" },
      turnComplete: false,
      modelReplyRequired: true,
    };
  const origin = await currentRequestedActionOrigin(args.runtime, args.message);
  if (!origin)
    return {
      success: false,
      text: "The original Calendar request could not be verified. Nothing was read or changed.",
      data: { code: "CALENDAR_TIME_UPDATE_UNAVAILABLE" },
      turnComplete: false,
      modelReplyRequired: true,
    };
  origin.assertCurrent();
  const operation = validateCalendarOperation({
    type: "calendar_read_selected",
    target: {
      sourceId: value.accountId,
      sourceRevision: value.sourceRevision,
      eventId: value.id,
      revision: value.revision,
    },
  });
  const outcome = await new DeviceActionService(
    args.runtime,
  ).proposeWithOutcome(
    active.credential,
    operation,
    (timeOnly ? "calendar_time_" : "calendar_update_") +
      digest([args.message.id, operation]),
    "Read the selected event for the original requested changes. Sharing does not approve editing; a separate update review follows.",
    context,
    undefined,
    undefined,
    timeOnly ? undefined : CALENDAR_UPDATE_HOST,
  );
  origin.assertCurrent();
  return {
    success: true,
    text:
      outcome.request.state === "pending"
        ? "Share the selected Calendar event to prepare its requested update review. No event has changed yet."
        : "This original selected-read request is already recorded. Complete its existing review or inspect action history; no new edit was performed.",
    data: {
      proposalId: outcome.request.id,
      state: outcome.request.state,
      executed: false,
      approvalRequired: outcome.request.state === "pending",
      calendarUpdatePendingRead: outcome.request.state === "pending",
    },
    turnComplete: false,
    modelReplyRequired: true,
  };
}

/** Routing is not effect authority. Stage1 runs before the OWNER reply-context setter;
 * this checks the authenticated request envelope/selection while the action's normal
 * gates admit planning. The existing helper still rechecks durable origin and reviews. */
export function registerLocalCalendarTimeUpdateRouting(
  runtime: IAgentRuntime,
): void {
  const matches = (_text: string, message?: Memory): boolean => {
    const active = getDeviceActionTurn();
    if (
      !message ||
      !active ||
      active.runtime !== runtime ||
      !active.isCurrent() ||
      !active.credential.capabilities?.includes(CALENDAR_CAPABILITY) ||
      deviceReadHostContextRevision(runtime) === null ||
      message.agentId !== runtime.agentId ||
      !message.id ||
      message.entityId === runtime.agentId ||
      message.content.source !== "client_chat" ||
      !["DM", "VOICE_DM"].includes(String(message.content.channelType))
    )
      return false;
    const metadata = message.content.metadata;
    if (
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      Reflect.get(metadata, "agentActionMode") !== "direct-request-v1"
    )
      return false;
    const marker = readDurableConversationChatMarker(
      message.content.chatIdempotency,
    );
    if (
      !marker ||
      conversationClientUserMemoryId(marker.scope, marker.clientMessageId) !==
        message.id
    )
      return false;
    try {
      const context = requireTurnObservation(metadata),
        selected = object(context.selectedObject);
      if (
        context.view !== "calendar" ||
        context.sensitive === true ||
        selected.kind !== "calendar-event" ||
        typeof context.timeZone !== "string"
      )
        return false;
      validateCalendarOperation({
        type: "calendar_read_selected",
        target: {
          sourceId: selected.accountId,
          sourceRevision: selected.sourceRevision,
          eventId: selected.id,
          revision: selected.revision,
        },
      });
      return wholeSelectedCalendarTimeRequest(message, context.timeZone);
    } catch {
      return false;
    }
  };
  registerDirectActionRoutingRule(runtime, {
    id: "calendar.selected-device-time-update",
    actionNames: ["DEVICE_CALENDAR_UPDATE"],
    requiredActionTags: [
      "domain:calendar",
      "capability:write",
      "effect:receipt-required",
      "target:selected-device",
    ],
    contexts: ["calendar", "general"],
    matches,
    wholeRequest: {
      matches,
      invalidateFields: ["calendarReadBindings", "visualContinuation"],
    },
  });
}

/** Selected Notes updates never accept model-authored replacement fields or old titles. */
export async function requestLocalNotesUpdate(args: {
  runtime: IAgentRuntime;
  message: Memory;
  name?: string;
}) {
  const active = getDeviceActionTurn();
  if (!active || active.runtime !== args.runtime) return;
  const metadata = args.message.content.metadata,
    context = requireTurnObservation(metadata),
    named = args.name !== undefined;
  if (
    context.sensitive === true ||
    !(named
      ? ["home", "notes"].includes(String(context.view))
      : context.view === "notes")
  )
    return;
  if (
    active.replyContext?.message !== args.message ||
    !active.isCurrent() ||
    !active.credential.capabilities?.includes(NOTES_CAPABILITY) ||
    deviceReadHostContextRevision(args.runtime) === null
  )
    return {
      success: false,
      text: "The current note update authority is unavailable. Nothing was read or changed.",
      data: { code: "NOTES_UPDATE_UNAVAILABLE" },
      turnComplete: false,
      modelReplyRequired: true,
    };
  let operation;
  if (named) {
    if (
      !active.credential.capabilities.includes(NAMED_TARGET_CAPABILITY) ||
      !active.credential.capabilities.includes(NOTES_QUERY_CAPABILITY)
    )
      return {
        success: false,
        text: "Current named-note lookup access is unavailable. Nothing was read or changed.",
        data: { code: "NOTES_UPDATE_UNAVAILABLE" },
        turnComplete: false,
        modelReplyRequired: true,
      };
    operation = validateNativeNotesQuery({
      type: "notes_query",
      query: { kind: "title", text: args.name },
    });
  } else {
    let target;
    try {
      target = notesSelectionTarget(context.selectedObject);
    } catch {
      return {
        success: false,
        text: "Select the exact note to prepare its edit. Nothing was read or changed.",
        data: { code: "NOTES_UPDATE_SELECTION_UNAVAILABLE" },
        turnComplete: false,
        modelReplyRequired: true,
      };
    }
    operation = validateNotesOperation({ type: "notes_read_selected", target });
  }
  const origin = await currentRequestedActionOrigin(args.runtime, args.message);
  if (!origin)
    return {
      success: false,
      text: "The original note edit request could not be verified. Nothing was read or changed.",
      data: { code: "NOTES_UPDATE_UNAVAILABLE" },
      turnComplete: false,
      modelReplyRequired: true,
    };
  origin.assertCurrent();
  const outcome = await new DeviceActionService(
    args.runtime,
  ).proposeWithOutcome(
    active.credential,
    operation,
    "notes_update_" + digest([args.message.id, operation]),
    "Read the exact note for the original requested edit. Sharing does not approve the update; a separate review follows.",
    context,
    undefined,
    undefined,
    undefined,
    named ? undefined : NOTES_UPDATE_HOST,
  );
  origin.assertCurrent();
  return {
    success: true,
    text:
      outcome.request.state === "pending"
        ? "Share the exact note to prepare the requested edit review. No note has changed yet."
        : "The original note read is already recorded. Inspect its existing review or receipt; no new edit was performed.",
    data: {
      proposalId: outcome.request.id,
      state: outcome.request.state,
      executed: false,
      approvalRequired: outcome.request.state === "pending",
      notesUpdatePendingRead: outcome.request.state === "pending",
    },
    turnComplete: false,
    modelReplyRequired: true,
  };
}

/** Only an explicitly selected native Calendar uses this bridge; ordinary app availability stays with CalendarService. */
export async function requestLocalCalendarAvailability(args: {
  runtime: IAgentRuntime;
  message: Memory;
  request: ReviewedAvailabilityRequest;
}) {
  const active = getDeviceActionTurn();
  if (!active || active.runtime !== args.runtime) return;
  const source = currentAppRecordSource(args.runtime, "calendar", args.message);
  // A native bridge capability does not select its separate Calendar store.
  // Declining this hook lets the canonical action inspect its runtime feed.
  if (source === "runtime") return;
  const fail = (text: string) => ({
    success: false,
    text,
    data: {
      code: "LOCAL_CALENDAR_AVAILABILITY_UNAVAILABLE",
      definitive: false,
    },
    turnComplete: false,
    modelReplyRequired: true,
  });
  if (source === "unavailable")
    return fail(
      "The current Calendar source cannot be verified. No calendar was read.",
    );
  if (
    ![
      CALENDAR_CAPABILITY,
      CALENDAR_CREATE_CAPABILITY,
      CALENDAR_NEXT_CAPABILITY,
      CALENDAR_AGENDA_CAPABILITY,
      CALENDAR_AVAILABILITY_CAPABILITY,
    ].some((capability) => active.credential.capabilities?.includes(capability))
  )
    return fail(
      "Current requesting-device Calendar access is unavailable. No calendar was read.",
    );
  if (
    !active.isCurrent() ||
    !active.credential.capabilities?.includes(CALENDAR_AGENDA_CAPABILITY) ||
    deviceReadHostContextRevision(args.runtime) === null
  )
    return fail(
      "Current requesting-device Calendar availability access is unavailable. No calendar was read.",
    );
  let request = validateReviewedAvailabilityRequest(args.request);
  if (
    request.proposal?.attendees?.length ||
    request.proposal?.guestAvailabilityGrantIds?.length
  )
    return fail(
      "The app-calendar read cannot verify the requested guest calendars. Guest availability remains unknown; no calendar was read.",
    );
  const metadata = args.message.content.metadata,
    context = requireTurnObservation(metadata);
  if (context.sensitive === true || context.timeZone !== request.timeZone)
    return fail(
      "The current Calendar time zone or private context changed. Availability was not checked.",
    );
  if (request.proposal) {
    const origin = await currentRequestedActionOrigin(
      args.runtime,
      args.message,
    );
    if (!origin)
      return fail(
        "The original availability request could not be verified. No calendar was read.",
      );
    const original = await originalAvailabilityWindow({
      runtime: args.runtime,
      message: args.message,
      timeZone: context.timeZone as string,
      signal: getStreamingContext()?.abortSignal,
    });
    origin.assertCurrent();
    if (!original.request)
      return fail(
        original.text ??
          "The availability window needs clarification. No calendar was read.",
      );
    request = validateReviewedAvailabilityRequest({
      ...original.request,
      ...(request.policy ? { policy: request.policy } : {}),
    });
  }

  const result = await requestLocalCalendarAgenda(
    {
      runtime: args.runtime,
      message: args.message,
      window: {
        ...request.range,
        timeZone: request.timeZone,
        maximumEvents: 200,
      },
    },
    { token: CALENDAR_AVAILABILITY_HOST, request },
  );
  return {
    ...result,
    text: result.success
      ? "Share the exact app-calendar window for a local availability check. No availability result is established yet."
      : result.text,
    data: {
      ...result.data,
      availabilityReadPending: result.success,
      scope: "reviewed-app-calendar-only",
      definitive: false,
    },
  };
}

/** Generic native availability uses the same original/readable window as the canonical conflict port. */
export async function requestOriginalNativeCalendarAvailability(args: {
  runtime: IAgentRuntime;
  message: Memory;
}) {
  const active = getDeviceActionTurn();
  const fail = (text: string) => ({
    success: false,
    text,
    data: {
      code: "CALENDAR_ORIGINAL_AVAILABILITY_UNAVAILABLE",
      definitive: false,
    },
    turnComplete: false,
    modelReplyRequired: true,
  });
  if (
    !active ||
    active.runtime !== args.runtime ||
    !active.isCurrent() ||
    !active.credential.capabilities?.includes(
      CALENDAR_AVAILABILITY_CAPABILITY,
    ) ||
    deviceReadHostContextRevision(args.runtime) === null
  )
    return fail(
      "Current requesting-device availability access is unavailable. No calendar was read.",
    );
  const metadata = args.message.content.metadata,
    context = requireTurnObservation(metadata);
  if (context.sensitive === true || typeof context.timeZone !== "string")
    return fail(
      "The current private context or time zone is unavailable. No calendar was read.",
    );
  const origin = await currentRequestedActionOrigin(args.runtime, args.message);
  if (!origin)
    return fail(
      "The original availability request could not be verified. No calendar was read.",
    );
  origin.assertCurrent();
  const interpreted = await originalAvailabilityWindow({
    runtime: args.runtime,
    message: args.message,
    timeZone: context.timeZone,
    signal: getStreamingContext()?.abortSignal,
  });
  origin.assertCurrent();
  if (!interpreted.request)
    return fail(
      interpreted.text ??
        "The availability window needs clarification. No calendar was read.",
    );
  const request = interpreted.request;
  const operation = validateDeviceOperation({
    type: "calendar_availability",
    ...request.range,
    timeZone: request.timeZone,
  });
  const outcome = await new DeviceActionService(
    args.runtime,
  ).proposeWithOutcome(
    active.credential,
    operation,
    "availability_original_" + digest([args.message.id, operation]),
    "Check the original requested availability window. The owner chooses calendars and reviews only busy intervals.",
    context,
    undefined,
    undefined,
    undefined,
    undefined,
    { token: CALENDAR_AVAILABILITY_HOST, request },
  );
  origin.assertCurrent();
  return {
    success: true,
    text: "The original requested availability window is ready for Calendar review. No calendar has been read yet.",
    data: {
      proposalId: outcome.request.id,
      state: outcome.request.state,
      executed: false,
      approvalRequired: outcome.request.state === "pending",
      availabilityReadPending: true,
      definitive: false,
    },
    turnComplete: false,
    modelReplyRequired: true,
  };
}

type NativeCalendarCreatePlanner = (args: {
  message: Memory;
  timeZone: string;
  signal: AbortSignal;
}) => Promise<{ fields?: CalendarFields; text: string }>;
const localCalendarCreatePlanners = new WeakMap<
  IAgentRuntime,
  NativeCalendarCreatePlanner
>();
export function registerLocalCalendarCreatePlanner(
  runtime: IAgentRuntime,
  planner: NativeCalendarCreatePlanner,
) {
  localCalendarCreatePlanners.set(runtime, planner);
}

/** Both generic creation variants prepare the original canonical plan, not model fields. */
export async function requestLocalCalendarCreate(args: {
  runtime: IAgentRuntime;
  message: Memory;
  type?: "calendar_create_local" | "calendar_create";
}) {
  const active = getDeviceActionTurn();
  if (!active || active.runtime !== args.runtime) return;
  const type = args.type ?? "calendar_create_local",
    metadata = args.message.content.metadata,
    context = requireTurnObservation(metadata);
  const fail = (text: string) => ({
    success: false,
    text,
    data: { code: "CALENDAR_CREATE_ORIGINAL_UNAVAILABLE" },
    turnComplete: false,
    modelReplyRequired: true,
  });
  if (
    !active.isCurrent() ||
    active.replyContext?.message !== args.message ||
    deviceReadHostContextRevision(args.runtime) === null ||
    context.sensitive === true ||
    !["home", "calendar"].includes(String(context.view)) ||
    typeof context.timeZone !== "string" ||
    !active.credential.capabilities?.includes(
      type === "calendar_create_local"
        ? CALENDAR_CREATE_CAPABILITY
        : CALENDAR_CAPABILITY,
    )
  )
    return fail(
      "Current requesting-device Calendar creation access is unavailable. No event was created.",
    );
  let source;
  if (type === "calendar_create") {
    try {
      const selected = object(context.selectedObject);
      if (context.view !== "calendar" || selected.kind !== "calendar-source")
        return fail(
          "Choose the exact Calendar source before preparing this event. No event was created.",
        );
      source = calendarSource({
        sourceId: selected.id,
        sourceRevision: selected.revision,
      });
    } catch {
      return fail(
        "The selected Calendar source changed. No event was created.",
      );
    }
  }
  const origin = await currentRequestedActionOrigin(args.runtime, args.message);
  if (!origin)
    return fail(
      "The original event request could not be verified. No event was created.",
    );
  origin.assertCurrent();
  const planner = localCalendarCreatePlanners.get(args.runtime);
  if (!planner)
    return fail(
      "The canonical Calendar create interpreter is unavailable. No event was created.",
    );
  const plan = await planner({
    message: args.message,
    timeZone: context.timeZone,
    signal: getStreamingContext()?.abortSignal ?? new AbortController().signal,
  });
  origin.assertCurrent();
  if (!plan.fields) return fail(plan.text);
  const refreshed = await currentRequestedActionOrigin(
    args.runtime,
    args.message,
  );
  origin.assertCurrent();
  if (!refreshed)
    return fail(
      "The original event request changed during interpretation. No event was created.",
    );
  refreshed.assertCurrent();
  const operation = validateCalendarOperation({
    type,
    ...(source ? { source } : {}),
    fields: plan.fields,
  });
  const outcome = await new DeviceActionService(
    args.runtime,
  ).proposeWithOutcome(
    active.credential,
    operation,
    "calendar_create_" + digest([args.message.id, operation]),
    "Original requested event, interpreted by Calendar; the phone owner confirms the exact destination and fields before saving.",
    context,
  );
  origin.assertCurrent();
  return {
    success: true,
    text: plan.text,
    data: {
      proposalId: outcome.request.id,
      state: outcome.request.state,
      executed: false,
      approvalRequired: outcome.request.state === "pending",
    },
    turnComplete: false,
    modelReplyRequired: true,
  };
}
