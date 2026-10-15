// Defines cloud shared anthropic web search behavior for backend service consumers.
import { anthropic as anthropicProvider } from "@ai-sdk/anthropic";
import {
  ANTHROPIC_WEB_SEARCH_BASE_COST_PER_REQUEST,
  PLATFORM_MARKUP_MULTIPLIER,
} from "../pricing-constants";

const SUPPORTED_ANTHROPIC_WEB_SEARCH_MODELS = ["claude-sonnet-4-6", "claude-opus-4-7"] as const;

const MAX_ANTHROPIC_WEB_SEARCH_MAX_USES = 10;

export const DEFAULT_ANTHROPIC_WEB_SEARCH_MAX_USES = 5;
/** Tool name the provider-native search is registered under (the AI SDK tool key). */
export const ANTHROPIC_WEB_SEARCH_TOOL_NAME = "web_search";
export const ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER = 10_000;

function toRequestCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Number of server-side web searches the provider reports for one call.
 * Anthropic bills each search on top of tokens, but reports the count only in
 * its raw usage (`usage.server_tool_use.web_search_requests`), never in the
 * token fields. Accepts the AI SDK usage object (whose `raw` carries the
 * provider usage), the raw Anthropic usage itself, or a usage record that
 * already carries a `webSearchRequests` total (e.g. summed over finished
 * steps). Unknown shapes count as zero searches.
 */
export function anthropicWebSearchRequestsFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const record = usage as Record<string, unknown>;
  const raw = (record.raw && typeof record.raw === "object" ? record.raw : record) as Record<
    string,
    unknown
  >;
  const serverToolUse = raw.server_tool_use as Record<string, unknown> | undefined;
  return Math.max(
    toRequestCount(record.webSearchRequests),
    toRequestCount(serverToolUse?.web_search_requests),
  );
}

/** Platform charge in USD (including the platform markup) for `requests` searches. */
export function calculateAnthropicWebSearchCost(requests: number): number {
  return (
    toRequestCount(requests) *
    ANTHROPIC_WEB_SEARCH_BASE_COST_PER_REQUEST *
    PLATFORM_MARKUP_MULTIPLIER
  );
}

function normalizeModelName(model: string): string {
  const [, normalized] = model.split("/");
  return (normalized ?? model).toLowerCase();
}

export function supportsAnthropicWebSearch(model: string): boolean {
  const normalized = normalizeModelName(model);
  return SUPPORTED_ANTHROPIC_WEB_SEARCH_MODELS.some(
    (supportedModel) =>
      normalized === supportedModel || normalized.startsWith(`${supportedModel}-`),
  );
}

export function isAnthropicWebSearchEnabled(
  provider: string,
  model: string,
  enabled: boolean,
): boolean {
  return enabled && provider === "anthropic" && supportsAnthropicWebSearch(model);
}

function resolveWebSearchMaxUses(maxUses: number | undefined): number {
  if (typeof maxUses !== "number" || !Number.isFinite(maxUses)) {
    return DEFAULT_ANTHROPIC_WEB_SEARCH_MAX_USES;
  }

  return Math.min(Math.max(Math.trunc(maxUses), 1), MAX_ANTHROPIC_WEB_SEARCH_MAX_USES);
}

/**
 * Input tokens whose price equals the worst-case search fee of one request
 * (`maxUses` searches), given the marked-up price of one input token. The
 * credit hold is sized from token estimates, so this lets the hold cover the
 * searches the model may run; the exact fee is charged at settlement from the
 * provider-reported count.
 */
export function anthropicWebSearchFeeInputTokens(
  maxUses: number | undefined,
  inputCostPerToken: number,
): number {
  if (!Number.isFinite(inputCostPerToken) || inputCostPerToken <= 0) return 0;
  const maxFee = calculateAnthropicWebSearchCost(resolveWebSearchMaxUses(maxUses));
  return Math.ceil(maxFee / inputCostPerToken);
}

export function buildProviderNativeWebSearchTools({
  provider,
  model,
  enabled,
  maxUses,
}: {
  provider: string;
  model: string;
  enabled: boolean;
  maxUses?: number;
}):
  | {
      tools: Record<string, ReturnType<typeof anthropicProvider.tools.webSearch_20260209>>;
    }
  | Record<string, never> {
  if (!isAnthropicWebSearchEnabled(provider, model, enabled)) {
    return {};
  }

  // This constructs an AI SDK provider-native tool descriptor only.
  // Model execution still flows through getLanguageModel()/AI Gateway.
  return {
    tools: {
      [ANTHROPIC_WEB_SEARCH_TOOL_NAME]: anthropicProvider.tools.webSearch_20260209({
        maxUses: resolveWebSearchMaxUses(maxUses),
      }),
    },
  };
}
