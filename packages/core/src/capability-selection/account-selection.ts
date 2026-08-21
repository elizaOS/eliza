/**
 * Deterministic connected-account selection for a capability intent. The LLM
 * proposes a provider-neutral capability; this module — never the model —
 * decides which connected account (and therefore adapter) is eligible, using
 * policy, health, location, and cost in a fixed total order. A pinned
 * `requestedAccountId` is honored exactly or fails loudly: an ineligible
 * pinned account is never silently substituted with a different account
 * (wrong-account prevention). Failures reuse the typed policy-denial and
 * unavailable codes from `types/provider-integrations`, and a policy denial
 * always outranks mere unavailability: an account-independent denial is
 * decided before any account is inspected, and an account-scoped denial is
 * preferred over any unavailability collected across candidates.
 */
import { ElizaError } from "../errors";
import {
	CAPABILITY_RISK_LEVELS,
	type CapabilityPolicyDenialCode,
	type CapabilityRiskLevel,
	type CapabilityUnavailableCode,
	type ConnectedAccount,
	type ConnectedAccountMode,
} from "../types/provider-integrations";

const RISK_RANK: Readonly<Record<CapabilityRiskLevel, number>> = Object.freeze({
	R0: 0,
	R1: 1,
	R2: 2,
	R3: 3,
});

/** Provider-neutral intent evaluated before dispatch binding. */
export interface AccountSelectionIntent {
	capabilityId: string;
	riskLevel: CapabilityRiskLevel;
	/** Exact pinned account, or null to let deterministic ranking choose. */
	requestedAccountId: string | null;
}

/** Deterministic policy inputs; absent constraints are explicitly null. */
export interface AccountSelectionPolicy {
	allowedModes: readonly ConnectedAccountMode[] | null;
	allowedProviderIds: readonly string[] | null;
	blockedAccountIds: readonly string[];
	maxRiskLevel: CapabilityRiskLevel;
	preferredRegion: string | null;
	maxUnitCostMicros: number | null;
}

/** Operational signal for one account; every candidate account must have one. */
export interface AccountSelectionSignal {
	accountId: string;
	healthy: boolean;
	region: string | null;
	unitCostMicros: number;
}

export interface AccountSelectionRationale {
	regionMatched: boolean;
	unitCostMicros: number;
	consideredAccountIds: readonly string[];
}

export type AccountSelectionResult =
	| {
			outcome: "selected";
			account: ConnectedAccount;
			rationale: AccountSelectionRationale;
	  }
	| {
			outcome: "denied";
			reasonCode: CapabilityPolicyDenialCode;
			accountId: string | null;
	  }
	| {
			outcome: "unavailable";
			code: CapabilityUnavailableCode;
			retryable: boolean;
	  };

type Ineligibility =
	| { kind: "denied"; reasonCode: CapabilityPolicyDenialCode }
	| {
			kind: "unavailable";
			code: CapabilityUnavailableCode;
			retryable: boolean;
	  };

function invalidSelectionInput(
	message: string,
	context: Record<string, unknown>,
): never {
	throw new ElizaError(message, {
		code: "INVALID_ACCOUNT_SELECTION_INPUT",
		context,
		severity: "fatal",
	});
}

