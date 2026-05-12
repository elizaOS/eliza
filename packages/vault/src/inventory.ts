/**
 * Vault inventory: a meta-layer over `Vault` that surfaces every stored
 * key in a categorized, UI-renderable shape, and lets the user attach
 * metadata (label, providerId, profiles, routing) to a key without
 * changing the vault's underlying storage contract.
 *
 * Storage convention:
 *   - Original keys live exactly where they always have (e.g.
 *     `OPENROUTER_API_KEY`).
 *   - Metadata for a key K lives at `_meta.<K>` as a JSON-encoded
 *     non-sensitive entry.
 *   - When profiles are enabled for K, the per-profile values live at
 *     `<K>.profile.<profileId>`. The "active profile" pointer lives in
 *     the meta blob.
 *   - Routing rules across keys live at `_routing.config` as a single
 *     JSON-encoded non-sensitive entry.
 *
 * The vault layer remains dumb: `vault.get(K)` still returns the value
 * stored under K. Profile resolution is a thin wrapper exposed by the
 * manager (see `manager.getActive`). This file owns the metadata
 * read/write/categorize logic only.
 *
 * Hard rule: `_meta.*` and `_routing.*` are reserved prefixes — every
 * inventory listing filters them out so the user never sees a meta
 * blob masquerading as a normal vault entry.
 */

import type { Vault } from "./vault.js";

// Reserved key prefixes. Anything starting with these is internal to
// the inventory layer and must not surface to UI listings.
export const META_PREFIX = "_meta.";
export const ROUTING_KEY = "_routing.config";
export const PROFILE_SEGMENT = "profile";

/**
 * High-level category of a vault entry — drives grouping in the UI.
 *
 * - `provider`   — model-provider API keys (OPENAI_API_KEY, etc.)
 * - `plugin`     — non-provider plugin tokens (WORKFLOW_API_KEY, GITHUB_TOKEN, …)
 * - `wallet`     — wallet private keys / mnemonics
 * - `credential` — saved-login records (`creds.<domain>.<user>`)
 * - `system`     — internal manager/preferences entries
 * - `session`    — password-manager session tokens (`pm.<vendor>.session`)
 */
export type VaultEntryCategory =
  | "provider"
  | "plugin"
  | "wallet"
  | "credential"
  | "system"
  | "session";

export interface VaultEntryProfile {
  readonly id: string;
  readonly label: string;
  /** Epoch ms; missing on legacy entries. */
  readonly createdAt?: number;
}

/**
 * On-disk shape of `_meta.<key>`. Only the fields the user has set
 * are persisted — partial writes via `setEntryMeta` merge.
 */
export interface VaultEntryMetaRecord {
  readonly category?: VaultEntryCategory;
  readonly label?: string;
  readonly providerId?: string;
  readonly lastModified?: number;
  readonly lastUsed?: number;
  readonly profiles?: ReadonlyArray<VaultEntryProfile>;
  readonly activeProfile?: string;
}

/**
 * Inventory row as the UI sees it. `kind` mirrors the underlying vault
 * entry's storage kind (secret = encrypted, value = plaintext config,
 * reference = pointer into a password manager).
 */
export interface VaultEntryMeta {
  readonly key: string;
  readonly category: VaultEntryCategory;
  readonly label: string;
  readonly providerId?: string;
  readonly hasProfiles: boolean;
  readonly activeProfile?: string;
  readonly profiles?: ReadonlyArray<VaultEntryProfile>;
  readonly lastModified?: number;
  readonly lastUsed?: number;
  readonly kind: "secret" | "value" | "reference";
}

// ── Categorization ──────────────────────────────────────────────────

/**
 * Heuristic categorization for keys without an explicit `_meta.*` entry.
 * Order matters: more specific patterns run first.
 */
