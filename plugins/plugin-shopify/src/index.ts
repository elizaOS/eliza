import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { shopifyAction } from "./actions/shopify.js";
import { createShopifyConnectorAccountProvider } from "./connector-account-provider.js";
import { storeContextProvider } from "./providers/store-context.js";
import { ShopifyService } from "./services/ShopifyService.js";

const shopifyPlugin: Plugin = {
  name: "shopify",
  description:
    "Manage Shopify stores -- products, orders, inventory, customers",
  actions: [shopifyAction],
  providers: [storeContextProvider],
  services: [ShopifyService],
  // Self-declared auto-enable: activate when the SHOPIFY_ACCESS_TOKEN env var
  // is set. The hardcoded AUTH_PROVIDER_PLUGINS map still serves as fallback.
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
};

export default shopifyPlugin;
export * from "./accounts.js";
export { createShopifyConnectorAccountProvider } from "./connector-account-provider.js";
export type { ShopifyPluginConfig } from "./types.js";
export { ShopifyService };
