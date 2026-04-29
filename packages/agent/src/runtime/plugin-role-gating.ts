/**
 * Plugin role gating — restricts plugin actions and providers to specific roles.
 *
 * After plugins are registered, this module wraps the `validate` function
 * of every action belonging to gated plugins so only users with the
 * required role (e.g. ADMIN/OWNER) can invoke them. Providers that expose
 * sensitive context are similarly gated so their `get()` returns empty
 * content for callers below the required role.
 *
 * Two maps control the gating:
 *
 * 1. `ROLE_GATED_PLUGINS` — sets a **floor** for every action in a plugin.
 * 2. `ACTION_ROLE_OVERRIDES` — raises individual actions **above** that floor.
 *
 * The effective gate for an action is `max(plugin floor, action override)`.
 *
 * @module plugin-role-gating
 */
import type {
  Action,
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

type RoleGate = "user" | "admin" | "owner";

const ROLE_GATE_RANK: Record<RoleGate, number> = {
  user: 1,
  admin: 2,
  owner: 3,
};

// ---------------------------------------------------------------------------
// Plugin-level defaults — every action in the plugin gets at least this role.
// ---------------------------------------------------------------------------

const ROLE_GATED_PLUGINS: Readonly<Record<string, RoleGate>> = {
  // Blockchain — financial actions
  "@elizaos/app-browser": "owner",
  "@elizaos/app-steward": "owner",
  "@elizaos/plugin-browser-bridge": "owner",
  "@elizaos/plugin-computeruse": "owner",
  "@elizaos/plugin-evm": "owner",
  "@elizaos/plugin-solana": "owner",
  evm: "owner",
  solana: "owner",

  // Orchestration — spawns agents, PTY sessions, workspaces
  "agent-orchestrator": "admin",

  // Plugin installs / registry — matches built-in pluginManagerCapability `name`.
  // The secrets capability is also built-in to core; gating happens via the
  // owner-only PLUGIN action validators rather than a plugin-name map entry
  // (no dedicated `secrets` plugin name to gate against).
  "plugin-manager": "owner",

  // Trust — policy / trust signals (matches plugin `name` from plugin-trust)
  trust: "admin",

  // Shell — arbitrary command execution
  shell: "owner",

  // Cron — scheduled job management
  cron: "admin",

  // Cloud — provisioning, billing, agent lifecycle
  elizaOSCloud: "admin",

  // Clipboard — floor is "user" for reads; writes elevated below
  clipboard: "user",

  // Experience — records agent learnings
  experience: "admin",

  // Form — form state management
  form: "admin",

  // Discord — the plugin floor is "user"; destructive actions elevated below
  discord: "user",

  // Music player — playback is user, management is elevated below
  "music-player": "user",
};

// ---------------------------------------------------------------------------
// Per-action overrides — raise individual actions above the plugin floor.
// Keys are exact action `name` strings from the plugin source.
// ---------------------------------------------------------------------------

const ACTION_ROLE_OVERRIDES: Readonly<Record<string, RoleGate>> = {
  // --- agent-orchestrator: escalate dangerous actions to owner ---
  SPAWN_AGENT: "owner",
  SEND_TO_AGENT: "owner",
  STOP_AGENT: "owner",
  TASK_CONTROL: "owner",
  PROVISION_WORKSPACE: "owner",
  MANAGE_ISSUES: "owner",
  CREATE_TASK: "owner",

  // --- orchestrator coding-agent actions ---
  SPAWN_CODING_AGENT: "owner",
  SEND_TO_CODING_AGENT: "owner",
  STOP_CODING_AGENT: "owner",
  START_CODING_TASK: "owner",
  // PROVISION_WORKSPACE / MANAGE_ISSUES already covered above

  // --- plugin-cron: create/delete/update are owner, list/run are admin ---
  CREATE_CRON: "owner",
  DELETE_CRON: "owner",
  UPDATE_CRON: "owner",

  // --- plugin-elizacloud: provisioning/billing are owner ---
  PROVISION_CLOUD_AGENT: "owner",
  FREEZE_CLOUD_AGENT: "owner",
  RESUME_CLOUD_AGENT: "owner",

  // --- plugin-discord: destructive/moderative actions ---
  DELETE_MESSAGE: "admin",
  EDIT_MESSAGE: "admin",
  PIN_MESSAGE: "admin",
  UNPIN_MESSAGE: "admin",
  SETUP_CREDENTIALS: "owner",
  CREATE_POLL: "admin",
  AGENT_SEND_MESSAGE: "admin",
  SEND_MESSAGE: "admin",
  SEND_DM: "admin",
  JOIN_CHANNEL: "admin",
  LEAVE_CHANNEL: "admin",
  LIST_CHANNELS: "admin",
  READ_CHANNEL: "admin",
  SEARCH_MESSAGES: "admin",
  GET_USER_INFO: "admin",
  SERVER_INFO: "admin",
  DOWNLOAD_MEDIA: "admin",
  TRANSCRIBE_MEDIA: "admin",
  CHAT_WITH_ATTACHMENTS: "admin",
  SUMMARIZE_CONVERSATION: "admin",

  // --- plugin-music-player: management actions ---
  MANAGE_ROUTING: "admin",
  MANAGE_ZONES: "admin",

  // --- clipboard: global writes are admin, reads are user (floor) ---
  CLIPBOARD_WRITE: "admin",
  CLIPBOARD_APPEND: "admin",
  CLIPBOARD_DELETE: "admin",
  READ_FILE: "admin",
};

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

function resolveGateLevel(
  pluginGate: RoleGate | undefined,
  overrideGate: RoleGate | undefined,
): RoleGate | null {
  if (!pluginGate && !overrideGate) return null;
  if (!pluginGate) return overrideGate ?? null;
  if (!overrideGate) return pluginGate;
  return ROLE_GATE_RANK[overrideGate] > ROLE_GATE_RANK[pluginGate]
    ? overrideGate
    : pluginGate;
}

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
 * Wrap an action's validate function so it rejects callers below the gate.
 */
function gateAction(action: Action, gate: RoleGate): void {
  if ((action as { __roleGate?: RoleGate }).__roleGate === gate) {
    return;
  }

  const originalValidate = action.validate;

  action.validate = async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    const { checkSenderRole } = await import("./roles.js");

    const check = await checkSenderRole(runtime, message);
    if (!check) {
      logger.debug(
        `[role-gating] ${action.name} blocked for entity ${message.entityId} ` +
          `(role: unknown, requires: ${gate})`,
      );
      return false;
    }

    if (!roleCheckPasses(check, gate)) {
      logger.debug(
        `[role-gating] ${action.name} blocked for entity ${message.entityId} ` +
          `(role: ${check.role}, requires: ${gate})`,
      );
      return false;
    }

    return originalValidate ? originalValidate(runtime, message, state) : true;
  };
  (action as { __roleGate?: RoleGate }).__roleGate = gate;
}

