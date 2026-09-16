/**
 * Minimal reminder action for Shared edge runtimes. The host supplies the
 * canonical runner and a trusted destination — the current verified private
 * chat, or a linked group chat when the sender is the binding owner; model
 * parameters can choose reminder content and timing but can never redirect
 * delivery. Group destinations carry the binding's delivery authority
 * (binding id, owner, personal agent, authority version) and connector account
 * so the fire-time dispatcher can lease the send through the same fence that
 * guards inbound group turns.
 */

import type {
  Action,
  ActionResult,
  EffectReceipt,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  Plugin,
} from "@elizaos/core/edge";
import { stableStringify } from "@elizaos/core/edge";
import {
  hasScheduledTaskApplyReceipt,
  isScheduledTaskRecurring,
  scheduledTaskApplyIntentContext,
  scheduledTaskApplyReceiptContext,
} from "./scheduled-task/runner.js";
import type {
  ScheduledTask,
  ScheduledTaskApplyResult,
  ScheduledTaskInput,
  ScheduledTaskReceiptVerb,
  ScheduledTaskRunner,
  ScheduledTaskStatus,
  ScheduledTaskTrigger,
} from "./scheduled-task/types.js";
import { resolveExplicitSharedReminderDelay } from "./shared-reminder-relative-delay.js";

/** Dedicated runtimes route imported Shared reminders through Cloud's trusted gateway. */
export const SHARED_CUTOVER_GATEWAY_CHANNEL = "shared_gateway_dm";
export const SHARED_REMINDER_MAX_TEXT_LENGTH = 2000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const CLEAR_RECEIPT_CONTEXT_KIND = "shared_reminder_clear_manifest";
const MUTATION_INTENT_CONTEXT_KIND = "shared_reminder_mutation_manifest";

type ClearReceiptManifest = {
  kind: typeof CLEAR_RECEIPT_CONTEXT_KIND;
  requestId: string;
  taskIds: string[];
};

type ReminderMutationManifest = {
  kind: typeof MUTATION_INTENT_CONTEXT_KIND;
  requestId: string;
  operation: "clear" | "delete";
  taskIds: string[];
};

function clearApplyIdempotencyKey(requestId: string, taskId: string): string {
  return `shared-reminder:${requestId}:clear:${taskId}`;
}

function mutationIntentIdempotencyKey(
  requestId: string,
  operation: ReminderMutationManifest["operation"],
): string {
  return `shared-reminder:${requestId}:${operation}:manifest`;
}

function parseReminderMutationManifest(
  context: Record<string, unknown> | undefined,
  requestId: string,
  operation: ReminderMutationManifest["operation"],
): ReminderMutationManifest | undefined {
  if (
    context?.kind !== MUTATION_INTENT_CONTEXT_KIND ||
    context.requestId !== requestId ||
    context.operation !== operation ||
    !Array.isArray(context.taskIds) ||
    context.taskIds.length === 0 ||
    context.taskIds.length > 10_000 ||
    !context.taskIds.every(
      (taskId) => typeof taskId === "string" && taskId.length > 0,
    )
  ) {
    return undefined;
  }
  const taskIds = [...new Set(context.taskIds as string[])].sort();
  return taskIds.length === context.taskIds.length
    ? { kind: MUTATION_INTENT_CONTEXT_KIND, requestId, operation, taskIds }
    : undefined;
}

function parseClearReceiptManifest(
  context: Record<string, unknown> | undefined,
  requestId: string,
): ClearReceiptManifest | undefined {
  if (
    context?.kind !== CLEAR_RECEIPT_CONTEXT_KIND ||
    context.requestId !== requestId ||
    !Array.isArray(context.taskIds) ||
    context.taskIds.length === 0 ||
    context.taskIds.length > 10_000 ||
    !context.taskIds.every(
      (taskId) => typeof taskId === "string" && taskId.length > 0,
    )
  ) {
    return undefined;
  }
  const taskIds = [...new Set(context.taskIds as string[])].sort();
  return taskIds.length === context.taskIds.length
    ? { kind: CLEAR_RECEIPT_CONTEXT_KIND, requestId, taskIds }
    : undefined;
}

async function recoverReminderMutationManifest(args: {
  tasks: ScheduledTask[];
  requestId: string;
  operation: ReminderMutationManifest["operation"];
}): Promise<ReminderMutationManifest | undefined> {
  const intentIdempotencyKey = mutationIntentIdempotencyKey(
    args.requestId,
    args.operation,
  );
  let recovered: ReminderMutationManifest | undefined;
  const legacyReceiptTaskIds: string[] = [];
  const accept = (manifest: ReminderMutationManifest | undefined) => {
    if (!manifest) return;
    if (
      recovered &&
      stableStringify(recovered.taskIds) !== stableStringify(manifest.taskIds)
    ) {
      throw new Error("Conflicting reminder mutation manifests");
    }
    recovered = manifest;
  };
  for (const task of args.tasks) {
    accept(
      parseReminderMutationManifest(
        await scheduledTaskApplyIntentContext(task, intentIdempotencyKey),
        args.requestId,
        args.operation,
      ),
    );
    const effectIdempotencyKey =
      args.operation === "clear"
        ? clearApplyIdempotencyKey(args.requestId, task.taskId)
        : `shared-reminder:${args.requestId}:delete:${task.taskId}`;
    if (
      !(await hasScheduledTaskApplyReceipt(
        task,
        "dismiss",
        effectIdempotencyKey,
      ))
    ) {
      continue;
    }
    const receiptContext = await scheduledTaskApplyReceiptContext(
      task,
      "dismiss",
      effectIdempotencyKey,
    );
    const mutationManifest = parseReminderMutationManifest(
      receiptContext,
      args.requestId,
      args.operation,
    );
    if (mutationManifest) {
      accept(mutationManifest);
      continue;
    }
    if (args.operation === "clear") {
      const clearManifest = parseClearReceiptManifest(
        receiptContext,
        args.requestId,
      );
      if (clearManifest) {
        accept({
          kind: MUTATION_INTENT_CONTEXT_KIND,
          requestId: args.requestId,
          operation: "clear",
          taskIds: clearManifest.taskIds,
        });
        continue;
      }
    }
    legacyReceiptTaskIds.push(task.taskId);
  }
  if (recovered) return recovered;
  const taskIds = [...new Set(legacyReceiptTaskIds)].sort();
  return taskIds.length > 0
    ? {
        kind: MUTATION_INTENT_CONTEXT_KIND,
        requestId: args.requestId,
        operation: args.operation,
        taskIds,
      }
    : undefined;
}

async function reserveReminderMutationManifest(args: {
  runner: ScheduledTaskRunner;
  tasks: ScheduledTask[];
  manifest: ReminderMutationManifest;
}): Promise<ReminderMutationManifest> {
  const manifestTaskIds = new Set(args.manifest.taskIds);
  // list() is creation-ordered in both canonical stores. An additive later
  // target therefore cannot change the shared oldest anchor chosen by two
  // same-request reservations racing with different snapshots.
  const anchor = args.tasks.find((task) => manifestTaskIds.has(task.taskId));
  if (!anchor || !args.runner.reserveApplyIntent) {
    throw new Error("Reminder mutation manifest storage is unavailable");
  }
  const idempotencyKey = mutationIntentIdempotencyKey(
    args.manifest.requestId,
    args.manifest.operation,
  );
  const reserved = await args.runner.reserveApplyIntent(anchor.taskId, {
    idempotencyKey,
    context: args.manifest,
  });
  const stored = parseReminderMutationManifest(
    await scheduledTaskApplyIntentContext(reserved.task, idempotencyKey),
    args.manifest.requestId,
    args.manifest.operation,
  );
  if (!stored)
    throw new Error("Reminder mutation manifest could not be verified");
  return stored;
}

export const SHARED_REMINDERS_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "scheduled-task",
  effects: ["tenant-postgres-write", "connector-send"],
  requiredBindings: ["HYPERDRIVE", "GATEWAY_INTERNAL_SECRET"],
  requiredSecrets: [],
} as const;

interface SharedGroupReminderDeliveryBase {
  kind: "group";
  project: string;
  connectorAccountId: string;
  chatId: string;
  ownerLabel: string;
  authority: SharedGroupReminderDeliveryAuthority;
}

export type SharedGroupReminderDelivery =
  | (SharedGroupReminderDeliveryBase & {
      platform: "telegram";
      /** Provider-owned forum topic containing the reminder-creating turn. */
      providerThreadId?: string;
    })
  | (SharedGroupReminderDeliveryBase & {
      platform: "blooio";
    });

export type SharedReminderDelivery =
  | {
      platform: "telegram";
      project: string;
      connectorAccountId: string;
      chatId: string;
    }
  | {
      platform: "blooio";
      project: string;
      phoneNumber: string;
    }
  | {
      platform: "discord";
      discordUserId: string;
    }
  | SharedGroupReminderDelivery;

