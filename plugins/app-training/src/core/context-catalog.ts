/**
 * Canonical context catalog for all known elizaOS actions, providers, and plugins.
 *
 * This catalog maps every known action and provider to one or more AgentContext
 * categories. It is used by:
 * 1. The v5 messageHandler context-routing prompt
 * 2. The synthetic dataset generator (to scope scenarios per context)
 * 3. The planner (to filter actions/providers by active context)
 *
 * When adding a new plugin/action, add its entry here.
 */

import { AGENT_CONTEXTS, type AgentContext } from "./context-types.js";

const FINANCE_CRYPTO_WALLET_CONTEXTS: AgentContext[] = [
  "finance",
  "crypto",
  "wallet",
];

const FINANCE_CRYPTO_WALLET_AUTOMATION_CONTEXTS: AgentContext[] = [
  ...FINANCE_CRYPTO_WALLET_CONTEXTS,
  "automation",
];

export type ContextResolutionSource =
  | "component"
  | "plugin"
  | "catalog"
  | "default";

/** Mapping from action name to its contexts. */
export const ACTION_CONTEXT_MAP: Record<string, AgentContext[]> = {
  // --- General ---
  NONE: ["general"],
  IGNORE: ["general"],
  CONTINUE: ["general"],
  REPLY: ["general"],
  HELP: ["general"],
  STATUS: ["general"],
  MODELS: ["general"],
  CONFIGURE: ["general", "system"],
  SET_USER_NAME: ["social"],
  CONTACT: ["social"],
  ENTITY: ["social"],
  CALENDAR: ["automation", "social"],
  OWNER_ROUTINES: ["automation"],
  MODIFY_CHARACTER: ["social", "system"],
  PLAY_EMOTE: ["social"],
  SHELL: ["code", "system"],
  RESTART_AGENT: ["system"],
  OWNER_TODOS: ["automation"],
  OWNER_REMINDERS: ["automation"],
  OWNER_GOALS: ["automation"],
  GO_LIVE: ["media", "social"],
  GO_OFFLINE: ["media", "social"],
  USE_SKILL: ["code", "general"],
  WORKFLOW: ["automation"],

  // --- Wallet / DeFi ---
  SEND_TOKEN: [...FINANCE_CRYPTO_WALLET_CONTEXTS, "payments"],
  TRANSFER: [...FINANCE_CRYPTO_WALLET_CONTEXTS, "payments"],
  CHECK_BALANCE: FINANCE_CRYPTO_WALLET_CONTEXTS,
  GET_BALANCE: FINANCE_CRYPTO_WALLET_CONTEXTS,
  SWAP_TOKEN: FINANCE_CRYPTO_WALLET_AUTOMATION_CONTEXTS,
  BRIDGE_TOKEN: FINANCE_CRYPTO_WALLET_AUTOMATION_CONTEXTS,
  APPROVE_TOKEN: FINANCE_CRYPTO_WALLET_CONTEXTS,
  SIGN_MESSAGE: FINANCE_CRYPTO_WALLET_CONTEXTS,
  DEPLOY_CONTRACT: [...FINANCE_CRYPTO_WALLET_CONTEXTS, "code"],
  CREATE_GOVERNANCE_PROPOSAL: [...FINANCE_CRYPTO_WALLET_CONTEXTS, "social"],
  VOTE_ON_PROPOSAL: [...FINANCE_CRYPTO_WALLET_CONTEXTS, "social"],
  STAKE: FINANCE_CRYPTO_WALLET_AUTOMATION_CONTEXTS,
  UNSTAKE: FINANCE_CRYPTO_WALLET_AUTOMATION_CONTEXTS,
  CLAIM_REWARDS: FINANCE_CRYPTO_WALLET_CONTEXTS,
  GET_TOKEN_PRICE: [...FINANCE_CRYPTO_WALLET_CONTEXTS, "documents"],
  GET_PORTFOLIO: FINANCE_CRYPTO_WALLET_CONTEXTS,
  CREATE_WALLET: FINANCE_CRYPTO_WALLET_CONTEXTS,
  IMPORT_WALLET: FINANCE_CRYPTO_WALLET_CONTEXTS,

  // --- Documents / RAG ---
  DOCUMENT: ["documents"],
  REMEMBER: ["documents"],
  RECALL: ["documents"],
  LEARN_FROM_EXPERIENCE: ["documents"],
  SEARCH_WEB: ["documents", "browser"],
  SUMMARIZE: ["documents"],
  ANALYZE: ["documents"],
  SEARCH_ENTITY: ["social", "documents"],
  READ_ENTITY: ["social", "documents"],

  // --- Browser ---
  BROWSE: ["browser"],
  SCREENSHOT: ["browser", "media"],
  NAVIGATE: ["browser"],
  CLICK: ["browser"],
  TYPE_TEXT: ["browser"],

  // --- Code ---
  SPAWN_AGENT: ["code", "automation"],
  KILL_AGENT: ["code", "automation"],
  UPDATE_AGENT: ["code", "system"],
  RUN_SCRIPT: ["code", "automation"],
  REVIEW_CODE: ["code"],
  GENERATE_CODE: ["code"],
  EXECUTE_TASK: ["code", "automation"],
  CREATE_SUBTASK: ["code", "automation"],
  COMPLETE_TASK: ["code", "automation"],
  CANCEL_TASK: ["code", "automation"],

  // --- Media ---
  GENERATE_MEDIA: ["media"],
  DESCRIBE_IMAGE: ["media", "documents"],
  DESCRIBE_VIDEO: ["media", "documents"],
  DESCRIBE_AUDIO: ["media", "documents"],
  TEXT_TO_SPEECH: ["media"],
  TRANSCRIBE: ["media", "documents"],
  UPLOAD_FILE: ["media"],

  // --- Automation ---
  CREATE_CRON: ["automation"],
  UPDATE_CRON: ["automation"],
  DELETE_CRON: ["automation"],
  LIST_CRONS: ["automation"],
  PAUSE_CRON: ["automation"],
  TRIGGER_WEBHOOK: ["automation"],
  SCHEDULE: ["automation"],

  // --- Social ---
  MESSAGE: ["social", "documents", "automation"],
  ADD_CONTACT: ["social"],
  UPDATE_CONTACT: ["social"],
  GET_CONTACT: ["social"],
  SEARCH_CONTACTS: ["social"],
  ELEVATE_TRUST: ["social", "system"],
  REVOKE_TRUST: ["social", "system"],
  BLOCK_USER: ["social", "system"],
  UNBLOCK_USER: ["social", "system"],

  // --- System ---
  MANAGE_PLUGINS: ["system"],
  MANAGE_SECRETS: ["system"],
  SHELL_EXEC: ["system", "code"],
  RESTART: ["system"],
  CONFIGURE_RUNTIME: ["system"],
};

