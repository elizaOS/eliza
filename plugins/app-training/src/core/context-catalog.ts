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
  PROFILE: ["social"],
  TRIAGE_MESSAGES: ["social", "knowledge"],
  LIST_INBOX: ["social", "knowledge"],
  SEARCH_MESSAGES: ["social", "knowledge"],
  DRAFT_REPLY: ["social"],
  DRAFT_FOLLOWUP: ["social"],
  SEND_DRAFT: ["social"],
  RESPOND_TO_MESSAGE: ["social"],
  MANAGE_MESSAGE: ["social"],
  SCHEDULE_DRAFT_SEND: ["social", "automation"],
  CALENDAR: ["automation", "social"],
  RELATIONSHIP: ["social"],
  CHECKIN: ["automation"],
  MODIFY_CHARACTER: ["social", "system"],
  PLAY_EMOTE: ["social"],
  SHELL_COMMAND: ["code", "system"],
  RESTART_AGENT: ["system"],
  SEND_ADMIN_MESSAGE: ["social", "system"],
  LIFE: ["automation"],
  GO_LIVE: ["media", "social"],
  GO_OFFLINE: ["media", "social"],
  SKILL_COMMAND: ["code", "general"],
  CREATE_TRIGGER_TASK: ["automation"],

  // --- Wallet / DeFi ---
  SEND_TOKEN: ["wallet"],
  TRANSFER: ["wallet"],
  CHECK_BALANCE: ["wallet"],
  GET_BALANCE: ["wallet"],
  SWAP_TOKEN: ["wallet", "automation"],
  BRIDGE_TOKEN: ["wallet"],
  APPROVE_TOKEN: ["wallet"],
  SIGN_MESSAGE: ["wallet"],
  DEPLOY_CONTRACT: ["wallet", "code"],
  CREATE_GOVERNANCE_PROPOSAL: ["wallet", "social"],
  VOTE_ON_PROPOSAL: ["wallet", "social"],
  STAKE: ["wallet"],
  UNSTAKE: ["wallet"],
  CLAIM_REWARDS: ["wallet"],
  GET_TOKEN_PRICE: ["wallet", "knowledge"],
  GET_PORTFOLIO: ["wallet"],
  CREATE_WALLET: ["wallet"],
  IMPORT_WALLET: ["wallet"],

  // --- Knowledge / RAG ---
  SEARCH_KNOWLEDGE: ["knowledge"],
  ADD_KNOWLEDGE: ["knowledge"],
  REMEMBER: ["knowledge"],
  RECALL: ["knowledge"],
  LEARN_FROM_EXPERIENCE: ["knowledge"],
  SEARCH_WEB: ["knowledge", "browser"],
  SUMMARIZE: ["knowledge"],
  ANALYZE: ["knowledge"],
  READ_CHANNEL: ["knowledge", "social"],
  SEARCH_CONVERSATIONS: ["knowledge", "social"],
  SEARCH_ENTITY: ["social", "knowledge"],
  READ_ENTITY: ["social", "knowledge"],

  // --- Browser ---
  BROWSE: ["browser"],
  SCREENSHOT: ["browser", "media"],
  NAVIGATE: ["browser"],
  CLICK: ["browser"],
  TYPE_TEXT: ["browser"],
  EXTRACT_PAGE: ["browser", "knowledge"],

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
  GENERATE_IMAGE: ["media"],
  DESCRIBE_IMAGE: ["media", "knowledge"],
  DESCRIBE_VIDEO: ["media", "knowledge"],
  DESCRIBE_AUDIO: ["media", "knowledge"],
  TEXT_TO_SPEECH: ["media"],
  TRANSCRIBE: ["media", "knowledge"],
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
  SEND_MESSAGE: ["social"],
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
  facts: ["general", "knowledge"],
  knowledge: ["knowledge"],
  entities: ["social"],
  relationships: ["social"],
  recentMessages: ["general"],
  worldInfo: ["general"],
  roleInfo: ["general"],
  settings: ["system"],

  // Wallet providers
  walletBalance: ["wallet"],
  walletPortfolio: ["wallet"],
  tokenPrices: ["wallet", "knowledge"],
  chainInfo: ["wallet"],

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
  workspaceContext: ["code", "knowledge"],
  userName: ["social"],
  adminPanel: ["social", "system"],
  elizaDynamicSkills: ["code", "general"],
  lifeops: ["automation"],
  "recent-conversations": ["knowledge", "social"],
  "relevant-conversations": ["knowledge", "social"],
  rolodex: ["social", "knowledge"],
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
