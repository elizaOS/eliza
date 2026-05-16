/**
 * Legacy provider role gating.
 *
 * Action access is declared on each action's `roleGate` and enforced by core
 * execution paths. This module only keeps provider redaction for legacy
 * providers that do not yet run through the context catalog.
 *
 * @module plugin-role-gating
 */
import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

type RoleGate = "user" | "admin" | "owner";

const ROLE_GATED_PLUGINS: Readonly<Record<string, RoleGate>> = {};

const ACTION_ROLE_OVERRIDES: Readonly<Record<string, RoleGate>> = {};

// ---------------------------------------------------------------------------
// Provider-level gating — providers that expose sensitive context.
// Keys are exact provider `name` strings.
// ---------------------------------------------------------------------------

const PROVIDER_ROLE_OVERRIDES: Readonly<Record<string, RoleGate>> = {
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
  role: string;
  isOwner: boolean;
  isAdmin: boolean;
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
  return fresh
    ? { role: fresh.role, isOwner: fresh.isOwner, isAdmin: fresh.isAdmin }
    : null;
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
    return fresh
      ? { role: fresh.role, isOwner: fresh.isOwner, isAdmin: fresh.isAdmin }
      : null;
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
  check: { isOwner?: boolean; isAdmin?: boolean; role?: string },
  gate: RoleGate,
): boolean {
  switch (gate) {
    case "owner":
      return check.isOwner === true;
    case "admin":
      return check.isAdmin === true;
    case "user":
      // USER, ADMIN, and OWNER all pass the "user" gate.
      // Only GUEST (rank 0) is blocked.
      return check.role !== "GUEST" && check.role !== "NONE";
    default:
      return false;
  }
}

/**
 * Wrap a provider's get function so it returns empty content for callers
 * below the gate. Providers don't block; they just withhold context.
 */
function gateProvider(provider: Provider, gate: RoleGate): void {
  if ((provider as { __roleGate?: RoleGate }).__roleGate === gate) {
    return;
  }

  const originalGet = provider.get;

  provider.get = async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    const check = await getCachedSenderRole(runtime, message);
    if (!check || !roleCheckPasses(check, gate)) {
      return { text: "" };
    }

    return originalGet.call(provider, runtime, message, state);
  };
  (provider as { __roleGate?: RoleGate }).__roleGate = gate;
}

/**
 * Apply role gating to all registered plugins. Call after runtime.initialize().
 *
 * Providers in PROVIDER_ROLE_OVERRIDES get gated. Actions are intentionally
 * not wrapped here; use action.roleGate.
 */
export function applyPluginRoleGating(plugins: Plugin[]): void {
  let totalProviders = 0;

  for (const plugin of plugins) {
    // Gate providers
    if (plugin.providers?.length) {
      for (const provider of plugin.providers) {
        const providerName = (provider as { name?: string }).name ?? "";
        const providerGate = PROVIDER_ROLE_OVERRIDES[providerName];
        if (providerGate) {
          gateProvider(provider, providerGate);
          totalProviders++;
        }
      }
    }
  }

  if (totalProviders > 0) {
    logger.info(`[role-gating] Total: ${totalProviders} provider(s) gated`);
  }
}

/** Exported for testing. */
export { ACTION_ROLE_OVERRIDES, PROVIDER_ROLE_OVERRIDES, ROLE_GATED_PLUGINS };
