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
import type { Order } from "../types.js";
import {
  confirmationRequired,
  getActionOptions,
  isConfirmed,
} from "./confirmation.js";
import { parseJsonObject } from "./json.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasShopifyConfig(runtime: IAgentRuntime): boolean {
  const domain = runtime.getSetting("SHOPIFY_STORE_DOMAIN");
  const token = runtime.getSetting("SHOPIFY_ACCESS_TOKEN");
  return (
    typeof domain === "string" &&
    domain.trim().length > 0 &&
    typeof token === "string" &&
    token.trim().length > 0
  );
}

function formatOrder(o: Order): string {
  const total = o.totalPriceSet.shopMoney;
  const items = o.lineItems.edges
    .map((e) => `${e.node.title} x${e.node.quantity}`)
    .join(", ");
  const customer = o.customer?.displayName ?? "Guest";
  return `- **${o.name}** | ${total.amount} ${total.currencyCode} | ${o.displayFulfillmentStatus} | ${customer} | Items: ${items} | ${o.createdAt.slice(0, 10)}`;
}

type OrderIntent =
  | { action: "list"; query: string | null }
  | { action: "get"; orderName: string }
  | { action: "fulfill"; orderName: string };

function readNullableString(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().toLowerCase() !== "null"
    ? value.trim()
    : null;
}

function readOrderIntent(options?: HandlerOptions): OrderIntent | null {
  const params = getActionOptions(options);
  const candidate =
    params.intent && typeof params.intent === "object"
      ? (params.intent as Record<string, unknown>)
      : params;
  const action = candidate.action;
  if (action === "list") {
    return { action, query: readNullableString(candidate.query) };
  }
  if (action === "get" || action === "fulfill") {
    const orderName = readNullableString(candidate.orderName);
    return orderName ? { action, orderName } : null;
  }
  return null;
}

async function classifyIntent(
  runtime: IAgentRuntime,
  text: string,
): Promise<OrderIntent | null> {
  const prompt = `Analyze the user message and determine what order action they want.
Respond with JSON only in one of these shapes:
{"action":"list","query":"optional filter like unfulfilled or last week"}

{"action":"get","orderName":"order number like #1001 or 1001"}

{"action":"fulfill","orderName":"order number to fulfill"}

User message: "${text}"
`;

  for (let i = 0; i < 2; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseJsonObject<Record<string, unknown>>(response);
    if (parsed?.action) {
      return readOrderIntent(parsed as HandlerOptions);
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
      content: { text: "Show me recent orders" },
    },
    {
      name: "assistant",
      content: {
        text: "Here are the most recent orders:",
      },
    },
  ],
  [
    {
      name: "user",
      content: { text: "What's the status of order #1042?" },
    },
    {
      name: "assistant",
      content: {
        text: "Here are the details for order #1042:",
      },
    },
  ],
  [
    {
      name: "user",
      content: { text: "Fulfill order 1042" },
    },
    {
      name: "assistant",
      content: {
        text: "Order #1042 has been marked as fulfilled.",
      },
    },
  ],
];

export const manageOrdersAction: Action = {
  name: "MANAGE_SHOPIFY_ORDERS",
  similes: ["LIST_ORDERS", "CHECK_ORDERS", "FULFILL_ORDER", "ORDER_STATUS"],
  description:
    "List recent orders and check order status. Fulfillment requires confirmed:true.",
  descriptionCompressed:
    "List orders, check status, mark fulfilled in Shopify.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to fulfill a Shopify order after preview.",
      required: false,
      schema: { type: "boolean", default: false },
    },
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
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const svc = runtime.getService<ShopifyService>(SHOPIFY_SERVICE_TYPE);
    if (!svc?.isConnected()) {
      await callback?.({
        text: "Shopify is not connected. Please check SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN.",
      });
      return { success: false, error: "Shopify not connected" };
    }

    const text =
      typeof message.content?.text === "string" ? message.content.text : "";
    const intent =
      readOrderIntent(options) ?? (await classifyIntent(runtime, text));

    if (!intent) {
      await callback?.({
        text: "I couldn't determine what order action you want. Try: list orders, check order status, or fulfill an order.",
      });
      return { success: false, error: "Could not classify intent" };
    }

    try {
      if (intent.action === "list") {
        const queryStr = intent.query ?? undefined;
        const result = await svc.listOrders({ query: queryStr, first: 10 });
        if (result.orders.length === 0) {
          await callback?.({
            text: queryStr
              ? `No orders found matching "${queryStr}".`
              : "No orders found.",
          });
          return { success: true, text: "No orders found" };
        }
        const lines = result.orders.map(formatOrder);
        const more = result.hasNextPage ? "\n\n(More orders available)" : "";
        await callback?.({
          text: `Recent orders (${result.orders.length}):\n\n${lines.join("\n")}${more}`,
        });
        return { success: true, data: { orders: result.orders } };
      }

      if (intent.action === "get") {
        // Search for the order by name
        const cleanName = intent.orderName.replace(/^#/, "").trim();
        const result = await svc.listOrders({
          query: `name:#${cleanName}`,
          first: 1,
        });
        if (result.orders.length === 0) {
          await callback?.({ text: `Order #${cleanName} not found.` });
          return { success: false, error: "Order not found" };
        }
        const order = result.orders[0];
        const total = order.totalPriceSet.shopMoney;
        const lineItems = order.lineItems.edges.map(
          (e) =>
            `  - ${e.node.title} x${e.node.quantity} (${e.node.originalUnitPriceSet.shopMoney.amount} ${e.node.originalUnitPriceSet.shopMoney.currencyCode})`,
        );
        const detail = [
          `**Order ${order.name}**`,
          `Status: ${order.displayFulfillmentStatus} | Payment: ${order.displayFinancialStatus ?? "n/a"}`,
          `Total: ${total.amount} ${total.currencyCode}`,
          `Customer: ${order.customer?.displayName ?? "Guest"}`,
          `Created: ${order.createdAt.slice(0, 10)}`,
          `Items:`,
          ...lineItems,
        ].join("\n");
        await callback?.({ text: detail });
        return { success: true, data: { order } };
      }

      if (intent.action === "fulfill") {
        const cleanName = intent.orderName.replace(/^#/, "").trim();
        const result = await svc.listOrders({
          query: `name:#${cleanName}`,
          first: 1,
        });
        if (result.orders.length === 0) {
          await callback?.({ text: `Order #${cleanName} not found.` });
          return { success: false, error: "Order not found" };
        }
        const order = result.orders[0];
        const preview = [
          "Confirmation required before fulfilling Shopify order:",
          `Order: ${order.name}`,
          `Status: ${order.displayFulfillmentStatus}`,
          `Customer: ${order.customer?.displayName ?? "Guest"}`,
        ].join("\n");
        if (!isConfirmed(options)) {
          await callback?.({ text: preview });
          return confirmationRequired(preview, { intent, orderId: order.id });
        }
        const fulfillment = await svc.fulfillOrder(order.id);
        await callback?.({
          text: `Order ${order.name} fulfilled (status: ${fulfillment.status}).`,
        });
        return { success: true, data: { order: order.name, fulfillment } };
      }

      await callback?.({ text: "Unsupported order action." });
      return { success: false, error: "Unknown action" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { src: "plugin:shopify:manage-orders", error: msg },
        "Order action failed",
      );
      await callback?.({ text: `Shopify order operation failed: ${msg}` });
      return { success: false, error: msg };
    }
  },

  examples,
};
