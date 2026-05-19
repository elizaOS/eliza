import type {
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
import type { Customer } from "../types.js";
import { getActionOptions } from "./confirmation.js";
import { parseJsonObject } from "./json.js";

function formatCustomer(c: Customer): string {
  const email = c.email ?? "no email";
  const spent = `${c.totalSpentV2.amount} ${c.totalSpentV2.currencyCode}`;
  return `- **${c.displayName}** | ${email} | Orders: ${c.ordersCount} | Total spent: ${spent}`;
}

type CustomerIntent =
  | { action: "list"; query: string | null }
  | { action: "search"; query: string };

function readNullableString(value: unknown): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().toLowerCase() !== "null"
    ? value.trim()
    : null;
}

function readCustomerIntent(options?: HandlerOptions): CustomerIntent | null {
  const params = getActionOptions(options);
  const candidate =
    params.intent && typeof params.intent === "object"
      ? (params.intent as Record<string, unknown>)
      : params;
  const action = candidate.action;
  const query = readNullableString(candidate.query);
  if (action === "list") {
    return { action, query };
  }
  if (action === "search" && query) {
    return { action, query };
  }
  return null;
}

async function classifyIntent(
  runtime: IAgentRuntime,
  text: string,
): Promise<CustomerIntent | null> {
  const prompt = `Analyze the user message and determine what customer action they want.
Respond with JSON only in one of these shapes:
{"action":"list","query":null}

{"action":"search","query":"customer name, email, or other search term"}

User message: "${text}"
`;

  for (let i = 0; i < 2; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
    const parsed = parseJsonObject<Record<string, unknown>>(response);
    if (parsed?.action) {
      return readCustomerIntent(parsed as HandlerOptions);
    }
  }
  return null;
}

export async function manageCustomersHandler(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> {
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
    readCustomerIntent(options) ?? (await classifyIntent(runtime, text));

  if (!intent) {
    await callback?.({
      text: "I couldn't determine what customer action you want. Try: list customers or search for a specific customer.",
    });
    return { success: false, error: "Could not classify intent" };
  }

  try {
    const queryStr =
      intent.action === "search" ? intent.query : (intent.query ?? undefined);
    const result = await svc.listCustomers({ query: queryStr, first: 15 });

    if (result.customers.length === 0) {
      const msg = queryStr
        ? `No customers found matching "${queryStr}".`
        : "No customers found in the store.";
      await callback?.({ text: msg });
      return { success: true, text: "No customers found" };
    }

    const lines = result.customers.map(formatCustomer);
    const more = result.hasNextPage ? "\n\n(More customers available)" : "";

    if (intent.action === "search" && result.customers.length === 1) {
      const c = result.customers[0];
      const detail = [
        `**${c.displayName}**`,
        `Email: ${c.email ?? "not set"}`,
        `Phone: ${c.phone ?? "not set"}`,
        `Orders: ${c.ordersCount}`,
        `Total spent: ${c.totalSpentV2.amount} ${c.totalSpentV2.currencyCode}`,
        `Customer since: ${c.createdAt.slice(0, 10)}`,
      ].join("\n");
      await callback?.({ text: detail });
    } else {
      await callback?.({
        text: `Customers (${result.customers.length}):\n\n${lines.join("\n")}${more}`,
      });
    }

    return { success: true, data: { customers: result.customers } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { src: "plugin:shopify:manage-customers", error: msg },
      "Customer action failed",
    );
    await callback?.({ text: `Shopify customer operation failed: ${msg}` });
    return { success: false, error: msg };
  }
}
