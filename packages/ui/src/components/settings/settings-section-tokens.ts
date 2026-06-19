/**
 * Lightweight settings-section token map — no React/component imports, so the
 * always-mounted chat composer can resolve `/settings <section>` without
 * pulling in the heavy section component graph from `settings-sections.ts`.
 *
 * Keep the canonical ids in sync with `SETTINGS_SECTION_META` in
 * `settings-section-meta.ts` (validated by a test).
 */

/**
 * Friendly tokens a user can type to jump to a settings section, e.g.
 * `/settings model`. Maps each token to a canonical settings section id.
 */
export const SETTINGS_SECTION_TOKEN_ALIASES: Record<string, string> = {
  basics: "identity",
  identity: "identity",
  profile: "identity",
  model: "ai-model",
  models: "ai-model",
  provider: "ai-model",
  providers: "ai-model",
  ai: "ai-model",
  cloud: "ai-model",
  runtime: "runtime",
  appearance: "appearance",
  theme: "appearance",
  look: "appearance",
  voice: "voice",
  tts: "voice",
  speech: "voice",
  capabilities: "capabilities",
  abilities: "capabilities",
  apps: "apps",
  views: "apps",
  "remote-plugins": "remote-plugins",
  remote: "remote-plugins",
  connectors: "connectors",
  connections: "connectors",
  integrations: "connectors",
  "app-permissions": "app-permissions",
  wallet: "wallet-rpc",
  rpc: "wallet-rpc",
  "wallet-rpc": "wallet-rpc",
  permissions: "permissions",
  perms: "permissions",
  secrets: "secrets",
  vault: "secrets",
  keys: "secrets",
  security: "security",
  updates: "updates",
  update: "updates",
  advanced: "advanced",
  "fine-tuning": "advanced",
};

/** The canonical section ids reachable via a token (derived from the map). */
const CANONICAL_SECTION_IDS: ReadonlySet<string> = new Set(
  Object.values(SETTINGS_SECTION_TOKEN_ALIASES),
);

/** Suggestion tokens (deduped) offered for `/settings <section>` completion. */
export const SETTINGS_SECTION_SUGGESTIONS: string[] = Array.from(
  new Set(Object.keys(SETTINGS_SECTION_TOKEN_ALIASES)),
);

/** Resolve a user-typed settings token to a canonical section id, if known. */
export function resolveSettingsSectionToken(token: string): string | undefined {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return undefined;
  if (CANONICAL_SECTION_IDS.has(normalized)) return normalized;
  return SETTINGS_SECTION_TOKEN_ALIASES[normalized];
}
