/**
 * Agent-owned preflight for the trigger HTTP surface: owns `POST /api/triggers`
 * for prompt-kind triggers so their delivery binding is resolved (or the create
 * is rejected, typed) BEFORE a task is persisted. The workflow plugin's generic
 * create binds every trigger task to the autonomy room, which no dashboard
 * conversation maps to — a prompt trigger created that way fires forever with
 * every delivery failing ("no conversation available to deliver message").
 * Workflow-kind creates and every other `/api/triggers` route are untouched:
 * the server dispatcher runs this preflight first and, when it does not handle
 * the request, forwards to the plugin's `handleTriggerRoutes` — replaying the
 * already-consumed JSON body when the preflight had to read it to inspect the
 * requested trigger kind.
 *
 * Prompt creates accept an optional `roomId` naming the delivery conversation;
 * roomless creates fall back to the owner's most recently active dashboard
 * conversation via `resolveTriggerDeliveryBinding`, and a create with no
 * resolvable binding is rejected 400 with the actionable ElizaError message.
 */
import crypto from "node:crypto";
import type http from "node:http";
import {
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  stringToUuid,
  type Task,
  type UUID,
  validateUuid,
} from "@elizaos/core";
import {
  resolveTriggerDeliveryBinding,
  TRIGGER_DELIVERY_UNBOUND_CODE,
} from "../triggers/delivery.ts";
import {
  getTriggerLimit,
  listTriggerTasks,
  readTriggerConfig,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "../triggers/runtime.ts";
import {
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  normalizeText,
  normalizeTriggerDraft,
} from "../triggers/scheduling.ts";
import type {
  TriggerTaskMetadata,
  TriggerType,
  TriggerWakeMode,
} from "../triggers/types.ts";

type JsonBodyReader = <T extends object>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<T | null>;

export interface TriggerCreatePreflightContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  runtime: IAgentRuntime | null;
  readJsonBody: JsonBodyReader;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
}

export interface TriggerCreatePreflightResult {
  /** True when the preflight wrote the response; the caller must not delegate. */
  handled: boolean;
  /**
   * Present when the preflight consumed the request body but did not handle
   * the route: the delegate must read the body through this replay instead of
   * the (already-drained) request stream.
   */
  replayJsonBody?: JsonBodyReader;
}

function parseNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Handle `POST /api/triggers` with `kind: "prompt"`, mirroring the workflow
 * plugin's create semantics (creator fallback, draft normalization, limit,
 * dedupe, 201 summary) with one difference: the created task's room is the
 * resolved delivery binding, never the autonomy room.
 */
