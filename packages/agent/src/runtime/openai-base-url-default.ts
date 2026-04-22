/**
 * Keep @elizaos/plugin-openai on OpenAI's default api.openai.com unless the user
 * explicitly persists OPENAI_BASE_URL in eliza config. Strips localhost bases
 * left by the local OpenAI-compatible probe when a real sk-* API key is in use.
 *
 * Runs after `maybeEnableOpenAiCompatibleFromLocalProbe` in plugin resolution so the
 * probe can finish (and restore its own snapshot when it does not commit a winner)
 * before this normalization step.
 */

import type { ElizaConfig } from "../config/types.eliza.js";

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readConfigEnvValue(
  config: ElizaConfig,
  key: string,
): string | undefined {
  const envConfig = config.env as
    | (Record<string, unknown> & { vars?: Record<string, unknown> })
    | undefined;
  if (!envConfig || typeof envConfig !== "object" || Array.isArray(envConfig)) {
    return undefined;
  }
  const nestedVars =
    envConfig.vars &&
    typeof envConfig.vars === "object" &&
    !Array.isArray(envConfig.vars)
      ? (envConfig.vars as Record<string, unknown>)
      : undefined;
  return trimEnvString(nestedVars?.[key]) ?? trimEnvString(envConfig[key]);
}

/**
 * When a real OpenAI API key is present but OPENAI_BASE_URL is not persisted in
 * config, remove localhost OPENAI_BASE_URL from env so traffic uses OpenAI's
 * default host. Run before {@link maybeEnableOpenAiCompatibleFromLocalProbe}.
 */
export function ensureOfficialOpenAiBaseUnlessConfigured(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (readConfigEnvValue(config, "OPENAI_BASE_URL")) return;
  const apiKey =
    readConfigEnvValue(config, "OPENAI_API_KEY") ??
    trimEnvString(env.OPENAI_API_KEY);
  if (!apiKey || apiKey === "lm-studio" || apiKey === "vllm") return;
  if (!/^sk-/i.test(apiKey)) return;
  const base = trimEnvString(env.OPENAI_BASE_URL);
  if (!base) return;
  try {
    const hostname = new URL(base).hostname.trim().toLowerCase();
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      delete env.OPENAI_BASE_URL;
    }
  } catch {
    /* leave base as-is if URL parse fails */
  }
}