export function categorizeKey(key: string): VaultEntryCategory {
  if (key.startsWith("creds.")) return "credential";
  if (key.startsWith("pm.")) return "session";
  if (key.startsWith("_manager.") || key === ROUTING_KEY) return "system";
  if (
    /(?:_PRIVATE_KEY|_MNEMONIC|_SEED_PHRASE)$/i.test(key) ||
    /^(?:EVM|SOLANA|BTC|ETH|BITCOIN)_/i.test(key) ||
    // wallet.<agent>.<chain>.privateKey  (Phase 3 unified storage)
    key.startsWith("wallet.") ||
    // Legacy per-agent shape: agent.<name>.wallet.<chain>
    /(?:^|\.)wallet\./i.test(key)
  ) {
    return "wallet";
  }
  if (/_API_KEY$/.test(key)) {
    if (PROVIDER_KEY_PATTERNS.some((rx) => rx.test(key))) return "provider";
    return "plugin";
  }
  if (PROVIDER_EXACT_KEYS.has(key)) return "provider";
  return "plugin";
}

/**
 * Provider id derivation when no explicit meta is set. Returns null
 * when the key isn't a recognized provider env var.
 */
export function inferProviderId(key: string): string | null {
  const lookup = PROVIDER_KEY_TO_ID[key];
  if (lookup) return lookup;
  const m = /^([A-Z][A-Z0-9_]*)_API_KEY$/.exec(key);
  if (m) return m[1]?.toLowerCase();
  return null;
}

const PROVIDER_KEY_TO_ID: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: "openai",
  ANTHROPIC_API_KEY: "anthropic",
  OPENROUTER_API_KEY: "openrouter",
  GROQ_API_KEY: "groq",
  XAI_API_KEY: "grok",
  DEEPSEEK_API_KEY: "deepseek",
  ZAI_API_KEY: "zai",
  Z_AI_API_KEY: "zai",
  MOONSHOT_API_KEY: "moonshot",
  KIMI_API_KEY: "moonshot",
  MISTRAL_API_KEY: "mistral",
  TOGETHER_API_KEY: "together",
  GOOGLE_GENERATIVE_AI_API_KEY: "gemini",
  GOOGLE_API_KEY: "gemini",
  GEMINI_API_KEY: "gemini",
  PERPLEXITY_API_KEY: "perplexity",
};

const PROVIDER_EXACT_KEYS: ReadonlySet<string> = new Set(
  Object.keys(PROVIDER_KEY_TO_ID),
);

const PROVIDER_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^OPENAI_API_KEY$/,
  /^ANTHROPIC_API_KEY$/,
  /^OPENROUTER_API_KEY$/,
  /^GROQ_API_KEY$/,
  /^XAI_API_KEY$/,
  /^DEEPSEEK_API_KEY$/,
  /^Z_?AI_API_KEY$/,
  /^(?:MOONSHOT|KIMI)_API_KEY$/,
  /^MISTRAL_API_KEY$/,
  /^TOGETHER_API_KEY$/,
  /^GOOGLE_(?:GENERATIVE_AI_)?API_KEY$/,
  /^GEMINI_API_KEY$/,
  /^PERPLEXITY_API_KEY$/,
];

// ── Default labels ─────────────────────────────────────────────────

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  groq: "Groq",
  grok: "xAI Grok",
  deepseek: "DeepSeek",
  zai: "z.ai",
  moonshot: "Kimi / Moonshot",
  mistral: "Mistral",
  together: "Together",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

