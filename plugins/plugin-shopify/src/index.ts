import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  getConnectorAccountManager,
  logger,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { shopifyAction } from "./actions/shopify.js";
import { createShopifyConnectorAccountProvider } from "./connector-account-provider.js";
import { storeContextProvider } from "./providers/store-context.js";
import { ShopifyService } from "./services/ShopifyService.js";

const shopifyPlugin: Plugin = {
  name: "shopify",
  description:
    "Manage Shopify stores -- products, orders, inventory, customers",
  actions: [...promoteSubactionsToActions(shopifyAction)],
  providers: [storeContextProvider],
  services: [ShopifyService],
  // Self-declared auto-enable: activate when the SHOPIFY_ACCESS_TOKEN env var
  // is set. (Manifest-only auto-enable — see ./auto-enable.ts.)
  autoEnable: {
    envKeys: ["SHOPIFY_ACCESS_TOKEN", "SHOPIFY_ACCOUNTS"],
  },
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createShopifyConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:shopify",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Shopify provider with ConnectorAccountManager",
      );
    }
  },
  async dispose(runtime) {
    await runtime
      .getService<ShopifyService>(ShopifyService.serviceType)
      ?.stop();
  },
};

export default shopifyPlugin;
export * from "./accounts.js";
export { createShopifyConnectorAccountProvider } from "./connector-account-provider.js";
export type { ShopifyPluginConfig } from "./types.js";
export { ShopifyService };

// Dashboard UI surface (merged from the former @elizaos/plugin-shopify-ui).
// `shopifyPlugin` from ./plugin is the route + views plugin; re-exported under
// a distinct name so it does not collide with the default agent plugin above.
export { shopifyPlugin as shopifyRoutePlugin } from "./plugin";
export * from "./register";
export * from "./routes";
export { ShopifyView } from "./ShopifyView";
export * from "./useShopifyDashboard";
