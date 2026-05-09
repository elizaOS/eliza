/**
 * Shopify App — @elizaos/app-shopify
 *
 * Full-screen overlay app for Shopify store management: products, orders,
 * inventory, and customers. Implements the OverlayApp API so the host shell
 * can launch it like any other overlay.
 */

import type { OverlayApp } from "@elizaos/ui";
import { registerOverlayApp } from "@elizaos/ui";
import { ShopifyAppView } from "./ShopifyAppView";

export const SHOPIFY_APP_NAME = "@elizaos/app-shopify";

export const shopifyApp: OverlayApp = {
  name: SHOPIFY_APP_NAME,
  displayName: "Shopify",
  description:
    "Manage your Shopify store — products, orders, inventory, customers",
  category: "utility",
  icon: null,
  Component: ShopifyAppView,
};

// Self-register at import time
registerOverlayApp(shopifyApp);