async function handlePromptTriggerCreate(
  runtime: IAgentRuntime,
  body: Record<string, unknown>,
  ctx: TriggerCreatePreflightContext,
): Promise<void> {
  const { res, json, error } = ctx;
  const creator =
    typeof body.createdBy === "string"
      ? normalizeText(body.createdBy) || "api"
      : "api";
  if (!parseNonEmptyString(body.instructions)) {
    error(res, "instructions is required when kind is 'prompt'", 400);
    return;
  }
  if (body.eventFilter != null && !isRecord(body.eventFilter)) {
    error(res, "eventFilter must be a JSON object", 400);
    return;
  }
  const explicitRoomId = validateUuid(body.roomId);
  if (body.roomId !== undefined && !explicitRoomId) {
    error(res, "roomId must be a valid UUID naming the delivery room", 400);
    return;
  }

  const normalized = normalizeTriggerDraft({
    input: {
      displayName:
        typeof body.displayName === "string" ? body.displayName : undefined,
      instructions:
        typeof body.instructions === "string" ? body.instructions : undefined,
      triggerType:
        typeof body.triggerType === "string"
          ? (body.triggerType as TriggerType)
          : undefined,
      wakeMode:
        typeof body.wakeMode === "string"
          ? (body.wakeMode as TriggerWakeMode)
          : undefined,
      enabled: !!(body.enabled ?? true),
      createdBy: creator,
      notifyOnOutcome: true,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      intervalMs:
        typeof body.intervalMs === "number" ? body.intervalMs : undefined,
      scheduledAtIso:
        typeof body.scheduledAtIso === "string"
          ? body.scheduledAtIso
          : undefined,
      cronExpression:
        typeof body.cronExpression === "string"
          ? body.cronExpression
          : undefined,
      eventKind:
        typeof body.eventKind === "string" ? body.eventKind : undefined,
      eventFilter: isRecord(body.eventFilter) ? body.eventFilter : undefined,
      maxRuns: typeof body.maxRuns === "number" ? body.maxRuns : undefined,
      kind: "prompt",
    },
    fallback: {
      displayName:
        typeof body.displayName === "string" && normalizeText(body.displayName)
          ? normalizeText(body.displayName)
          : "New Trigger",
      instructions:
        typeof body.instructions === "string"
          ? normalizeText(body.instructions)
          : "",
      triggerType:
        typeof body.triggerType === "string"
          ? (body.triggerType as TriggerType)
          : "interval",
      wakeMode:
        typeof body.wakeMode === "string"
          ? (body.wakeMode as TriggerWakeMode)
          : "inject_now",
      enabled: body.enabled === undefined ? true : body.enabled === true,
      createdBy: creator,
      notifyOnOutcome: true,
    },
  });
  if (!normalized.draft) {
    error(res, normalized.error ?? "Invalid trigger request", 400);
    return;
  }

  const existingTasks = await listTriggerTasks(runtime);
  const activeCount = existingTasks.filter((task) => {
    const trigger = readTriggerConfig(task);
    return trigger?.enabled && trigger.createdBy === creator;
  }).length;
  const limit = getTriggerLimit(runtime);
  if (activeCount >= limit) {
    error(res, `Active trigger limit reached (${limit})`, 429);
    return;
  }

  const triggerId = stringToUuid(crypto.randomUUID());
  const trigger = buildTriggerConfig({ draft: normalized.draft, triggerId });

  const duplicate = existingTasks.find((task) => {
    const existingTrigger = readTriggerConfig(task);
    return (
      existingTrigger?.enabled &&
      existingTrigger.dedupeKey &&
      existingTrigger.dedupeKey === trigger.dedupeKey
    );
  });
  if (duplicate?.id) {
    error(res, "Equivalent trigger already exists", 409);
    return;
  }

  const nowMs = Date.now();
  const metadata: TriggerTaskMetadata | null = trigger.enabled
    ? buildTriggerMetadata({ trigger, nowMs })
    : {
        updatedAt: nowMs,
        updateInterval: DISABLED_TRIGGER_INTERVAL_MS,
        trigger: {
          ...trigger,
          nextRunAtMs: nowMs + DISABLED_TRIGGER_INTERVAL_MS,
        },
      };
  if (!metadata) {
    error(res, "Unable to compute trigger schedule", 400);
    return;
  }

  let deliveryRoomId: UUID | undefined;
  try {
    const binding = await resolveTriggerDeliveryBinding(runtime, {
      explicitRoomId: explicitRoomId ?? undefined,
    });
    deliveryRoomId = binding.roomId;
  } catch (err) {
    // error-policy:J1 boundary translation — a prompt trigger that can never
    // deliver is rejected at the create boundary with the actionable reason
    // instead of being persisted to fire-and-fail forever.
    if (isElizaError(err) && err.code === TRIGGER_DELIVERY_UNBOUND_CODE) {
      error(res, err.message, 400);
      return;
    }
    throw err;
  }
  if (!deliveryRoomId) {
    // Unreachable by construction (the resolver returns a room or throws),
    // kept as a typed guard so a future resolver change cannot silently
    // reintroduce a roomless create.
    throw new ElizaError(
      "trigger delivery binding resolved without a room id",
      { code: TRIGGER_DELIVERY_UNBOUND_CODE, context: { triggerId } },
    );
  }

  const taskId = await runtime.createTask({
    name: TRIGGER_TASK_NAME,
    description: trigger.displayName,
    roomId: deliveryRoomId,
    tags: [...TRIGGER_TASK_TAGS],
    metadata: metadata as Task["metadata"],
  });
  const created = await runtime.getTask(taskId);
  const summary = created ? taskToTriggerSummary(created) : null;
  if (!summary) {
    error(res, "Trigger created but summary could not be generated", 500);
    return;
  }
  json(res, { trigger: summary }, 201);
}

/**
 * Run before delegating `/api/triggers` to the workflow plugin. Handles
 * prompt-kind creates itself; for any other request it returns unhandled —
 * with a body replay when it had to parse the JSON to inspect `kind`.
 */
export async function interceptTriggerCreate(
  ctx: TriggerCreatePreflightContext,
): Promise<TriggerCreatePreflightResult> {
  if (ctx.method !== "POST" || ctx.pathname !== "/api/triggers") {
    return { handled: false };
  }
  const runtime = ctx.runtime;
  // Missing runtime / disabled feature answer through the delegate so those
  // states keep one owner (and one response shape) for the whole surface.
  if (!runtime || !triggersFeatureEnabled(runtime)) {
    return { handled: false };
  }
  const body = await ctx.readJsonBody<Record<string, unknown>>(
    ctx.req,
    ctx.res,
  );
  if (!body) {
    // readJsonBody already wrote the malformed-body response.
    return { handled: true };
  }
  const replayJsonBody: JsonBodyReader = <T extends object>() =>
    Promise.resolve(body as unknown as T);
  if (body.kind !== "prompt") {
    return { handled: false, replayJsonBody };
  }
  await handlePromptTriggerCreate(runtime, body, ctx);
  return { handled: true };
}
