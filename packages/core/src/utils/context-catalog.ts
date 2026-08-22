/**
 * Context resolvers that pick a component's contexts: its own declared `contexts`
 * when present, otherwise a legacy fallback table, defaulting to "general".
 *
 * Actions are the source of truth for their own contexts and should declare
 * `contexts` on the action definition. LEGACY_ACTION_CONTEXT_FALLBACK is retained
 * only for plugin-owned / third-party action names that have not yet migrated (see its
 * doc comment). PROVIDER_CONTEXT_MAP still maps built-in provider names.
 */

import { FIRST_PARTY_CONTEXT_IDS } from "../runtime/context-normalization";
import type { Action, AgentContext, Provider } from "../types/components";

/**
 * LEGACY_ACTION_CONTEXT_FALLBACK is a legacy, host-owned fallback map from action
 * NAME to domain contexts, consulted ONLY when an action does not declare its own
 * `contexts` array (see {@link resolveActionContexts}).
 *
 * The contexts contract now lives on the owner action: every action should declare
 * `contexts` on its own definition, and `resolveActionContexts` always prefers a
 * declared array over this table (declared wins, proven by the guard test in
 * `context-catalog.test.ts`).
 *
 * This table is retained ONLY for plugin-owned / third-party action NAMES whose
 * definitions live outside this repo (wallet, cron, browser, media, connector, and
 * other loadable plugins) and have not yet migrated their contexts onto the action.
 * It is NOT the source of truth and must not be extended with in-repo core actions.
 *
 * Invariant (enforced by `context-catalog.test.ts`): no core-owned action that
 * declares its own `contexts` may appear as a key here. Core owners that previously
 * relied on this table (ATTACHMENT, DOCUMENT, GENERATE_MEDIA, MESSAGE, POST,
 * MANAGE_PLUGINS, PAYMENT) now declare `contexts` on the action itself and were
 * removed from here. Several had drifted: the ATTACHMENT, GENERATE_MEDIA, and
 * MESSAGE map entries were narrower than the owner declaration, so the static entry
 * was silently wrong for those actions.
 */
