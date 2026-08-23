/**
 * Exercises deterministic connected-account selection directly, including
 * validation, pinned-account handling, failure precedence, and every ranking
 * dimension. The suite is deterministic and mock-free.
 */
import { describe, expect, it } from "vitest";
import type { ConnectedAccount } from "../types/provider-integrations";
import { PROVIDER_INTEGRATION_CONTRACT_VERSION } from "../types/provider-integrations";
import {
	type AccountSelectionIntent,
	type AccountSelectionPolicy,
	type AccountSelectionSignal,
	selectConnectedAccount,
} from "./account-selection";

const CAPABILITY_ID = "email.message.send";

const intent = (
	overrides: Partial<AccountSelectionIntent> = {},
): AccountSelectionIntent => ({
	capabilityId: CAPABILITY_ID,
	riskLevel: "R2",
	requestedAccountId: null,
	...overrides,
});

const policy = (
	overrides: Partial<AccountSelectionPolicy> = {},
): AccountSelectionPolicy => ({
	allowedModes: null,
	allowedProviderIds: null,
	blockedAccountIds: [],
	maxRiskLevel: "R3",
	preferredRegion: null,
	maxUnitCostMicros: null,
	...overrides,
});

const account = (
	accountId: string,
	overrides: Partial<ConnectedAccount> = {},
): ConnectedAccount => ({
	contractVersion: PROVIDER_INTEGRATION_CONTRACT_VERSION,
	accountId,
	providerId: "google-mail",
	mode: "cloud",
	status: "connected",
	displayName: null,
	capabilities: [
		{ capabilityId: CAPABILITY_ID, riskLevel: "R2", status: "available" },
	],
	lastUsedAt: null,
	...overrides,
});

const signal = (
	accountId: string,
	overrides: Partial<AccountSelectionSignal> = {},
): AccountSelectionSignal => ({
	accountId,
	healthy: true,
	region: "us-east",
	unitCostMicros: 10,
	...overrides,
});

const expectInvalid = (run: () => unknown): void => {
	expect(run).toThrowError(
		expect.objectContaining({ code: "INVALID_ACCOUNT_SELECTION_INPUT" }),
	);
};