function isUnitCostMicros(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Fail-closed validation of policy, account, and signal facts. Malformed
 * inputs (unknown risk level, non-finite or negative cost, unparseable
 * `lastUsedAt`, duplicate capability grants, signals for unknown accounts)
 * must throw rather than silently disable a policy check or perturb the
 * documented total order.
 */
function validateSelectionFacts(
	accounts: readonly ConnectedAccount[],
	policy: AccountSelectionPolicy,
	signals: readonly AccountSelectionSignal[],
	signalsById: ReadonlyMap<string, AccountSelectionSignal>,
): void {
	if (!CAPABILITY_RISK_LEVELS.includes(policy.maxRiskLevel)) {
		invalidSelectionInput("Account selection policy maxRiskLevel is invalid.", {
			maxRiskLevel: policy.maxRiskLevel,
		});
	}
	if (
		policy.maxUnitCostMicros !== null &&
		!isUnitCostMicros(policy.maxUnitCostMicros)
	) {
		invalidSelectionInput(
			"Account selection policy maxUnitCostMicros must be a nonnegative safe integer.",
			{ maxUnitCostMicros: policy.maxUnitCostMicros },
		);
	}
	const accountIds = new Set(accounts.map((account) => account.accountId));
	for (const signal of signals) {
		if (!accountIds.has(signal.accountId)) {
			invalidSelectionInput(
				"Account selection signal references an unknown accountId.",
				{ accountId: signal.accountId },
			);
		}
		if (!isUnitCostMicros(signal.unitCostMicros)) {
			invalidSelectionInput(
				"Account selection signal unitCostMicros must be a nonnegative safe integer.",
				{ accountId: signal.accountId, unitCostMicros: signal.unitCostMicros },
			);
		}
	}
	for (const account of accounts) {
		if (!signalsById.has(account.accountId)) {
			invalidSelectionInput(
				"Every connected account requires a selection signal.",
				{ accountId: account.accountId },
			);
		}
		if (
			account.lastUsedAt !== null &&
			Number.isNaN(Date.parse(account.lastUsedAt))
		) {
			invalidSelectionInput(
				"Connected account lastUsedAt must be a parseable timestamp or null.",
				{ accountId: account.accountId, lastUsedAt: account.lastUsedAt },
			);
		}
		const capabilityIds = new Set(
			account.capabilities.map((entry) => entry.capabilityId),
		);
		if (capabilityIds.size !== account.capabilities.length) {
			invalidSelectionInput(
				"Connected account has a duplicate capability grant.",
				{ accountId: account.accountId },
			);
		}
	}
}

const ACCOUNT_STATUS_UNAVAILABILITY: Readonly<
	Record<string, { code: CapabilityUnavailableCode; retryable: boolean }>
> = Object.freeze({
	disabled: { code: "account_disabled", retryable: false },
	error: { code: "account_error", retryable: true },
	reauth_required: { code: "needs_scope", retryable: false },
	revoked: { code: "account_revoked", retryable: false },
	unavailable: { code: "provider_unavailable", retryable: true },
});

const UNAVAILABLE_RETRYABLE: Readonly<
	Record<CapabilityUnavailableCode, boolean>
> = Object.freeze({
	account_disabled: false,
	account_error: true,
	account_revoked: false,
	cost_blocked: false,
	needs_admin: false,
	needs_review: false,
	needs_scope: false,
	not_configured: false,
	provider_unavailable: true,
	unsupported: false,
});

/**
 * Failure precedence when no account is eligible: report the most actionable
 * cause. A policy denial anywhere is surfaced over mere unavailability so a
 * blocked request is a deterministic denial, never a vague "not configured".
 */
const UNAVAILABLE_PRECEDENCE: readonly CapabilityUnavailableCode[] =
	Object.freeze([
		"needs_scope",
		"needs_admin",
		"needs_review",
		"account_revoked",
		"account_disabled",
		"cost_blocked",
		"account_error",
		"provider_unavailable",
		"unsupported",
		"not_configured",
	]);

function evaluateAccount(
	account: ConnectedAccount,
	intent: AccountSelectionIntent,
	policy: AccountSelectionPolicy,
	signal: AccountSelectionSignal,
): Ineligibility | null {
	if (policy.blockedAccountIds.includes(account.accountId)) {
		return { kind: "denied", reasonCode: "account_policy_denied" };
	}
	if (
		policy.allowedModes !== null &&
		!policy.allowedModes.includes(account.mode)
	) {
		return { kind: "denied", reasonCode: "organization_policy_denied" };
	}
	if (
		policy.allowedProviderIds !== null &&
		!policy.allowedProviderIds.includes(account.providerId)
	) {
		return { kind: "denied", reasonCode: "organization_policy_denied" };
	}
	if (account.status !== "connected") {
		const mapped = ACCOUNT_STATUS_UNAVAILABILITY[account.status];
		if (mapped === undefined) {
			invalidSelectionInput("Connected account has an unknown status.", {
				accountId: account.accountId,
				status: account.status,
			});
		}
		return { kind: "unavailable", ...mapped };
	}
	const capability = account.capabilities.find(
		(entry) => entry.capabilityId === intent.capabilityId,
	);
	if (capability === undefined) {
		return { kind: "unavailable", code: "unsupported", retryable: false };
	}
	if (capability.status !== "available") {
		return {
			kind: "unavailable",
			code: capability.status,
			retryable: UNAVAILABLE_RETRYABLE[capability.status],
		};
	}
	if (RISK_RANK[intent.riskLevel] > RISK_RANK[capability.riskLevel]) {
		return { kind: "unavailable", code: "needs_scope", retryable: false };
	}
	if (
		policy.maxUnitCostMicros !== null &&
		signal.unitCostMicros > policy.maxUnitCostMicros
	) {
		return { kind: "unavailable", code: "cost_blocked", retryable: false };
	}
	if (!signal.healthy) {
		return {
			kind: "unavailable",
			code: "provider_unavailable",
			retryable: true,
		};
	}
	return null;
}

function compareEligible(
	a: { account: ConnectedAccount; signal: AccountSelectionSignal },
	b: { account: ConnectedAccount; signal: AccountSelectionSignal },
	preferredRegion: string | null,
): number {
	if (preferredRegion !== null) {
		const aMatch = a.signal.region === preferredRegion ? 1 : 0;
		const bMatch = b.signal.region === preferredRegion ? 1 : 0;
		if (aMatch !== bMatch) return bMatch - aMatch;
	}
	if (a.signal.unitCostMicros !== b.signal.unitCostMicros) {
		return a.signal.unitCostMicros - b.signal.unitCostMicros;
	}
	const aUsed =
		a.account.lastUsedAt === null ? 0 : Date.parse(a.account.lastUsedAt);
	const bUsed =
		b.account.lastUsedAt === null ? 0 : Date.parse(b.account.lastUsedAt);
	if (aUsed !== bUsed) return bUsed - aUsed;
	// Code-unit comparison keeps the accountId tie-breaker locale-independent.
	if (a.account.accountId === b.account.accountId) return 0;
	return a.account.accountId < b.account.accountId ? -1 : 1;
}

/**
 * Selects the single eligible account for the intent, or the typed reason
 * there is none. Deterministic: identical inputs always yield the identical
 * result, ranked by region match, then unit cost ascending, then most recent
 * use, then `accountId` ascending.
 */
export function selectConnectedAccount(
	intent: AccountSelectionIntent,
	accounts: readonly ConnectedAccount[],
	policy: AccountSelectionPolicy,
	signals: readonly AccountSelectionSignal[],
): AccountSelectionResult {
	if (intent.capabilityId.trim().length === 0) {
		invalidSelectionInput(
			"Account selection intent capabilityId must be non-empty.",
			{},
		);
	}
	if (!CAPABILITY_RISK_LEVELS.includes(intent.riskLevel)) {
		invalidSelectionInput("Account selection intent riskLevel is invalid.", {
			riskLevel: intent.riskLevel,
		});
	}
	const accountIds = new Set(accounts.map((account) => account.accountId));
	if (accountIds.size !== accounts.length) {
		invalidSelectionInput(
			"Connected accounts contain a duplicate accountId.",
			{},
		);
	}
	const signalsById = new Map(
		signals.map((signal) => [signal.accountId, signal]),
	);
	if (signalsById.size !== signals.length) {
		invalidSelectionInput(
			"Account selection signals contain a duplicate accountId.",
			{},
		);
	}
	validateSelectionFacts(accounts, policy, signals, signalsById);

	// The intent-vs-policy risk comparison names no field of any account, so it
	// is decided once before any account is inspected. Leaving it inside the
	// per-account loop let an unavailable account mask a categorical denial and
	// send the caller down a reauth path that could never unblock the request.
	if (RISK_RANK[intent.riskLevel] > RISK_RANK[policy.maxRiskLevel]) {
		return {
			outcome: "denied",
			reasonCode: "risk_policy_denied",
			accountId: null,
		};
	}

	if (intent.requestedAccountId !== null) {
		const account = accounts.find(
			(candidate) => candidate.accountId === intent.requestedAccountId,
		);
		if (account === undefined) {
			return {
				outcome: "unavailable",
				code: "not_configured",
				retryable: false,
			};
		}
		const signal = signalsById.get(account.accountId) as AccountSelectionSignal;
		const ineligibility = evaluateAccount(account, intent, policy, signal);
		if (ineligibility !== null) {
			return ineligibility.kind === "denied"
				? {
						outcome: "denied",
						reasonCode: ineligibility.reasonCode,
						accountId: account.accountId,
					}
				: {
						outcome: "unavailable",
						code: ineligibility.code,
						retryable: ineligibility.retryable,
					};
		}
		return {
			outcome: "selected",
			account,
			rationale: {
				regionMatched:
					policy.preferredRegion !== null &&
					signal.region === policy.preferredRegion,
				unitCostMicros: signal.unitCostMicros,
				consideredAccountIds: Object.freeze([account.accountId]),
			},
		};
	}

	const eligible: Array<{
		account: ConnectedAccount;
		signal: AccountSelectionSignal;
	}> = [];
	const ineligibilities: Ineligibility[] = [];
	for (const account of accounts) {
		const signal = signalsById.get(account.accountId) as AccountSelectionSignal;
		const ineligibility = evaluateAccount(account, intent, policy, signal);
		if (ineligibility === null) {
			eligible.push({ account, signal });
		} else {
			ineligibilities.push(ineligibility);
		}
	}

	if (eligible.length === 0) {
		const denial = ineligibilities.find(
			(entry): entry is Extract<Ineligibility, { kind: "denied" }> =>
				entry.kind === "denied",
		);
		if (denial !== undefined) {
			return {
				outcome: "denied",
				reasonCode: denial.reasonCode,
				accountId: null,
			};
		}
		const unavailable = ineligibilities.filter(
			(entry): entry is Extract<Ineligibility, { kind: "unavailable" }> =>
				entry.kind === "unavailable",
		);
		if (unavailable.length === 0) {
			return {
				outcome: "unavailable",
				code: "not_configured",
				retryable: false,
			};
		}
		const best = [...unavailable].sort(
			(a, b) =>
				UNAVAILABLE_PRECEDENCE.indexOf(a.code) -
				UNAVAILABLE_PRECEDENCE.indexOf(b.code),
		)[0];
		return {
			outcome: "unavailable",
			code: best.code,
			retryable: best.retryable,
		};
	}

	const ranked = [...eligible].sort((a, b) =>
		compareEligible(a, b, policy.preferredRegion),
	);
	const winner = ranked[0];
	return {
		outcome: "selected",
		account: winner.account,
		rationale: {
			regionMatched:
				policy.preferredRegion !== null &&
				winner.signal.region === policy.preferredRegion,
			unitCostMicros: winner.signal.unitCostMicros,
			consideredAccountIds: Object.freeze(
				ranked.map((candidate) => candidate.account.accountId),
			),
		},
	};
}
