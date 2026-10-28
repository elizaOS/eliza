/** Catalog identity is evidence, not a rewrite of the model sent to Cloud. */
export interface CloudCatalogModelIdentity {
  provider: string;
  model: string;
}
interface CatalogModelIdentityInput {
  id: string;
  provider?: string;
}
const RESERVED_PROVIDERS = new Set([
  "unknown",
  "undefined",
  "null",
  "none",
  "system",
  "constructor",
  "prototype",
  "__proto__",
]);
const BARE_PROVIDER_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["gpt-", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["dall-e", "openai"],
  ["whisper", "openai"],
  ["tts", "openai"],
  ["claude-", "anthropic"],
  ["gemini-", "google"],
  ["llama", "meta"],
  ["deepseek", "deepseek"],
  ["grok", "xai"],
  ["kimi", "moonshot"],
];
function providerKey(value: string): string | null {
  const provider = value.trim().toLowerCase();
  return /^[a-z0-9~][a-z0-9._~-]*$/.test(provider) && !RESERVED_PROVIDERS.has(provider)
    ? provider
    : null;
}
function parseModelId(value: string): { provider?: string; model: string } | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9~][A-Za-z0-9~._:/-]*$/.test(value)) return null;
  const slash = value.indexOf("/"),
    colon = value.indexOf(":");
  const separator = slash < 0 ? colon : colon < 0 ? slash : Math.min(slash, colon);
  const rawProvider = separator < 0 ? undefined : value.slice(0, separator);
  const provider = rawProvider === undefined ? undefined : providerKey(rawProvider);
  const model = separator < 0 ? value : value.slice(separator + 1);
  if (
    (rawProvider !== undefined && (!provider || provider !== rawProvider)) ||
    !model ||
    model.split("/").some((part) => !part || part === "." || part === "..")
  )
    return null;
  return { ...(provider ? { provider } : {}), model };
}
/** owned_by (or the registry's already-bound provider) must not contradict an explicit namespace. */
export function cloudCatalogModelIdentity(
  id: string,
  owner?: string
): CloudCatalogModelIdentity | null {
  const parsed = parseModelId(id);
  if (!parsed) return null;
  const supplied = owner != null && owner !== "";
  const ownedBy = supplied && typeof owner === "string" ? providerKey(owner) : null;
  if (supplied && !ownedBy) return null;
  if (parsed.provider && ownedBy && parsed.provider !== ownedBy) return null;
  const provider =
    parsed.provider ??
    ownedBy ??
    BARE_PROVIDER_PREFIXES.find(([prefix]) => id.toLowerCase().startsWith(prefix))?.[1];
  return provider ? { provider, model: parsed.model } : null;
}
/** Only the Gateway's established Cerebras slash/colon/bare equivalence expands qualified ids. */
export function isCloudCatalogModelAvailable(
  configuredId: string,
  models: readonly CatalogModelIdentityInput[]
): boolean {
  const requested = parseModelId(configuredId);
  if (!requested) return false;
  const candidates = new Set<string>();
  const exactCandidates = new Set<string>();
  for (const entry of models) {
    const identity = cloudCatalogModelIdentity(entry.id, entry.provider);
    if (requested.provider) {
      if (
        !identity ||
        identity.provider !== requested.provider ||
        identity.model !== requested.model
      )
        continue;
      if (entry.id === configuredId || requested.provider === "cerebras") return true;
    } else if (identity?.model === requested.model) {
      const key = JSON.stringify([identity.provider, identity.model]);
      candidates.add(key);
      if (entry.id === configuredId) exactCandidates.add(key);
    }
  }
  // A literal catalog id selects that route, even when a qualified route on
  // another provider has the same model name. Conflicting owners for the
  // literal id remain ambiguous; only absent literal ids use name matching.
  return !requested.provider &&
    (exactCandidates.size > 0 ? exactCandidates.size === 1 : candidates.size === 1);
}
