import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { manageCustomersAction } from "./actions/manage-customers.js";
import { manageInventoryAction } from "./actions/manage-inventory.js";
import { manageOrdersAction } from "./actions/manage-orders.js";
import { manageProductsAction } from "./actions/manage-products.js";
import { searchStoreAction } from "./actions/search-store.js";
import { storeContextProvider } from "./providers/store-context.js";
import { registerShopifySearchCategory } from "./search-category.js";
import { ShopifyService } from "./services/ShopifyService.js";

const shopifyPlugin: Plugin = {
  name: "shopify",
  description:
    "Manage Shopify stores -- products, orders, inventory, customers",
  actions: [
    manageProductsAction,
    manageInventoryAction,
    manageOrdersAction,
    manageCustomersAction,
    searchStoreAction,
  ],
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