/** Mapping from provider name to its contexts. */
export const PROVIDER_CONTEXT_MAP: Record<string, AgentContext[]> = {
  // General providers
  time: ["general"],
  boredom: ["general"],
  facts: ["general", "documents"],
  knowledge: ["documents"],
  entities: ["social"],
  relationships: ["social"],
  recentMessages: ["general"],
  worldInfo: ["general"],
  roleInfo: ["general"],
  settings: ["system"],

  // Wallet providers
  walletBalance: FINANCE_CRYPTO_WALLET_CONTEXTS,
  walletPortfolio: FINANCE_CRYPTO_WALLET_CONTEXTS,
  tokenPrices: [...FINANCE_CRYPTO_WALLET_CONTEXTS, "documents"],
  chainInfo: FINANCE_CRYPTO_WALLET_CONTEXTS,

  // Social providers
  contacts: ["social"],
  trustScores: ["social"],
  platformIdentity: ["social"],

  // Automation providers
  cronJobs: ["automation"],
  taskList: ["automation", "code"],

  // System providers
  agentConfig: ["system"],
  pluginList: ["system"],
  elizaChannelProfile: ["general"],
  elizaSessionBridge: ["general", "system"],
  roleBackfill: ["social", "system"],
  "activity-profile": ["general", "social"],
  elizaAdminTrust: ["social", "system"],
  escalationTrigger: ["system", "social"],
  uiCatalog: ["system"],
  workspaceContext: ["code", "documents"],
  userName: ["social"],
  adminPanel: ["social", "system"],
  elizaDynamicSkills: ["code", "general"],
  lifeops: ["automation"],
  "recent-conversations": ["documents", "social"],
  "relevant-conversations": ["documents", "social"],
  rolodex: ["social", "documents"],
  userPersonalityPreferences: ["social"],
};

