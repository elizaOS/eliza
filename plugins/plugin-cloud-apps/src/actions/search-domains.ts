/**
 * Searches the organization-level registrar catalog for priced domain ideas.
 *
 * The endpoint is POST-shaped because it accepts a bounded query body, but it
 * is strictly read-only: no domain is attached, purchased, or reserved.
 */

import type {
  AppDomainPriceQuote,
  DomainSearchCandidateDto,
} from "@elizaos/cloud-sdk";
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import { getCloudClient, resolveCloudApiKey } from "../client.js";
import { actionParams, usdFromCents } from "../domain-intent.js";

const ACTION = "SEARCH_DOMAINS";
const NO_KEY_MESSAGE = "Connect Eliza Cloud before searching for domain ideas.";
const QUERY_MESSAGE =
  "What should the domain be about? Give me a keyword or short name.";
const INVALID_QUERY_MESSAGE =
  "Domain searches need a query of 1–100 characters and an optional result limit from 1–20.";
const ERROR_MESSAGE =
  "I couldn't search the domain catalog right now. Try again in a moment.";

interface SearchIntent {
  query: string;
  limit: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseIntent(
  options: unknown,
):
  | { ok: true; intent: SearchIntent }
  | { ok: false; reason: "missing_query" | "invalid_query" } {
  const params = actionParams(options);
  const rawQuery =
    params.query ?? params.searchQuery ?? params.keyword ?? params.name;
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    return { ok: false, reason: "missing_query" };
  }
  const query = rawQuery.trim();
  const rawLimit = params.limit;
  const limit = rawLimit === undefined ? 10 : rawLimit;
  if (
    query.length > 100 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  ) {
    return { ok: false, reason: "invalid_query" };
  }
  return { ok: true, intent: { query, limit } };
}

function isPrice(value: unknown): value is AppDomainPriceQuote | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.wholesaleUsdCents === "number" &&
    Number.isInteger(value.wholesaleUsdCents) &&
    value.wholesaleUsdCents >= 0 &&
    typeof value.marginUsdCents === "number" &&
    Number.isInteger(value.marginUsdCents) &&
    value.marginUsdCents >= 0 &&
    typeof value.totalUsdCents === "number" &&
    Number.isInteger(value.totalUsdCents) &&
    value.totalUsdCents >= 0 &&
    typeof value.marginBps === "number" &&
    Number.isInteger(value.marginBps) &&
    value.marginBps >= 0
  );
}

function isCandidate(value: unknown): value is DomainSearchCandidateDto {
  if (!isRecord(value)) return false;
  return (
    typeof value.domain === "string" &&
    value.domain.length > 0 &&
    value.domain.length <= 253 &&
    typeof value.available === "boolean" &&
    (value.reason === undefined || typeof value.reason === "string") &&
    typeof value.currency === "string" &&
    value.currency.length > 0 &&
    typeof value.years === "number" &&
    Number.isInteger(value.years) &&
    value.years > 0 &&
    isPrice(value.price) &&
    (!value.available || value.price !== null)
  );
}

function assertSearchResponse(
  response: unknown,
  intent: SearchIntent,
): DomainSearchCandidateDto[] {
  if (
    !isRecord(response) ||
    response.success !== true ||
    response.query !== intent.query ||
    !Array.isArray(response.candidates) ||
    response.candidates.length > intent.limit ||
    !response.candidates.every(isCandidate)
  ) {
    throw new ElizaError("Cloud returned an invalid domain-search response", {
      code: "CLOUD_DOMAIN_SEARCH_INVALID",
      context: { query: intent.query, limit: intent.limit },
      severity: "fatal",
    });
  }
  return response.candidates;
}

