/**
 * Event dispatch handler for the agent-server.
 *
 * Receives structured events forwarded by the gateway's POST /internal/event
 * route and dispatches them to the appropriate agent runtime handler based on
 * the event type.
 *
 * Ticket #54 behavior spec:
 *   1. Validate: Agent with :id must be loaded in this pod's runtime
 *   2. Dispatch: Route by type (cron | notification | system)
 *   3. Response: 200 { handled: true, type } on success
 */

import {
  ChannelType,
  createMessageMemory,
  type EventPayload,
  type IAgentRuntime,
  stringToUuid,
} from "@elizaos/core";
import { z } from "zod";
import { logger } from "../logger";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
const JsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  JsonValueSchema,
);
export type AgentEventType = "cron" | "notification" | "system";

const CANONICAL_NOTIFICATION_SOURCES = [
  "email",
  "gmail",
  "calendar",
  "google_calendar",
] as const;

const CanonicalNotificationProvenanceSchema = z
  .object({
    source: z.enum(CANONICAL_NOTIFICATION_SOURCES),
    accountId: z.string().min(1).max(128),
    platformRecordId: z.string().min(1).max(256),
    chat: z
      .object({
        id: z.string().min(1).max(128),
        type: z.enum(["dm", "private", "direct", "group", "channel"]),
      })
      .strict(),
    senderName: z.string().min(1).max(255).optional(),
  })
  .strict();

type CanonicalNotificationProvenance = z.infer<
  typeof CanonicalNotificationProvenanceSchema
>;

/**
 * Zod schema for the event request body.
 *
 * Matches the body format sent by the gateway's forwardEventToServer():
 *   JSON.stringify({ userId, type, payload })
 *
 * userId regex allows alphanumeric, underscore, @, period, and hyphen to
 * support email-format userIds while preventing path traversal.
 */
export const EventBodySchema = z
  .object({
    userId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_@.-]+$/),
    type: z.enum(["cron", "notification", "system"] as const),
    payload: JsonObjectSchema,
  })
  .superRefine((event, ctx) => {
    const envelope = event.payload.canonicalProvenance;
    if (envelope === undefined) return;
    if (event.type !== "notification") {
      ctx.addIssue({
        code: "custom",
        path: ["payload", "canonicalProvenance"],
        message: "canonicalProvenance is only accepted on notification events",
      });
      return;
    }
    const parsed = CanonicalNotificationProvenanceSchema.safeParse(envelope);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ["payload", "canonicalProvenance", ...issue.path],
        });
      }
    }
  });

/**
 * Dispatch result returned by each per-type handler, merged into the
 * route response alongside { handled: true, type }.
 */
export interface DispatchResult {
  response?: string;
  status?: "running";
  agentId?: string;
  reloaded?: true;
}

/**
 * Routes an event to the correct handler based on its type.
 *
 * This is the core dispatch function called by AgentManager.handleEvent()
 * after inFlight tracking has been engaged and the runtime has been resolved.
 *
 * @param runtime  - The agent runtime for the target agent
 * @param agentId  - The agent ID from the URL path
 * @param userId   - The user ID from the event body
 * @param type     - The event type: "cron" | "notification" | "system"
 * @param payload  - Arbitrary structured data for the handler
 */
export async function dispatchEvent(
  runtime: IAgentRuntime,
  agentId: string,
  userId: string,
  type: AgentEventType,
  payload: JsonObject,
): Promise<DispatchResult> {
  switch (type) {
    case "cron":
      return handleCronEvent(runtime, userId, payload);
    case "notification":
      return handleNotificationEvent(runtime, agentId, userId, payload);
    case "system":
      return handleSystemEvent(runtime, agentId, payload);
  }
}

/**
 * Handles cron-type events by emitting a "cron" event on the agent runtime.
 *
 * Plugins can register handlers for the "cron" event via Plugin.events to
 * implement scheduled behaviors (e.g. matcher tick, reminder check).
 *
 * Note: The eliza core EventType enum does not include "cron" — this is an
 * app-level string event, supported by runtime.emitEvent(string, ...).
 * Specific cron dispatch will be extended as Epic 2 progresses.
 */
async function handleCronEvent(
  runtime: IAgentRuntime,
  userId: string,
  payload: JsonObject,
): Promise<DispatchResult> {
  logger.debug("Dispatching cron event", { userId });
  const eventPayload: EventPayload & { userId: string; payload: JsonObject } = {
    runtime,
    source: "agent-server",
    userId,
    payload,
  };
  await runtime.emitEvent("cron", eventPayload);
  return {};
}

