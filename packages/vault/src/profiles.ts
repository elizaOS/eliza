/**
 * Profile resolution + per-context routing on top of `Vault`.
 *
 * Two layers:
 *
 * 1. Per-key active profile.
 *    A key K can have multiple named profiles (e.g. work, personal,
 *    throwaway). Each profile's value lives at `K.profile.<profileId>`;
 *    the meta blob (`_meta.K`) tracks the profile list and which one
 *    is currently active for bare reads. When no meta is present the
 *    legacy storage path is used (the value lives at K itself).
 *
 * 2. Per-context routing rules.
 *    A user can declare "for OPENROUTER_API_KEY, when agentId=X use the
 *    work profile". Rules are walked in order; the first match wins.
 *    Falls back to the key's `activeProfile`, then to the global
 *    `defaultProfile`, then to the legacy bare-key value.
 *
 * The vault stays dumb: every read goes through `Vault.get/has`. The
 * only routing logic lives here so the vault contract is unchanged.
 */

import {
  META_PREFIX,
  profileStorageKey,
  ROUTING_KEY,
  readEntryMeta,
} from "./inventory.js";
import type { Vault } from "./vault.js";

// ── Routing config ─────────────────────────────────────────────────

export type RoutingScopeKind = "agent" | "app" | "skill";

export interface RoutingScope {
  readonly kind: RoutingScopeKind;
  readonly agentId?: string;
  readonly appName?: string;
  readonly skillId?: string;
}

export interface RoutingRule {
  /** Exact-match against the vault key (e.g. "OPENROUTER_API_KEY"). */
  readonly keyPattern: string;
  readonly scope: RoutingScope;
  readonly profileId: string;
}

export interface RoutingConfig {
  readonly rules: ReadonlyArray<RoutingRule>;
  /**
   * Profile id used when no rule matches and the key's own
   * `activeProfile` is unset. Acts as the global default for keys
   * that have profiles enabled.
   */
  readonly defaultProfile?: string;
}

const EMPTY_ROUTING: RoutingConfig = { rules: [] };

