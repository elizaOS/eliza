// spec/agent/plugins/profile.md, "Story: Register my product's own actions and routes"; spec/agent/models/binding.md, "Plugins reach the cloud only through the cloud service of a cloud backend, and a managed Google change needs the owner's consent"
import type { Action } from "@elizaos/core";
import type { AgentPlugin } from "../../../src/host/module.vibe";
import type { CloudLinkReply, CloudLinkService } from "../../../src/models/cloud-link.vibe";

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
    };
    return { success: true, text: "Tried the cloud link.", data: { linked: true, attempts } };
  },
};

export const googleProductPlugin = {
  name: "google-product-fixture",
  description: "A product plugin fixture that reaches managed Google only through the cloud service.",
  actions: [productGoogleAction],
} satisfies AgentPlugin;

export default productPlugin;
