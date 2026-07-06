/**
 * Lightweight settings-section token map — no React/component imports, so the
 * always-mounted chat composer can resolve `/settings <section>` without
 * pulling in the heavy section component graph from `settings-sections.ts`.
 *
 * The token map is DERIVED from the section registry rather than hand-written:
 *   - built-in tokens come from `SETTINGS_SECTION_META` (id + declared aliases),
 *     the single source of truth for built-in ids/labels/grouping, and
 *   - plugin/host sections registered via `registerSettingsSection` are resolved
 *     live from the registry, so a section added at boot is reachable by its id
 *     and declared aliases without a central edit here.
 *
 * `LEGACY_SETTINGS_SECTION_TOKEN_ALIASES` remains only as a covered fallback for
 * tokens that are not (yet) owned by a section's `aliases` declaration; a drift
 * test asserts every legacy token still resolves and that the derived map has
 * not silently lost a built-in id.
 */

import { SETTINGS_SECTION_META } from "./settings-section-meta";
import { getAllSettingsSections } from "./settings-section-registry";

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * Legacy hand-maintained token → canonical id map. Superseded by the
 * `aliases` field on each section (declared in `SETTINGS_SECTION_META` for
 * built-ins, on the `SettingsSectionDef` for plugin sections). Kept ONLY as a
 * covered fallback so any token that has not been migrated to an owner
 * declaration still resolves; a test pins that every entry here also resolves
 * through the derived map, guarding against drift when the two diverge.
 */
export const LEGACY_SETTINGS_SECTION_TOKEN_ALIASES: Readonly<
  Record<string, string>
> = {
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
  backup: "advanced",
  backups: "advanced",
};

/**
 * Build the built-in token → canonical id map from the pinned META list: each
 * section id is a token for itself, plus every declared alias. Derived, not
 * duplicated — adding/renaming a built-in section or its aliases updates the
 * token map automatically.
 */
function buildBuiltinTokenAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const section of SETTINGS_SECTION_META) {
    const id = normalizeToken(section.id);
    if (!id) continue;
    aliases[id] = section.id;
    for (const alias of section.aliases ?? []) {
      const token = normalizeToken(alias);
      if (token) aliases[token] = section.id;
    }
  }
  return aliases;
}

/**
 * Friendly tokens a user can type to jump to a BUILT-IN settings section, e.g.
 * `/settings model`. Derived from `SETTINGS_SECTION_META` (id + aliases). For
 * plugin/host-registered sections, use {@link resolveSettingsSectionToken},
 * which additionally consults the live registry.
 */
export const SETTINGS_SECTION_TOKEN_ALIASES: Readonly<Record<string, string>> =
  buildBuiltinTokenAliases();

/** The canonical built-in section ids reachable via a token. */
const CANONICAL_SECTION_IDS: ReadonlySet<string> = new Set(
  Object.values(SETTINGS_SECTION_TOKEN_ALIASES),
);

/** Suggestion tokens (deduped) offered for `/settings <section>` completion. */
export const SETTINGS_SECTION_SUGGESTIONS: string[] = Array.from(
  new Set(Object.keys(SETTINGS_SECTION_TOKEN_ALIASES)),
);

/**
 * Resolve a user-typed settings token to a canonical section id, if known.
 *
 * Resolution order:
 *   1. Built-in token map derived from META (id + declared aliases).
 *   2. Live registry — a plugin/host section registered via
 *      `registerSettingsSection` is reachable by its id and its declared
 *      `aliases`, so modular sections work without editing this file.
 *   3. Legacy hand-maintained fallback map, for tokens not yet migrated to an
 *      owner `aliases` declaration.
 */
export function resolveSettingsSectionToken(token: string): string | undefined {
  const normalized = normalizeToken(token);
  if (!normalized) return undefined;

  // 1. Built-ins (id or declared alias), and bare canonical ids.
  if (CANONICAL_SECTION_IDS.has(normalized)) return normalized;
  const builtin = SETTINGS_SECTION_TOKEN_ALIASES[normalized];
  if (builtin) return builtin;

  // 2. Live registry — plugin/host sections and their declared aliases.
  const registered = resolveRegisteredSectionToken(normalized);
  if (registered) return registered;

  // 3. Legacy covered fallback.
  return LEGACY_SETTINGS_SECTION_TOKEN_ALIASES[normalized];
}

function resolveRegisteredSectionToken(
  normalizedToken: string,
): string | undefined {
  for (const section of getAllSettingsSections()) {
    if (normalizeToken(section.id) === normalizedToken) return section.id;
    for (const alias of section.aliases ?? []) {
      if (normalizeToken(alias) === normalizedToken) return section.id;
    }
  }
  return undefined;
}
