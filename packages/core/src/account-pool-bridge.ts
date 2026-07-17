/**
 * `globalThis` `Symbol.for` account-selection bridges — the single source of
 * truth for their symbols and contracts.
 *
 * The account pool and credential store live in `@elizaos/app-core`; the
 * plugins that must select a credentialed account
 * (`@elizaos/plugin-anthropic`, `@elizaos/plugin-agent-orchestrator`,
 * `@elizaos/plugin-cli-inference`) depend only on `@elizaos/core` and cannot
 * import app-core. `runtime.getService(...)` is not viable either — these
 * consumers run at spawn/token-resolve time without a runtime handle. So
 * app-core publishes a narrow contract on a `globalThis` symbol and the
 * plugins read it back.
 *
 * This module defines each bridge's symbol, contract interface, and typed
 * get/set accessors ONCE. The producer (app-core) and every plugin consumer
 * import from here so there is exactly one symbol string and one interface per
 * bridge. Provider ids cross the `globalThis` boundary as plain strings (they
 * round-trip through session metadata as strings), so the contracts type them
 * as `string`; the producer validates/narrows to its provider union on entry.
 */

type GlobalBridgeSlot = Record<symbol, unknown>;

function bridgeSlot(): GlobalBridgeSlot | null {
	return typeof globalThis === "undefined"
		? null
		: (globalThis as GlobalBridgeSlot);
}

/* ------------------------- Anthropic subscription ------------------------- */

export const ANTHROPIC_ACCOUNT_POOL_BRIDGE_SYMBOL: unique symbol = Symbol.for(
	"eliza.account-pool.anthropic.v1",
);

/**
 * Contract consumed by `plugin-anthropic`'s credential store. Kept narrow so
 * the plugin never imports the full `AccountPool` surface.
 */
export interface AnthropicAccountPoolBridge {
	/** Pick an Anthropic subscription account; null when none are eligible. */
	selectAnthropicSubscription(opts?: {
		sessionKey?: string;
		exclude?: string[];
	}): Promise<{ id: string; expiresAt: number } | null>;
	/** Resolve an access token for a previously-selected account. */
	getAccessToken(
		providerId: "anthropic-subscription",
		accountId: string,
	): Promise<string | null>;
	/** Mark health = invalid (e.g. persistent 401 after refresh). */
	markInvalid(accountId: string, detail?: string): Promise<void>;
	/** Mark health = rate-limited until `untilMs`. */
	markRateLimited(
		accountId: string,
		untilMs: number,
		detail?: string,
	): Promise<void>;
}

export function getAnthropicAccountPoolBridge(): AnthropicAccountPoolBridge | null {
	const slot = bridgeSlot();
	if (!slot) return null;
	return (
		(slot[ANTHROPIC_ACCOUNT_POOL_BRIDGE_SYMBOL] as
			| AnthropicAccountPoolBridge
			| undefined) ?? null
	);
}

/** Install (or, with `null`, clear) the Anthropic bridge. Idempotent. */
export function setAnthropicAccountPoolBridge(
	bridge: AnthropicAccountPoolBridge | null,
): void {
	const slot = bridgeSlot();
	if (!slot) return;
	if (bridge) {
		slot[ANTHROPIC_ACCOUNT_POOL_BRIDGE_SYMBOL] = bridge;
	} else {
		delete slot[ANTHROPIC_ACCOUNT_POOL_BRIDGE_SYMBOL];
	}
}

/* ------------------------ Coding-agent account pool ----------------------- */

export const CODING_AGENT_SELECTOR_BRIDGE_SYMBOL: unique symbol = Symbol.for(
	"eliza.account-pool.coding-agent.v1",
);

export type CodingAccountStrategy =
	| "priority"
	| "round-robin"
	| "least-used"
	| "quota-aware"
	// Reset-timestamp-aware selection. Coordination note: the runtime
	// consumer of this strategy in the coding bridge lives in
	// plugin-cli-inference (#16203). The type accepts it here so the
	// settings picker can persist it; the actual reset-soonest ordering is
	// implemented in AccountPool.applyStrategy (app-core).
	| "reset-soonest"
	| "drain-soonest-reset";

export interface CodingAccountUsage {
	sessionPct?: number;
	weeklyPct?: number;
	weeklyModelBuckets?: Record<string, { pct: number; resetsAt?: number }>;
	resetsAt?: number;
	refreshedAt: number;
}