/**
 * The binding generation a group reminder was scheduled under. Fire-time
 * delivery is authorized only while the live binding still matches every
 * field, so an owner rebind, revocation, or chat cutover fails the send closed.
 */
export interface SharedGroupReminderDeliveryAuthority {
  bindingId: string;
  ownerUserId: string;
  personalAgentId: string;
  version: number;
}

export function isSharedGroupReminderDelivery(
  delivery: SharedReminderDelivery,
): delivery is SharedGroupReminderDelivery {
  return "kind" in delivery && delivery.kind === "group";
}

/**
 * Telegram legacy-Markdown metacharacters. The owner label is interpolated
 * into connector text sent with parse_mode Markdown, so formatting and link
 * syntax are stripped rather than rendered. Stripping (instead of escaping)
 * never lengthens the label, which keeps the creation-time prefix budget
 * exact at fire time.
 */
const OWNER_LABEL_MARKDOWN_METACHARACTERS = /[[\]()*_`]/g;
const FALLBACK_OWNER_LABEL = "the group owner";

function sanitizedOwnerLabel(label: string): string {
  const sanitized = label
    .replace(OWNER_LABEL_MARKDOWN_METACHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 0 ? sanitized : FALLBACK_OWNER_LABEL;
}

/**
 * The owner-attributed text a group reminder delivers at fire time.
 * Participants who never scheduled anything must see why Eliza spoke.
 */
export function sharedGroupReminderMessageText(
  delivery: SharedGroupReminderDelivery,
  body: string,
): string {
  return `Reminder for this group from ${delivery.ownerLabel}: ${body}`;
}

/**
 * Group deliveries reserve the fire-time prefix inside the connector text
 * limit so a reminder accepted at creation can never become undeliverable.
 */
export function sharedReminderMaxBodyLength(
  delivery: SharedReminderDelivery,
): number {
  return isSharedGroupReminderDelivery(delivery)
    ? SHARED_REMINDER_MAX_TEXT_LENGTH -
        sharedGroupReminderMessageText(delivery, "").length
    : SHARED_REMINDER_MAX_TEXT_LENGTH;
}

const PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const TELEGRAM_CHAT_ID_PATTERN = /^-?\d{1,20}$/;
const TELEGRAM_THREAD_ID_PATTERN = /^[1-9]\d{0,15}$/;
const BLOOIO_GROUP_CHAT_ID_PATTERN = /^chat_[A-Za-z0-9_-]{1,120}$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTOR_ACCOUNT_ID_MAX_LENGTH = 160;
const PERSONAL_AGENT_ID_MAX_LENGTH = 160;

function parseGroupDeliveryAuthority(
  value: unknown,
): SharedGroupReminderDeliveryAuthority | undefined {
  if (!value || typeof value !== "object") return undefined;
  const authority = value as Record<string, unknown>;
  if (
    typeof authority.bindingId === "string" &&
    UUID_PATTERN.test(authority.bindingId) &&
    typeof authority.ownerUserId === "string" &&
    UUID_PATTERN.test(authority.ownerUserId) &&
    typeof authority.personalAgentId === "string" &&
    authority.personalAgentId.trim().length > 0 &&
    authority.personalAgentId.length <= PERSONAL_AGENT_ID_MAX_LENGTH &&
    typeof authority.version === "number" &&
    Number.isInteger(authority.version) &&
    authority.version > 0
  ) {
    return {
      bindingId: authority.bindingId,
      ownerUserId: authority.ownerUserId,
      personalAgentId: authority.personalAgentId,
      version: authority.version,
    };
  }
  return undefined;
}

/** Validates the server-owned destination stored with a Shared reminder. */
export function parseSharedReminderDelivery(
  value: unknown,
): SharedReminderDelivery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const delivery = value as Record<string, unknown>;
  if (delivery.kind === "group") {
    const authority = parseGroupDeliveryAuthority(delivery.authority);
    const providerThreadId = delivery.providerThreadId;
    const validTelegramThread =
      providerThreadId === undefined ||
      (typeof providerThreadId === "string" &&
        TELEGRAM_THREAD_ID_PATTERN.test(providerThreadId) &&
        Number.isSafeInteger(Number(providerThreadId)));
    if (
      authority &&
      (delivery.platform === "telegram" || delivery.platform === "blooio") &&
      typeof delivery.project === "string" &&
      PROJECT_PATTERN.test(delivery.project) &&
      typeof delivery.connectorAccountId === "string" &&
      delivery.connectorAccountId.trim().length >= 3 &&
      delivery.connectorAccountId.length <= CONNECTOR_ACCOUNT_ID_MAX_LENGTH &&
      typeof delivery.chatId === "string" &&
      (delivery.platform === "telegram"
        ? TELEGRAM_CHAT_ID_PATTERN
        : BLOOIO_GROUP_CHAT_ID_PATTERN
      ).test(delivery.chatId) &&
      typeof delivery.ownerLabel === "string" &&
      delivery.ownerLabel.trim().length > 0 &&
      delivery.ownerLabel.length <= 128 &&
      (delivery.platform === "telegram"
        ? validTelegramThread
        : providerThreadId === undefined)
    ) {
      const groupDelivery = {
        kind: "group",
        project: delivery.project,
        connectorAccountId: delivery.connectorAccountId,
        chatId: delivery.chatId,
        ownerLabel: sanitizedOwnerLabel(delivery.ownerLabel),
        authority,
      } as const;
      return delivery.platform === "telegram"
        ? {
            platform: "telegram",
            ...groupDelivery,
            ...(typeof providerThreadId === "string"
              ? { providerThreadId }
              : {}),
          }
        : { platform: "blooio", ...groupDelivery };
    }
    return undefined;
  }
  if (
    delivery.platform === "telegram" &&
    typeof delivery.project === "string" &&
    PROJECT_PATTERN.test(delivery.project) &&
    typeof delivery.connectorAccountId === "string" &&
    delivery.connectorAccountId.trim().length >= 3 &&
    delivery.connectorAccountId.length <= CONNECTOR_ACCOUNT_ID_MAX_LENGTH &&
    typeof delivery.chatId === "string" &&
    TELEGRAM_CHAT_ID_PATTERN.test(delivery.chatId)
  ) {
    return {
      platform: "telegram",
      project: delivery.project,
      connectorAccountId: delivery.connectorAccountId,
      chatId: delivery.chatId,
    };
  }
  if (
    delivery.platform === "blooio" &&
    typeof delivery.project === "string" &&
    PROJECT_PATTERN.test(delivery.project) &&
    typeof delivery.phoneNumber === "string" &&
    /^\+[1-9]\d{6,14}$/.test(delivery.phoneNumber)
  ) {
    return {
      platform: "blooio",
      project: delivery.project,
      phoneNumber: delivery.phoneNumber,
    };
  }
  if (
    delivery.platform === "discord" &&
    typeof delivery.discordUserId === "string" &&
    /^\d{1,32}$/.test(delivery.discordUserId)
  ) {
    return {
      platform: "discord",
      discordUserId: delivery.discordUserId,
    };
  }
  return undefined;
}

export interface SharedRemindersEdgePluginOptions {
  runner: ScheduledTaskRunner;
  agentId: string;
  delivery: SharedReminderDelivery;
  /** Reject planner-selected operations unless this server boundary supplied intent. */
  operationIntentRequired?: boolean;
  /** Server-owned provenance that the current turn corrects a grounded reminder. */
  clockCorrection?: boolean;
  /** Server-owned provenance for the immediately preceding clear-all warning. */
  clearConfirmationChallenge?: boolean;
  /** Server-owned classification that the current request targets all reminders. */
  clearAllIntent?: boolean;
  /** High-confidence server classification that dominates a confused planner. */
  operationIntent?:
    | "create"
    | "list"
    | "update"
    | "snooze"
    | "complete"
    | "delete"
    | "dismiss";
  /** Server-owned visible title or exact task id; planner targets cannot override it. */
  targetIntent?: string;
  now?: () => Date;
}

function parameters(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  return record.parameters && typeof record.parameters === "object"
    ? (record.parameters as Record<string, unknown>)
    : record;
}

function textParameter(
  input: Record<string, unknown>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function positiveNumber(
  input: Record<string, unknown>,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const raw = input[name];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

async function actionFailure(
  text: string,
  callback?: HandlerCallback,
  data: Record<string, unknown> = {},
): Promise<ActionResult> {
  await callback?.({ text });
  return {
    success: false,
    text,
    error: text,
    data: { actionName: "REMINDERS", ...data },
    verifiedUserFacing: true,
    userFacingText: text,
    turnComplete: true,
  };
}

function reportReminderError(
  runtime: Pick<IAgentRuntime, "reportError">,
  scope: string,
  error: unknown,
  context: Record<string, unknown>,
): void {
  try {
    runtime.reportError?.(scope, error, context);
  } catch {
    // error-policy:J7 diagnostics are best-effort and must never hide the
    // grounded action result.
  }
}

const IMMEDIATELY_ACTIVE_REMINDER_STATUSES = new Set([
  "scheduled",
  "fired",
  "acknowledged",
] as const);

const QUERYABLE_REMINDER_STATUSES: ScheduledTaskStatus[] = [
  "scheduled",
  "fired",
  "acknowledged",
  "completed",
  "skipped",
  "expired",
  "failed",
];
const ALL_REMINDER_STATUSES: ScheduledTaskStatus[] = [
  ...QUERYABLE_REMINDER_STATUSES,
  "dismissed",
];

function isActiveReminder(task: ScheduledTask): boolean {
  return (
    IMMEDIATELY_ACTIVE_REMINDER_STATUSES.has(
      task.state.status as "scheduled" | "fired" | "acknowledged",
    ) ||
    (task.state.status !== "dismissed" && isScheduledTaskRecurring(task))
  );
}

function normalizeReminderText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeReminderTargetTitle(value: string): string {
  return normalizeReminderText(value).replace(
    /\b(?:in|to) (?:my|your) todo(?: list)?\b/gu,
    "to your todo",
  );
}

function normalizeReminderTargetReference(value: string): string {
  return normalizeReminderTargetTitle(value).replace(
    /^(?:remove|delete|dismiss|cancel) (?:the )?reminder(?: (?:named|called))? /u,
    "",
  );
}

function deliveryScopeKey(delivery: SharedReminderDelivery): string {
  if (isSharedGroupReminderDelivery(delivery)) {
    const { ownerLabel: _ownerLabel, ...immutableAuthority } = delivery;
    return stableStringify(immutableAuthority);
  }
  return stableStringify(delivery);
}

function taskDelivery(task: ScheduledTask): SharedReminderDelivery | undefined {
  return parseSharedReminderDelivery(task.metadata?.delivery);
}

function isReminderInDeliveryScope(
  task: ScheduledTask,
  delivery: SharedReminderDelivery,
): boolean {
  const persistedDelivery = taskDelivery(task);
  // Shared has always persisted a trusted destination. A malformed or absent
  // destination is not legacy authority and must never become reachable from
  // whichever transport happens to ask first.
  return (
    persistedDelivery !== undefined &&
    deliveryScopeKey(persistedDelivery) === deliveryScopeKey(delivery)
  );
}

function sameReminderSemantics(
  task: ScheduledTask,
  body: string,
  trigger: ScheduledTaskTrigger,
  delivery: SharedReminderDelivery,
  timezone?: string,
  includeTimezone = false,
): boolean {
  return (
    isReminderInDeliveryScope(task, delivery) &&
    normalizeReminderText(reminderText(task)) === normalizeReminderText(body) &&
    stableStringify(task.trigger) === stableStringify(trigger) &&
    (!includeTimezone || taskDisplayTimezone(task) === validTimeZone(timezone))
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function semanticCreateIdempotencyKey(args: {
  agentId: string;
  body: string;
  trigger: ScheduledTaskTrigger;
  delivery: SharedReminderDelivery;
  timezone?: string;
  includeTimezone?: boolean;
  generation: number;
}): Promise<string> {
  const digest = await sha256Hex(
    stableStringify({
      agentId: args.agentId,
      body: normalizeReminderText(args.body),
      trigger: args.trigger,
      deliveryScope: deliveryScopeKey(args.delivery),
      ...(args.includeTimezone
        ? { timezone: validTimeZone(args.timezone) ?? null }
        : {}),
    }),
  );
  return `shared-reminder:semantic:${digest}:${args.generation}`;
}

function scheduledTaskInput(task: ScheduledTask): ScheduledTaskInput {
  const { taskId: _taskId, state: _state, ...input } = task;
  return input;
}

function reminderTrigger(
  input: Record<string, unknown>,
  now: Date,
  explicitDelayMilliseconds?: number,
): ScheduledTaskTrigger | undefined {
  if (explicitDelayMilliseconds !== undefined) {
    const at = now.getTime() + explicitDelayMilliseconds;
    if (Number.isFinite(at) && Math.abs(at) <= MAX_DATE_TIMESTAMP_MS) {
      return { kind: "once", atIso: new Date(at).toISOString() };
    }
    return undefined;
  }
  const inMinutes = positiveNumber(input, "inMinutes", "minutesFromNow");
  if (inMinutes !== undefined) {
    const milliseconds = minuteDurationMilliseconds(inMinutes);
    if (milliseconds === undefined) return undefined;
    const at = now.getTime() + milliseconds;
    if (!Number.isFinite(at) || Math.abs(at) > MAX_DATE_TIMESTAMP_MS) {
      return undefined;
    }
    return {
      kind: "once",
      atIso: new Date(at).toISOString(),
    };
  }
  const atIso = textParameter(input, "atIso", "at");
  if (
    atIso &&
    /(?:Z|[+-]\d{2}:\d{2})$/iu.test(atIso) &&
    Number.isFinite(Date.parse(atIso))
  ) {
    return { kind: "once", atIso: new Date(atIso).toISOString() };
  }
  const everyMinutes = positiveNumber(input, "everyMinutes");
  if (everyMinutes !== undefined) {
    return { kind: "interval", everyMinutes };
  }
  const expression = textParameter(input, "cronExpression", "cron");
  const tz = validTimeZone(textParameter(input, "timezone", "tz"));
  if (expression && tz) return { kind: "cron", expression, tz };
  return undefined;
}

function hasOffsetlessAtIso(input: Record<string, unknown>): boolean {
  const atIso = textParameter(input, "atIso", "at");
  return Boolean(atIso && !/(?:Z|[+-]\d{2}:\d{2})$/iu.test(atIso));
}

const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const CRON_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function reminderText(task: ScheduledTask): string {
  return task.output?.fallback?.body ?? task.promptInstructions;
}

function validTimeZone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    // error-policy:J3 an invalid or unsupported timezone remains explicitly
    // unavailable instead of being replaced with a fabricated zone.
    return undefined;
  }
}

function taskDisplayTimezone(task: ScheduledTask): string | undefined {
  const stored = task.metadata?.displayTimezone;
  if (typeof stored === "string") return validTimeZone(stored);
  return task.trigger.kind === "cron"
    ? validTimeZone(task.trigger.tz)
    : undefined;
}

function formatUtcInstant(atIso: string): string {
  const instant = new Date(atIso);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("Shared reminder has an invalid one-off schedule");
  }
  const hour = instant.getUTCHours();
  const hour12 = hour % 12 || 12;
  const minute = String(instant.getUTCMinutes()).padStart(2, "0");
  const seconds = instant.getUTCSeconds();
  const milliseconds = instant.getUTCMilliseconds();
  const preciseTime =
    seconds === 0 && milliseconds === 0
      ? `${hour12}:${minute}`
      : `${hour12}:${minute}:${String(seconds).padStart(2, "0")}${
          milliseconds === 0 ? "" : `.${String(milliseconds).padStart(3, "0")}`
        }`;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `on ${UTC_MONTHS[instant.getUTCMonth()]} ${instant.getUTCDate()}, ${instant.getUTCFullYear()} at ${preciseTime} ${meridiem} UTC`;
}

function formatZonedInstant(atIso: string, timezone?: string): string {
  const safeTimezone = validTimeZone(timezone);
  if (!safeTimezone || safeTimezone === "UTC") return formatUtcInstant(atIso);
  const instant = new Date(atIso);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error("Shared reminder has an invalid one-off schedule");
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second:
      instant.getUTCSeconds() === 0 && instant.getUTCMilliseconds() === 0
        ? undefined
        : "2-digit",
    hour12: true,
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const seconds = part("second");
  const milliseconds = instant.getUTCMilliseconds();
  const preciseTime = `${part("hour")}:${part("minute")}${
    seconds ? `:${seconds}` : ""
  }${milliseconds === 0 ? "" : `.${String(milliseconds).padStart(3, "0")}`}`;
  const local = `on ${part("month")} ${part("day")}, ${part("year")} at ${preciseTime} ${part("dayPeriod")} ${safeTimezone}`;
  return `${local} (${formatUtcInstant(atIso).slice(3)})`;
}

function formatDuration(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(
      "Shared reminder duration must be a positive whole millisecond",
    );
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const remainder = milliseconds % 60_000;
  const parts: string[] = [];
  if (minutes > 0)
    parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (remainder >= 1_000) {
    const seconds = Math.floor(remainder / 1_000);
    const fraction = remainder % 1_000;
    const amount =
      fraction === 0
        ? String(seconds)
        : `${seconds}.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`;
    parts.push(`${amount} ${amount === "1" ? "second" : "seconds"}`);
  } else if (remainder > 0) {
    parts.push(
      `${remainder} ${remainder === 1 ? "millisecond" : "milliseconds"}`,
    );
  }
  return parts.join(" and ");
}

function minuteDurationMilliseconds(minutes: number): number | undefined {
  const milliseconds = minutes * 60_000;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? milliseconds
    : undefined;
}

function formatClockTime(hour: number, minute: number): string {
  const hour12 = hour % 12 || 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${hour12}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

function cronScheduleDescription(expression: string, timezone: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length === 5) {
    const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
    const minute = Number(minuteField);
    const hour = Number(hourField);
    const simpleTime =
      /^\d{1,2}$/.test(minuteField ?? "") &&
      /^\d{1,2}$/.test(hourField ?? "") &&
      minute >= 0 &&
      minute <= 59 &&
      hour >= 0 &&
      hour <= 23;
    if (simpleTime && dayOfMonth === "*" && month === "*") {
      if (dayOfWeek === "*") {
        return `every day at ${formatClockTime(hour, minute)} in ${timezone}`;
      }
      if (/^[0-7]$/.test(dayOfWeek ?? "")) {
        const weekday = CRON_WEEKDAYS[Number(dayOfWeek) % 7];
        return `every ${weekday} at ${formatClockTime(hour, minute)} in ${timezone}`;
      }
    }
  }
  return `on its recurring schedule in ${timezone}`;
}

function scheduleDescription(
  trigger: ScheduledTaskTrigger,
  timezone?: string,
): string {
  switch (trigger.kind) {
    case "once":
      return formatZonedInstant(trigger.atIso, timezone);
    case "interval":
      return `every ${trigger.everyMinutes} ${trigger.everyMinutes === 1 ? "minute" : "minutes"}`;
    case "cron":
      return cronScheduleDescription(trigger.expression, trigger.tz);
    case "event":
      return "when its scheduled event occurs";
    case "after_task":
      return "after its linked task";
    case "manual":
      return "when you ask it to run";
    case "relative_to_anchor":
      return "relative to its scheduled anchor";
    case "during_window":
      return "during its scheduled window";
  }
}

function requestedScheduleDescription(
  input: Record<string, unknown>,
  trigger: ScheduledTaskTrigger,
  explicitDelayMilliseconds?: number,
): string {
  if (explicitDelayMilliseconds !== undefined) {
    return `in ${formatDuration(explicitDelayMilliseconds)}`;
  }
  const inMinutes = positiveNumber(input, "inMinutes", "minutesFromNow");
  const inMilliseconds =
    inMinutes === undefined ? undefined : minuteDurationMilliseconds(inMinutes);
  return inMilliseconds === undefined
    ? scheduleDescription(trigger, textParameter(input, "timezone", "tz"))
    : `in ${formatDuration(inMilliseconds)}`;
}

function taskSummary(task: ScheduledTask): string {
  return `${reminderText(task)} — ${taskScheduleDescription(task)}`;
}

function taskScheduleDescription(task: ScheduledTask): string {
  if (task.state.status === "scheduled" && task.state.firedAt) {
    return formatZonedInstant(task.state.firedAt, taskDisplayTimezone(task));
  }
  return scheduleDescription(task.trigger, taskDisplayTimezone(task));
}

function creationReceipt(args: {
  task: ScheduledTask;
  commit: { logId: string; occurredAtIso: string };
  replayed: boolean;
}): EffectReceipt {
  const base = {
    receiptId: `shared-reminder:create:${args.commit.logId}`,
    operation: "shared.reminder.create",
    resource: {
      kind: "shared.reminder",
      id: args.task.taskId,
      version: args.commit.logId,
    },
    artifacts: [
      {
        kind: "shared.reminder.log",
        id: args.commit.logId,
        version: "scheduled",
      },
    ],
    idempotency: {
      key: args.task.idempotencyKey ?? null,
      replayed: args.replayed,
    },
    observedAt: args.commit.occurredAtIso,
  } as const;
  return args.replayed
    ? {
        ...base,
        outcome: "noop",
        idempotency: {
          key: args.task.idempotencyKey ?? null,
          replayed: true,
        },
        reason:
          "The persisted reminder already satisfies this idempotent request.",
      }
    : {
        ...base,
        outcome: "applied",
        commit: {
          kind: "durable",
          id: args.commit.logId,
          committedAt: args.commit.occurredAtIso,
        },
      };
}

function lifecycleReceipt(
  operation: "snooze" | "complete" | "dismiss",
  result: ScheduledTaskApplyResult,
): EffectReceipt {
  const base = {
    receiptId: `shared-reminder:${operation}:${result.commit.logId}`,
    operation: `shared.reminder.${operation}`,
    resource: {
      kind: "shared.reminder",
      id: result.task.taskId,
      version: result.commit.logId,
    },
    artifacts: [
      {
        kind: "shared.reminder.log",
        id: result.commit.logId,
        version: result.commit.transition,
      },
    ],
    idempotency: {
      key: result.idempotencyKey,
      replayed: result.replayed,
    },
    observedAt: result.commit.occurredAtIso,
  } as const;
  return result.replayed
    ? {
        ...base,
        outcome: "noop",
        reason:
          "The persisted reminder already records this idempotent lifecycle request.",
      }
    : {
        ...base,
        outcome: "applied",
        commit: {
          kind: "durable",
          id: result.commit.logId,
          committedAt: result.commit.occurredAtIso,
        },
      };
}

type SemanticScheduleResult =
  | {
      kind: "persisted";
      result: Awaited<ReturnType<ScheduledTaskRunner["scheduleWithResult"]>>;
    }
  | { kind: "legacy-existing"; task: ScheduledTask };

async function scheduleSemanticReminder(args: {
  runner: ScheduledTaskRunner;
  agentId: string;
  delivery: SharedReminderDelivery;
  input: ScheduledTaskInput;
  includeTimezoneInSemantics?: boolean;
  requestIdempotencyKey?: string;
}): Promise<SemanticScheduleResult> {
  const displayTimezone =
    typeof args.input.metadata?.displayTimezone === "string"
      ? args.input.metadata.displayTimezone
      : args.input.trigger.kind === "cron"
        ? args.input.trigger.tz
        : undefined;
  const allTasks = (
    await args.runner.list({ kind: "reminder", ownerVisibleOnly: true })
  ).filter((task) => isReminderInDeliveryScope(task, args.delivery));
  const semanticMatches = allTasks.filter((task) =>
    sameReminderSemantics(
      task,
      args.input.promptInstructions,
      args.input.trigger,
      args.delivery,
      displayTimezone,
      args.includeTimezoneInSemantics,
    ),
  );
  const { idempotencyKey: _idempotencyKey, ...input } = args.input;
  const scheduleGeneration = async (
    generation: number,
  ): Promise<SemanticScheduleResult> => ({
    kind: "persisted",
    result: await args.runner.scheduleWithResult({
      ...input,
      idempotencyKey:
        args.requestIdempotencyKey ??
        (await semanticCreateIdempotencyKey({
          agentId: args.agentId,
          body: input.promptInstructions,
          trigger: input.trigger,
          delivery: args.delivery,
          timezone: displayTimezone,
          includeTimezone: args.includeTimezoneInSemantics,
          generation,
        })),
    }),
  });
  const activeMatch = semanticMatches.find(isActiveReminder);
  if (activeMatch) {
    if (!activeMatch.idempotencyKey) {
      return { kind: "legacy-existing", task: activeMatch };
    }
    const replayed = await args.runner.scheduleWithResult(
      scheduledTaskInput(activeMatch),
    );
    if (isActiveReminder(replayed.task)) {
      return { kind: "persisted", result: replayed };
    }
    // A lifecycle mutation may win between list() and idempotency replay.
    // Retry once at the next semantic generation; the generation key makes a
    // concurrent recreator converge on the same durable row.
    const nextGeneration =
      semanticMatches.filter((task) => !isActiveReminder(task)).length + 1;
    return scheduleGeneration(nextGeneration);
  }

  const generation = semanticMatches.filter(
    (task) => !isActiveReminder(task),
  ).length;
  return scheduleGeneration(generation);
}

function booleanParameter(
  input: Record<string, unknown>,
  ...names: string[]
): boolean {
  return names.some((name) => input[name] === true);
}

function normalizedOperation(value: string | undefined): string | undefined {
  switch (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s-]+/gu, "_")
  ) {
    case "set":
    case "add":
      return "create";
    case "show":
      return "list";
    case "change":
    case "edit":
    case "reschedule":
      return "update";
    case "remove":
    case "delete":
    case "cancel":
      return "delete";
    case "clear":
    case "clean":
    case "clear_all":
    case "clean_all":
    case "delete_all":
    case "remove_all":
      return "clear";
    case "create":
    case "list":
    case "update":
    case "snooze":
    case "complete":
    case "dismiss":
      return value
        ?.trim()
        .toLowerCase()
        .replace(/[\s-]+/gu, "_");
    default:
      return undefined;
  }
}

type ReminderTargetResolution =
  | { kind: "match"; task: ScheduledTask; semanticDuplicates: ScheduledTask[] }
  | { kind: "missing"; text: string }
  | { kind: "ambiguous"; text: string; candidates: ScheduledTask[] };

function ambiguityText(tasks: ScheduledTask[]): string {
  return (
    "More than one reminder matches that. Which one do you mean?\n" +
    tasks.map((task) => `• ${taskSummary(task)}`).join("\n")
  );
}

async function resolveReminderTarget(args: {
  runner: ScheduledTaskRunner;
  delivery: SharedReminderDelivery;
  reference?: string;
  exactReference?: boolean;
  coalesceExactSemanticDuplicates?: boolean;
  replay?: {
    verb: ScheduledTaskReceiptVerb;
    idempotencyKey: (task: ScheduledTask) => string;
  };
}): Promise<ReminderTargetResolution> {
  const scopedTasks = (
    await args.runner.list({
      kind: "reminder",
      ownerVisibleOnly: true,
      status: ALL_REMINDER_STATUSES,
    })
  ).filter((task) => isReminderInDeliveryScope(task, args.delivery));
  const tasks: ScheduledTask[] = [];
  for (const task of scopedTasks) {
    if (isActiveReminder(task)) {
      tasks.push(task);
      continue;
    }
    if (
      args.replay &&
      (await hasScheduledTaskApplyReceipt(
        task,
        args.replay.verb,
        args.replay.idempotencyKey(task),
      ))
    ) {
      tasks.push(task);
    }
  }
  if (tasks.length === 0) {
    return { kind: "missing", text: "You have no active reminders." };
  }
  const reference = args.reference?.trim();
  if (!reference) {
    if (tasks.length === 1) {
      return { kind: "match", task: tasks[0], semanticDuplicates: [tasks[0]] };
    }
    const [first] = tasks;
    const semanticDuplicates = tasks.filter((task) =>
      sameReminderSemantics(
        task,
        reminderText(first),
        first.trigger,
        args.delivery,
        taskDisplayTimezone(first),
        true,
      ),
    );
    return args.coalesceExactSemanticDuplicates &&
      semanticDuplicates.length === tasks.length
      ? { kind: "match", task: first, semanticDuplicates }
      : { kind: "ambiguous", text: ambiguityText(tasks), candidates: tasks };
  }

  const idMatch = tasks.find((task) => task.taskId === reference);
  if (idMatch) {
    return { kind: "match", task: idMatch, semanticDuplicates: [idMatch] };
  }

  const normalizedReference = normalizeReminderText(reference);
  const normalizedTargetReference = normalizeReminderTargetReference(reference);
  const exact = tasks.filter(
    (task) =>
      normalizeReminderTargetTitle(reminderText(task)) ===
        normalizedTargetReference ||
      normalizeReminderText(taskSummary(task)) === normalizedReference,
  );
  if (exact.length === 1) {
    return { kind: "match", task: exact[0], semanticDuplicates: exact };
  }
  if (exact.length > 1) {
    const [first] = exact;
    const semanticDuplicates = exact.filter((task) =>
      sameReminderSemantics(
        task,
        reminderText(first),
        first.trigger,
        args.delivery,
        taskDisplayTimezone(first),
        true,
      ),
    );
    if (
      args.coalesceExactSemanticDuplicates &&
      semanticDuplicates.length === exact.length
    ) {
      return { kind: "match", task: first, semanticDuplicates };
    }
    return { kind: "ambiguous", text: ambiguityText(exact), candidates: exact };
  }

  if (args.exactReference) {
    return {
      kind: "missing",
      text: `I couldn't find an active reminder named “${reference}”.`,
    };
  }

  const partial = tasks.filter((task) => {
    const title = normalizeReminderTargetTitle(reminderText(task));
    return (
      title.length > 0 &&
      (normalizedTargetReference.includes(title) ||
        title.includes(normalizedTargetReference))
    );
  });
  if (partial.length === 1) {
    return {
      kind: "match",
      task: partial[0],
      semanticDuplicates: partial,
    };
  }
  if (partial.length > 1) {
    return {
      kind: "ambiguous",
      text: ambiguityText(partial),
      candidates: partial,
    };
  }
  return {
    kind: "missing",
    text: `I couldn't find an active reminder named “${reference}”.`,
  };
}

