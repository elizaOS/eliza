/**
 * Service-routing type contracts.
 *
 * Describes which backend serves each capability (LLM text, TTS, media,
 * embeddings, RPC) and the linked-account records that own credentials.
 * Pure types only — normalizers and builders live in @elizaos/core.
 */

export const LINKED_ACCOUNT_STATUSES = ['linked', 'unlinked'] as const;

export type LinkedAccountStatus = (typeof LINKED_ACCOUNT_STATUSES)[number];

export const LINKED_ACCOUNT_SOURCES = ['api-key', 'oauth', 'credentials', 'subscription'] as const;

export type LinkedAccountSource = (typeof LINKED_ACCOUNT_SOURCES)[number];

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
export const LINKED_ACCOUNT_PROVIDER_IDS = [
	'anthropic-subscription',
	'openai-codex',
	'gemini-cli',
	'zai-coding',
	'kimi-coding',
	'deepseek-coding',
	'anthropic-api',
	'openai-api',
	'deepseek-api',
	'zai-api',
	'moonshot-api',
	'cerebras-api',
] as const;

export type LinkedAccountProviderId = (typeof LINKED_ACCOUNT_PROVIDER_IDS)[number];

export const LINKED_ACCOUNT_ACCOUNT_SOURCES = ['oauth', 'api-key'] as const;

export type LinkedAccountAccountSource = (typeof LINKED_ACCOUNT_ACCOUNT_SOURCES)[number];

export const LINKED_ACCOUNT_HEALTH_STATES = [
	'ok',
	'rate-limited',
	'needs-reauth',
	'invalid',
	'unknown',
	'expired',
] as const;

export type LinkedAccountHealth = (typeof LINKED_ACCOUNT_HEALTH_STATES)[number];

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
	/** 0–100, seven-day or provider secondary window */
	weeklyPct?: number;
	/**
	 * Per-model 7-day utilization buckets from provider usage APIs. Keys are
	 * provider display/model names normalized only enough for case-insensitive
	 * lookup by the selector; values preserve the provider's reset timestamp.
	 */
	weeklyModelBuckets?: Record<string, { pct: number; resetsAt?: number }>;
	/**
	 * epoch ms. Anthropic: all-model seven-day reset used for drain ordering.
	 * Codex: primary five-hour reset. This is never a generic reset clock.
	 */
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
	/** Whether `priority` was hand-set by the operator or generated from creation order. */
	prioritySource?: 'explicit' | 'generated';
	/** epoch ms */
	createdAt: number;
	/** epoch ms */
	lastUsedAt?: number;
	/** epoch ms: last subscription usage priming probe attempt */
	lastPrimedAt?: number;
	health: LinkedAccountHealth;
	healthDetail?: LinkedAccountHealthDetail;
	usage?: LinkedAccountUsage;
	/** epoch ms — account subscription cutoff; expired when <= now */
	subscriptionEndsAt?: number;
	organizationId?: string;
	userId?: string;
	email?: string;
}

export type LinkedAccountsConfig = Record<string, LinkedAccountConfig>;

/** Services whose transport and backend can be selected independently. */
export const SERVICE_CAPABILITIES = ['llmText', 'tts', 'media', 'embeddings', 'rpc'] as const;

export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];

export const SERVICE_TRANSPORTS = ['direct', 'cloud-proxy', 'remote'] as const;

export type ServiceTransport = (typeof SERVICE_TRANSPORTS)[number];

export const SERVICE_ROUTE_ACCOUNT_STRATEGIES = [
	'priority',
	'round-robin',
	'least-used',
	'quota-aware',
	// Reset-timestamp-aware: prefer the account whose weekly budget refunds
	// SOONEST, because spending a budget that's about to reset costs the least
	// (accounts that just reset are held in reserve). Falls back to
	// least-recently-used when reset instants are unknown.
	'reset-soonest',
	// Weekly-drain strategy: explicit hand-set priorities win first, otherwise
	// spend the account/model bucket whose weekly reset arrives soonest, then
	// lower utilization, with subscription end as the final-days booster.
	'drain-soonest-reset',
] as const;

export type ServiceRouteAccountStrategy = (typeof SERVICE_ROUTE_ACCOUNT_STRATEGIES)[number];

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
