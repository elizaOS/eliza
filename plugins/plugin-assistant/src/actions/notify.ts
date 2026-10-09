/**
 * NOTIFY — create a user-facing notification.
 *
 * The agent (or anything routing through the action layer) calls this to push
 * a structured notification onto the unified rail: persisted to the inbox and
 * fanned out live to every client surface (in-app center + toast, desktop OS,
 * mobile native). Distinct from a chat reply — use NOTIFY when the user should
 * be alerted to something (a finished job, a needed approval, a reminder) even
 * when they are not looking at the conversation.
 */

import type {
  Action,
  ActionResult,
  HandlerOptions,
  NotificationCategory,
  NotificationInput,
  NotificationPriority,
} from "@elizaos/core";
import { logger, NotificationService, ServiceType } from "@elizaos/core";

const CATEGORIES: NotificationCategory[] = [
  "reminder",
  "task",
  "workflow",
  "agent",
  "approval",
  "message",
  "health",
  "system",
  "general",
];

const PRIORITIES: NotificationPriority[] = ["low", "normal", "high", "urgent"];

interface NotifyParams {
  title?: string;
  body?: string;
  category?: string;
  priority?: string;
  deepLink?: string;
  groupKey?: string;
}

function getService(runtime: {
  getService: (t: string) => unknown;
}): NotificationService | null {
  const svc = runtime.getService(ServiceType.NOTIFICATION);
  return svc instanceof NotificationService ? svc : null;
}

export const notifyAction: Action = {
  name: "NOTIFY",
  // Deliberately NOT the chat-answer path: without explicit contexts this
  // action fell back to ["general"], landing on the action surface of every
  // ordinary chat turn — and similes like NOTIFY_USER read to a weak planner
  // as "tell the user the answer" (observed live: NOTIFY chosen for "who are
  // the top 3 contributors", posting a self-notification instead of the
  // answer). Scope it to automation/agent-internal turns where proactive
  // alerts actually originate.
  contexts: ["automation", "agent_internal"],
  routingHint:
    "push a proactive OS/notification-center alert (completed job, reminder, approval needed) -> NOTIFY; to answer the user's question in chat -> REPLY (never NOTIFY)",
  similes: ["SEND_NOTIFICATION", "PUSH_NOTIFICATION", "SEND_ALERT"],
  description:
    "Send the user a notification (persisted to their notification center and surfaced as an OS/in-app alert). Use when the user should be proactively alerted to something — a completed job, a reminder, an approval needed — rather than just replying in chat. Provide a short `title` and optional `body`, `category` (reminder|task|workflow|agent|approval|message|health|system|general), and `priority` (low|normal|high|urgent).",
  descriptionCompressed:
    "push a user-facing notification (title/body/category/priority) to the notification center + OS/in-app alert",
  validate: async (runtime): Promise<boolean> => getService(runtime) !== null,
  handler: async (
    runtime,
    _message,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const service = getService(runtime);
    if (!service) {
      return {
        success: false,
        text: "Notification service is not available.",
        values: { error: "NOTIFICATION_SERVICE_UNAVAILABLE" },
        data: { actionName: "NOTIFY" },
      };
    }

    const params =
      ((options as HandlerOptions | undefined)?.parameters as
        | NotifyParams
        | undefined) ?? {};
    const title = params.title?.trim();
    if (!title) {
      if (callback) {
        callback({
          text: "I need a title to send a notification.",
          action: "NOTIFY_INVALID",
        });
      }
      return {
        success: false,
        text: "Notification title is required.",
        values: { error: "NOTIFY_MISSING_TITLE" },
        data: { actionName: "NOTIFY" },
      };
    }

    const category =
      params.category &&
      CATEGORIES.includes(params.category as NotificationCategory)
        ? (params.category as NotificationCategory)
        : "general";
    const priority =
      params.priority &&
      PRIORITIES.includes(params.priority as NotificationPriority)
        ? (params.priority as NotificationPriority)
        : "normal";

    const input: NotificationInput = {
      title,
      body: params.body?.trim() || undefined,
      category,
      priority,
      deepLink: params.deepLink?.trim() || undefined,
      groupKey: params.groupKey?.trim() || undefined,
      source: "agent",
    };

    try {
      const notification = await service.notify(input);
      if (callback) {
        callback({
          text: `Notification sent: ${title}`,
          action: "NOTIFY_SENT",
        });
      }
      return {
        success: true,
        text: `Sent notification "${title}".`,
        values: { notificationId: notification.id, category, priority },
        data: { actionName: "NOTIFY", notification },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[NOTIFY] failed: ${msg}`);
      return {
        success: false,
        text: `Failed to send notification: ${msg}`,
        values: { error: "NOTIFY_FAILED" },
        data: { actionName: "NOTIFY" },
      };
    }
  },
  parameters: [
    {
      name: "title",
      description: "Short notification headline.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description: "Optional longer detail line.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "category",
      description: "Notification category for grouping/iconography.",
      required: false,
      schema: { type: "string" as const, enum: [...CATEGORIES] },
    },
    {
      name: "priority",
      description:
        "Urgency. high/urgent interrupt a focused window; low/normal land quietly in the inbox.",
      required: false,
      schema: { type: "string" as const, enum: [...PRIORITIES] },
    },
    {
      name: "deepLink",
      description:
        "App route (e.g. /tasks) or URL to open when the notification is tapped.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "groupKey",
      description:
        "Collapse key — a newer notification with the same key replaces the older one.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "Let me know when the deploy finishes." },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Will do — I'll notify you the moment it's done.",
          actions: ["NOTIFY"],
        },
      },
    ],
  ],
};

export default notifyAction;
