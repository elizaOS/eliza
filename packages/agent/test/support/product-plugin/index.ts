// spec/agent/plugins/profile.md, "Story: Register my product's own actions and routes"; spec/agent/models/binding.md, "Plugins reach the cloud only through the cloud service of a cloud backend, and a managed Google change needs the owner's consent"
import { ModelType, promoteSubactionsToActions, type Action, type IAgentRuntime } from "@elizaos/core";
import type { AgentPlugin } from "../../../src/host/module.vibe";
import type { CloudLinkReply, CloudLinkService } from "../../../src/models/cloud-link.vibe";
import { scheduledTasksServiceType, type ScheduledTasksApi, type TaskTrigger } from "../../../src/schedule/scheduled-task-routes.vibe";
import type { DeliveryResult } from "../../../src/schedule/scheduled-tasks.vibe";

export const productActionName = "PRODUCT_ACTION";

const productAction: Action = {
  name: productActionName,
  description: "Echo the owner's words back as structured data for the product's own screen.",
  validate: () => Promise.resolve(true),
  handler: (_runtime, message) => Promise.resolve({
    success: true,
    text: "Echoed.",
    data: { echoed: typeof message.content.text === "string" ? message.content.text : "" },
  }),
};

export const productPlugin = {
  name: "product-fixture",
  description: "A product plugin fixture: one action and one route of its own.",
  actions: [productAction],
  routes: [
    {
      method: "GET",
      path: "/api/product/ping",
      handler: () => Promise.resolve({ status: 200, body: { pong: true } }),
    },
  ],
} satisfies AgentPlugin;

export const claimingProductPlugin = {
  ...productPlugin,
  name: "claiming-product-fixture",
  routes: [{ ...productPlugin.routes[0], path: "/api/tasks/product" }],
} satisfies AgentPlugin;

export const productClearActionName = "PRODUCT_CLEAR";

const productClearAction: Action = {
  name: productClearActionName,
  description: "Ask the owner before clearing the product's own list.",
  validate: () => Promise.resolve(true),
  handler: () => Promise.resolve({
    success: true,
    effectReceipts: [{
      receiptId: "product-list:clear:preview", operation: "product.clear", resource: { kind: "product.list", id: "list-1" }, artifacts: [],
      idempotency: { key: "product-list:clear", replayed: false }, observedAt: new Date().toISOString(), outcome: "preview",
    }],
    text: "This clears 3 items. Reply yes to clear them, or anything else to keep them.",
    data: { awaitingUserInput: true },
  }),
};

export const clearingProductPlugin = {
  name: "clearing-product-fixture",
  description: "A product plugin fixture whose action previews a change and tells only the model the question to ask.",
  actions: [productClearAction],
} satisfies AgentPlugin;

export const productDraftActionName = "PRODUCT_DRAFT";

const productDraftAction: Action = {
  name: productDraftActionName,
  description: "Draft a summary of the product's own list with the text model.",
  validate: () => Promise.resolve(true),
  handler: async (runtime) => {
    const drafted = await runtime.useModel(ModelType.TEXT_SMALL, { prompt: "Summarize the product's list." });
    return { success: true, text: typeof drafted === "string" ? drafted : "", data: { drafted } };
  },
};

export const draftingProductPlugin = {
  name: "drafting-product-fixture",
  description: "A product plugin fixture whose action asks the text model for a draft.",
  actions: [productDraftAction],
} satisfies AgentPlugin;

export const productGoogleActionName = "PRODUCT_GOOGLE";

const google = "/api/v1/eliza/google";

const productGoogleAction: Action = {
  name: productGoogleActionName,
  description: "Try a managed Gmail change, a calendar edit and a Gmail read through the owner's cloud link.",
  validate: () => Promise.resolve(true),
  handler: async (runtime) => {
    const cloud = runtime.getService<CloudLinkService>("cloud");
    if (cloud === null) return { success: false, text: "No cloud link.", data: { linked: false } };
    const attempts: Record<string, CloudLinkReply> = {
      gmailChange: await cloud.request({ method: "POST", path: `${google}/gmail/inbox-v1/operations`, body: { kind: "archive", threadId: "thread-1" }, idempotencyKey: "fixture-gmail-1" }),
      calendarEdit: await cloud.request({ method: "POST", path: `${google}/calendar/events`, body: { title: "Fixture", start: "2026-11-18T10:00:00Z", end: "2026-11-18T11:00:00Z" }, idempotencyKey: "fixture-calendar-1" }),
      read: await cloud.request({ method: "GET", path: `${google}/gmail/triage` }),
      privateInboxArrival: await cloud.request({ method: "GET", path: `${google}/gmail/inbox-v1/arrival` }).then(
        (response) => response,
        () => ({ kind: "refused", status: 403, body: null }),
      ),
    };
    return { success: true, text: "Tried the cloud link.", data: { linked: true, attempts } };
  },
};

export const googleProductPlugin = {
  name: "google-product-fixture",
  description: "A product plugin fixture that reaches managed Google only through the cloud service.",
  actions: [productGoogleAction],
} satisfies AgentPlugin;

export const scheduledDeliveries = { script: [] as DeliveryResult[], attempts: [] as string[] };

interface ProductTask {
  readonly kind: string;
  readonly ownerVisible: boolean;
  readonly promptInstructions: string;
  readonly trigger: TaskTrigger;
  readonly idempotencyKey?: string;
}

let scheduledRuntime: IAgentRuntime | undefined;

export const scheduledProductPlugin = {
  name: "scheduled-product-fixture",
  description: "A product plugin fixture that creates scheduled task rows through the scheduled-tasks module and scripts their delivery.",
  init: (_config, runtime) => {
    scheduledRuntime = runtime;
    return Promise.resolve();
  },
  routes: [
    {
      method: "POST",
      path: "/api/product/scheduled-tasks",
      handler: async ({ body }) => {
        const tasks = scheduledRuntime?.getService<ScheduledTasksApi>(scheduledTasksServiceType);
        if (tasks === null || tasks === undefined) return { status: 503, body: { error: "no_scheduled_tasks" } };
        const made = await tasks.create({
          ...(body as ProductTask),
          delivery: (task) => {
            scheduledDeliveries.attempts.push(task.taskId);
            return Promise.resolve(scheduledDeliveries.script.shift() ?? { kind: "delivered" });
          },
        });
        return { status: 200, body: { created: made.kind, taskId: made.task.taskId, revision: made.task.revision } };
      },
    },
  ],
} satisfies AgentPlugin;

export const umbrellaActionName = "PRODUCT_MANAGE";
export const umbrellaSubactionName = "PRODUCT_MANAGE_CREATE";

const umbrellaAction: Action = {
  name: umbrellaActionName,
  description: "Manage the product's own records.",
  parameters: [{ name: "action", description: "The operation to run.", required: true, schema: { type: "string", enum: ["create"] } }],
  validate: () => Promise.resolve(true),
  handler: () => Promise.resolve({ success: true, text: "Managed." }),
};

export const umbrellaProductPlugin = {
  name: "umbrella-product-fixture",
  description: "A product plugin fixture: one umbrella action whose subaction core promotes.",
  actions: [...promoteSubactionsToActions(umbrellaAction)],
} satisfies AgentPlugin;

export default productPlugin;
