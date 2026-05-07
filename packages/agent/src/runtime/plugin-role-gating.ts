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

  // Clipboard
  clipboard: "admin",

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
    const { checkSenderRole } = await import("./roles.js");

    const check = await checkSenderRole(runtime, message);
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
