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
import type { InventoryLevel, Location } from "../types.js";
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

function formatInventoryLevel(level: InventoryLevel): string {
  const qty = level.available !== null ? String(level.available) : "untracked";
  return `- ${level.location.name}: ${qty} available`;
}

function formatLocation(loc: Location): string {
  return `- ${loc.name} (${loc.isActive ? "active" : "inactive"})`;
}

type InventoryIntent =
  | { action: "check"; productQuery: string }
  | {
      action: "adjust";
      productQuery: string;
      delta: number;
      reason: string | null;
    }
  | { action: "locations" };

function readNullableString(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().toLowerCase() !== "null"
    ? value.trim()
    : null;
}

function readInventoryIntent(options?: HandlerOptions): InventoryIntent | null {
  const params = getActionOptions(options);
  const candidate =
    params.intent && typeof params.intent === "object"
      ? (params.intent as Record<string, unknown>)
      : params;
  const action = candidate.action;
  if (action === "locations") {
    return { action };
  }
  if (action === "check") {
    const productQuery = readNullableString(candidate.productQuery);
    return productQuery ? { action, productQuery } : null;
  }
  if (action === "adjust") {
    const productQuery = readNullableString(candidate.productQuery);
    const delta =
      typeof candidate.delta === "number"
        ? candidate.delta
        : Number.parseInt(String(candidate.delta ?? ""), 10);
    if (!productQuery || !Number.isFinite(delta)) return null;
    return {
      action,
      productQuery,
      delta,
      reason: readNullableString(candidate.reason),
    };
  }
  return null;
}

async function classifyIntent(
  runtime: IAgentRuntime,
  text: string,
): Promise<InventoryIntent | null> {
  const prompt = `Analyze the user message and determine what inventory action they want.
Respond with JSON only in one of these shapes:
{"action":"check","productQuery":"product name or SKU to check"}

{"action":"adjust","productQuery":"product name","delta":5,"reason":"reason"}

{"action":"locations"}

For adjust, delta is positive to add stock and negative to remove stock.

User message: "${text}"
`;

  for (let i = 0; i < 2; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseJsonObject<Record<string, unknown>>(response);
    if (parsed?.action) {
      return readInventoryIntent(parsed as HandlerOptions);
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
      content: { text: "Check inventory for 'Summer Hat'" },
    },
    {
      name: "assistant",
      content: {
        text: "Here are the inventory levels for Summer Hat:",
      },
    },
  ],
  [
    {
      name: "user",
      content: { text: "Add 50 units of stock for the blue t-shirt" },
    },
    {
      name: "assistant",
      content: {
        text: "I've adjusted the inventory for Blue T-Shirt by +50.",
      },
    },
  ],
];

