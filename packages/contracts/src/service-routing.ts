/**
 * Service-routing type contracts.
 *
 * Describes which backend serves each capability (LLM text, TTS, media,
 * embeddings, RPC) and the linked-account records that own credentials.
 * Pure types only — normalizers and builders live in @elizaos/core.
 */

export type LinkedAccountStatus = 'linked' | 'unlinked';

export type LinkedAccountSource = 'api-key' | 'oauth' | 'credentials' | 'subscription';

/**
 * Legacy "is this provider linked" flag stored in `eliza.json` under
 * `linkedAccounts.{providerId}` (e.g. `linkedAccounts.elizacloud`).
 *
 * Predates the multi-account credential system. Kept for the
 * config-on-disk shape — actual per-account credential records live in
 * `~/.eliza/auth/{providerId}/{accountId}.json` and are surfaced via the
 * richer {@link LinkedAccountConfig} below.
 */
export type LinkedAccountFlagConfig = {
	status?: LinkedAccountStatus;
	source?: LinkedAccountSource;
	userId?: string;
	organizationId?: string;
};

export type LinkedAccountFlagsConfig = Record<string, LinkedAccountFlagConfig>;

/**
 * Restricted set of provider IDs that can own multi-account credential
 * records. Cloud-managed providers (`elizacloud`, etc.) use the legacy
 * {@link LinkedAccountFlagConfig} flag instead.
 */
export type LinkedAccountProviderId =
	| 'anthropic-subscription'
	| 'openai-codex'
	| 'gemini-cli'
	| 'zai-coding'
	| 'kimi-coding'
	| 'deepseek-coding'
	| 'anthropic-api'
	| 'openai-api'
	| 'deepseek-api'
	| 'zai-api'
	| 'moonshot-api';

export type LinkedAccountAccountSource = 'oauth' | 'api-key';

export type LinkedAccountHealth = 'ok' | 'rate-limited' | 'needs-reauth' | 'invalid' | 'unknown';

export interface LinkedAccountHealthDetail {
	/** epoch ms — when this state expires (e.g. rate-limit reset) */
	until?: number;
	lastError?: string;
	/** epoch ms */
	lastChecked?: number;
}

export interface LinkedAccountUsage {
	/** 0–100, current 5h window (Anthropic) or primary window (Codex) */
	sessionPct?: number;
	/** 0–100, 7-day (Anthropic only) */
	weeklyPct?: number;
	/** epoch ms */
	resetsAt?: number;
	/** epoch ms — when this snapshot was last refreshed */
	refreshedAt: number;
}

/**
 * First-class linked-account record. One per credential set —
 * surfaced by the accounts CRUD API and the AccountPool service.
 * The on-disk credential blob is intentionally not part of this type.
 */
export interface LinkedAccountConfig {
	id: string;
	providerId: LinkedAccountProviderId;
	label: string;
	source: LinkedAccountAccountSource;
	enabled: boolean;
	/** lower = higher priority */
	priority: number;
	/** epoch ms */
	createdAt: number;
	/** epoch ms */
	lastUsedAt?: number;
	health: LinkedAccountHealth;
	healthDetail?: LinkedAccountHealthDetail;
	usage?: LinkedAccountUsage;
	organizationId?: string;
	userId?: string;
	email?: string;
}

export type LinkedAccountsConfig = Record<string, LinkedAccountConfig>;

export type ServiceCapability = 'llmText' | 'tts' | 'media' | 'embeddings' | 'rpc';

export type ServiceTransport = 'direct' | 'cloud-proxy' | 'remote';

export type ServiceRouteAccountStrategy = 'priority' | 'round-robin' | 'least-used' | 'quota-aware';

export type ServiceRouteConfig = {
	backend?: string;
	transport?: ServiceTransport;
	/**
	 * Backcompat shorthand for `accountIds: [accountId]`. Prefer
	 * `accountIds` for new callers; the runtime treats both forms as
	 * equivalent when only one of them is set.
	 */
	accountId?: string;
	/** Pool of account IDs eligible to serve this capability. */
	accountIds?: string[];
	/** Default `"priority"` when `accountIds` has more than one entry. */
	strategy?: ServiceRouteAccountStrategy;
	primaryModel?: string;
	nanoModel?: string;
	smallModel?: string;
	mediumModel?: string;
	largeModel?: string;
	megaModel?: string;
	remoteApiBase?: string;

	/**
	 * Per-step model overrides for the fine-tuned pipeline.
	 * Each step can specify a model ID (e.g., a Vertex AI fine-tuned endpoint).
	 * Falls back to: stepModel -> plugin override -> smallModel/largeModel -> system default.
	 */
	responseHandlerModel?: string;
	shouldRespondModel?: string;
	actionPlannerModel?: string;
	plannerModel?: string;
	responseModel?: string;
	mediaDescriptionModel?: string;
};

export type ServiceRoutingConfig = Partial<Record<ServiceCapability, ServiceRouteConfig>>;
