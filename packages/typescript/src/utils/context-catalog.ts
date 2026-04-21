import type { Action, AgentContext, Provider } from "../types/components";

export const ACTION_CONTEXT_MAP: Record<string, AgentContext[]> = {
	NONE: ["general"],
	IGNORE: ["general"],
	CONTINUE: ["general"],
	REPLY: ["general"],
	HELP: ["general"],
	STATUS: ["general"],
	MODELS: ["general"],
	CONFIGURE: ["general", "system"],
	LAUNCH_APP: ["apps"],
	STOP_APP: ["apps"],
	LIST_RUNNING_APPS: ["apps"],
	MODIFY_CHARACTER: ["character", "system"],
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
	SEARCH_KNOWLEDGE: ["knowledge"],
	ADD_KNOWLEDGE: ["knowledge"],
	REMEMBER: ["knowledge"],
	RECALL: ["knowledge"],
	LEARN_FROM_EXPERIENCE: ["knowledge"],
	SEARCH_WEB: ["knowledge", "browser"],
	WEB_SEARCH: ["knowledge", "browser"],
	SUMMARIZE: ["knowledge"],
	ANALYZE: ["knowledge"],
	BROWSER_SESSION: ["browser"],
	BROWSE: ["browser"],
	SCREENSHOT: ["browser", "media"],
	NAVIGATE: ["browser"],
	CLICK: ["browser"],
	TYPE_TEXT: ["browser"],
	EXTRACT_PAGE: ["browser", "knowledge"],
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
	GENERATE_IMAGE: ["media"],
	DESCRIBE_IMAGE: ["media", "knowledge"],
	DESCRIBE_VIDEO: ["media", "knowledge"],
	DESCRIBE_AUDIO: ["media", "knowledge"],
	TEXT_TO_SPEECH: ["media"],
	TRANSCRIBE: ["media", "knowledge"],
	UPLOAD_FILE: ["media"],
	CREATE_CRON: ["automation"],
	UPDATE_CRON: ["automation"],
	DELETE_CRON: ["automation"],
	LIST_CRONS: ["automation"],
	PAUSE_CRON: ["automation"],
	RUN_CRON: ["automation"],
	CREATE_N8N_WORKFLOW: ["automation"],
	ACTIVATE_N8N_WORKFLOW: ["automation"],
	DEACTIVATE_N8N_WORKFLOW: ["automation"],
	DELETE_N8N_WORKFLOW: ["automation"],
	GET_N8N_EXECUTIONS: ["automation"],
	TRIGGER_WEBHOOK: ["automation"],
	SCHEDULE: ["automation"],
	SEND_MESSAGE: ["social"],
	OWNER_SEND_MESSAGE: ["social"],
	OWNER_INBOX: ["social", "knowledge"],
	OWNER_RELATIONSHIP: ["social"],
	OWNER_CALENDAR: ["automation", "social"],
	RUN_MORNING_CHECKIN: ["automation"],
	RUN_NIGHT_CHECKIN: ["automation"],
	UPDATE_OWNER_PROFILE: ["social"],
	ADD_CONTACT: ["social"],
	UPDATE_CONTACT: ["social"],
	GET_CONTACT: ["social"],
	SEARCH_CONTACTS: ["social"],
	ELEVATE_TRUST: ["social", "system"],
	REVOKE_TRUST: ["social", "system"],
	BLOCK_USER: ["social", "system"],
	UNBLOCK_USER: ["social", "system"],
	MANAGE_PLUGINS: ["system"],
	MANAGE_SECRETS: ["system"],
	SHELL_EXEC: ["system", "code"],
	RESTART: ["system"],
	CONFIGURE_RUNTIME: ["system"],
	OAUTH_CONNECT: ["system", "social"],
	SEARCH_ACTIONS: ["system", "knowledge"],
	FINISH: ["general"],
};

export const PROVIDER_CONTEXT_MAP: Record<string, AgentContext[]> = {
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
	walletBalance: ["wallet"],
	walletPortfolio: ["wallet"],
	tokenPrices: ["wallet", "knowledge"],
	chainInfo: ["wallet"],
	contacts: ["social"],
	trustScores: ["social"],
	platformIdentity: ["social"],
	cronJobs: ["automation"],
	taskList: ["automation", "code"],
	agentConfig: ["system"],
	pluginList: ["system"],
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

	return ACTION_CONTEXT_MAP[action.name.toUpperCase()] ?? ["general"];
}

export function resolveProviderContexts(provider: Provider): AgentContext[] {
	const declared = normalizeContexts(provider.contexts);
	if (declared.length > 0) {
		return declared;
	}

	return PROVIDER_CONTEXT_MAP[provider.name] ?? ["general"];
}