function candidateLine(candidate: DomainSearchCandidateDto): string {
  if (!candidate.available) {
    const reason = candidate.reason ? ` (${candidate.reason})` : "";
    return `• ${candidate.domain} — unavailable${reason}`;
  }
  const price = candidate.price;
  if (!price) {
    throw new ElizaError("Available domain candidate has no price", {
      code: "CLOUD_DOMAIN_SEARCH_INVALID",
      context: { domain: candidate.domain },
      severity: "fatal",
    });
  }
  const years = `${candidate.years} year${candidate.years === 1 ? "" : "s"}`;
  return `• ${candidate.domain} — available for ${usdFromCents(price.totalUsdCents)} / ${years}`;
}

export const searchDomainsAction: Action = {
  name: ACTION,
  similes: ["DOMAIN_IDEAS", "SUGGEST_DOMAINS", "FIND_DOMAIN_OPTIONS"],
  description:
    "Search Eliza Cloud's registrar catalog for available domain-name suggestions and exact marked-up prices. Read-only: this never buys, reserves, or attaches a domain. Use for brainstorming options; use CHECK_APP_DOMAIN for an exact domain.",
  descriptionCompressed:
    "Search priced domain suggestions without buying or reserving.",
  contexts: ["settings", "finance", "projects"],
  contextGate: { anyOf: ["settings", "finance", "projects"] },
  suppressPostActionContinuation: true,
  parameters: [
    {
      name: "query",
      description: "A keyword or short name to search, 1–100 characters.",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 100 },
    },
    {
      name: "limit",
      description: "Maximum suggestions to return (default 10, maximum 20).",
      required: false,
      schema: { type: "integer", minimum: 1, maximum: 20 },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> =>
    resolveCloudApiKey(runtime) !== null,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const parsed = parseIntent(options);
    if (!parsed.ok) {
      const reply =
        parsed.reason === "missing_query"
          ? QUERY_MESSAGE
          : INVALID_QUERY_MESSAGE;
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: false,
        text: "Domain search query is missing or invalid.",
        userFacingText: reply,
        data: { reason: parsed.reason },
      };
    }

    try {
      const response = await client.searchDomains(parsed.intent);
      const candidates = assertSearchResponse(response, parsed.intent);
      if (candidates.length === 0) {
        const reply = `Eliza Cloud found no domain suggestions for “${parsed.intent.query}”. Try a different keyword.`;
        await callback?.({ text: reply, actions: [ACTION] });
        return {
          success: true,
          text: `No domain suggestions found for ${parsed.intent.query}.`,
          userFacingText: reply,
          verifiedUserFacing: true,
          data: {
            query: parsed.intent.query,
            candidates: [],
          },
        };
      }

      const reply = [
        `Domain suggestions for “${parsed.intent.query}”:`,
        ...candidates.map(candidateLine),
        "Prices are current search quotes; check the exact domain again before purchase.",
      ].join("\n");
      await callback?.({ text: reply, actions: [ACTION] });
      return {
        success: true,
        text: `Found ${candidates.length} domain suggestion(s).`,
        userFacingText: reply,
        verifiedUserFacing: true,
        data: {
          query: parsed.intent.query,
          candidates: candidates.map((candidate) => ({
            domain: candidate.domain,
            available: candidate.available,
            reason: candidate.reason ?? null,
            currency: candidate.currency,
            years: candidate.years,
            priceUsdCents: candidate.price?.totalUsdCents ?? null,
          })),
        },
      };
    } catch (error) {
      // error-policy:J1 action boundary returns an observable planner failure.
      logger.error(
        { error, query: parsed.intent.query },
        "[SEARCH_DOMAINS] Domain catalog search failed",
      );
      await callback?.({ text: ERROR_MESSAGE, actions: [ACTION] });
      return {
        success: false,
        text: "Domain catalog search failed.",
        userFacingText: ERROR_MESSAGE,
        error: error instanceof Error ? error : new Error(String(error)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: { text: "give me five domain ideas for my habit tracker" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Domain suggestions for “habit tracker”:\n• habit.tools — available for $13.60 / 1 year",
          actions: [ACTION],
        },
      },
    ],
  ],
};

export default searchDomainsAction;