/** All canonical contexts. */
export const ALL_CONTEXTS: AgentContext[] = [...AGENT_CONTEXTS];

function sanitizeContexts(
  contexts?: AgentContext[],
): AgentContext[] | undefined {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    return undefined;
  }

  const normalized = contexts.filter(
    (context): context is AgentContext =>
      typeof context === "string" && context.trim().length > 0,
  );

  return normalized.length > 0 ? normalized : undefined;
}

function resolveActionCatalogEntry(
  actionName: string,
): AgentContext[] | undefined {
  return ACTION_CONTEXT_MAP[actionName.toUpperCase()];
}

function resolveProviderCatalogEntry(
  providerName: string,
): AgentContext[] | undefined {
  return (
    PROVIDER_CONTEXT_MAP[providerName] ??
    PROVIDER_CONTEXT_MAP[
      Object.keys(PROVIDER_CONTEXT_MAP).find(
        (key) => key.toLowerCase() === providerName.toLowerCase(),
      ) ?? ""
    ]
  );
}

export function resolveActionContextResolution(
  actionName: string,
  actionContexts?: AgentContext[],
  pluginContexts?: AgentContext[],
): {
  contexts: AgentContext[];
  source: ContextResolutionSource;
} {
  const componentContexts = sanitizeContexts(actionContexts);
  if (componentContexts) {
    return {
      contexts: [...componentContexts],
      source: "component",
    };
  }

  const inheritedPluginContexts = sanitizeContexts(pluginContexts);
  if (inheritedPluginContexts) {
    return {
      contexts: [...inheritedPluginContexts],
      source: "plugin",
    };
  }

  const catalogEntry = resolveActionCatalogEntry(actionName);
  if (catalogEntry) {
    return {
      contexts: [...catalogEntry],
      source: "catalog",
    };
  }

  return {
    contexts: ["general"],
    source: "default",
  };
}

export function resolveProviderContextResolution(
  providerName: string,
  providerContexts?: AgentContext[],
  pluginContexts?: AgentContext[],
): {
  contexts: AgentContext[];
  source: ContextResolutionSource;
} {
  const componentContexts = sanitizeContexts(providerContexts);
  if (componentContexts) {
    return {
      contexts: [...componentContexts],
      source: "component",
    };
  }

  const inheritedPluginContexts = sanitizeContexts(pluginContexts);
  if (inheritedPluginContexts) {
    return {
      contexts: [...inheritedPluginContexts],
      source: "plugin",
    };
  }

  const catalogEntry = resolveProviderCatalogEntry(providerName);
  if (catalogEntry) {
    return {
      contexts: [...catalogEntry],
      source: "catalog",
    };
  }

  return {
    contexts: ["general"],
    source: "default",
  };
}

/**
 * Resolve the effective contexts for an action.
 * Priority: action.contexts > plugin.contexts > catalog lookup > ["general"]
 */
export function resolveActionContexts(
  actionName: string,
  actionContexts?: AgentContext[],
  pluginContexts?: AgentContext[],
): AgentContext[] {
  return resolveActionContextResolution(
    actionName,
    actionContexts,
    pluginContexts,
  ).contexts;
}

/**
 * Resolve the effective contexts for a provider.
 */
export function resolveProviderContexts(
  providerName: string,
  providerContexts?: AgentContext[],
  pluginContexts?: AgentContext[],
): AgentContext[] {
  return resolveProviderContextResolution(
    providerName,
    providerContexts,
    pluginContexts,
  ).contexts;
}

/**
 * Given active contexts, return all actions that should be available.
 */
export function filterActionsByContexts(
  activeContexts: AgentContext[],
  allActions: Array<{ name: string; contexts?: AgentContext[] }>,
  pluginContexts?: Record<string, AgentContext[]>,
): Array<{ name: string; contexts?: AgentContext[] }> {
  const ctxSet = new Set(activeContexts);
  // "general" context always includes everything
  if (ctxSet.has("general") && activeContexts.length === 1) return allActions;

  return allActions.filter((action) => {
    const resolved = resolveActionContexts(
      action.name,
      action.contexts,
      pluginContexts?.[action.name],
    );
    return resolved.some((ctx) => ctxSet.has(ctx));
  });
}
