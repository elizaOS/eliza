// Defines cloud shared provider env behavior for backend service consumers.
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

function isPlaceholderProviderKey(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("placeholder") ||
    normalized.includes("replace_with") ||
    normalized.includes("your_") ||
    normalized.includes("your-") ||
    normalized.includes("your_openai_key") ||
    normalized.includes("your_groq_api_key")
  );
}

export function getProviderKey(envName: string): string | null {
  const apiKey = getCloudAwareEnv()[envName]?.trim();
  return isPlaceholderProviderKey(apiKey) ? null : (apiKey ?? null);
}

export function getRequiredProviderKey(envName: string): string {
  const apiKey = getProviderKey(envName);
  if (!apiKey) {
    throw new Error(`${envName} environment variable is required`);
  }

  return apiKey;
}

/**
 * Collect ALL configured keys for a provider so callers can rotate across them
 * to spread rate-limit headroom (e.g. multiple Cerebras keys).
 *
 * Sources, merged + de-duped in this order:
 *   1. `${base}S` as a comma/whitespace-separated list (e.g. `CEREBRAS_API_KEYS`)
 *   2. the singular `${base}` (e.g. `CEREBRAS_API_KEY`)
 *   3. numbered suffixes `${base}_2`, `${base}_3`, ... up to a small cap
 *
 * Placeholder values are filtered out (same rule as getProviderKey). Returns an
 * empty array when nothing is configured.
 */
export function getProviderKeys(envName: string): string[] {
  const env = getCloudAwareEnv();
  const keys: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | undefined) => {
    const value = raw?.trim();
    if (!value || isPlaceholderProviderKey(value) || seen.has(value)) return;
    seen.add(value);
    keys.push(value);
  };

  // 1. plural list env (CEREBRAS_API_KEYS="k1,k2 k3")
  const listRaw = env[`${envName}S`]?.trim();
  if (listRaw) {
    for (const part of listRaw.split(/[\s,]+/)) push(part);
  }

  // 2. singular
  push(env[envName]);

  // 3. numbered suffixes
  for (let i = 2; i <= 16; i++) {
    push(env[`${envName}_${i}`]);
  }

  return keys;
}