describe("selectConnectedAccount input validation", () => {
	it("rejects an empty capability id and an unknown intent risk level", () => {
		expectInvalid(() =>
			selectConnectedAccount(intent({ capabilityId: "  " }), [], policy(), []),
		);
		expectInvalid(() =>
			selectConnectedAccount(
				intent({ riskLevel: "R9" as AccountSelectionIntent["riskLevel"] }),
				[],
				policy(),
				[],
			),
		);
	});

	it("rejects duplicate account and signal ids", () => {
		expectInvalid(() =>
			selectConnectedAccount(
				intent(),
				[account("acct-a"), account("acct-a")],
				policy(),
				[signal("acct-a")],
			),
		);
		expectInvalid(() =>
			selectConnectedAccount(intent(), [account("acct-a")], policy(), [
				signal("acct-a"),
				signal("acct-a"),
			]),
		);
	});

	it("rejects invalid policy risk and cost limits", () => {
		expectInvalid(() =>
			selectConnectedAccount(
				intent(),
				[],
				policy({
					maxRiskLevel: "R9" as AccountSelectionPolicy["maxRiskLevel"],
				}),
				[],
			),
		);
		for (const maxUnitCostMicros of [
			-1,
			0.5,
			Number.NaN,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expectInvalid(() =>
				selectConnectedAccount(intent(), [], policy({ maxUnitCostMicros }), []),
			);
		}
	});

	it("rejects unknown-account signals and invalid signal costs", () => {
		expectInvalid(() =>
			selectConnectedAccount(intent(), [], policy(), [signal("acct-ghost")]),
		);
		for (const unitCostMicros of [
			-1,
			0.5,
			Number.NaN,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expectInvalid(() =>
				selectConnectedAccount(intent(), [account("acct-a")], policy(), [
					signal("acct-a", { unitCostMicros }),
				]),
			);
		}
	});

	it("rejects malformed account status, missing signals, and invalid timestamps", () => {
		expectInvalid(() =>
			selectConnectedAccount(
				intent(),
				[
					account("acct-a", {
						status: "mystery" as ConnectedAccount["status"],
					}),
				],
				policy(),
				[signal("acct-a")],
			),
		);
		expectInvalid(() =>
			selectConnectedAccount(intent(), [account("acct-a")], policy(), []),
		);
		expectInvalid(() =>
			selectConnectedAccount(
				intent(),
				[account("acct-a", { lastUsedAt: "not-a-date" })],
				policy(),
				[signal("acct-a")],
			),
		);
	});

	it("rejects duplicate capability grants on one account", () => {
		const grant = {
			capabilityId: CAPABILITY_ID,
			riskLevel: "R2",
			status: "available",
		} as const;
		expectInvalid(() =>
			selectConnectedAccount(
				intent(),
				[account("acct-a", { capabilities: [grant, grant] })],
				policy(),
				[signal("acct-a")],
			),
		);
	});
});

describe("selectConnectedAccount pinned selection", () => {
	it("returns not_configured instead of substituting when the pin is missing", () => {
		expect(
			selectConnectedAccount(
				intent({ requestedAccountId: "acct-missing" }),
				[account("acct-a")],
				policy(),
				[signal("acct-a")],
			),
		).toEqual({
			outcome: "unavailable",
			code: "not_configured",
			retryable: false,
		});
	});

	it("returns an account-scoped denial for a blocked pin", () => {
		expect(
			selectConnectedAccount(
				intent({ requestedAccountId: "acct-a" }),
				[account("acct-a")],
				policy({ blockedAccountIds: ["acct-a"] }),
				[signal("acct-a")],
			),
		).toEqual({
			outcome: "denied",
			reasonCode: "account_policy_denied",
			accountId: "acct-a",
		});
	});

	it.each([
		["mode", policy({ allowedModes: ["local"] })],
		["provider", policy({ allowedProviderIds: ["microsoft-mail"] })],
	])(
		"returns an organization denial when the pinned account violates %s policy",
		(_case, selectionPolicy) => {
			expect(
				selectConnectedAccount(
					intent({ requestedAccountId: "acct-a" }),
					[account("acct-a")],
					selectionPolicy,
					[signal("acct-a")],
				),
			).toEqual({
				outcome: "denied",
				reasonCode: "organization_policy_denied",
				accountId: "acct-a",
			});
		},
	);

	it.each([
		["disabled", "account_disabled", false],
		["error", "account_error", true],
		["reauth_required", "needs_scope", false],
		["revoked", "account_revoked", false],
		["unavailable", "provider_unavailable", true],
	] as const)("maps %s account status to %s", (status, code, retryable) => {
		expect(
			selectConnectedAccount(
				intent({ requestedAccountId: "acct-a" }),
				[account("acct-a", { status })],
				policy(),
				[signal("acct-a")],
			),
		).toEqual({ outcome: "unavailable", code, retryable });
	});

	it.each([
		[[], "unsupported", false],
		[
			[{ capabilityId: CAPABILITY_ID, riskLevel: "R2", status: "needs_admin" }],
			"needs_admin",
			false,
		],
	] as const)(
		"maps capability eligibility to %s",
		(capabilities, code, retryable) => {
			expect(
				selectConnectedAccount(
					intent({ requestedAccountId: "acct-a" }),
					[account("acct-a", { capabilities })],
					policy(),
					[signal("acct-a")],
				),
			).toEqual({ outcome: "unavailable", code, retryable });
		},
	);

	it("enforces capability risk, cost, and health in that order", () => {
		expect(
			selectConnectedAccount(
				intent({ requestedAccountId: "acct-a", riskLevel: "R3" }),
				[account("acct-a")],
				policy({ maxUnitCostMicros: 5 }),
				[signal("acct-a", { healthy: false, unitCostMicros: 10 })],
			),
		).toEqual({
			outcome: "unavailable",
			code: "needs_scope",
			retryable: false,
		});

		expect(
			selectConnectedAccount(
				intent({ requestedAccountId: "acct-a" }),
				[account("acct-a")],
				policy({ maxUnitCostMicros: 5 }),
				[signal("acct-a", { healthy: false, unitCostMicros: 10 })],
			),
		).toEqual({
			outcome: "unavailable",
			code: "cost_blocked",
			retryable: false,
		});

		expect(
			selectConnectedAccount(
				intent({ requestedAccountId: "acct-a" }),
				[account("acct-a")],
				policy(),
				[signal("acct-a", { healthy: false })],
			),
		).toEqual({
			outcome: "unavailable",
			code: "provider_unavailable",
			retryable: true,
		});
	});

	it("returns the exact pinned account and its rationale", () => {
		const pinned = account("acct-a");
		expect(
			selectConnectedAccount(
				intent({ requestedAccountId: "acct-a" }),
				[pinned, account("acct-b")],
				policy({ preferredRegion: "eu" }),
				[
					signal("acct-a", { region: "eu", unitCostMicros: 7 }),
					signal("acct-b"),
				],
			),
		).toEqual({
			outcome: "selected",
			account: pinned,
			rationale: {
				regionMatched: true,
				unitCostMicros: 7,
				consideredAccountIds: ["acct-a"],
			},
		});
	});
});

describe("selectConnectedAccount automatic selection", () => {
	it("returns not_configured for an empty account list", () => {
		expect(selectConnectedAccount(intent(), [], policy(), [])).toEqual({
			outcome: "unavailable",
			code: "not_configured",
			retryable: false,
		});
	});

	it("applies account-independent risk denial before account availability", () => {
		expect(
			selectConnectedAccount(
				intent({ riskLevel: "R3" }),
				[],
				policy({ maxRiskLevel: "R2" }),
				[],
			),
		).toEqual({
			outcome: "denied",
			reasonCode: "risk_policy_denied",
			accountId: null,
		});
	});

	it("prefers any policy denial over account unavailability", () => {
		expect(
			selectConnectedAccount(
				intent(),
				[
					account("acct-unavailable", { status: "unavailable" }),
					account("acct-blocked"),
				],
				policy({ blockedAccountIds: ["acct-blocked"] }),
				[signal("acct-unavailable"), signal("acct-blocked")],
			),
		).toEqual({
			outcome: "denied",
			reasonCode: "account_policy_denied",
			accountId: null,
		});
	});

	it("uses the documented unavailability precedence regardless of input order", () => {
		const accounts = [
			account("acct-unsupported", { capabilities: [] }),
			account("acct-error", { status: "error" }),
			account("acct-scope", { status: "reauth_required" }),
		];
		const signals = accounts.map(({ accountId }) => signal(accountId));
		expect(
			selectConnectedAccount(intent(), accounts, policy(), signals),
		).toEqual({
			outcome: "unavailable",
			code: "needs_scope",
			retryable: false,
		});
		expect(
			selectConnectedAccount(
				intent(),
				[...accounts].reverse(),
				policy(),
				[...signals].reverse(),
			),
		).toEqual({
			outcome: "unavailable",
			code: "needs_scope",
			retryable: false,
		});
	});

	it("ranks region before cost", () => {
		const result = selectConnectedAccount(
			intent(),
			[account("acct-cheap"), account("acct-region")],
			policy({ preferredRegion: "eu" }),
			[
				signal("acct-cheap", { region: "us", unitCostMicros: 1 }),
				signal("acct-region", { region: "eu", unitCostMicros: 100 }),
			],
		);
		expect(result.outcome === "selected" && result.account.accountId).toBe(
			"acct-region",
		);
	});

	it("ranks lower cost before recency", () => {
		const result = selectConnectedAccount(
			intent(),
			[
				account("acct-cheap", { lastUsedAt: "2020-01-01T00:00:00.000Z" }),
				account("acct-recent", { lastUsedAt: "2026-01-01T00:00:00.000Z" }),
			],
			policy(),
			[
				signal("acct-cheap", { unitCostMicros: 1 }),
				signal("acct-recent", { unitCostMicros: 2 }),
			],
		);
		expect(result.outcome === "selected" && result.account.accountId).toBe(
			"acct-cheap",
		);
	});

	it("ranks recent use ahead of never-used accounts when costs tie", () => {
		const result = selectConnectedAccount(
			intent(),
			[
				account("acct-never"),
				account("acct-recent", { lastUsedAt: "2026-01-01T00:00:00.000Z" }),
			],
			policy(),
			[signal("acct-never"), signal("acct-recent")],
		);
		expect(result.outcome === "selected" && result.account.accountId).toBe(
			"acct-recent",
		);
	});

	it("breaks a full tie by account id independent of input order", () => {
		const accounts = [account("acct-b"), account("acct-a")];
		const signals = [signal("acct-b"), signal("acct-a")];
		const forward = selectConnectedAccount(
			intent(),
			accounts,
			policy(),
			signals,
		);
		const reversed = selectConnectedAccount(
			intent(),
			[...accounts].reverse(),
			policy(),
			[...signals].reverse(),
		);
		expect(forward.outcome === "selected" && forward.account.accountId).toBe(
			"acct-a",
		);
		expect(reversed).toEqual(forward);
		if (forward.outcome === "selected") {
			expect(forward.rationale).toEqual({
				regionMatched: false,
				unitCostMicros: 10,
				consideredAccountIds: ["acct-a", "acct-b"],
			});
		}
	});
});
