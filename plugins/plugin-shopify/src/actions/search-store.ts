import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import {
  SHOPIFY_SERVICE_TYPE,
  type ShopifyService,
} from "../services/ShopifyService.js";
import type { Customer, Order, Product } from "../types.js";
import {
  getShopifyAccountId,
  hasShopifyConfig,
  shopifyAccountIdParameter,
} from "./account-options.js";
import { parseJsonObject } from "./json.js";

function formatProductBrief(p: Product): string {
  const price = p.variants.edges[0]?.node.price ?? "n/a";
  return `[Product] **${p.title}** -- ${p.status} -- ${price}`;
}

function formatOrderBrief(o: Order): string {
  const total = o.totalPriceSet.shopMoney;
  return `[Order] **${o.name}** -- ${total.amount} ${total.currencyCode} -- ${o.displayFulfillmentStatus}`;
}

function formatCustomerBrief(c: Customer): string {
  return `[Customer] **${c.displayName}** -- ${c.email ?? "no email"} -- ${c.ordersCount} orders`;
}

type SearchIntent = {
  query: string;
  scope: "all" | "products" | "orders" | "customers";
};

type SearchStoreParams = {
  query?: unknown;
  scope?: unknown;
  limit?: unknown;
};

function readSearchStoreParams(options?: HandlerOptions): {
  intent: SearchIntent | null;
  limit: number;
} {
  const params = (options?.parameters ?? {}) as SearchStoreParams;
  const query =
    typeof params.query === "string" && params.query.trim().length > 0
      ? params.query.trim()
      : null;
  const scope =
    params.scope === "products" ||
    params.scope === "orders" ||
    params.scope === "customers" ||
    params.scope === "all"
      ? params.scope
      : "all";
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : 5;
  return {
    intent: query ? { query, scope } : null,
    limit,
  };
}

async function classifyIntent(
  runtime: IAgentRuntime,
  text: string,
): Promise<SearchIntent | null> {
  const prompt = `Analyze the user message and determine what they want to search for in a Shopify store.
Respond with JSON only:
{"query":"the search term","scope":"all"}

Use "all" when the user does not specify a specific category, or mentions multiple.

User message: "${text}"
`;

  for (let i = 0; i < 2; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseJsonObject<Record<string, unknown>>(response);
    const query =
      typeof parsed?.query === "string" && parsed.query.trim().length > 0
        ? parsed.query.trim()
        : null;
    const scope =
      parsed?.scope === "products" ||
      parsed?.scope === "orders" ||
      parsed?.scope === "customers" ||
      parsed?.scope === "all"
        ? parsed.scope
        : "all";
    if (query) {
      return { query, scope };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

const examples: ActionExample[][] = [
  [
    {
      name: "user",
      content: { text: "Search the Shopify store for 'hat'" },
    },
    {
      name: "assistant",
      content: {
        text: "Here are the results across the store for 'hat':",
      },
    },
  ],
  [
    {
      name: "user",
      content: { text: "Find anything related to john@example.com in Shopify" },
    },
    {
      name: "assistant",
      content: {
        text: "Here is what I found for 'john@example.com':",
      },
    },
  ],
];

export const searchStoreAction: Action = {
  name: "SEARCH_SHOPIFY_STORE",
  contexts: ["payments", "connectors", "automation", "knowledge"],
  contextGate: { anyOf: ["payments", "connectors", "automation", "knowledge"] },
  roleGate: { minRole: "USER" },
  similes: ["SHOPIFY_SEARCH", "STORE_SEARCH"],
  description:
    "Search across products, orders, and customers in a connected Shopify store.",
  descriptionCompressed: "Search Shopify products, orders, customers.",
  parameters: [
    {
      name: "query",
      description: "Search term.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "scope",
      description: "Search scope: all, products, orders, or customers.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["all", "products", "orders", "customers"],
      },
    },
    {
      name: "limit",
      description: "Maximum results per scope.",
      required: false,
      schema: { type: "number" as const },
    },
    shopifyAccountIdParameter,
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    return hasShopifyConfig(runtime);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const svc = runtime.getService<ShopifyService>(SHOPIFY_SERVICE_TYPE);
    const accountId = getShopifyAccountId(runtime, _options);
    if (!svc?.isConnected(accountId)) {
      await callback?.({
        text: "Shopify is not connected. Please check SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN.",
      });
      return { success: false, error: "Shopify not connected" };
    }

    const text =
      typeof message.content?.text === "string" ? message.content.text : "";
    const structured = readSearchStoreParams(_options);
    const intent = structured.intent ?? (await classifyIntent(runtime, text));

    if (!intent) {
      await callback?.({
        text: "I couldn't determine what to search for. Please provide a search term.",
      });
      return { success: false, error: "Could not classify intent" };
    }

    try {
      const sections: string[] = [];
      const data: Record<string, unknown[]> = {};

      // Search products
      if (intent.scope === "all" || intent.scope === "products") {
        const result = await svc.listProducts({
          query: intent.query,
          first: structured.limit,
        }, accountId);
        if (result.products.length > 0) {
          sections.push(
            `**Products** (${result.products.length}):\n${result.products.map(formatProductBrief).join("\n")}`,
          );
          data.products = result.products;
        }
      }

      // Search orders
      if (intent.scope === "all" || intent.scope === "orders") {
        const result = await svc.listOrders({
          query: intent.query,
          first: structured.limit,
        }, accountId);
        if (result.orders.length > 0) {
          sections.push(
            `**Orders** (${result.orders.length}):\n${result.orders.map(formatOrderBrief).join("\n")}`,
          );
          data.orders = result.orders;
        }
      }

      // Search customers
      if (intent.scope === "all" || intent.scope === "customers") {
        const result = await svc.listCustomers({
          query: intent.query,
          first: structured.limit,
        }, accountId);
        if (result.customers.length > 0) {
          sections.push(
            `**Customers** (${result.customers.length}):\n${result.customers.map(formatCustomerBrief).join("\n")}`,
          );
          data.customers = result.customers;
        }
      }

      if (sections.length === 0) {
        await callback?.({
          text: `No results found for "${intent.query}" in the store.`,
        });
        return { success: true, text: "No results" };
      }

      await callback?.({
        text: `Search results for "${intent.query}":\n\n${sections.join("\n\n")}`,
      });
      return { success: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { src: "plugin:shopify:search-store", error: msg },
        "Store search failed",
      );
      await callback?.({ text: `Shopify search failed: ${msg}` });
      return { success: false, error: msg };
    }
  },

  parameters: [
    {
      name: "query",
      description: "Search term for Shopify products, orders, or customers.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "scope",
      description: "Restrict search to all, products, orders, or customers.",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["all", "products", "orders", "customers"],
      },
    },
    {
      name: "limit",
      description: "Maximum results per searched Shopify category.",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples,
};