export const manageInventoryAction: Action = {
  name: "MANAGE_SHOPIFY_INVENTORY",
  contexts: ["payments", "connectors", "automation"],
  contextGate: { anyOf: ["payments", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "CHECK_INVENTORY",
    "ADJUST_INVENTORY",
    "CHECK_STOCK",
    "UPDATE_STOCK",
  ],
  description:
    "Check inventory levels and list store locations. Stock adjustments require confirmed:true.",
  descriptionCompressed:
    "Check inventory, adjust stock, list Shopify locations.",
  parameters: [
    {
      name: "confirmed",
      description: "Must be true to adjust Shopify inventory after preview.",
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
      readInventoryIntent(options) ?? (await classifyIntent(runtime, text));

    if (!intent) {
      await callback?.({
        text: "I couldn't determine what inventory action you want. Try: check stock, adjust inventory, or list locations.",
      });
      return { success: false, error: "Could not classify intent" };
    }

    try {
      if (intent.action === "locations") {
        const locations = await svc.listLocations();
        if (locations.length === 0) {
          await callback?.({ text: "No locations found in the store." });
          return { success: true, text: "No locations" };
        }
        await callback?.({
          text: `Store locations:\n\n${locations.map(formatLocation).join("\n")}`,
        });
        return { success: true, data: { locations } };
      }

      if (intent.action === "check") {
        // Find product and its first variant's inventory item
        const result = await svc.listProducts({
          query: intent.productQuery,
          first: 3,
        });
        if (result.products.length === 0) {
          await callback?.({
            text: `No product found matching "${intent.productQuery}".`,
          });
          return { success: false, error: "Product not found" };
        }

        const product = result.products[0];
        const firstVariant = product.variants.edges[0]?.node;
        if (!firstVariant) {
          await callback?.({
            text: `Product "${product.title}" has no variants.`,
          });
          return { success: false, error: "No variants" };
        }

        // The inventoryItem GID is derived from the variant's ID.
        // Shopify variant IDs look like gid://shopify/ProductVariant/123
        // The inventory item ID is gid://shopify/InventoryItem/123
        const variantNumericId = firstVariant.id.split("/").pop();
        const inventoryItemId = `gid://shopify/InventoryItem/${variantNumericId}`;

        const levels = await svc.checkInventory(inventoryItemId);
        if (levels.length === 0) {
          await callback?.({
            text: `No inventory tracking found for "${product.title}".`,
          });
          return { success: true, text: "No inventory tracking" };
        }

        await callback?.({
          text: `Inventory for **${product.title}** (${firstVariant.title}):\n\n${levels.map(formatInventoryLevel).join("\n")}`,
        });
        return { success: true, data: { product: product.title, levels } };
      }

      if (intent.action === "adjust") {
        // Find the product
        const result = await svc.listProducts({
          query: intent.productQuery,
          first: 3,
        });
        if (result.products.length === 0) {
          await callback?.({
            text: `No product found matching "${intent.productQuery}".`,
          });
          return { success: false, error: "Product not found" };
        }

        const product = result.products[0];
        const firstVariant = product.variants.edges[0]?.node;
        if (!firstVariant) {
          await callback?.({
            text: `Product "${product.title}" has no variants.`,
          });
          return { success: false, error: "No variants" };
        }

        const variantNumericId = firstVariant.id.split("/").pop();
        const inventoryItemId = `gid://shopify/InventoryItem/${variantNumericId}`;

        // Get current levels to find a location
        const levels = await svc.checkInventory(inventoryItemId);
        const locationId =
          levels[0]?.location.id ?? (await svc.listLocations())[0]?.id;
        const locationName =
          levels[0]?.location.name ?? "first active location";
        if (!locationId) {
          await callback?.({
            text: "No locations found in the store to adjust inventory against.",
          });
          return { success: false, error: "No locations" };
        }
        const sign = intent.delta >= 0 ? "+" : "";
        const preview = [
          "Confirmation required before adjusting Shopify inventory:",
          `Product: ${product.title}`,
          `Variant: ${firstVariant.title}`,
          `Location: ${locationName}`,
          `Adjustment: ${sign}${intent.delta} units`,
          `Reason: ${intent.reason ?? "correction"}`,
        ].join("\n");
        if (!isConfirmed(options)) {
          await callback?.({ text: preview });
          return confirmationRequired(preview, {
            intent,
            productId: product.id,
            inventoryItemId,
            locationId,
          });
        }

        if (levels.length === 0) {
          await svc.adjustInventory({
            inventoryItemId,
            locationId,
            delta: intent.delta,
            reason: intent.reason ?? "correction",
          });
        } else {
          await svc.adjustInventory({
            inventoryItemId,
            locationId,
            delta: intent.delta,
            reason: intent.reason ?? "correction",
          });
        }

        await callback?.({
          text: `Inventory adjusted for **${product.title}**: ${sign}${intent.delta} units.`,
        });
        return {
          success: true,
          data: { product: product.title, delta: intent.delta },
        };
      }

      await callback?.({ text: "Unsupported inventory action." });
      return { success: false, error: "Unknown action" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { src: "plugin:shopify:manage-inventory", error: msg },
        "Inventory action failed",
      );
      await callback?.({ text: `Shopify inventory operation failed: ${msg}` });
      return { success: false, error: msg };
    }
  },

  examples,
};