function explicitClearConfirmation(
  input: Record<string, unknown>,
  message: Memory,
  challengeActive: boolean,
): boolean {
  if (!challengeActive) return false;
  if (!booleanParameter(input, "confirmed", "confirmClearAll")) return false;
  const text = (message.content?.text?.trim() ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text || text.length > 120) return false;
  const confirmation =
    "(?:yes|yep|oui|confirm|confirmed|confirmé|confirmée|i confirm|je confirme|do it|go ahead|vas y|allez y)";
  const clearCommand =
    "(?:(?:clear|clean|delete|remove|dismiss|cancel) (?:all (?:my )?reminders|the reminder list|the list)|(?:efface|supprime|vide) (?:tous mes rappels|la liste des rappels))";
  return new RegExp(
    `^(?:${confirmation})(?: (?:${confirmation}))* ${clearCommand}$`,
    "iu",
  ).test(text);
}

function reminderScheduleInput(args: {
  agentId: string;
  body: string;
  trigger: ScheduledTaskTrigger;
  delivery: SharedReminderDelivery;
  timezone?: string;
}): ScheduledTaskInput {
  return {
    kind: "reminder",
    promptInstructions: args.body,
    trigger: args.trigger,
    priority: "medium",
    escalation: {
      steps: [{ delayMinutes: 0, channelKey: "current_dm" }],
    },
    output: {
      destination: "channel",
      target: "current_dm",
      fallback: { body: args.body },
    },
    subject: { kind: "self", id: args.agentId },
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: args.agentId,
    ownerVisible: true,
    metadata: {
      delivery: args.delivery,
      ...(args.timezone ? { displayTimezone: args.timezone } : {}),
    },
    executionProfile: "notify-only",
  };
}

