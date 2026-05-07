import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { searchStoreAction } from "./actions/search-store.js";
import { shopifyAction } from "./actions/shopify.js";
import { storeContextProvider } from "./providers/store-context.js";
import { registerShopifySearchCategory } from "./search-category.js";
import { ShopifyService } from "./services/ShopifyService.js";

// SHOPIFY handles mutating CRUD; SEARCH_SHOPIFY_STORE handles read-only
// catalog browsing. Splitting the read path out keeps each action's
// purpose unambiguous and lets the planner pick the cheaper, side-effect-
// free action when the user is just browsing.
const shopifyPlugin: Plugin = {
  name: "shopify",
  description: "Manage Shopify stores -- products, orders, inventory, customers",
  actions: [shopifyAction, searchStoreAction],
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