/**
 * Handles notification-type events by delivering a proactive message to the
 * user via the agent's runtime message pipeline.
 *
 * Follows the same pattern as AgentManager.handleMessage():
 *   ensureConnection → createMessageMemory → messageService.handleMessage
 *
 * The notification text is extracted from payload.text or payload.message.
 */
async function handleNotificationEvent(
  runtime: IAgentRuntime,
  agentId: string,
  userId: string,
  payload: JsonObject,
): Promise<DispatchResult> {
  const text =
    typeof payload.text === "string"
      ? payload.text
      : typeof payload.message === "string"
        ? payload.message
        : JSON.stringify(payload);

  logger.debug("Dispatching notification event", { agentId, userId });

  const provenance = readCanonicalNotificationProvenance(payload);
  const entityId = stringToUuid(userId);
  const source = provenance?.source ?? "notification";
  const roomKey = provenance
    ? `${agentId}:${provenance.source}:${provenance.accountId}:${provenance.chat.id}`
    : `${agentId}:${userId}`;
  const roomId = stringToUuid(roomKey);
  const worldId = stringToUuid(`server:${process.env.SERVER_NAME}`);
  const channelType =
    provenance && isGroupNotificationChatType(provenance.chat.type)
      ? ChannelType.GROUP
      : ChannelType.DM;

  await runtime.ensureConnection({
    entityId,
    roomId,
    worldId,
    userName: userId,
    source,
    channelId: provenance
      ? `${provenance.source}:${provenance.accountId}:${provenance.chat.id}`
      : `${agentId}-${userId}`,
    type: channelType,
  } as Parameters<typeof runtime.ensureConnection>[0]);

  const mem = createMessageMemory({
    entityId,
    roomId,
    content: {
      text,
      source,
      channelType,
    },
  });
  if (provenance) {
    mem.metadata = buildNotificationCanonicalMetadata({
      provenance,
      userId,
      entityId,
    }) as typeof mem.metadata;
  }

  if (!runtime.messageService) {
    throw new Error("Message service unavailable");
  }

  let response = "";
  await runtime.messageService.handleMessage(runtime, mem, async (content) => {
    if (content?.text) response += content.text;
    return [];
  });

  return response ? { response } : {};
}

function readCanonicalNotificationProvenance(
  payload: JsonObject,
): CanonicalNotificationProvenance | null {
  const value = payload.canonicalProvenance;
  if (value === undefined) return null;
  return CanonicalNotificationProvenanceSchema.parse(value);
}

function isGroupNotificationChatType(
  type: CanonicalNotificationProvenance["chat"]["type"],
): boolean {
  return type === "group" || type === "channel";
}

function buildNotificationCanonicalMetadata(args: {
  provenance: CanonicalNotificationProvenance;
  userId: string;
  entityId: string;
}): Record<string, unknown> {
  const { provenance, userId, entityId } = args;
  const sender = provenance.senderName
    ? { id: userId, name: provenance.senderName }
    : { id: userId };
  return {
    type: "message",
    timestamp: Date.now(),
    scope: "private",
    provider: provenance.source,
    accountId: provenance.accountId,
    platformMessageId: provenance.platformRecordId,
    sourceId: provenance.platformRecordId,
    chatType: provenance.chat.type,
    sender,
    ...(provenance.senderName
      ? { entityName: provenance.senderName }
      : undefined),
    [provenance.source]: {
      id: userId,
      userId,
      entityId,
      ...(provenance.senderName ? { name: provenance.senderName } : {}),
      accountId: provenance.accountId,
      messageId: provenance.platformRecordId,
      chatId: provenance.chat.id,
    },
  };
}

/**
 * Handles system-type events for internal lifecycle operations.
 *
 * Dispatches by payload.action:
 *   - "health": returns agent runtime status info
 *   - "config-reload": emits a runtime event for loaded plugins/services
 *   - default: logs and acknowledges
 */
async function handleSystemEvent(
  runtime: IAgentRuntime,
  agentId: string,
  payload: JsonObject,
): Promise<DispatchResult> {
  const action =
    typeof payload.action === "string" ? payload.action : "unknown";
  logger.info("Dispatching system event", { agentId, action });

  switch (action) {
    case "health":
      return { status: "running", agentId };
    case "config-reload": {
      logger.info("Dispatching config reload event", { agentId });
      const eventPayload: EventPayload & {
        agentId: string;
        payload: JsonObject;
      } = {
        runtime,
        source: "agent-server",
        agentId,
        payload,
      };
      await runtime.emitEvent("config-reload", eventPayload);
      return { reloaded: true };
    }
    default:
      return {};
  }
}