function updatedReminderInput(args: {
  task: ScheduledTask;
  body: string;
  trigger: ScheduledTaskTrigger;
  delivery: SharedReminderDelivery;
  timezone?: string;
}): ScheduledTaskInput {
  const existing = scheduledTaskInput(args.task);
  return {
    ...existing,
    promptInstructions: args.body,
    trigger: args.trigger,
    output: {
      ...existing.output,
      destination: "channel",
      target: "current_dm",
      fallback: { ...existing.output?.fallback, body: args.body },
    },
    metadata: {
      delivery: args.delivery,
      ...(args.timezone ? { displayTimezone: args.timezone } : {}),
    },
  };
}

export function createSharedRemindersEdgeAction(
  options: SharedRemindersEdgePluginOptions,
): Action {
  const now = options.now ?? (() => new Date());
  const delivery = parseSharedReminderDelivery(options.delivery);
  if (!delivery) {
    throw new Error(
      "Shared reminders require a trusted server-owned destination",
    );
  }
  const groupDelivery = isSharedGroupReminderDelivery(delivery);

  return {
    name: "REMINDERS",
    similes: [
      "REMIND_ME",
      "SET_REMINDER",
      "LIST_REMINDERS",
      "UPDATE_REMINDER",
      "DELETE_REMINDER",
      "SNOOZE_REMINDER",
      "DISMISS_REMINDER",
      "CLEAR_REMINDERS",
    ],
    tags: ["resource:scheduled-item", "capability:read", "capability:write"],
    contexts: ["reminders", "general"],
    roleGate: { minRole: "GUEST" },
    description: groupDelivery
      ? "Create, list, update, snooze, complete, delete/dismiss, or confirmation-gated clear free reminders delivered only to this linked group chat. Resolve mutations by the visible reminder title; never ask the user for a task id. For create or update, supply reminderText and a schedule when it changes: inMinutes, atIso, everyMinutes, or cronExpression plus timezone."
      : "Create, list, update, snooze, complete, delete/dismiss, or confirmation-gated clear free reminders delivered only to this current verified private chat. Resolve mutations by the visible reminder title; never ask the user for a task id. For create or update, supply reminderText and a schedule when it changes: inMinutes, atIso, everyMinutes, or cronExpression plus timezone.",
    parameters: [
      {
        name: "operation",
        description: "Reminder operation.",
        required: true,
        schema: {
          type: "string",
          enum: [
            "create",
            "list",
            "update",
            "snooze",
            "complete",
            "delete",
            "dismiss",
            "clear",
          ],
        },
      },
      {
        name: "reminderText",
        description: "What Eliza should remind the user about.",
        schema: { type: "string" },
      },
      {
        name: "target",
        description:
          "Visible reminder title for update, snooze, complete, delete, or dismiss. Omit only when exactly one active reminder exists.",
        schema: { type: "string" },
      },
      {
        name: "newReminderText",
        description: "Replacement reminder text when operation is update.",
        schema: { type: "string" },
      },
      {
        name: "taskId",
        description:
          "Internal compatibility identifier for a reminder mutation. Never request or display it to the user; prefer target.",
        schema: { type: "string" },
      },
      {
        name: "inMinutes",
        description: "One-off delay from now in minutes.",
        schema: { type: "number" },
      },
      {
        name: "atIso",
        description:
          "One-off absolute ISO-8601 timestamp with an explicit Z or ±HH:MM offset.",
        schema: { type: "string" },
      },
      {
        name: "everyMinutes",
        description: "Recurring interval in minutes.",
        schema: { type: "number" },
      },
      {
        name: "cronExpression",
        description: "Five-field cron expression for a recurring reminder.",
        schema: { type: "string" },
      },
      {
        name: "timezone",
        description:
          "Canonical IANA timezone used to display one-off atIso times in local time; required with cronExpression.",
        schema: { type: "string" },
      },
      {
        name: "snoozeMinutes",
        description: "Positive snooze duration in minutes.",
        schema: { type: "number" },
      },
      {
        name: "confirmed",
        description:
          "Set true for operation=clear only after the user explicitly confirms the immediately preceding clear-all warning. Never set it on the initial clear request.",
        schema: { type: "boolean" },
      },
    ],
    validate: async () => true,
    handler: async (
      runtime,
      message: Memory,
      _state,
      rawOptions,
      callback?: HandlerCallback,
    ): Promise<ActionResult> => {
      const input = parameters(rawOptions);
      const requestedOperation = normalizedOperation(
        textParameter(input, "operation", "action"),
      );
      if (
        options.operationIntentRequired === true &&
        options.clearAllIntent !== true &&
        options.clockCorrection !== true &&
        options.operationIntent === undefined
      ) {
        return await actionFailure(
          "I couldn't safely verify that reminder request, so I didn't run it. Please state the reminder action explicitly.",
          callback,
          {
            operation: requestedOperation,
            failureCode: "REMINDER_OPERATION_UNVERIFIED",
          },
        );
      }
      // Server-owned intent classifications dominate the planner's operation:
      // otherwise delete-without-target could bypass clear confirmation or a
      // grounded correction could delete the user's sole reminder.
      const operation = options.clearAllIntent
        ? "clear"
        : options.clockCorrection
          ? "update"
          : (options.operationIntent ?? requestedOperation);
      const enforcedOperationIntent = options.clockCorrection
        ? "update"
        : options.operationIntent;
      if (
        enforcedOperationIntent !== undefined &&
        requestedOperation !== enforcedOperationIntent
      ) {
        return await actionFailure(
          "I couldn't safely verify that reminder operation, so I didn't run it. Please try again.",
          callback,
          {
            operation: enforcedOperationIntent,
            failureCode: "REMINDER_OPERATION_MISMATCH",
          },
        );
      }
      if (options.clockCorrection && !options.targetIntent) {
        return await actionFailure(
          "I couldn't safely identify the reminder being corrected, so nothing was changed. Please list your reminders and try again.",
          callback,
          {
            operation: "update",
            failureCode: "REMINDER_CORRECTION_TARGET_UNVERIFIED",
          },
        );
      }
      if (
        enforcedOperationIntent !== undefined &&
        enforcedOperationIntent !== "create" &&
        enforcedOperationIntent !== "list" &&
        !options.targetIntent
      ) {
        return await actionFailure(
          "I couldn't safely identify which reminder you meant, so I didn't change anything. Please name the reminder.",
          callback,
          {
            operation: enforcedOperationIntent,
            failureCode: "REMINDER_TARGET_UNVERIFIED",
          },
        );
      }
      try {
        if (operation === "list") {
          const tasks = (
            await options.runner.list({
              kind: "reminder",
              ownerVisibleOnly: true,
              status: QUERYABLE_REMINDER_STATUSES,
            })
          ).filter(
            (task) =>
              isActiveReminder(task) &&
              isReminderInDeliveryScope(task, delivery),
          );
          const text =
            tasks.length === 0
              ? "You have no reminders."
              : `Your reminders:\n${tasks.map((task) => `• ${taskSummary(task)}`).join("\n")}`;
          await callback?.({ text });
          return {
            success: true,
            text,
            data: { actionName: "REMINDERS", operation, tasks },
            verifiedUserFacing: true,
            userFacingText: text,
            turnComplete: true,
          };
        }

        if (operation === "create") {
          const body = textParameter(input, "reminderText", "text", "body");
          if (!body) {
            return await actionFailure("Reminder text is required.", callback, {
              operation,
            });
          }
          const maxBodyLength = sharedReminderMaxBodyLength(delivery);
          if (body.length > maxBodyLength) {
            return await actionFailure(
              `Reminder text must be ${maxBodyLength} characters or fewer.`,
              callback,
              { operation },
            );
          }
          const requestedTimezone = textParameter(input, "timezone", "tz");
          const timezone = validTimeZone(requestedTimezone);
          if (requestedTimezone && !timezone) {
            return await actionFailure(
              "Use a valid IANA timezone such as Europe/Paris.",
              callback,
              { operation },
            );
          }
          if (hasOffsetlessAtIso(input)) {
            return await actionFailure(
              "Use an absolute atIso time with an explicit Z or ±HH:MM offset so I don't guess the timezone.",
              callback,
              { operation },
            );
          }
          const explicitDelay = resolveExplicitSharedReminderDelay(
            message.content?.text,
          );
          if (explicitDelay.kind === "invalid") {
            return await actionFailure(explicitDelay.reason, callback, {
              operation,
            });
          }
          const inputMinutes = positiveNumber(
            input,
            "inMinutes",
            "minutesFromNow",
          );
          if (
            explicitDelay.kind === "absent" &&
            inputMinutes !== undefined &&
            minuteDurationMilliseconds(inputMinutes) === undefined
          ) {
            return await actionFailure(
              "Reminder delay must resolve to a positive whole millisecond.",
              callback,
              { operation },
            );
          }
          const trigger = reminderTrigger(
            input,
            now(),
            explicitDelay.kind === "resolved"
              ? explicitDelay.milliseconds
              : undefined,
          );
          if (!trigger) {
            return await actionFailure(
              "A reminder time is required: inMinutes, atIso, everyMinutes, or cronExpression with timezone.",
              callback,
              { operation },
            );
          }
          const outcome = await scheduleSemanticReminder({
            runner: options.runner,
            agentId: options.agentId,
            delivery,
            requestIdempotencyKey:
              (explicitDelay.kind === "resolved" ||
                inputMinutes !== undefined) &&
              message.id
                ? `shared-reminder:${String(message.id)}:create`
                : undefined,
            input: reminderScheduleInput({
              agentId: options.agentId,
              body,
              trigger,
              delivery,
              timezone,
            }),
          });
          if (outcome.kind === "legacy-existing") {
            const text = `That reminder is already set ${taskScheduleDescription(outcome.task)}: ${reminderText(outcome.task)}`;
            await callback?.({ text });
            return {
              success: true,
              text,
              data: {
                actionName: "REMINDERS",
                operation,
                deduplicated: true,
                task: outcome.task,
              },
              verifiedUserFacing: true,
              userFacingText: text,
              turnComplete: true,
            };
          }
          if (!isActiveReminder(outcome.result.task)) {
            return await actionFailure(
              "That retried reminder request is no longer active, so I didn't create another reminder.",
              callback,
              { operation, replayedTerminalRequest: true },
            );
          }
          const scheduled = outcome.result;
          const schedule = scheduled.replayed
            ? taskScheduleDescription(scheduled.task)
            : requestedScheduleDescription(
                input,
                scheduled.task.trigger,
                explicitDelay.kind === "resolved"
                  ? explicitDelay.milliseconds
                  : undefined,
              );
          const persistedBody = reminderText(scheduled.task);
          const text = scheduled.replayed
            ? `That reminder is already set ${schedule}: ${persistedBody}`
            : `Got it — I'll remind ${groupDelivery ? "this group" : "you"} ${schedule}: ${persistedBody}`;
          const receipt = creationReceipt(scheduled);
          await callback?.({ text });
          return {
            success: true,
            text,
            data: {
              actionName: "REMINDERS",
              operation,
              task: scheduled.task,
              replayed: scheduled.replayed,
              deduplicated: scheduled.replayed,
            },
            verifiedUserFacing: true,
            userFacingText: text,
            effectReceipts: [receipt],
            userFacingEffectReceiptIds: [receipt.receiptId],
            turnComplete: true,
          };
        }

        if (operation === "update") {
          const target = await resolveReminderTarget({
            runner: options.runner,
            delivery,
            exactReference: options.targetIntent !== undefined,
            reference:
              options.targetIntent ??
              textParameter(
                input,
                "taskId",
                "target",
                "targetTitle",
                "existingTitle",
                "title",
              ),
            coalesceExactSemanticDuplicates: true,
          });
          if (target.kind !== "match") {
            return await actionFailure(target.text, callback, {
              operation,
              ...(target.kind === "ambiguous"
                ? {
                    requiresSelection: true,
                    candidateTaskIds: target.candidates
                      .map((task) => task.taskId)
                      .slice(0, 100),
                  }
                : {}),
            });
          }
          const body =
            textParameter(
              input,
              "newReminderText",
              "replacementText",
              "reminderText",
            ) ?? reminderText(target.task);
          const maxBodyLength = sharedReminderMaxBodyLength(delivery);
          if (body.length > maxBodyLength) {
            return await actionFailure(
              `Reminder text must be ${maxBodyLength} characters or fewer.`,
              callback,
              { operation },
            );
          }
          const requestedTimezone = textParameter(input, "timezone", "tz");
          const timezone = requestedTimezone
            ? validTimeZone(requestedTimezone)
            : taskDisplayTimezone(target.task);
          if (requestedTimezone && !timezone) {
            return await actionFailure(
              "Use a valid IANA timezone such as Europe/Paris.",
              callback,
              { operation },
            );
          }
          if (hasOffsetlessAtIso(input)) {
            return await actionFailure(
              "Use an absolute atIso time with an explicit Z or ±HH:MM offset so I don't guess the timezone. Nothing was changed.",
              callback,
              { operation },
            );
          }
          const explicitDelay = resolveExplicitSharedReminderDelay(
            message.content?.text,
          );
          if (explicitDelay.kind === "invalid") {
            return await actionFailure(explicitDelay.reason, callback, {
              operation,
            });
          }
          const hasSchedulePatch =
            explicitDelay.kind === "resolved" ||
            [
              "inMinutes",
              "minutesFromNow",
              "atIso",
              "at",
              "everyMinutes",
              "cronExpression",
              "cron",
            ].some((name) => input[name] !== undefined);
          const usesRelativeSchedule =
            explicitDelay.kind === "resolved" ||
            ["inMinutes", "minutesFromNow"].some(
              (name) => input[name] !== undefined,
            );
          const trigger = hasSchedulePatch
            ? reminderTrigger(
                input,
                now(),
                explicitDelay.kind === "resolved"
                  ? explicitDelay.milliseconds
                  : undefined,
              )
            : requestedTimezone &&
                timezone &&
                target.task.trigger.kind === "cron"
              ? { ...target.task.trigger, tz: timezone }
              : target.task.trigger;
          if (!trigger) {
            return await actionFailure(
              "I couldn't understand the replacement reminder time. Nothing was changed.",
              callback,
              { operation },
            );
          }
          const outcome = await scheduleSemanticReminder({
            runner: options.runner,
            agentId: options.agentId,
            delivery,
            includeTimezoneInSemantics: true,
            requestIdempotencyKey:
              usesRelativeSchedule && message.id
                ? `shared-reminder:${String(message.id)}:update-replacement`
                : undefined,
            input: updatedReminderInput({
              task: target.task,
              body,
              trigger,
              delivery,
              timezone,
            }),
          });
          if (
            outcome.kind === "persisted" &&
            !isActiveReminder(outcome.result.task)
          ) {
            return await actionFailure(
              "That retried reminder update is no longer active, so I didn't create another reminder or dismiss anything else.",
              callback,
              { operation, replayedTerminalRequest: true },
            );
          }
          const replacement =
            outcome.kind === "persisted" ? outcome.result.task : outcome.task;
          const receipts: EffectReceipt[] =
            outcome.kind === "persisted"
              ? [creationReceipt(outcome.result)]
              : [];
          const originalsToDismiss = target.semanticDuplicates.filter(
            (task) => task.taskId !== replacement.taskId,
          );
          let failedDismissals = 0;
          for (const original of originalsToDismiss) {
            try {
              const dismissed = await options.runner.applyWithResult(
                original.taskId,
                "dismiss",
                { reason: "replaced by reminder update" },
                {
                  idempotencyKey: `shared-reminder:${String(message.id)}:update-dismiss:${original.taskId}`,
                },
              );
              receipts.push(lifecycleReceipt("dismiss", dismissed));
            } catch (error) {
              // error-policy:J1 the action boundary reports an honest partial
              // replacement result after attempting every original copy.
              failedDismissals += 1;
              reportReminderError(
                runtime,
                "SharedReminders.updateDismiss",
                error,
                {
                  operation,
                  phase: "replacement-dismiss",
                  failedCount: failedDismissals,
                },
              );
            }
          }
          if (failedDismissals > 0) {
            const removedCount = originalsToDismiss.length - failedDismissals;
            const text = `I saved the replacement reminder and removed ${removedCount} ${removedCount === 1 ? "old copy" : "old copies"}, but couldn't verify removal of ${failedDismissals} ${failedDismissals === 1 ? "other copy" : "other copies"}. Please list your reminders before retrying.`;
            await callback?.({ text });
            return {
              success: false,
              text,
              error: text,
              data: {
                actionName: "REMINDERS",
                operation,
                partial: true,
                replacement,
                removedCount,
                failedCount: failedDismissals,
              },
              verifiedUserFacing: true,
              userFacingText: text,
              effectReceipts: receipts,
              userFacingEffectReceiptIds: receipts.map(
                (receipt) => receipt.receiptId,
              ),
              turnComplete: true,
            };
          }
          const text =
            replacement.taskId === target.task.taskId
              ? `That reminder is already set ${taskScheduleDescription(replacement)}: ${reminderText(replacement)}`
              : `Updated reminder: ${taskSummary(replacement)}`;
          await callback?.({ text });
          return {
            success: true,
            text,
            data: {
              actionName: "REMINDERS",
              operation,
              task: replacement,
              replayed: outcome.kind === "persisted" && outcome.result.replayed,
            },
            verifiedUserFacing: true,
            userFacingText: text,
            ...(receipts.length
              ? {
                  effectReceipts: receipts,
                  userFacingEffectReceiptIds: receipts.map(
                    (receipt) => receipt.receiptId,
                  ),
                }
              : {}),
            turnComplete: true,
          };
        }

        if (operation === "clear") {
          if (
            !explicitClearConfirmation(
              input,
              message,
              options.clearConfirmationChallenge === true,
            )
          ) {
            return await actionFailure(
              "Clearing removes every active reminder. Please confirm by replying “yes, clear all reminders”.",
              callback,
              { operation, requiresConfirmation: true },
            );
          }
          const scopedTasks = (
            await options.runner.list({
              kind: "reminder",
              ownerVisibleOnly: true,
              status: ALL_REMINDER_STATUSES,
            })
          ).filter((task) => isReminderInDeliveryScope(task, delivery));
          const requestId = String(message.id);
          const scopedById = new Map(
            scopedTasks.map((task) => [task.taskId, task]),
          );
          const recoveredManifest = await recoverReminderMutationManifest({
            tasks: scopedTasks,
            requestId,
            operation: "clear",
          });
          const proposedManifest: ReminderMutationManifest =
            recoveredManifest ?? {
              kind: MUTATION_INTENT_CONTEXT_KIND,
              requestId,
              operation: "clear",
              taskIds: scopedTasks
                .filter((task) => isActiveReminder(task))
                .map((task) => task.taskId)
                .sort(),
            };
          if (proposedManifest.taskIds.length === 0) {
            const text = "You have no active reminders to clear.";
            await callback?.({ text });
            return {
              success: true,
              text,
              data: {
                actionName: "REMINDERS",
                operation,
                dismissedCount: 0,
                failedCount: 0,
              },
              verifiedUserFacing: true,
              userFacingText: text,
              turnComplete: true,
            };
          }
          // The exact target set is durable before the first dismiss attempt,
          // including when every downstream effect fails.
          const manifest = await reserveReminderMutationManifest({
            runner: options.runner,
            tasks: scopedTasks,
            manifest: proposedManifest,
          });
          const manifestTaskIds = manifest.taskIds;
          const tasks = manifestTaskIds.flatMap((taskId) => {
            const task = scopedById.get(taskId);
            return task ? [task] : [];
          });
          if (tasks.length === 0) {
            const text = "You have no active reminders to clear.";
            await callback?.({ text });
            return {
              success: true,
              text,
              data: {
                actionName: "REMINDERS",
                operation,
                dismissedCount: 0,
                failedCount: 0,
              },
              verifiedUserFacing: true,
              userFacingText: text,
              turnComplete: true,
            };
          }
          const receiptContext: ClearReceiptManifest = {
            kind: CLEAR_RECEIPT_CONTEXT_KIND,
            requestId,
            taskIds: manifestTaskIds,
          };
          const receipts: EffectReceipt[] = [];
          let failedCount = manifestTaskIds.length - tasks.length;
          for (const task of tasks) {
            try {
              const applied = await options.runner.applyWithResult(
                task.taskId,
                "dismiss",
                { reason: "confirmed clear all reminders" },
                {
                  idempotencyKey: clearApplyIdempotencyKey(
                    requestId,
                    task.taskId,
                  ),
                  receiptContext,
                },
              );
              receipts.push(lifecycleReceipt("dismiss", applied));
            } catch (error) {
              // error-policy:J1 the confirmed-clear action boundary reports
              // exact succeeded and unverified counts to the user.
              failedCount += 1;
              reportReminderError(
                runtime,
                "SharedReminders.clearDismiss",
                error,
                {
                  operation,
                  phase: "confirmed-clear-dismiss",
                  failedCount,
                },
              );
            }
          }
          const dismissedCount = receipts.length;
          const text =
            failedCount === 0
              ? `Cleared ${dismissedCount} ${dismissedCount === 1 ? "reminder" : "reminders"}.`
              : `Cleared ${dismissedCount} ${dismissedCount === 1 ? "reminder" : "reminders"}, but couldn't verify ${failedCount} ${failedCount === 1 ? "other reminder" : "other reminders"}.`;
          await callback?.({ text });
          return {
            success: failedCount === 0,
            text,
            ...(failedCount > 0 ? { error: text } : {}),
            data: {
              actionName: "REMINDERS",
              operation,
              dismissedCount,
              failedCount,
            },
            verifiedUserFacing: true,
            userFacingText: text,
            effectReceipts: receipts,
            userFacingEffectReceiptIds: receipts.map(
              (receipt) => receipt.receiptId,
            ),
            turnComplete: true,
          };
        }

        if (
          operation === "snooze" ||
          operation === "complete" ||
          operation === "dismiss" ||
          operation === "delete"
        ) {
          const requestId = String(message.id);
          const deleteScopedTasks =
            operation === "delete"
              ? (
                  await options.runner.list({
                    kind: "reminder",
                    ownerVisibleOnly: true,
                    status: ALL_REMINDER_STATUSES,
                  })
                ).filter((task) => isReminderInDeliveryScope(task, delivery))
              : undefined;
          const recoveredDeleteManifest = deleteScopedTasks
            ? await recoverReminderMutationManifest({
                tasks: deleteScopedTasks,
                requestId,
                operation: "delete",
              })
            : undefined;
          const recoveredDeleteTasks = recoveredDeleteManifest
            ? recoveredDeleteManifest.taskIds.flatMap((taskId) => {
                const task = deleteScopedTasks?.find(
                  (candidate) => candidate.taskId === taskId,
                );
                return task ? [task] : [];
              })
            : [];
          const target: ReminderTargetResolution = recoveredDeleteManifest
            ? recoveredDeleteTasks.length > 0
              ? {
                  kind: "match",
                  task: recoveredDeleteTasks[0],
                  semanticDuplicates: recoveredDeleteTasks,
                }
              : {
                  kind: "missing",
                  text: "I couldn't safely recover the original delete request, so I didn't delete any additional reminders. Please send a new delete request.",
                }
            : await resolveReminderTarget({
                runner: options.runner,
                delivery,
                exactReference: options.targetIntent !== undefined,
                reference:
                  options.targetIntent ??
                  textParameter(
                    input,
                    "taskId",
                    "target",
                    "targetTitle",
                    "title",
                    "reminderText",
                  ),
                coalesceExactSemanticDuplicates: operation === "delete",
                replay: {
                  verb:
                    operation === "delete" || operation === "dismiss"
                      ? "dismiss"
                      : operation,
                  idempotencyKey: (task) =>
                    `shared-reminder:${requestId}:${operation}:${task.taskId}`,
                },
              });
          if (target.kind !== "match") {
            return await actionFailure(target.text, callback, {
              operation,
              ...(target.kind === "ambiguous"
                ? {
                    requiresSelection: true,
                    candidateTaskIds: target.candidates
                      .map((task) => task.taskId)
                      .slice(0, 100),
                  }
                : {}),
            });
          }
          const verb = operation === "delete" ? "dismiss" : operation;
          const minutes = positiveNumber(input, "snoozeMinutes", "minutes");
          if (verb === "snooze" && minutes === undefined) {
            return await actionFailure(
              "Tell me how many minutes to snooze that reminder.",
              callback,
              { operation },
            );
          }
          const snoozeMilliseconds =
            verb === "snooze" && minutes !== undefined
              ? minuteDurationMilliseconds(minutes)
              : undefined;
          if (verb === "snooze" && snoozeMilliseconds === undefined) {
            return await actionFailure(
              "Snooze duration must resolve to a positive whole millisecond.",
              callback,
              { operation },
            );
          }
          let mutationTargets =
            operation === "delete" ? target.semanticDuplicates : [target.task];
          let deleteManifest: ReminderMutationManifest | undefined;
          if (operation === "delete") {
            const proposedManifest: ReminderMutationManifest =
              recoveredDeleteManifest ?? {
                kind: MUTATION_INTENT_CONTEXT_KIND,
                requestId,
                operation: "delete",
                taskIds: mutationTargets.map((task) => task.taskId).sort(),
              };
            deleteManifest = await reserveReminderMutationManifest({
              runner: options.runner,
              tasks: deleteScopedTasks ?? mutationTargets,
              manifest: proposedManifest,
            });
            mutationTargets = deleteManifest.taskIds.flatMap((taskId) => {
              const task = (deleteScopedTasks ?? mutationTargets).find(
                (candidate) => candidate.taskId === taskId,
              );
              return task ? [task] : [];
            });
            if (mutationTargets.length === 0) {
              return await actionFailure(
                "I couldn't safely recover the original delete request, so I didn't delete any additional reminders. Please send a new delete request.",
                callback,
                {
                  operation,
                  failureCode: "REMINDER_DELETE_MANIFEST_UNRECOVERABLE",
                },
              );
            }
          }
          const appliedResults: ScheduledTaskApplyResult[] = [];
          let failedCount =
            operation === "delete" && deleteManifest
              ? deleteManifest.taskIds.length - mutationTargets.length
              : 0;
          for (const task of mutationTargets) {
            try {
              appliedResults.push(
                await options.runner.applyWithResult(
                  task.taskId,
                  verb,
                  verb === "snooze" ? { minutes } : undefined,
                  {
                    idempotencyKey: `shared-reminder:${String(message.id)}:${operation}:${task.taskId}`,
                    ...(deleteManifest
                      ? { receiptContext: deleteManifest }
                      : {}),
                  },
                ),
              );
            } catch (error) {
              // error-policy:J1 delete is an explicit multi-row action whose
              // boundary returns an honest partial outcome; other verbs rethrow.
              reportReminderError(
                runtime,
                "SharedReminders.lifecycleMutation",
                error,
                {
                  operation,
                  phase: verb,
                  failedCount: failedCount + 1,
                },
              );
              if (operation !== "delete") throw error;
              failedCount += 1;
            }
          }
          const applied = appliedResults[0];
          const appliedTask = applied?.task ?? target.task;
          const text =
            verb === "snooze"
              ? `Reminder snoozed for ${formatDuration(snoozeMilliseconds as number)}: ${reminderText(appliedTask)}`
              : operation === "delete"
                ? failedCount > 0
                  ? `Deleted ${appliedResults.length} ${appliedResults.length === 1 ? "reminder" : "reminders"}, but couldn't verify ${failedCount} ${failedCount === 1 ? "other matching reminder" : "other matching reminders"}: ${reminderText(appliedTask)}`
                  : appliedResults.length === 1
                    ? `Reminder deleted: ${reminderText(appliedTask)}`
                    : `Deleted ${appliedResults.length} identical reminders: ${reminderText(appliedTask)}`
                : `Reminder ${verb === "complete" ? "completed" : "dismissed"}: ${reminderText(appliedTask)}`;
          const receipts = appliedResults.map((result) =>
            lifecycleReceipt(verb, result),
          );
          await callback?.({ text });
          return {
            success: failedCount === 0,
            text,
            ...(failedCount > 0 ? { error: text } : {}),
            data: {
              actionName: "REMINDERS",
              operation,
              task: appliedTask,
              replayed: applied?.replayed ?? false,
              affectedCount: appliedResults.length,
              failedCount,
            },
            verifiedUserFacing: true,
            userFacingText: text,
            effectReceipts: receipts,
            userFacingEffectReceiptIds: receipts.map(
              (receipt) => receipt.receiptId,
            ),
            turnComplete: true,
          };
        }

        return await actionFailure(
          "Choose create, list, update, snooze, complete, delete, dismiss, or clear.",
          callback,
          { operation: operation ?? "unknown" },
        );
      } catch (error) {
        // error-policy:J1 this action boundary translates an unverified durable
        // mutation into an explicit failure and never claims success.
        reportReminderError(runtime, "SharedReminders.handler", error, {
          operation: operation ?? "unknown",
          phase: "durable-operation",
        });
        return await actionFailure(
          "I couldn't verify that reminder change, so I won't claim it succeeded. Please list your reminders before retrying.",
          callback,
          {
            operation: operation ?? "unknown",
            failureCode: "REMINDER_MUTATION_UNVERIFIED",
          },
        );
      }
    },
  };
}

export function createSharedRemindersEdgePlugin(
  options: SharedRemindersEdgePluginOptions,
): Plugin {
  return {
    name: "shared-reminders-edge",
    description:
      "Free reminders persisted by the canonical scheduler and locked to the trusted chat that created them.",
    actions: [createSharedRemindersEdgeAction(options)],
  };
}