/**
 * Wrap a provider's get function so it returns empty content for callers
 * below the gate. Providers don't block — they just withhold context.
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

function resolvePluginGate(pluginName: string): RoleGate | undefined {
  return (
    ROLE_GATED_PLUGINS[pluginName] ??
    ROLE_GATED_PLUGINS[pluginName.replace(/^@elizaos\/plugin-/, "")] ??
    ROLE_GATED_PLUGINS[pluginName.replace(/^@elizaos\/app-/, "")]
  );
}

/**
 * Apply role gating to all registered plugins. Call after runtime.initialize().
 *
 * For each plugin:
 * 1. Actions get gated to `max(plugin floor, action override)`.
 * 2. Providers in PROVIDER_ROLE_OVERRIDES get gated.
 */
export function applyPluginRoleGating(plugins: Plugin[]): void {
  let totalActions = 0;
  let totalProviders = 0;

  for (const plugin of plugins) {
    const pluginName = plugin.name ?? "";
    const pluginGate = resolvePluginGate(pluginName);

    // Gate actions
    if (plugin.actions?.length) {
      for (const action of plugin.actions) {
        const actionOverride = ACTION_ROLE_OVERRIDES[action.name];
        const effectiveGate = resolveGateLevel(pluginGate, actionOverride);
        if (effectiveGate) {
          gateAction(action, effectiveGate);
          totalActions++;
        }
      }
    }

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

    if (pluginGate) {
      const actionCount = plugin.actions?.length ?? 0;
      const providerCount = plugin.providers?.length ?? 0;
      logger.info(
        `[role-gating] ${pluginName}: ${actionCount} action(s) floor=${pluginGate}, ` +
          `${providerCount} provider(s) checked`,
      );
    }
  }

  if (totalActions > 0 || totalProviders > 0) {
    logger.info(
      `[role-gating] Total: ${totalActions} action(s), ${totalProviders} provider(s) gated`,
    );
  }
}

/** Exported for testing. */
export { ACTION_ROLE_OVERRIDES, PROVIDER_ROLE_OVERRIDES, ROLE_GATED_PLUGINS };
