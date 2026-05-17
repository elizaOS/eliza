import { anthropic as anthropicProvider } from "@ai-sdk/anthropic";

const SUPPORTED_ANTHROPIC_WEB_SEARCH_MODELS = ["claude-sonnet-4-6", "claude-opus-4-7"] as const;

const MAX_ANTHROPIC_WEB_SEARCH_MAX_USES = 10;

export const DEFAULT_ANTHROPIC_WEB_SEARCH_MAX_USES = 5;
export const ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER = 10_000;

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
      web_search: anthropicProvider.tools.webSearch_20260209({
        maxUses: resolveWebSearchMaxUses(maxUses),
      }),
    },
  };
}
