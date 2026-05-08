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
import type { Product } from "../types.js";
import {
  getShopifyAccountId,
  hasShopifyConfig,
  shopifyAccountIdParameter,
} from "./account-options.js";
import {
  confirmationRequired,
  getActionOptions,
  isConfirmed,
} from "./confirmation.js";
import { parseJsonObject } from "./json.js";

function formatProduct(p: Product): string {
  const variants = p.variants.edges.map((e) => e.node);
  const priceRange =
    variants.length > 0 ? variants.map((v) => v.price).join(", ") : "n/a";
  const inventory =
    p.totalInventory !== null ? String(p.totalInventory) : "untracked";
  return `- **${p.title}** (${p.status}) | Price: ${priceRange} | Inventory: ${inventory} | Handle: ${p.handle}`;
}

type ProductIntent =
  | { action: "list"; query: string | null }
  | {
      action: "create";
      title: string;
      description: string | null;
      productType: string | null;
      vendor: string | null;
      status: string | null;
    }
  | {
      action: "update";
      identifier: string;
      title: string | null;
      description: string | null;
      status: string | null;
    };

function readNullableString(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().toLowerCase() !== "null"
    ? value.trim()
    : null;
}

function readProductIntent(options?: HandlerOptions): ProductIntent | null {
  const params = getActionOptions(options);
  const candidate =
    params.intent && typeof params.intent === "object"
      ? (params.intent as Record<string, unknown>)
      : params;
  const action = candidate.action;
  if (action === "list") {
    return { action, query: readNullableString(candidate.query) };
  }
  if (action === "create") {
    const title = readNullableString(candidate.title);
    if (!title) return null;
    return {
      action,
      title,
      description: readNullableString(candidate.description),
      productType: readNullableString(candidate.productType),
      vendor: readNullableString(candidate.vendor),
      status: readNullableString(candidate.status),
    };
  }
  if (action === "update") {
    const identifier = readNullableString(candidate.identifier);
    if (!identifier) return null;
    return {
      action,
      identifier,
      title: readNullableString(candidate.title),
      description: readNullableString(candidate.description),
      status: readNullableString(candidate.status),
    };
  }
  return null;
}

async function classifyIntent(
  runtime: IAgentRuntime,
  text: string,
): Promise<ProductIntent | null> {
  const prompt = `Analyze the user message and determine what product action they want.
Respond with JSON only in one of these shapes:
{"action":"list","query":"search term"}

{"action":"create","title":"product title","description":"description","productType":"type","vendor":"vendor","status":"ACTIVE"}

{"action":"update","identifier":"product title or handle to find","title":"new title","description":"new description","status":"ACTIVE"}

User message: "${text}"
`;

  for (let i = 0; i < 2; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseJsonObject<Record<string, unknown>>(response);
    if (parsed?.action) {
      return readProductIntent(parsed as HandlerOptions);
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
      content: { text: "Show me all products in the Shopify store" },
    },
    {
      name: "assistant",
      content: {
        text: "Here are the products currently in the store:",
      },
    },
  ],
  [
    {
      name: "user",
      content: {
        text: "Create a new product called 'Summer Hat' priced at 29.99",
      },
    },
    {
      name: "assistant",
      content: {
        text: "I've created the product 'Summer Hat' as a draft.",
      },
    },
  ],
];

