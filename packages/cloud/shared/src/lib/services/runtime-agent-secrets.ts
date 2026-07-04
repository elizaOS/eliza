// Coordinates cloud service runtime agent secrets behavior behind route handlers.
import { shouldStripRawOpenAIForKeyless } from "./managed-eliza-env";

export const RUNTIME_AGENT_SECRET_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_API_KEY",
  "OPENAI_EMBEDDING_URL",
  "OPENAI_EMBEDDING_DIMENSIONS",
  "SMALL_MODEL",
  "LARGE_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "VERCEL_AI_GATEWAY_API_KEY",
] as const;

export function mergeRuntimeAgentSecretsFromEnv(params: {
  rawSecrets?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
  controlEnv?: Record<string, string | undefined>;
}): Record<string, unknown> {
  const stripRawOpenAI = shouldStripRawOpenAIForKeyless(params.controlEnv ?? process.env);
  const secrets: Record<string, unknown> = { ...(params.rawSecrets ?? {}) };
  if (stripRawOpenAI) delete secrets.OPENAI_API_KEY;

  const environmentVars = params.environmentVars ?? {};
  for (const key of RUNTIME_AGENT_SECRET_KEYS) {
    if (stripRawOpenAI && key === "OPENAI_API_KEY") continue;
    const current = typeof secrets[key] === "string" ? secrets[key].trim() : "";
    const next = environmentVars[key]?.trim();
    if (!current && next) {
      secrets[key] = next;
    }
  }

  return secrets;
}
