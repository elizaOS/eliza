import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  SHOPIFY_SERVICE_TYPE,
  type ShopifyService,
} from "../services/ShopifyService.js";

const MAX_SHOPIFY_DOMAIN_CHARS = 200;

export const storeContextProvider: Provider = {
  name: "shopifyStoreContext",
  description:
    "Provides context about the connected Shopify store -- name, domain, plan, product count, and order count.",
  descriptionCompressed:
    "Shopify store: name, domain, plan, product/order counts.",
  dynamic: true,
  contexts: ["connectors", "finance"],
  contextGate: { anyOf: ["connectors", "finance"] },
  cacheStable: false,
  cacheScope: "turn",

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
  ): Promise<ProviderResult> => {
    const svc = runtime.getService<ShopifyService>(SHOPIFY_SERVICE_TYPE);
    if (!svc?.isConnected()) {
      return {
        text: "",
        values: { shopifyConnected: false },
        data: { shopifyConnected: false },
      };
    }

    try {
      const [shop, productCount, orderCount] = await Promise.all([
        svc.getShop(),
        svc.getProductCount().catch(() => null),
        svc.getOrderCount().catch(() => null),
      ]);

      const contextText = [
        `Connected Shopify store: ${shop.name}`,
        `Domain: ${shop.primaryDomain.url}`,
        `Plan: ${shop.plan.displayName}`,
        `Currency: ${shop.currencyCode}`,
        productCount !== null ? `Products: ${productCount}` : null,
        orderCount !== null ? `Orders: ${orderCount}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        text: contextText,
        values: {
          shopifyConnected: true,
          shopifyStoreName: shop.name,
          shopifyDomain: shop.myshopifyDomain.slice(
            0,
            MAX_SHOPIFY_DOMAIN_CHARS,
          ),
          shopifyPlan: shop.plan.displayName,
          shopifyCurrency: shop.currencyCode,
          shopifyProductCount: productCount ?? 0,
          shopifyOrderCount: orderCount ?? 0,
        },
        data: {
          shopifyConnected: true,
          shop,
          productCount: productCount ?? 0,
          orderCount: orderCount ?? 0,
          truncated: false,
        },
      };
    } catch (err) {
      logger.error(
        {
          src: "plugin:shopify:store-context",
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to fetch Shopify store context",
      );
      return {
        text: "Shopify store context unavailable.",
        values: { shopifyConnected: false },
        data: { shopifyConnected: false },
      };
    }
  },
};