export const LEGACY_ACTION_CONTEXT_FALLBACK: Record<string, AgentContext[]> = {
	NONE: ["general"],
	IGNORE: ["general"],
	CONTINUE: ["general"],
	REPLY: ["general"],
	HELP: ["general"],
	STATUS: ["general"],
	MODELS: ["general"],
	CONFIGURE: ["general", "settings"],
	APP: ["connectors"],
	PLUGIN: ["connectors", "admin"],
	// PAGE_DELEGATE's contexts array is declared on the action itself; this
	// fallback entry covers any code paths that still resolve via this catalog.
	PAGE_DELEGATE: ["general"],
	WALLET: ["wallet"],
	PREDICTION_MARKET: ["wallet"],
	MODIFY_CHARACTER: ["settings", "admin"],
	UPDATE_OWNER_NAME: ["settings"],
	SET_USER_NAME: ["settings"],
	SEND_TOKEN: ["wallet"],
	TRANSFER: ["wallet"],
	TRANSFER_TOKEN: ["wallet"],
	CHECK_BALANCE: ["wallet"],
	GET_BALANCE: ["wallet"],
	GET_RECEIVE_ADDRESS: ["wallet"],
	PREPARE_SWAP: ["wallet"],
	PREPARE_TRANSFER: ["wallet"],
	EXECUTE_TRADE: ["wallet"],
	CROSS_CHAIN_TRANSFER: ["wallet"],
	SWAP_TOKEN: ["wallet", "automation"],
	SWAP: ["wallet", "automation"],
	SWAP_SOLANA: ["wallet", "automation"],
	BRIDGE_TOKEN: ["wallet"],
	APPROVE_TOKEN: ["wallet"],
	SIGN_MESSAGE: ["wallet"],
	SIGN_WITH_ELIZA_WALLET: ["wallet"],
	APPROVE_ELIZA_WALLET_REQUEST: ["wallet"],
	REJECT_ELIZA_WALLET_REQUEST: ["wallet"],
	DEPLOY_CONTRACT: ["wallet", "code"],
	CREATE_GOVERNANCE_PROPOSAL: ["wallet", "social_posting"],
	GOV_PROPOSE: ["wallet", "social_posting"],
	VOTE_ON_PROPOSAL: ["wallet", "social_posting"],
	GOV_VOTE: ["wallet", "social_posting"],
	GOV_QUEUE: ["wallet", "social_posting"],
	GOV_EXECUTE: ["wallet", "social_posting"],
	STAKE: ["wallet"],
	UNSTAKE: ["wallet"],
	CLAIM_REWARDS: ["wallet"],
	GET_TOKEN_PRICE: ["wallet", "documents"],
	GET_PORTFOLIO: ["wallet"],
	CREATE_WALLET: ["wallet"],
	IMPORT_WALLET: ["wallet"],
	// DOCUMENT, GENERATE_MEDIA, MESSAGE, POST, ATTACHMENT, PAYMENT, MANAGE_PLUGINS
	// were core-owned entries here; they now declare `contexts` on their own action
	// (#12090 item 35) and were removed from this fallback (drift-guarded by test).
	SEARCH: ["documents", "browser"],
	REMEMBER: ["documents"],
	RECALL: ["documents"],
	LEARN_FROM_EXPERIENCE: ["documents"],
	SEARCH_WEB: ["documents", "browser"],
	WEB_SEARCH: ["documents", "browser"],
	SUMMARIZE: ["documents"],
	ANALYZE: ["documents"],
	CREATE_TASK: ["automation"],
	START_CODING_TASK: ["code", "automation"],
	BROWSER: ["browser"],
	MANAGE_BROWSER_BRIDGE: ["browser", "files", "connectors", "settings"],
	BROWSE: ["browser"],
	SCREENSHOT: ["browser", "media"],
	NAVIGATE: ["browser"],
	CLICK: ["browser"],
	TYPE_TEXT: ["browser"],
	SPAWN_AGENT: ["code", "automation"],
	SEND_TO_AGENT: ["code", "automation"],
	LIST_AGENTS: ["code", "automation"],
	STOP_AGENT: ["code", "automation"],
	TASK_HISTORY: ["code", "automation"],
	TASK_CONTROL: ["code", "automation"],
	TASK_SHARE: ["code", "automation"],
	PROVISION_WORKSPACE: ["code", "automation"],
	FINALIZE_WORKSPACE: ["code", "automation"],
	KILL_AGENT: ["code", "automation"],
	UPDATE_AGENT: ["code", "admin"],
	RUN_SCRIPT: ["code", "automation"],
	REVIEW_CODE: ["code"],
	GENERATE_CODE: ["code"],
	EXECUTE_TASK: ["code", "automation"],
	CREATE_SUBTASK: ["code", "automation"],
	COMPLETE_TASK: ["code", "automation"],
	CANCEL_TASK: ["code", "automation"],
	DESCRIBE_IMAGE: ["media", "documents"],
	DESCRIBE_VIDEO: ["media", "documents"],
	DESCRIBE_AUDIO: ["media", "documents"],
	TEXT_TO_SPEECH: ["media"],
	TRANSCRIBE: ["media", "documents"],
	UPLOAD_FILE: ["media"],
	CREATE_CRON: ["automation"],
	UPDATE_CRON: ["automation"],
	DELETE_CRON: ["automation"],
	LIST_CRONS: ["automation"],
	PAUSE_CRON: ["automation"],
	RUN_CRON: ["automation"],
	WORKFLOW: ["automation"],
	TASK: ["tasks", "automation"],
	TRIGGER: ["automation", "tasks"],
	TRIGGER_WEBHOOK: ["automation"],
	CONTACT: ["contacts", "messaging", "documents"],
	ENTITY: ["contacts", "messaging", "documents"],
	CALENDAR: ["calendar", "automation"],
	ADD_CONTACT: ["contacts"],
	UPDATE_CONTACT: ["contacts"],
	GET_CONTACT: ["contacts"],
	SEARCH_CONTACTS: ["contacts"],
	SUMMARIZE_CONVERSATION: ["messaging", "documents"],
	CHAT_WITH_ATTACHMENTS: ["messaging", "documents", "media"],
	DOWNLOAD_MEDIA: ["messaging", "media"],
	TRANSCRIBE_MEDIA: ["messaging", "documents", "media"],
	SERVER_INFO: ["messaging"],
	VOICE_CALL: ["messaging", "phone", "connectors"],
	OWNER_TODOS: ["tasks"],
	OWNER_REMINDERS: ["tasks", "automation"],
	OWNER_ALARMS: ["tasks", "automation"],
	OWNER_GOALS: ["tasks"],
	OWNER_ROUTINES: ["tasks", "health", "automation"],
	OWNER_HEALTH: ["health"],
	OWNER_SCREENTIME: ["screen_time"],
	OWNER_FINANCES: ["finance", "subscriptions", "payments"],
	SCHEDULED_TASKS: ["tasks", "automation"],
	COMPUTER_USE: ["browser", "files", "terminal", "automation", "admin"],
	PERSONAL_ASSISTANT: ["calendar", "payments", "web"],
	BLOCK: ["automation", "settings"],
	RESOLVE_REQUEST: ["tasks", "automation", "admin", "general"],
	CREDENTIALS: ["browser", "settings", "secrets"],
	CHAT_THREAD: ["messaging"],
	X: ["social_posting", "messaging"],
	CONNECTOR: ["connectors"],
	ELEVATE_TRUST: ["contacts", "admin"],
	REVOKE_TRUST: ["contacts", "admin"],
	BLOCK_USER: ["messaging", "admin"],
	UNBLOCK_USER: ["messaging", "admin"],
	MANAGE_SECRETS: ["secrets", "admin"],
	SHELL_EXEC: ["terminal", "code", "admin"],
	RESTART: ["admin"],
	CONFIGURE_RUNTIME: ["settings", "admin"],
	UPDATE_IDENTITY: ["settings"],
	UPDATE_AI_PROVIDER: ["settings"],
	TOGGLE_CAPABILITY: ["settings"],
	TOGGLE_AUTO_TRAINING: ["settings"],
	TOGGLE_CONNECTOR: ["connectors"],
	SAVE_CONNECTOR_CONFIG: ["connectors"],
	DISCONNECT_CONNECTOR: ["connectors"],
	LIST_CONNECTORS: ["connectors"],
	SEARCH_ACTIONS: ["documents", "connectors"],
	FINISH: ["general"],
};

