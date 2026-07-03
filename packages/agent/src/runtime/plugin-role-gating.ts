/**
 * Legacy provider role gating.
 *
 * Action access is declared on each action's `roleGate` and enforced by core
 * execution paths. This module only keeps provider redaction for legacy
 * providers that still use direct provider registration instead of the
 * context catalog.
 *
 * @module plugin-role-gating
 */
import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  RoleGateRole,
  State,
} from "@elizaos/core";
import { logger, satisfiesRoleGate } from "@elizaos/core";

// Lowercase tier alias kept for override-map ergonomics. Each tier normalizes to
// a canonical `RoleGateRole` (`TIER_TO_CANONICAL_ROLE`) so the pass/fail decision
// runs through the shared `satisfiesRoleGate` primitive instead of a local rank
// reimplementation.
type RoleGateTier = "user" | "admin" | "owner";

const TIER_TO_CANONICAL_ROLE: Readonly<Record<RoleGateTier, RoleGateRole>> = {
  user: "USER",
  admin: "ADMIN",
  owner: "OWNER",
};

// ---------------------------------------------------------------------------
// Provider-level gating — providers that expose sensitive context.
// Keys are exact provider `name` strings.
// ---------------------------------------------------------------------------

const PROVIDER_ROLE_OVERRIDES: Readonly<Record<string, RoleGateTier>> = {
  // Shell
  shellHistoryProvider: "admin",
  terminalUsage: "admin",

  // Orchestrator
  ACTIVE_WORKSPACE_CONTEXT: "admin",
  CODING_AGENT_EXAMPLES: "admin",

  // Secrets
  SECRETS_STATUS: "admin",
  SECRETS_INFO: "admin",
  MISSING_SECRETS: "admin",

  // Cron
  cronContext: "admin",

  // Cloud
  elizacloud_status: "admin",
  elizacloud_credits: "admin",
  elizacloud_health: "admin",
  elizacloud_models: "admin",

  // Todos
  todos: "user",

  // Browser / wallet operational state
  app_browser_workspace: "owner",
  computerState: "owner",
  "get-balance": "owner",
  "solana-wallet": "owner",
  wallet: "owner",
  walletBalance: "owner",
  walletPortfolio: "owner",
  tokenPrices: "owner",
  chainInfo: "owner",

  // Apps / plugins expose local installation/runtime state.
  available_apps: "owner",
  pluginConfigurationStatus: "owner",
  pluginState: "owner",
  registryPlugins: "owner",
};

// ---------------------------------------------------------------------------
// Sender-role lookup dedup
// ---------------------------------------------------------------------------
// `checkSenderRole` does two DB queries (resolveWorldForMessage +
// resolveEntityRole). When state composition runs, every gated provider's
// wrapped `get()` calls it in parallel via `Promise.all`. With even a
// modest set of gated providers (ACTIVE_WORKSPACE_CONTEXT,
// CODING_AGENT_EXAMPLES, SECRETS_STATUS, walletPortfolio, etc. —
// 10+ providers gated to admin or owner), that's 20+ DB queries per
// turn before the planner is prompted. On a busy host the per-validator
// stats compound and the provider provider-loop hits its overall
// timeout cap, dropping providers from the prompt's context.
//
// This intentionally dedups only live in-flight checks. Provider redaction is
// security-sensitive, and `checkSenderRole` also depends on live connector
// metadata stamped onto the current message, so resolved role decisions are not
// cached across turns.
type RoleCheckValue = {
  role: RoleGateRole;
} | null;

const roleCheckInflightByRuntime = new WeakMap<
  IAgentRuntime,
  Map<string, Promise<RoleCheckValue>>
>();
let roleCheckLoader:
  | Promise<typeof import("./roles.ts").checkSenderRole>
  | undefined;