/** A selected account plus the env the coding subprocess needs to auth as it. */
export interface CodingAgentSelection {
	providerId: string;
	accountId: string;
	label: string;
	source: "oauth" | "api-key";
	strategy: string;
	usage?: CodingAccountUsage;
	/** Secrets injected into the spawned subprocess env; never persisted. */
	envPatch: Record<string, string>;
}

export interface CodingProviderAvailability {
	providerId: string;
	total: number;
	enabled: number;
	healthy: number;
}

/**
 * Contract consumed by the orchestrator and cli-inference plugins. The
 * producer maps a coding-agent type to candidate providers, pool-selects an
 * account, and materializes the subprocess env.
 */
export interface CodingAgentSelectorBridge {
	/** Which providers can serve each coding-agent type, with account counts. */
	describe(): Record<string, CodingProviderAvailability[]>;
	/** Pick an account for a new (or continuing) coding sub-agent. */
	select(
		agentType: string,
		opts?: {
			sessionKey?: string;
			strategy?: CodingAccountStrategy;
			/** Requested model/display name, used to rank provider-specific weekly buckets. */
			model?: string;
			exclude?: string[];
			/**
			 * Restrict selection to these account ids. A continuing session pins
			 * its follow-up token resolves to the spawn-time account with this —
			 * pool session-affinity alone expires after a few selects, after which
			 * a strategy re-pick would silently drift the subprocess onto a
			 * sibling account while usage and health marks stay keyed to the
			 * original. Returns null when none of the ids is selectable.
			 */
			accountIds?: string[];
		},
	): Promise<CodingAgentSelection | null>;
	markRateLimited(
		providerId: string,
		accountId: string,
		untilMs: number,
		detail?: string,
	): Promise<void>;
	markNeedsReauth(
		providerId: string,
		accountId: string,
		detail?: string,
	): Promise<void>;
	recordUsage(
		providerId: string,
		accountId: string,
		result: {
			tokens?: number;
			ok: boolean;
			model?: string;
			latencyMs?: number;
		},
	): Promise<void>;
}

export function getCodingAgentSelectorBridge(): CodingAgentSelectorBridge | null {
	const slot = bridgeSlot();
	if (!slot) return null;
	return (
		(slot[CODING_AGENT_SELECTOR_BRIDGE_SYMBOL] as
			| CodingAgentSelectorBridge
			| undefined) ?? null
	);
}

/** Install (or, with `null`, clear) the coding-agent bridge. Idempotent. */
export function setCodingAgentSelectorBridge(
	bridge: CodingAgentSelectorBridge | null,
): void {
	const slot = bridgeSlot();
	if (!slot) return;
	if (bridge) {
		slot[CODING_AGENT_SELECTOR_BRIDGE_SYMBOL] = bridge;
	} else {
		delete slot[CODING_AGENT_SELECTOR_BRIDGE_SYMBOL];
	}
}

/* ---------------------- Account-pool broker snapshot --------------------- */

export interface AccountPoolBrokerLastLease {
	leaseId: string;
	atMs: number;
	sessionKeyHash: string;
	model?: string;
}

export interface AccountPoolBrokerLastReportedStatus {
	atMs: number;
	ok: boolean;
	category: "ok" | "auth" | "rate_limit" | "transient" | "other";
	reason: string;
	httpStatus?: number;
	model?: string;
}

export interface AccountPoolBrokerAccountSnapshot {
	activeLeaseCount: number;
	lastLease: AccountPoolBrokerLastLease | null;
	lastLeaseAt: number | null;
	lastReportedStatus: AccountPoolBrokerLastReportedStatus | null;
}

export interface AccountPoolBrokerProviderLastSelection {
	accountId: string;
	atMs: number;
	reason: string;
}

export interface AccountPoolBrokerFailoverSnapshot {
	atMs: number;
	providerId: string;
	sessionKeyHash: string;
	fromAccountId: string;
	toAccountId: string;
	cause: {
		category: "auth" | "rate_limit" | "transient";
		reason: string;
	};
	model?: string;
}

export interface AccountPoolBrokerProviderSnapshot {
	lastSelection: AccountPoolBrokerProviderLastSelection | null;
	recentFailovers: AccountPoolBrokerFailoverSnapshot[];
}

export interface AccountPoolBrokerSnapshot {
	accounts: Record<string, AccountPoolBrokerAccountSnapshot>;
	providers: Record<string, AccountPoolBrokerProviderSnapshot>;
}

export function emptyAccountPoolBrokerSnapshot(): AccountPoolBrokerSnapshot {
	return { accounts: {}, providers: {} };
}