export const PROVIDER_CONTEXT_MAP: Record<string, AgentContext[]> = {
	ACTION_STATE: [...FIRST_PARTY_CONTEXT_IDS],
	time: ["general"],
	boredom: ["general"],
	facts: ["general", "documents"],
	documents: ["documents"],
	entities: ["contacts"],
	relationships: ["contacts"],
	recentMessages: ["general"],
	worldInfo: ["general"],
	roleInfo: ["general"],
	settings: ["settings"],
	"page-scoped-context": [
		"browser",
		"wallet",
		"automation",
		"connectors",
		"settings",
		"tasks",
		"messaging",
	],
	available_apps: ["connectors"],
	app_browser_workspace: ["browser"],
	walletBalance: ["wallet"],
	walletPortfolio: ["wallet"],
	tokenPrices: ["wallet", "documents"],
	chainInfo: ["wallet"],
	wallet: ["wallet"],
	"get-balance": ["wallet"],
	"solana-wallet": ["wallet"],
	CODING_AGENT_EXAMPLES: ["code", "automation"],
	ACTIVE_WORKSPACE_CONTEXT: ["code", "automation"],
	// Orchestrator inventory (plugin-agent-orchestrator): the coding-backend /
	// sub-agent listings belong on code/automation planner turns, matching
	// ACTIVE_WORKSPACE_CONTEXT — not on ordinary "general" chat turns (#13203).
	AVAILABLE_AGENTS: ["code", "automation"],
	ACTIVE_SUB_AGENTS: ["code", "automation"],
	contacts: ["contacts"],
	trustScores: ["contacts"],
	platformIdentity: ["messaging"],
	cronJobs: ["automation"],
	taskList: ["automation", "code"],
	agentConfig: ["settings", "admin"],
	pluginList: ["connectors", "admin"],
	pluginConfigurationStatus: ["connectors", "admin"],
	pluginState: ["connectors", "admin"],
	registryPlugins: ["connectors", "admin"],
	webSearch: ["documents", "browser"],
	imessageContacts: ["contacts", "messaging", "connectors"],
	imessageChatContext: ["messaging", "connectors"],
	slackChannelState: ["messaging", "connectors"],
	twitchChannelState: ["messaging", "connectors"],
	signalConversationState: ["messaging", "connectors"],
	lineChatContext: ["messaging", "connectors"],
	googleChatUserContext: ["messaging", "connectors"],
	googleChatSpaceState: ["messaging", "connectors"],
	PLATFORM_CHAT_CONTEXT: ["messaging", "connectors"],
	PLATFORM_USER_CONTEXT: ["messaging", "connectors"],
	crossChannelContext: ["messaging", "connectors"],
};

function normalizeContexts(
	contexts: AgentContext[] | undefined,
): AgentContext[] {
	return Array.isArray(contexts)
		? contexts.filter((context): context is AgentContext => Boolean(context))
		: [];
}

export function resolveActionContexts(action: Action): AgentContext[] {
	const declared = normalizeContexts(action.contexts);
	if (declared.length > 0) {
		return declared;
	}

	return (
		LEGACY_ACTION_CONTEXT_FALLBACK[action.name.toUpperCase()] ?? ["general"]
	);
}

/**
 * Catalog lookup for a provider name (exact, lower, upper), or `undefined` when
 * the provider is uncataloged. Split out so registration can distinguish a
 * deliberate catalog entry of `["general"]` from the uncataloged default and
 * warn only on the latter (#13203).
 */
export function lookupProviderCatalogContexts(
	name: string,
): AgentContext[] | undefined {
	return (
		PROVIDER_CONTEXT_MAP[name] ??
		PROVIDER_CONTEXT_MAP[name.toLowerCase()] ??
		PROVIDER_CONTEXT_MAP[name.toUpperCase()]
	);
}

export function resolveProviderContexts(
	provider: Pick<Provider, "name" | "contexts">,
): AgentContext[] {
	const declared = normalizeContexts(provider.contexts);
	if (declared.length > 0) {
		return declared;
	}

	return lookupProviderCatalogContexts(provider.name) ?? ["general"];
}
