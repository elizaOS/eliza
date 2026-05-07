import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { manageCustomersAction } from "./manage-customers.js";
import { manageInventoryAction } from "./manage-inventory.js";
import { manageOrdersAction } from "./manage-orders.js";
import { manageProductsAction } from "./manage-products.js";
import { searchStoreAction } from "./search-store.js";

type ShopifyOp = "products" | "inventory" | "orders" | "customers" | "search";

const ALL_OPS: readonly ShopifyOp[] = [
  "products",
  "inventory",
  "orders",
  "customers",
  "search",
] as const;

interface ShopifyRoute {
  op: ShopifyOp;
  action: Action;
  match: RegExp;
}

const ROUTES: ShopifyRoute[] = [
  {
    op: "search",
    action: searchStoreAction,
    match:
      /\b(search|find|query|look up)\b.*\b(shopify|store|catalog|product|order|customer|inventory)\b/i,
  },
  {
    op: "inventory",
    action: manageInventoryAction,
    match: /\b(inventory|stock|quantity|on hand|in stock|out of stock|restock)\b/i,
  },
  {
    op: "customers",
    action: manageCustomersAction,
    match: /\b(customer|buyer|shopper|client)s?\b/i,
  },
  {
    op: "orders",
    action: manageOrdersAction,
    match: /\b(order|fulfill|ship|refund|return)s?\b/i,
  },
  {
    op: "products",
    action: manageProductsAction,
    match: /\b(product|sku|variant|listing|item)s?\b/i,
  },
];

function readOptions(
  options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeOp(value: unknown): ShopifyOp | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return (ALL_OPS as readonly string[]).includes(trimmed) ? (trimmed as ShopifyOp) : null;
}

function selectRoute(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>,
): ShopifyRoute | null {
  const opts = readOptions(options);
  const requested = normalizeOp(opts.op ?? opts.entity ?? opts.subaction);
  if (requested) {
    const route = ROUTES.find((candidate) => candidate.op === requested);
    if (route) return route;
  }
  const text = typeof message.content?.text === "string" ? message.content.text : "";
  return ROUTES.find((route) => route.match.test(text)) ?? null;
}

export const shopifyAction: Action = {
  name: "SHOPIFY",
  description:
    "Manage a Shopify store. Operations: products (CRUD on products), inventory (stock adjustments), orders (list/update orders), customers (CRUD on customers), search (catalog-wide search). Op is inferred from the message text when not explicitly provided.",
  descriptionCompressed:
    "Shopify: products, inventory, orders, customers, search.",
  similes: [
    // Generic
    "STORE",
    "SHOPIFY_STORE",
    // Per-entity legacy names
    "MANAGE_SHOPIFY_PRODUCTS",
    "MANAGE_SHOPIFY_INVENTORY",
    "MANAGE_SHOPIFY_ORDERS",
    "MANAGE_SHOPIFY_CUSTOMERS",
    "SEARCH_SHOPIFY_STORE",
    "SEARCH_SHOPIFY",
    // Common natural language
    "SHOPIFY_PRODUCTS",
    "SHOPIFY_ORDERS",
    "SHOPIFY_INVENTORY",
    "SHOPIFY_CUSTOMERS",
  ],
  contexts: ["payments", "connectors", "automation", "knowledge"],
  contextGate: { anyOf: ["payments", "connectors", "automation", "knowledge"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "op",
      description:
        "Operation to perform. One of: products, inventory, orders, customers, search. Inferred from message text when omitted.",
      required: false,
      schema: { type: "string", enum: [...ALL_OPS] },
    },
  ],
  validate: async (runtime, message) => {
    if (!runtime.getSetting("SHOPIFY_ACCESS_TOKEN")) return false;
    return selectRoute(message) !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const route = selectRoute(message, options);
    if (!route) {
      const ops = ALL_OPS.join(", ");
      const text = `SHOPIFY could not determine the operation. Specify one of: ${ops}.`;
      await callback?.({ text, source: message.content?.source });
      return {
        success: false,
        text,
        values: { error: "MISSING_OP" },
        data: { actionName: "SHOPIFY", availableOps: ops },
      };
    }
    const result =
      (await route.action.handler(runtime, message, state, options, callback)) ??
      ({ success: true } as ActionResult);
    return {
      ...result,
      data: {
        ...(typeof result.data === "object" && result.data ? result.data : {}),
        actionName: "SHOPIFY",
        routedActionName: route.action.name,
        op: route.op,
      },
    };
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Show me my Shopify orders from this week" } },
      {
        name: "{{agentName}}",
        content: { text: "Pulling recent Shopify orders.", actions: ["SHOPIFY"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Adjust inventory for SKU ABC-123 to 50 units" } },
      {
        name: "{{agentName}}",
        content: { text: "Updating inventory.", actions: ["SHOPIFY"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Create a new product: red t-shirt, $25" } },
      {
        name: "{{agentName}}",
        content: { text: "Creating that product.", actions: ["SHOPIFY"] },
      },
    ],
  ],
};
