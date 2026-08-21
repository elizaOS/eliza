/**
 * Canonical public pricing metadata for Cloud-hosted MCP tools.
 *
 * Runtime debits and discovery surfaces import these values so a catalog can
 * never advertise a fixed charge that the executing transport does not apply.
 * Dynamic provider-backed tools deliberately expose no guessed dollar amount.
 */

import {
  ORGANIZATION_CREDIT_UNIT,
  RETRIEVE_MEMORIES_PRICE_USD,
  SAVE_MEMORY_PRICE_USD,
} from "./organization-credits.js";

export const MCP_FREE_COST_LABEL = "Free" as const;
export const MCP_USAGE_BASED_COST_LABEL = "Usage-based cloud credits" as const;

export const PLATFORM_MCP_TOOL_PRICING = Object.freeze({
  save_memory: Object.freeze({
    billing: "fixed" as const,
    priceUsd: SAVE_MEMORY_PRICE_USD,
    label: `$${SAVE_MEMORY_PRICE_USD} in cloud credit`,
  }),
  retrieve_memories: Object.freeze({
    billing: "free" as const,
    priceUsd: RETRIEVE_MEMORIES_PRICE_USD,
    label: MCP_FREE_COST_LABEL,
  }),
});

const FREE_BUILTIN_CATALOG_PRICE = Object.freeze({
  type: "free" as const,
  description: "Free to use",
  creditUnit: ORGANIZATION_CREDIT_UNIT,
  priceUsd: 0,
});

/**
 * Built-in MCP transports currently have no organization-credit debit path.
 * Keep them free until a transport-level billing authority is implemented.
 */
export const BUILTIN_MCP_PRICING = Object.freeze({
  time: FREE_BUILTIN_CATALOG_PRICE,
  weather: FREE_BUILTIN_CATALOG_PRICE,
  crypto: FREE_BUILTIN_CATALOG_PRICE,
  webSearch: Object.freeze({
    type: "credits" as const,
    description: "Usage-based cloud credits; the exact price is resolved at execution",
    creditUnit: ORGANIZATION_CREDIT_UNIT,
  }),
});
