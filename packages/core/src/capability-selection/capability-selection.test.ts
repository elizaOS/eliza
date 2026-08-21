/**
 * Exercises the real capability-selection surface: deterministic retrieval
 * (ranking, ambiguity flagging, designed-empty, flood metrics), account
 * selection (policy denial, unavailability mapping, wrong-account prevention,
 * ranking order), invalid-input rejection, and the evaluation harness run
 * against the built-in corpus. Deterministic and mock-free — the corpus data
 * are real contract values, not stand-ins for the system under test.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import { PROVIDER_INTEGRATION_CONTRACT_VERSION } from "../types/provider-integrations";
import {
	type AccountSelectionPolicy,
	selectConnectedAccount,
} from "./account-selection";
import { runCapabilitySelectionEvaluation } from "./evaluation";
import {
	CAPABILITY_EVALUATION_CATALOG,
	CAPABILITY_EVALUATION_CORPUS,
} from "./evaluation-corpus";
import { retrieveCapabilities } from "./retrieval";

const OPEN_POLICY: AccountSelectionPolicy = {
	allowedModes: null,
	allowedProviderIds: null,
	blockedAccountIds: [],
	maxRiskLevel: "R2",
	preferredRegion: null,
	maxUnitCostMicros: null,
};

describe("capability retrieval", () => {
	it("ranks the intended capability first and bounds the retrieved token budget", () => {
		const result = retrieveCapabilities({
			catalog: CAPABILITY_EVALUATION_CATALOG,
			intentText: "send an email to sam about the offsite",
		});
		expect(result.results[0]?.entry.capabilityId).toBe("email.message.send");
		expect(result.metrics.retrievedCount).toBeLessThanOrEqual(5);
		expect(result.metrics.retrievedPromptTokenEstimate).toBeLessThan(
			result.metrics.catalogPromptTokenEstimate,
		);
		expect(result.metrics.floodRatio).toBeLessThan(0.6);
	});

	it("flags cross-domain near-ties as ambiguous with both contenders", () => {
		const result = retrieveCapabilities({
			catalog: CAPABILITY_EVALUATION_CATALOG,
			intentText: "send a message",
		});
		expect(result.ambiguity.ambiguous).toBe(true);
		expect(result.ambiguity.contenders).toContain("messaging.chat.send");
		expect(result.ambiguity.contenders).toContain("email.message.send");
	});

	it("returns designed-empty for a non-matching intent instead of the full catalog", () => {
		const result = retrieveCapabilities({
			catalog: CAPABILITY_EVALUATION_CATALOG,
			intentText: "zzqx flibberwock",
		});
		expect(result.results).toHaveLength(0);
		expect(result.ambiguity.ambiguous).toBe(false);
		expect(result.metrics.retrievedPromptTokenEstimate).toBe(0);
	});

	it("is idempotent for identical inputs", () => {
		const run = () =>
			retrieveCapabilities({
				catalog: CAPABILITY_EVALUATION_CATALOG,
				intentText: "search my files and documents",
			});
		expect(run()).toEqual(run());
	});

	it("rejects duplicate capability ids, bad token estimates, and bad limits", () => {
		const entry = CAPABILITY_EVALUATION_CATALOG[0];
		expect(() =>
			retrieveCapabilities({ catalog: [entry, entry], intentText: "email" }),
		).toThrowError(ElizaError);
		expect(() =>
			retrieveCapabilities({
				catalog: [{ ...entry, promptTokenEstimate: 0 }],
				intentText: "email",
			}),
		).toThrowError(ElizaError);
		expect(() =>
			retrieveCapabilities({
				catalog: CAPABILITY_EVALUATION_CATALOG,
				intentText: "email",
				limit: 0,
			}),
		).toThrowError(ElizaError);
	});

	it("rejects a catalog whose aggregate token estimate overflows the safe range", () => {
		const base = CAPABILITY_EVALUATION_CATALOG[0];
		const huge = (suffix: string) => ({
			...base,
			capabilityId: `${base.capabilityId}.${suffix}`,
			promptTokenEstimate: Number.MAX_SAFE_INTEGER,
		});
		expect(() =>
			retrieveCapabilities({
				catalog: [huge("a"), huge("b")],
				intentText: "email",
			}),
		).toThrowError(ElizaError);
	});
});

describe("deterministic account selection", () => {
	const capability = {
		capabilityId: "email.message.send",
		riskLevel: "R2",
		status: "available",
	} as const;
	const baseAccount = {
		contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
		providerId: "google-mail",
		mode: "cloud",
		status: "connected",
		displayName: null,
		capabilities: [capability],
		lastUsedAt: null,
	} as const;
	const intent = {
		capabilityId: "email.message.send",
		riskLevel: "R2",
		requestedAccountId: null,
	} as const;

	it("never substitutes a different account for an ineligible pinned account", () => {
		const result = selectConnectedAccount(
			{ ...intent, requestedAccountId: "acct-b" },
			[
				{ ...baseAccount, accountId: "acct-a" },
				{ ...baseAccount, accountId: "acct-b", status: "revoked" },
			],
			OPEN_POLICY,
			[
				{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 },
				{ accountId: "acct-b", healthy: true, region: "us", unitCostMicros: 1 },
			],
		);
		expect(result).toEqual({
			outcome: "unavailable",
			code: "account_revoked",
			retryable: false,
		});
	});

	it("prefers a policy denial over unavailability when nothing is eligible", () => {
		const result = selectConnectedAccount(
			intent,
			[
				{ ...baseAccount, accountId: "acct-a", status: "unavailable" },
				{ ...baseAccount, accountId: "acct-b" },
			],
			{ ...OPEN_POLICY, blockedAccountIds: ["acct-b"] },
			[
				{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 },
				{ accountId: "acct-b", healthy: true, region: "us", unitCostMicros: 1 },
			],
		);
		expect(result).toEqual({
			outcome: "denied",
			reasonCode: "account_policy_denied",
			accountId: null,
		});
	});

	it("orders eligible accounts by region, cost, recency, then accountId", () => {
		const result = selectConnectedAccount(
			intent,
			[
				{ ...baseAccount, accountId: "acct-c" },
				{ ...baseAccount, accountId: "acct-a" },
				{ ...baseAccount, accountId: "acct-b" },
			],
			{ ...OPEN_POLICY, preferredRegion: "eu" },
			[
				{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 },
				{ accountId: "acct-b", healthy: true, region: "eu", unitCostMicros: 9 },
				{ accountId: "acct-c", healthy: true, region: "eu", unitCostMicros: 9 },
			],
		);
		expect(result.outcome).toBe("selected");
		if (result.outcome === "selected") {
			expect(result.account.accountId).toBe("acct-b");
			expect(result.rationale.consideredAccountIds).toEqual([
				"acct-b",
				"acct-c",
				"acct-a",
			]);
			expect(result.rationale.regionMatched).toBe(true);
		}
	});

	it("maps a stricter capability grant than the intent risk to needs_scope", () => {
		const result = selectConnectedAccount(
			{ ...intent, riskLevel: "R2" },
			[
				{
					...baseAccount,
					accountId: "acct-a",
					capabilities: [{ ...capability, riskLevel: "R1" }],
				},
			],
			{ ...OPEN_POLICY, maxRiskLevel: "R3" },
			[{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 }],
		);
		expect(result).toEqual({
			outcome: "unavailable",
			code: "needs_scope",
			retryable: false,
		});
	});

	const RISK_DENYING_POLICY: AccountSelectionPolicy = {
		...OPEN_POLICY,
		maxRiskLevel: "R1",
	};
	const overRiskIntent = { ...intent, riskLevel: "R3" } as const;
	const riskDenial = {
		outcome: "denied",
		reasonCode: "risk_policy_denied",
		accountId: null,
	};

	it("denies a policy-exceeding intent when every account needs reauthorization", () => {
		const result = selectConnectedAccount(
			overRiskIntent,
			[{ ...baseAccount, accountId: "acct-a", status: "reauth_required" }],
			RISK_DENYING_POLICY,
			[{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 }],
		);
		expect(result).toEqual(riskDenial);
	});

	it("denies a policy-exceeding intent when every account is revoked", () => {
		const result = selectConnectedAccount(
			overRiskIntent,
			[{ ...baseAccount, accountId: "acct-a", status: "revoked" }],
			RISK_DENYING_POLICY,
			[{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 }],
		);
		expect(result).toEqual(riskDenial);
	});

	it("denies a policy-exceeding intent when no account grants the capability", () => {
		const result = selectConnectedAccount(
			overRiskIntent,
			[{ ...baseAccount, accountId: "acct-a", capabilities: [] }],
			RISK_DENYING_POLICY,
			[{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 }],
		);
		expect(result).toEqual(riskDenial);
	});

	it("denies a policy-exceeding intent when there are no accounts at all", () => {
		expect(
			selectConnectedAccount(overRiskIntent, [], RISK_DENYING_POLICY, []),
		).toEqual(riskDenial);
	});

	it("denies a policy-exceeding intent pinned to an unavailable account", () => {
		const result = selectConnectedAccount(
			{ ...overRiskIntent, requestedAccountId: "acct-a" },
			[{ ...baseAccount, accountId: "acct-a", status: "reauth_required" }],
			RISK_DENYING_POLICY,
			[{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 }],
		);
		expect(result).toEqual(riskDenial);
	});

	it("denies a policy-exceeding intent pinned to an account that does not exist", () => {
		const result = selectConnectedAccount(
			{ ...overRiskIntent, requestedAccountId: "acct-missing" },
			[{ ...baseAccount, accountId: "acct-a" }],
			RISK_DENYING_POLICY,
			[{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 }],
		);
		expect(result).toEqual(riskDenial);
	});

	it("still reports account unavailability when the intent is within policy risk", () => {
		const result = selectConnectedAccount(
			{ ...intent, riskLevel: "R1" },
			[{ ...baseAccount, accountId: "acct-a", status: "reauth_required" }],
			RISK_DENYING_POLICY,
			[{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 }],
		);
		expect(result).toEqual({
			outcome: "unavailable",
			code: "needs_scope",
			retryable: false,
		});
	});

	it("fails closed on an invalid policy maxRiskLevel instead of skipping the risk check", () => {
		expect(() =>
			selectConnectedAccount(
				{ ...intent, riskLevel: "R2" },
				[{ ...baseAccount, accountId: "acct-a" }],
				{
					...OPEN_POLICY,
					maxRiskLevel:
						"R9" as unknown as AccountSelectionPolicy["maxRiskLevel"],
				},
				[
					{
						accountId: "acct-a",
						healthy: true,
						region: "us",
						unitCostMicros: 1,
					},
				],
			),
		).toThrowError(ElizaError);
	});

	it("rejects NaN, negative, fractional, and unsafe unitCostMicros signals", () => {
		for (const unitCostMicros of [Number.NaN, -1, 2 ** 53, 0.5]) {
			expect(() =>
				selectConnectedAccount(
					intent,
					[{ ...baseAccount, accountId: "acct-a" }],
					OPEN_POLICY,
					[
						{
							accountId: "acct-a",
							healthy: true,
							region: "us",
							unitCostMicros,
						},
					],
				),
			).toThrowError(ElizaError);
		}
	});

	it("rejects an invalid policy maxUnitCostMicros instead of bypassing the ceiling", () => {
		expect(() =>
			selectConnectedAccount(
				intent,
				[{ ...baseAccount, accountId: "acct-a" }],
				{ ...OPEN_POLICY, maxUnitCostMicros: Number.NaN },
				[
					{
						accountId: "acct-a",
						healthy: true,
						region: "us",
						unitCostMicros: 1,
					},
				],
			),
		).toThrowError(ElizaError);
	});

	it("rejects an unparseable lastUsedAt timestamp", () => {
		expect(() =>
			selectConnectedAccount(
				intent,
				[{ ...baseAccount, accountId: "acct-a", lastUsedAt: "not-a-date" }],
				OPEN_POLICY,
				[
					{
						accountId: "acct-a",
						healthy: true,
						region: "us",
						unitCostMicros: 1,
					},
				],
			),
		).toThrowError(ElizaError);
	});

	it("rejects duplicate capability grants within one account", () => {
		expect(() =>
			selectConnectedAccount(
				intent,
				[
					{
						...baseAccount,
						accountId: "acct-a",
						capabilities: [capability, capability],
					},
				],
				OPEN_POLICY,
				[
					{
						accountId: "acct-a",
						healthy: true,
						region: "us",
						unitCostMicros: 1,
					},
				],
			),
		).toThrowError(ElizaError);
	});

	it("rejects a signal referencing an unknown account", () => {
		expect(() =>
			selectConnectedAccount(
				intent,
				[{ ...baseAccount, accountId: "acct-a" }],
				OPEN_POLICY,
				[
					{
						accountId: "acct-a",
						healthy: true,
						region: "us",
						unitCostMicros: 1,
					},
					{
						accountId: "acct-ghost",
						healthy: true,
						region: "us",
						unitCostMicros: 1,
					},
				],
			),
		).toThrowError(ElizaError);
	});

	it("selects the same account regardless of input order for equal candidates", () => {
		const accounts = [
			{ ...baseAccount, accountId: "acct-b" },
			{ ...baseAccount, accountId: "acct-a" },
		];
		const signals = [
			{ accountId: "acct-a", healthy: true, region: "us", unitCostMicros: 1 },
			{ accountId: "acct-b", healthy: true, region: "us", unitCostMicros: 1 },
		];
		const forward = selectConnectedAccount(
			intent,
			accounts,
			OPEN_POLICY,
			signals,
		);
		const reversed = selectConnectedAccount(
			intent,
			[...accounts].reverse(),
			OPEN_POLICY,
			[...signals].reverse(),
		);
		expect(forward.outcome).toBe("selected");
		expect(reversed.outcome).toBe("selected");
		if (forward.outcome === "selected" && reversed.outcome === "selected") {
			expect(forward.account.accountId).toBe("acct-a");
			expect(reversed.account.accountId).toBe("acct-a");
		}
	});

	it("rejects missing signals and duplicate accounts as invalid input", () => {
		expect(() =>
			selectConnectedAccount(
				intent,
				[{ ...baseAccount, accountId: "acct-a" }],
				OPEN_POLICY,
				[],
			),
		).toThrowError(ElizaError);
		expect(() =>
			selectConnectedAccount(
				intent,
				[
					{ ...baseAccount, accountId: "acct-a" },
					{ ...baseAccount, accountId: "acct-a" },
				],
				OPEN_POLICY,
				[
					{
						accountId: "acct-a",
						healthy: true,
						region: "us",
						unitCostMicros: 1,
					},
				],
			),
		).toThrowError(ElizaError);
	});
});

describe("evaluation harness", () => {
	it("passes every built-in corpus case and reports flood metrics", () => {
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			CAPABILITY_EVALUATION_CORPUS,
		);
		const failed = report.cases.filter((entry) => !entry.passed);
		expect(
			failed.map((entry) => `${entry.name}: ${entry.failures.join("; ")}`),
		).toEqual([]);
		expect(report.summary.total).toBe(CAPABILITY_EVALUATION_CORPUS.length);
		expect(report.summary.passed).toBe(report.summary.total);
		expect(report.summary.meanFloodRatio).toBeGreaterThan(0);
		expect(report.summary.meanFloodRatio).toBeLessThan(0.6);
		expect(report.summary.maxLatencyMs).toBeGreaterThanOrEqual(0);
	});

	it("produces identical outcomes across repeated runs", () => {
		const strip = (
			report: ReturnType<typeof runCapabilitySelectionEvaluation>,
		) => report.cases.map((entry) => ({ ...entry, latencyMs: 0 }));
		expect(
			strip(
				runCapabilitySelectionEvaluation(
					CAPABILITY_EVALUATION_CATALOG,
					CAPABILITY_EVALUATION_CORPUS,
				),
			),
		).toEqual(
			strip(
				runCapabilitySelectionEvaluation(
					CAPABILITY_EVALUATION_CATALOG,
					CAPABILITY_EVALUATION_CORPUS,
				),
			),
		);
	});

	it("rejects an empty corpus and duplicate case names", () => {
		expect(() =>
			runCapabilitySelectionEvaluation(CAPABILITY_EVALUATION_CATALOG, []),
		).toThrowError(ElizaError);
		const dup = CAPABILITY_EVALUATION_CORPUS[0];
		expect(() =>
			runCapabilitySelectionEvaluation(CAPABILITY_EVALUATION_CATALOG, [
				dup,
				dup,
			]),
		).toThrowError(ElizaError);
	});

	it("reports a failing case with actionable failure text", () => {
		const report = runCapabilitySelectionEvaluation(
			CAPABILITY_EVALUATION_CATALOG,
			[
				{
					name: "expected wrong top capability",
					intentText: "send an email to sam",
					retrieval: {
						topCapabilityId: "calendar.event.create",
						mustInclude: [],
						expectAmbiguous: false,
					},
					selection: null,
				},
			],
		);
		expect(report.summary.failed).toBe(1);
		expect(report.cases[0].failures[0]).toContain("calendar.event.create");
	});
});