export interface ResolutionContext {
  readonly agentId?: string;
  readonly appName?: string;
  readonly skillId?: string;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Resolve `key` against (a) per-context routing rules, (b) the key's
 * `activeProfile`, (c) the global `defaultProfile`, then (d) the bare
 * key value.
 *
 * Throws when none of the above resolves to a stored value — callers
 * decide how to surface the miss (e.g. inventory routes return 404,
 * runtime callers fall back to env var).
 */
export async function resolveActiveValue(
  vault: Vault,
  key: string,
  ctx?: ResolutionContext,
): Promise<string> {
  const meta = await readEntryMeta(vault, key);
  const profiles = meta?.profiles ?? [];
  const hasProfiles = profiles.length > 0;

  if (hasProfiles) {
    const routing = await readRoutingConfig(vault);
    const ruled = pickRule(routing.rules, key, ctx);
    const candidateOrder = [
      ruled?.profileId,
      meta?.activeProfile,
      routing.defaultProfile,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    const allowed = new Set(profiles.map((p) => p.id));
    for (const candidate of candidateOrder) {
      if (!allowed.has(candidate)) continue;
      const profileKey = profileStorageKey(key, candidate);
      if (await vault.has(profileKey)) {
        return vault.get(profileKey);
      }
    }
    // Fall through to the bare key — preserves backwards compat for
    // keys whose `meta.profiles` exists but the chosen profile blob
    // is missing (a partial migration). This is intentional: the
    // bare key is the legacy "default" location.
  }

  return vault.get(key);
}

/**
 * Read the routing config blob from the vault. Missing or malformed
 * entries return `EMPTY_ROUTING` — routing is best-effort overlay,
 * not a load-bearing contract.
 */
export async function readRoutingConfig(vault: Vault): Promise<RoutingConfig> {
  if (!(await vault.has(ROUTING_KEY))) return EMPTY_ROUTING;
  const raw = await vault.get(ROUTING_KEY);
  return parseRoutingConfig(raw);
}

/** Persist the routing config blob. Caller-validated input. */
export async function writeRoutingConfig(
  vault: Vault,
  config: RoutingConfig,
): Promise<void> {
  const normalized = normalizeRoutingConfig(config);
  await vault.set(ROUTING_KEY, JSON.stringify(normalized));
}

// ── Internals ───────────────────────────────────────────────────────

function pickRule(
  rules: ReadonlyArray<RoutingRule>,
  key: string,
  ctx: ResolutionContext | undefined,
): RoutingRule | null {
  if (!ctx) return null;
  for (const rule of rules) {
    if (rule.keyPattern !== key) continue;
    if (matchesScope(rule.scope, ctx)) return rule;
  }
  return null;
}

function matchesScope(scope: RoutingScope, ctx: ResolutionContext): boolean {
  if (scope.kind === "agent") {
    return (
      typeof scope.agentId === "string" &&
      typeof ctx.agentId === "string" &&
      scope.agentId === ctx.agentId
    );
  }
  if (scope.kind === "app") {
    return (
      typeof scope.appName === "string" &&
      typeof ctx.appName === "string" &&
      scope.appName === ctx.appName
    );
  }
  if (scope.kind === "skill") {
    return (
      typeof scope.skillId === "string" &&
      typeof ctx.skillId === "string" &&
      scope.skillId === ctx.skillId
    );
  }
  return false;
}

function parseRoutingConfig(raw: string): RoutingConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_ROUTING;
  }
  const obj = parsed as Record<string, unknown>;
  const rules: RoutingRule[] = [];
  if (Array.isArray(obj.rules)) {
    for (const r of obj.rules) {
      const normalized = normalizeRule(r);
      if (normalized) rules.push(normalized);
    }
  }
  const out: RoutingConfig = {
    rules,
    ...(typeof obj.defaultProfile === "string" && obj.defaultProfile.length > 0
      ? { defaultProfile: obj.defaultProfile }
      : {}),
  };
  return out;
}

function normalizeRoutingConfig(config: RoutingConfig): RoutingConfig {
  const rules: RoutingRule[] = [];
  for (const r of config.rules ?? []) {
    const normalized = normalizeRule(r);
    if (normalized) rules.push(normalized);
  }
  return {
    rules,
    ...(typeof config.defaultProfile === "string" &&
    config.defaultProfile.length > 0
      ? { defaultProfile: config.defaultProfile }
      : {}),
  };
}

function normalizeRule(r: unknown): RoutingRule | null {
  if (!r || typeof r !== "object") return null;
  const rec = r as Record<string, unknown>;
  if (typeof rec.keyPattern !== "string" || rec.keyPattern.length === 0) {
    return null;
  }
  if (
    rec.keyPattern.startsWith(META_PREFIX) ||
    rec.keyPattern === ROUTING_KEY
  ) {
    return null; // never route an internal key
  }
  if (typeof rec.profileId !== "string" || rec.profileId.length === 0) {
    return null;
  }
  const scope = rec.scope;
  if (!scope || typeof scope !== "object") return null;
  const scopeRec = scope as Record<string, unknown>;
  const kind = scopeRec.kind;
  if (kind !== "agent" && kind !== "app" && kind !== "skill") return null;

  if (kind === "agent" && typeof scopeRec.agentId === "string") {
    return {
      keyPattern: rec.keyPattern,
      scope: { kind: "agent", agentId: scopeRec.agentId },
      profileId: rec.profileId,
    };
  }
  if (kind === "app" && typeof scopeRec.appName === "string") {
    return {
      keyPattern: rec.keyPattern,
      scope: { kind: "app", appName: scopeRec.appName },
      profileId: rec.profileId,
    };
  }
  if (kind === "skill" && typeof scopeRec.skillId === "string") {
    return {
      keyPattern: rec.keyPattern,
      scope: { kind: "skill", skillId: scopeRec.skillId },
      profileId: rec.profileId,
    };
  }
  return null;
}
