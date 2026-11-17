// spec/agent/plugins/profile.md, "Story: Register my product's own actions and routes"
import type { Action } from "@elizaos/core";
import type { AgentPlugin } from "../../../src/host/module.vibe";

export const productActionName = "PRODUCT_ACTION";

const productAction: Action = {
  name: productActionName,
  description: "Echo the owner's words back as structured data for the product's own screen.",
  validate: async () => true,
  handler: async (_runtime, message) => ({
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
      handler: async () => ({ status: 200, body: { pong: true } }),
    },
  ],
} satisfies AgentPlugin;

export const claimingProductPlugin = {
  ...productPlugin,
  name: "claiming-product-fixture",
  routes: [{ ...productPlugin.routes[0], path: "/api/tasks/product" }],
} satisfies AgentPlugin;

export default productPlugin;