export const manageProductsAction: Action = {
  name: "MANAGE_SHOPIFY_PRODUCTS",
  contexts: ["payments", "connectors", "automation"],
  contextGate: { anyOf: ["payments", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "LIST_PRODUCTS",
    "CREATE_PRODUCT",
    "UPDATE_PRODUCT",
    "SEARCH_PRODUCTS",
  ],
  description:
    "List and search Shopify products. Product creation and updates require confirmed:true.",
  descriptionCompressed: "List/search/create/update Shopify products.",
  parameters: [
    {
      name: "confirmed",
      description:
        "Must be true to create or update a Shopify product after preview.",
      required: false,
      schema: { type: "boolean", default: false },
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
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const svc = runtime.getService<ShopifyService>(SHOPIFY_SERVICE_TYPE);
    const accountId = getShopifyAccountId(runtime, options);
    if (!svc?.isConnected(accountId)) {
      await callback?.({
        text: "Shopify is not connected. Please check SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN.",
      });
      return { success: false, error: "Shopify not connected" };
    }

    const text =
      typeof message.content?.text === "string" ? message.content.text : "";
    const intent =
      readProductIntent(options) ?? (await classifyIntent(runtime, text));

    if (!intent) {
      await callback?.({
        text: "I couldn't determine what product action you want. You can ask me to list, create, or update products.",
      });
      return { success: false, error: "Could not classify intent" };
    }

    try {
      if (intent.action === "list") {
        const result = await svc.listProducts({
          query: intent.query,
          first: 10,
        }, accountId);
        if (result.products.length === 0) {
          await callback?.({
            text: intent.query
              ? `No products found matching "${intent.query}".`
              : "The store has no products yet.",
          });
          return { success: true, text: "No products found" };
        }
        const lines = result.products.map(formatProduct);
        const more = result.hasNextPage
          ? "\n\n(More products available -- ask to see more)"
          : "";
        await callback?.({
          text: `Found ${result.products.length} product(s):\n\n${lines.join("\n")}${more}`,
        });
        return { success: true, data: { products: result.products } };
      }

      if (intent.action === "create") {
        const status = intent.status ?? "DRAFT";
        const preview = [
          "Confirmation required before creating Shopify product:",
          `Title: ${intent.title}`,
          `Status: ${status}`,
          intent.vendor ? `Vendor: ${intent.vendor}` : null,
          intent.productType ? `Type: ${intent.productType}` : null,
        ]
          .filter((line): line is string => line !== null)
          .join("\n");
        if (!isConfirmed(options)) {
          await callback?.({ text: preview });
          return confirmationRequired(preview, { intent });
        }
        const product = await svc.createProduct({
          title: intent.title,
          descriptionHtml: intent.description ?? undefined,
          productType: intent.productType ?? undefined,
          vendor: intent.vendor ?? undefined,
          status,
        }, accountId);
        await callback?.({
          text: `Product created: ${product.title} (${product.status}).`,
        });
        return { success: true, data: { product } };
      }

      if (intent.action === "update") {
        // Find the product first
        const searchResult = await svc.listProducts({
          query: intent.identifier,
          first: 5,
        }, accountId);
        if (searchResult.products.length === 0) {
          await callback?.({
            text: `Could not find a product matching "${intent.identifier}".`,
          });
          return { success: false, error: "Product not found" };
        }
        const target = searchResult.products[0];
        const updateInput: Record<string, string | undefined> = {};
        if (intent.title) updateInput.title = intent.title;
        if (intent.description)
          updateInput.descriptionHtml = intent.description;
        if (intent.status) updateInput.status = intent.status.toUpperCase();

        const changeLines = [
          intent.title ? `Title: ${intent.title}` : null,
          intent.description ? "Description: updated" : null,
          intent.status ? `Status: ${intent.status.toUpperCase()}` : null,
        ].filter((line): line is string => line !== null);
        const preview = [
          "Confirmation required before updating Shopify product:",
          `Product: ${target.title}`,
          ...changeLines,
        ].join("\n");
        if (!isConfirmed(options)) {
          await callback?.({ text: preview });
          return confirmationRequired(preview, {
            intent,
            productId: target.id,
          });
        }

        const updated = await svc.updateProduct(target.id, updateInput, accountId);
        await callback?.({
          text: `Product updated: ${updated.title} (${updated.status}).`,
        });
        return { success: true, data: { product: updated } };
      }

      await callback?.({ text: "Unsupported product action." });
      return { success: false, error: "Unknown action" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { src: "plugin:shopify:manage-products", error: msg },
        "Product action failed",
      );
      await callback?.({ text: `Shopify product operation failed: ${msg}` });
      return { success: false, error: msg };
    }
  },

  examples,
};