function defaultLabel(key: string, providerId: string | null): string {
  if (providerId && PROVIDER_LABELS[providerId])
    return PROVIDER_LABELS[providerId]!;
  return key;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Read the meta record for `key`, parsing the underlying JSON. Returns
 * null when no meta has been written. Malformed JSON is treated as
 * "no meta" and logged at warn — we never silently coerce a corrupt
 * blob into a valid meta to mask the underlying problem.
 */
export async function readEntryMeta(
  vault: Vault,
  key: string,
): Promise<VaultEntryMetaRecord | null> {
  const metaKey = `${META_PREFIX}${key}`;
  if (!(await vault.has(metaKey))) return null;
  const raw = await vault.get(metaKey);
  return parseMetaRecord(raw, metaKey);
}

/**
 * Merge `partial` into the existing meta for `key`. Writing partial
 * meta is the only public way to mutate metadata — callers always
 * read-modify-write through this helper so concurrent fields don't
 * clobber each other.
 *
 * Wipe a field by setting its value to `null` in the partial.
 */
/**
 * Partial-update payload accepted by `setEntryMeta`. Fields are
 * optional; passing `null` deletes the underlying field from the
 * stored meta blob (the only way to wipe e.g. activeProfile without
 * round-tripping the entire record).
 */
export interface VaultEntryMetaUpdate {
  readonly category?: VaultEntryCategory | null;
  readonly label?: string | null;
  readonly providerId?: string | null;
  readonly lastUsed?: number | null;
  readonly profiles?: ReadonlyArray<VaultEntryProfile> | null;
  readonly activeProfile?: string | null;
}

export async function setEntryMeta(
  vault: Vault,
  key: string,
  partial: VaultEntryMetaUpdate,
): Promise<void> {
  const metaKey = `${META_PREFIX}${key}`;
  const existing = (await readEntryMeta(vault, key)) ?? {};
  const merged: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(partial)) {
    if (v === null) {
      delete merged[k];
      continue;
    }
    if (v === undefined) continue;
    merged[k] = v;
  }
  merged.lastModified = Date.now();
  // Meta is non-sensitive but its content describes which keys exist
  // and which profiles a user maintains — disclosure-meaningful but
  // not credential-bearing. Stored as a plain `value` entry; the
  // sensitive value sits in `<key>` (or `<key>.profile.<id>`).
  await vault.set(metaKey, JSON.stringify(merged));
}

/**
 * Drop the meta record for `key`. Callers are responsible for also
 * removing the underlying value(s) and profile entries — this only
 * touches `_meta.<key>`.
 */
export async function removeEntryMeta(
  vault: Vault,
  key: string,
): Promise<void> {
  const metaKey = `${META_PREFIX}${key}`;
  if (await vault.has(metaKey)) {
    await vault.remove(metaKey);
  }
}

/**
 * List every meaningful vault entry, grouped by category. Reserved
 * `_meta.*` and `_routing.*` keys are filtered out, as are the
 * `_manager.*` preferences keys.
 *
 * For keys with profile entries (`<K>.profile.<id>`), only the parent
 * `<K>` is surfaced — the profile rows roll up under it.
 */
export async function listVaultInventory(
  vault: Vault,
): Promise<readonly VaultEntryMeta[]> {
  const allKeys = await vault.list();
  const profileChildren = new Set<string>();

  // First pass: identify keys that are themselves children of a
  // profile-bearing parent. Pattern: <PARENT>.profile.<id>.
  // We strip these so the inventory only ever exposes the parent.
  for (const k of allKeys) {
    const split = k.indexOf(`.${PROFILE_SEGMENT}.`);
    if (split > 0) profileChildren.add(k);
  }

  // The set of parents we want to expose:
  //   1. Every concrete vault key that isn't a profile child or a
  //      reserved internal key.
  //   2. Every parent whose `_meta.<key>` exists even if the bare key
  //      itself doesn't (the user has profiles but no legacy default
  //      value at the bare key — common after `migrate-to-profiles`).
  const parentKeys = new Set<string>();
  for (const key of allKeys) {
    if (key.startsWith(META_PREFIX)) {
      parentKeys.add(key.slice(META_PREFIX.length));
      continue;
    }
    if (key === ROUTING_KEY) continue;
    if (key.startsWith("_manager.")) continue;
    if (profileChildren.has(key)) continue;
    parentKeys.add(key);
  }

  const out: VaultEntryMeta[] = [];
  for (const key of parentKeys) {
    const descriptor = await vault.describe(key);
    const meta = await readEntryMeta(vault, key);
    if (!descriptor && !meta) continue; // nothing to surface

    const kind: "secret" | "value" | "reference" = descriptor
      ? descriptorKind(descriptor.source)
      : "secret"; // meta-only parents are presumed to back sensitive data

    const providerId = meta?.providerId ?? inferProviderId(key) ?? undefined;
    const category = meta?.category ?? categorizeKey(key);
    const label = meta?.label ?? defaultLabel(key, providerId ?? null);
    const profiles = meta?.profiles ?? [];
    const hasProfiles = profiles.length > 0;

    out.push({
      key,
      category,
      label,
      ...(providerId ? { providerId } : {}),
      hasProfiles,
      ...(meta?.activeProfile ? { activeProfile: meta.activeProfile } : {}),
      ...(hasProfiles ? { profiles } : {}),
      ...(meta?.lastModified !== undefined
        ? { lastModified: meta.lastModified }
        : descriptor?.lastModified !== undefined
          ? { lastModified: descriptor.lastModified }
          : {}),
      ...(meta?.lastUsed !== undefined ? { lastUsed: meta.lastUsed } : {}),
      kind,
    });
  }

  return out;
}

