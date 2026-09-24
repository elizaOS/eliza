/**
 * Resolves profile credentials for agent, app, and skill contexts through the
 * vault's existing storage API. The first matching routing rule precedes the
 * active profile, global default, and bare key. Persisted routing must validate
 * completely before it can influence credential selection.
 */

import {
  META_PREFIX,
  profileStorageKey,
  ROUTING_KEY,
  readEntryMeta,
} from "./inventory.js";
import type { Vault } from "./vault.js";

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

/** Missing configuration has no rules; malformed persisted configuration throws. */
export async function readRoutingConfig(vault: Vault): Promise<RoutingConfig> {
  if (!(await vault.has(ROUTING_KEY))) return EMPTY_ROUTING;
  const raw = await vault.get(ROUTING_KEY);
  return parseRoutingConfig(raw);
}

/** Validate the complete configuration before replacing persisted routing. */
export async function writeRoutingConfig(
  vault: Vault,
  config: unknown,
): Promise<void> {
  const normalized = validateRoutingConfig(config);
  await vault.set(ROUTING_KEY, JSON.stringify(normalized));
}

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

/** Safe diagnostics for routing failures; values and credential keys are never included. */
export class RoutingConfigError extends Error {
  readonly code = "VAULT_ROUTING_CONFIG_INVALID";
  constructor(readonly field: string) {
    super(`Invalid vault routing configuration at ${field}`);
    this.name = "RoutingConfigError";
  }
}

function parseRoutingConfig(raw: string): RoutingConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 reject malformed persisted input without copying its bytes into diagnostics.
    throw new RoutingConfigError("config");
  }
  return validateRoutingConfig(parsed);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingConfigError(field);
  }
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RoutingConfigError(field);
  }
  return value;
}

function validateRoutingConfig(value: unknown): RoutingConfig {
  const config = record(value, "config");
  if (!Array.isArray(config.rules)) throw new RoutingConfigError("rules");
  const rules = config.rules.map(
    (value: unknown, index: number): RoutingRule => {
      const field = `rules[${index}]`;
      const rule = record(value, field);
      const keyPattern = nonemptyString(rule.keyPattern, `${field}.keyPattern`);
      if (keyPattern.startsWith(META_PREFIX) || keyPattern === ROUTING_KEY) {
        throw new RoutingConfigError(`${field}.keyPattern`);
      }
      const profileId = nonemptyString(rule.profileId, `${field}.profileId`);
      const scope = record(rule.scope, `${field}.scope`);
      switch (scope.kind) {
        case "agent":
          return {
            keyPattern,
            profileId,
            scope: {
              kind: "agent",
              agentId: nonemptyString(scope.agentId, `${field}.scope.agentId`),
            },
          };
        case "app":
          return {
            keyPattern,
            profileId,
            scope: {
              kind: "app",
              appName: nonemptyString(scope.appName, `${field}.scope.appName`),
            },
          };
        case "skill":
          return {
            keyPattern,
            profileId,
            scope: {
              kind: "skill",
              skillId: nonemptyString(scope.skillId, `${field}.scope.skillId`),
            },
          };
        default:
          throw new RoutingConfigError(`${field}.scope.kind`);
      }
    },
  );
  return {
    rules,
    ...(config.defaultProfile === undefined
      ? {}
      : {
          defaultProfile: nonemptyString(
            config.defaultProfile,
            "defaultProfile",
          ),
        }),
  };
}