function loadCheckSenderRole() {
  if (!roleCheckLoader) {
    // Clear the cached promise if the dynamic import rejects so the next
    // call can retry. Without this, a single transient module-registry
    // failure (e.g. evaluation error during startup) would permanently
    // wedge every gated provider for the runtime's lifetime by handing
    // back the same rejected promise on every call.
    roleCheckLoader = import("./roles.ts").then((mod) => mod.checkSenderRole);
    roleCheckLoader.catch(() => {
      roleCheckLoader = undefined;
    });
  }
  return roleCheckLoader;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function liveRoleMetadataKey(message: Memory): string {
  const source =
    typeof message.content.source === "string" ? message.content.source : "";
  const metadata = (message as Memory & { metadata?: unknown }).metadata;
  return stableStringify({ metadata, source });
}

async function fetchSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckValue> {
  const checkSenderRole = await loadCheckSenderRole();
  const fresh = await checkSenderRole(runtime, message);
  return fresh ? { role: fresh.role } : null;
}

async function getCachedSenderRole(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<RoleCheckValue> {
  const entityId = message.entityId;
  const roomId = message.roomId;
  if (!entityId || !roomId) {
    const checkSenderRole = await loadCheckSenderRole();
    const fresh = await checkSenderRole(runtime, message);
    return fresh ? { role: fresh.role } : null;
  }

  const key = `${runtime.agentId}|${entityId}|${roomId}|${liveRoleMetadataKey(message)}`;
  let roleCheckInflight = roleCheckInflightByRuntime.get(runtime);
  if (!roleCheckInflight) {
    roleCheckInflight = new Map();
    roleCheckInflightByRuntime.set(runtime, roleCheckInflight);
  }
  const inflight = roleCheckInflight.get(key);
  if (inflight) return inflight;

  const promise = fetchSenderRole(runtime, message).finally(() => {
    roleCheckInflight.delete(key);
  });
  roleCheckInflight.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Gating implementation
// ---------------------------------------------------------------------------

function roleCheckPasses(
  check: { role: RoleGateRole },
  tier: RoleGateTier,
): boolean {
  // Route through the canonical gate primitive: the caller's resolved role must
  // out-rank the override tier. OWNER passes "owner", OWNER/ADMIN pass "admin",
  // and anyone above GUEST passes "user".
  return satisfiesRoleGate([check.role], {
    minRole: TIER_TO_CANONICAL_ROLE[tier],
  });
}

/**
 * Wrap a provider's get function so it returns empty content for callers
 * below the gate. Providers don't block; they just withhold context.
 */
function gateProvider(provider: Provider, tier: RoleGateTier): void {
  if ((provider as { __roleGate?: RoleGateTier }).__roleGate === tier) {
    return;
  }

  const originalGet = provider.get;

  provider.get = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const check = await getCachedSenderRole(runtime, message);
    if (!check || !roleCheckPasses(check, tier)) {
      return { text: "" };
    }

    return originalGet.call(provider, runtime, message, state);
  };
  (provider as { __roleGate?: RoleGateTier }).__roleGate = tier;
}

/**
 * Hard-withhold a provider's output. Used as the fail-closed fallback when a
 * sensitive provider cannot be gated normally: rather than leaving its original
 * `get` exposed (fail-open), replace it with one that returns no content for
 * every caller so owner/admin-tier context can never leak.
 */
function withholdProvider(provider: Provider): void {
  const redact = async (): Promise<ProviderResult> => ({ text: "" });
  try {
    provider.get = redact;
  } catch {
    // `get` may be a read-only data property; force-replace it when the
    // property is configurable so withholding still wins over exposure.
    Object.defineProperty(provider, "get", {
      value: redact,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  // Mark as gated at the strictest tier so a subsequent pass treats it as done.
  try {
    (provider as { __roleGate?: RoleGateTier }).__roleGate = "owner";
  } catch {
    // Best-effort marker only; the withholding above already applied.
  }
}

function withholdSensitiveProviders(plugin: Plugin): number {
  let withheld = 0;
  for (const provider of plugin.providers ?? []) {
    const providerName = (provider as { name?: string }).name ?? "";
    if (!PROVIDER_ROLE_OVERRIDES[providerName]) continue;
    withholdProvider(provider);
    withheld++;
  }
  return withheld;
}

/**
 * Apply role gating to the given plugins. Safe to call repeatedly and per
 * plugin: `gateProvider` is idempotent (already-gated providers are skipped),
 * so this doubles as the register-time chokepoint hook.
 *
 * Providers in PROVIDER_ROLE_OVERRIDES get gated. Actions are intentionally
 * not wrapped here; use action.roleGate.
 *
 * Fail-closed: if wrapping a sensitive provider throws, its content is withheld
 * entirely and the failure is logged at ERROR — redaction is never silently
 * disabled.
 */
export function applyPluginRoleGating(plugins: Plugin[]): void {
  let gatedProviders = 0;
  let withheldProviders = 0;

  for (const plugin of plugins) {
    // Gate providers
    if (plugin.providers?.length) {
      for (const provider of plugin.providers) {
        const providerName = (provider as { name?: string }).name ?? "";
        const providerTier = PROVIDER_ROLE_OVERRIDES[providerName];
        if (!providerTier) continue;
        try {
          gateProvider(provider, providerTier);
          gatedProviders++;
        } catch (err) {
          // Fail closed: a sensitive provider we could not wrap must not be
          // exposed. Withhold its content and report loudly — never silently
          // leave redaction disabled.
          withholdProvider(provider);
          withheldProviders++;
          logger.error(
            `[role-gating] Failed to gate sensitive provider "${providerName}" (tier=${providerTier}); withholding its content to fail closed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  if (gatedProviders > 0) {
    logger.info(`[role-gating] Total: ${gatedProviders} provider(s) gated`);
  }
  if (withheldProviders > 0) {
    logger.error(
      `[role-gating] ${withheldProviders} sensitive provider(s) withheld after a gating failure (fail-closed)`,
    );
  }
}

type ProviderRoleGatingRuntime = Pick<IAgentRuntime, "registerPlugin"> & {
  __elizaProviderRoleGatingInstalled?: boolean;
};

/**
 * Install the durable provider-gating chokepoint on runtime.registerPlugin so
 * boot-time plugins and post-boot hot-installs are gated identically.
 */
export function installProviderRoleGatingChokepoint(
  runtime: ProviderRoleGatingRuntime,
): void {
  if (runtime.__elizaProviderRoleGatingInstalled) return;

  const originalRegisterPlugin = runtime.registerPlugin.bind(runtime);
  runtime.registerPlugin = async (plugin: Plugin): Promise<void> => {
    try {
      applyPluginRoleGating([plugin]);
    } catch (err) {
      let withheld = 0;
      try {
        withheld = withholdSensitiveProviders(plugin);
      } catch (withholdErr) {
        logger.error(
          `[role-gating] Provider role-gating failed for plugin "${plugin?.name}" and sensitive provider withholding also failed; blocking registration to fail closed: ${
            withholdErr instanceof Error
              ? withholdErr.message
              : String(withholdErr)
          }`,
        );
        throw err;
      }
      logger.error(
        `[role-gating] Provider role-gating failed for plugin "${plugin?.name}"; withheld ${withheld} sensitive provider(s) to fail closed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return originalRegisterPlugin(plugin);
  };

  runtime.__elizaProviderRoleGatingInstalled = true;
}

/** Exported for testing. */
export { PROVIDER_ROLE_OVERRIDES, TIER_TO_CANONICAL_ROLE };