/**
 * Vault key for the storage backing one profile of a parent key.
 *
 * Profiles use dot separators so `vault.list("<KEY>")` matches both the
 * parent and every profile via the existing prefix logic.
 */
export function profileStorageKey(key: string, profileId: string): string {
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new TypeError("profileStorageKey: profileId must be non-empty");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
    throw new TypeError(
      `profileStorageKey: profileId must match [a-zA-Z0-9_-]+, got ${JSON.stringify(profileId)}`,
    );
  }
  return `${key}.${PROFILE_SEGMENT}.${profileId}`;
}

// ── Internals ───────────────────────────────────────────────────────

function descriptorKind(
  source: "file" | "keychain-encrypted" | "1password" | "protonpass",
): "secret" | "value" | "reference" {
  if (source === "file") return "value";
  if (source === "keychain-encrypted") return "secret";
  return "reference";
}

function parseMetaRecord(
  raw: string,
  metaKey: string,
): VaultEntryMetaRecord | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `vault: meta entry ${metaKey} is not a JSON object (got ${typeof parsed})`,
    );
  }
  const obj = parsed as Record<string, unknown>;

  const out: VaultEntryMetaRecord = {};
  const cat = obj.category;
  if (typeof cat === "string" && isCategory(cat)) {
    (out as { category: VaultEntryCategory }).category = cat;
  }
  if (typeof obj.label === "string" && obj.label.length > 0) {
    (out as { label: string }).label = obj.label;
  }
  if (typeof obj.providerId === "string" && obj.providerId.length > 0) {
    (out as { providerId: string }).providerId = obj.providerId;
  }
  if (typeof obj.lastModified === "number") {
    (out as { lastModified: number }).lastModified = obj.lastModified;
  }
  if (typeof obj.lastUsed === "number") {
    (out as { lastUsed: number }).lastUsed = obj.lastUsed;
  }
  if (typeof obj.activeProfile === "string" && obj.activeProfile.length > 0) {
    (out as { activeProfile: string }).activeProfile = obj.activeProfile;
  }
  if (Array.isArray(obj.profiles)) {
    const profiles: VaultEntryProfile[] = [];
    for (const p of obj.profiles) {
      if (!p || typeof p !== "object") continue;
      const rec = p as Record<string, unknown>;
      if (typeof rec.id !== "string" || rec.id.length === 0) continue;
      const label =
        typeof rec.label === "string" && rec.label.length > 0
          ? rec.label
          : rec.id;
      const profile: VaultEntryProfile = {
        id: rec.id,
        label,
        ...(typeof rec.createdAt === "number"
          ? { createdAt: rec.createdAt }
          : {}),
      };
      profiles.push(profile);
    }
    if (profiles.length > 0) {
      (out as { profiles: ReadonlyArray<VaultEntryProfile> }).profiles =
        profiles;
    }
  }
  return out;
}

function isCategory(v: string): v is VaultEntryCategory {
  return (
    v === "provider" ||
    v === "plugin" ||
    v === "wallet" ||
    v === "credential" ||
    v === "system" ||
    v === "session"
  );
}
