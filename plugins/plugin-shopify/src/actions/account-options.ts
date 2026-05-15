import type { HandlerOptions, IAgentRuntime } from "@elizaos/core";
import {
  hasShopifyAccountConfig,
  resolveShopifyAccountId,
} from "../accounts.js";

export function getShopifyActionOptions(
  options?: HandlerOptions | Record<string, unknown>,
): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

export function getShopifyAccountId(
  runtime: IAgentRuntime,
  options?: HandlerOptions | Record<string, unknown>,
): string {
  return resolveShopifyAccountId(runtime, getShopifyActionOptions(options));
}

export function hasShopifyConfig(
  runtime: IAgentRuntime,
  options?: HandlerOptions | Record<string, unknown>,
): boolean {
  return hasShopifyAccountConfig(runtime, getShopifyActionOptions(options));
}

export const shopifyAccountIdParameter = {
  name: "accountId",
  description:
    "Optional Shopify account id from SHOPIFY_ACCOUNTS. Defaults to SHOPIFY_DEFAULT_ACCOUNT_ID or the legacy single store token.",
  required: false,
  schema: { type: "string" as const },
};
