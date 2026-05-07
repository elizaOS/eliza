import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { shopifyAction } from "./actions/shopify.js";
import { storeContextProvider } from "./providers/store-context.js";
import { registerShopifySearchCategory } from "./search-category.js";
import { ShopifyService } from "./services/ShopifyService.js";

const shopifyPlugin: Plugin = {
  name: "shopify",
  description: "Manage Shopify stores -- products, orders, inventory, customers",
  actions: [shopifyAction],
  providers: [storeContextProvider],
  services: [ShopifyService],
  // Self-declared auto-enable: activate when the SHOPIFY_ACCESS_TOKEN env var
  // is set. The hardcoded AUTH_PROVIDER_PLUGINS map still serves as fallback.
  autoEnable: {
    envKeys: ["SHOPIFY_ACCESS_TOKEN"],
  },
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    registerShopifySearchCategory(runtime);
  },
};

export default shopifyPlugin;
export type { ShopifyPluginConfig } from "./types.js";
export { ShopifyService };
