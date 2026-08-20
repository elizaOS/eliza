/**
 * Adversarial contract tests for provider-neutral account projection,
 * account-selected policy binding, consume-once confirmation, and receipts.
 */

import { describe, expect, it } from "vitest";
import {
	type AuthorizedCapabilityRequest,
	authorizeCapabilityDispatch,
	type BoundCapabilityRequest,
	bindCapabilityRequest,
	CapabilityAuthorizationCoordinator,
	computeBoundCapabilityRequestDigest,
	normalizeBoundCapabilityRequest,
	normalizeCapabilityActionReceipt,
	normalizeCapabilityConfirmationGrant,
	normalizeCapabilityExecutionOutcome,
	normalizeCapabilityPolicyDecision,
	normalizeCapabilityRequest,
	normalizeConnectedAccount,
	PROVIDER_INTEGRATION_CONTRACT_VERSION,
} from "./provider-integrations";

const VERSION = PROVIDER_INTEGRATION_CONTRACT_VERSION;
const INPUT_DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const BOUND_AT = "2026-08-18T12:00:00.000Z";
const ISSUED_AT = "2026-08-18T12:00:10.000Z";
const CONFIRMED_AT = "2026-08-18T12:00:20.000Z";
const AUTHORIZED_NOW = Date.parse("2026-08-18T12:00:30.000Z");
const EXPIRES_AT = "2026-08-18T12:05:00.000Z";

function account(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		contractVersion: VERSION,
		accountId: "conn_opaque_work",
		providerId: "calendar",
		mode: "cloud",
		status: "connected",
		displayName: "Work calendar",
		capabilities: [
			{
				capabilityId: "calendar.events.write",
				riskLevel: "R2",
				status: "available",
			},
		],
		lastUsedAt: "2026-08-18T05:00:00-07:00",
		...overrides,
	};
}

function request(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		contractVersion: VERSION,
		requestId: "req_create_event_1",
		capabilityId: "calendar.events.write",
		operation: "calendar.event.create",
		riskLevel: "R2",
		accountId: null,
		inputDigest: INPUT_DIGEST,
		...overrides,
	};
}

function bound(
	requestOverrides: Record<string, unknown> = {},
	accountOverrides: Record<string, unknown> = {},
): BoundCapabilityRequest {
	return bindCapabilityRequest(
		request(requestOverrides),
		account(accountOverrides),
		BOUND_AT,
	);
}

function decision(
	requestValue: BoundCapabilityRequest,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		contractVersion: VERSION,
		decisionId: "policy_decision_1",
		requestDigest: requestValue.requestDigest,
		riskLevel: requestValue.riskLevel,
		issuedAt: ISSUED_AT,
		expiresAt: EXPIRES_AT,
		outcome: "allowed",
		confirmation: "not_required",
		...overrides,
	};
}

function authorizationCoordinator(
	isSnapshotCurrent: (
		request: BoundCapabilityRequest,
		now: number,
	) => boolean = () => true,
): CapabilityAuthorizationCoordinator {
	return new CapabilityAuthorizationCoordinator({ isSnapshotCurrent });
}

async function allowedAuthorization(
	requestValue: BoundCapabilityRequest = bound(),
): Promise<AuthorizedCapabilityRequest> {
	const coordinator = authorizationCoordinator();
	const policy = coordinator.register(
		decision(requestValue),
		requestValue,
		AUTHORIZED_NOW,
	);
	return authorizeCapabilityDispatch(requestValue, policy, {
		authorizationConsumer: coordinator,
		now: AUTHORIZED_NOW,
	});
}

function appliedReceipt(
	authorization: AuthorizedCapabilityRequest,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		contractVersion: VERSION,
		authorizationId: authorization.authorizationId,
		policyDecisionId: authorization.policyDecisionId,
		policyDecisionDigest: authorization.policyDecisionDigest,
		confirmationId: authorization.confirmationId,
		confirmationGrantDigest: authorization.confirmationGrantDigest,
		requestDigest: authorization.requestDigest,
		accountId: authorization.account.accountId,
		capabilityId: authorization.capabilityId,
		operation: authorization.operation,
		inputDigest: authorization.inputDigest,
		effect: {
			receiptId: "provider_receipt_1",
			operation: authorization.operation,
			resource: { kind: "calendar.event", id: "event_opaque_1" },
			artifacts: [],
			idempotency: {
				key: authorization.requestDigest,
				replayed: false,
			},
			observedAt: "2026-08-18T12:00:40.000Z",
			outcome: "applied",
			commit: {
				kind: "provider_accepted",
				id: "provider_commit_1",
				committedAt: "2026-08-18T12:00:39.000Z",
			},
		},
		...overrides,
	};
}

describe("provider integration contracts", () => {
	it("round-trips a versioned opaque account and freezes nested state", () => {
		const normalized = normalizeConnectedAccount(account());
		const wire = JSON.stringify(normalized);

		expect(wire).not.toMatch(/token|secret|credential|@/i);
		expect(normalized.lastUsedAt).toBe("2026-08-18T12:00:00.000Z");
		expect(Object.isFrozen(normalized)).toBe(true);
		expect(Object.isFrozen(normalized.capabilities)).toBe(true);
		expect(Object.isFrozen(normalized.capabilities[0])).toBe(true);
		expect(normalizeConnectedAccount(JSON.parse(wire))).toEqual(normalized);
	});

	it("rejects secret-shaped additions, duplicate capabilities, and invalid versions", () => {
		expect(() =>
			normalizeConnectedAccount({
				...account(),
				accessToken: "must-not-cross",
			}),
		).toThrow(/unsupported fields/);
		expect(() =>
			normalizeConnectedAccount(
				account({
					capabilities: [
						{
							capabilityId: "calendar.events.write",
							riskLevel: "R2",
							status: "available",
						},
						{
							capabilityId: "calendar.events.write",
							riskLevel: "R3",
							status: "needs_scope",
						},
					],
				}),
			),
		).toThrow(/unique/);
		expect(() =>
			normalizeConnectedAccount(account({ contractVersion: 1 })),
		).toThrow(/contract version/);
	});

	it("normalizes provider-owned input digests without accepting raw input", () => {
		expect(normalizeCapabilityRequest(request())).toEqual(request());
		expect(() =>
			normalizeCapabilityRequest({
				...request(),
				input: { title: "private meeting" },
			}),
		).toThrow(/unsupported fields/);
		expect(() =>
			normalizeCapabilityRequest(request({ inputDigest: "not-a-digest" })),
		).toThrow(/SHA-256/);
	});

	it("binds account, capability, operation, risk, and exact input", () => {
		const original = bound();
		const variants = [
			bound(
				{ accountId: "conn_opaque_other" },
				{ accountId: "conn_opaque_other" },
			),
			bound(
				{
					capabilityId: "calendar.events.delete",
					operation: "calendar.event.delete",
					riskLevel: "R3",
				},
				{
					capabilities: [
						{
							capabilityId: "calendar.events.delete",
							riskLevel: "R3",
							status: "available",
						},
					],
				},
			),
			bound({ operation: "calendar.event.update" }),
			bound({ riskLevel: "R3" }),
			bound({ inputDigest: OTHER_DIGEST }),
			bindCapabilityRequest(request(), account(), "2026-08-18T12:00:01.000Z"),
		];

		for (const variant of variants) {
			expect(variant.requestDigest).not.toBe(original.requestDigest);
		}
		expect(
			computeBoundCapabilityRequestDigest({
				contractVersion: original.contractVersion,
				requestId: original.requestId,
				account: original.account,
				capabilityId: original.capabilityId,
				operation: original.operation,
				riskLevel: original.riskLevel,
				inputDigest: original.inputDigest,
				boundAt: original.boundAt,
			}),
		).toBe(original.requestDigest);
		const elevatedFromR2 = bound({ riskLevel: "R3" });
		const catalogR3 = bound(
			{ riskLevel: "R3" },
			{
				capabilities: [
					{
						capabilityId: "calendar.events.write",
						riskLevel: "R3",
						status: "available",
					},
				],
			},
		);
		expect(catalogR3.requestDigest).not.toBe(elevatedFromR2.requestDigest);
	});

	it("allows contextual risk elevation but rejects downgrade and unavailable accounts", () => {
		expect(bound({ riskLevel: "R3" }).riskLevel).toBe("R3");
		expect(() => bound({ riskLevel: "R1" })).toThrow(/downgrade/);
		expect(() => bound({}, { status: "revoked" })).toThrow(/not connected/);
		expect(() =>
			bound(
				{},
				{
					capabilities: [
						{
							capabilityId: "calendar.events.write",
							riskLevel: "R2",
							status: "needs_scope",
						},
					],
				},
			),
		).toThrow(/unavailable/);
	});

	it("copies an immutable authorization snapshot and rejects digest tampering", () => {
		const mutable = account();
		const selected = bindCapabilityRequest(request(), mutable, BOUND_AT);
		mutable.status = "revoked";
		const mutableCapability = (
			mutable.capabilities as Array<Record<string, unknown>>
		)[0];
		if (!mutableCapability) throw new Error("fixture capability is missing");
		mutableCapability.riskLevel = "R3";

		expect(selected.account.status).toBe("connected");
		expect(selected.account.capability.riskLevel).toBe("R2");
		expect(Object.isFrozen(selected.account)).toBe(true);
		expect(Object.isFrozen(selected.account.capability)).toBe(true);
		expect(
			normalizeBoundCapabilityRequest(JSON.parse(JSON.stringify(selected))),
		).toEqual(selected);
		expect(() =>
			normalizeBoundCapabilityRequest({
				...selected,
				operation: "calendar.event.delete",
			}),
		).toThrow(/digest/);
		expect(() =>
			normalizeBoundCapabilityRequest({
				...selected,
				account: {
					...selected.account,
					capability: {
						...selected.account.capability,
						riskLevel: "R1",
					},
				},
			}),
		).toThrow(/digest/);
	});

	it("keeps invalid wire values out of fatal error context", () => {
		const sentinel = "secret-token-sentinel";
		const serializedErrors: string[] = [];
		try {
			normalizeCapabilityPolicyDecision({
				...decision(bound()),
				outcome: sentinel,
			});
		} catch (error) {
			serializedErrors.push(JSON.stringify(error));
		}
		try {
			normalizeConnectedAccount({
				...account(),
				[sentinel]: "also-private",
			});
		} catch (error) {
			serializedErrors.push(JSON.stringify(error));
		}
		expect(serializedErrors).toHaveLength(2);
		expect(serializedErrors.join("\n")).not.toContain(sentinel);
	});

	it("sanitizes malformed nested effect proof errors", async () => {
		const authorization = await allowedAuthorization();
		const sentinel = "secret-token-sentinel";
		let serializedError = "";
		try {
			normalizeCapabilityActionReceipt(
				{
					...appliedReceipt(authorization),
					effect: {
						...(appliedReceipt(authorization).effect as Record<
							string,
							unknown
						>),
						receiptId: sentinel,
						outcome: sentinel,
					},
				},
				{
					authorization,
					now: Date.parse("2026-08-18T12:01:00.000Z"),
				},
			);
		} catch (error) {
			serializedError = JSON.stringify(error);
		}
		expect(serializedError).not.toBe("");
		expect(serializedError).not.toContain(sentinel);
	});

	it("requires a registered, current policy decision for dispatch", async () => {
		const selected = bound();
		const rawPolicy = normalizeCapabilityPolicyDecision(decision(selected));
		const unregistered = authorizationCoordinator();
		await expect(
			authorizeCapabilityDispatch(selected, rawPolicy, {
				authorizationConsumer: unregistered,
				now: AUTHORIZED_NOW,
			}),
		).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });

		const coordinator = authorizationCoordinator();
		const policy = coordinator.register(rawPolicy, selected, AUTHORIZED_NOW);
		const authorization = await authorizeCapabilityDispatch(selected, policy, {
			authorizationConsumer: coordinator,
			now: AUTHORIZED_NOW,
		});
		expect(authorization.policyDecisionId).toBe(policy.decisionId);
		expect(authorization.confirmationId).toBeNull();
		expect(Object.isFrozen(authorization)).toBe(true);
		await expect(
			authorizeCapabilityDispatch(selected, policy, {
				authorizationConsumer: coordinator,
				now: AUTHORIZED_NOW,
			}),
		).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });
	});

	it("burns registered authority when the selected account is revoked", async () => {
		const selected = bound();
		let accountCurrent = true;
		const coordinator = authorizationCoordinator(() => accountCurrent);
		const policy = coordinator.register(
			decision(selected),
			selected,
			AUTHORIZED_NOW,
		);
		accountCurrent = false;

		await expect(
			authorizeCapabilityDispatch(selected, policy, {
				authorizationConsumer: coordinator,
				now: AUTHORIZED_NOW,
			}),
		).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });

		accountCurrent = true;
		await expect(
			authorizeCapabilityDispatch(selected, policy, {
				authorizationConsumer: coordinator,
				now: AUTHORIZED_NOW,
			}),
		).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });
	});

	it("fails closed when a snapshot validator is accidentally asynchronous", async () => {
		const selected = bound();
		const asynchronousValidator = (() => Promise.resolve(true)) as unknown as (
			request: BoundCapabilityRequest,
			now: number,
		) => boolean;
		const coordinator = authorizationCoordinator(asynchronousValidator);
		const policy = coordinator.register(
			decision(selected),
			selected,
			AUTHORIZED_NOW,
		);

		await expect(
			authorizeCapabilityDispatch(selected, policy, {
				authorizationConsumer: coordinator,
				now: AUTHORIZED_NOW,
			}),
		).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });
	});

	it("refuses stale policy and altered request reuse", async () => {
		const selected = bound();
		const coordinator = authorizationCoordinator();
		expect(() =>
			coordinator.register(
				decision(selected, { expiresAt: "2026-08-18T12:00:29.000Z" }),
				selected,
				AUTHORIZED_NOW,
			),
		).toThrow(/stale or misbound/);

		const policy = coordinator.register(
			decision(selected),
			selected,
			AUTHORIZED_NOW,
		);
		const altered = bound({ inputDigest: OTHER_DIGEST });
		await expect(
			authorizeCapabilityDispatch(altered, policy, {
				authorizationConsumer: coordinator,
				now: AUTHORIZED_NOW,
			}),
		).rejects.toMatchObject({ code: "UNTRUSTED_CAPABILITY_POLICY_DECISION" });
	});

	it("atomically consumes one exact expiring confirmation under concurrency", async () => {
		const selected = bound();
		const coordinator = authorizationCoordinator();
		const rawDecision = decision(selected, {
			outcome: "confirmation_required",
			confirmation: undefined,
			confirmationId: "confirm_create_event_1",
		});
		delete rawDecision.confirmation;
		const policy = coordinator.register(rawDecision, selected, AUTHORIZED_NOW);
		const grant = coordinator.issue(
			"confirm_create_event_1",
			policy,
			selected,
			CONFIRMED_AT,
			AUTHORIZED_NOW,
		);
		expect(
			normalizeCapabilityConfirmationGrant(JSON.parse(JSON.stringify(grant))),
		).toEqual(grant);
		const options = {
			authorizationConsumer: coordinator,
			confirmationGrant: grant,
			now: AUTHORIZED_NOW,
		};
		const results = await Promise.allSettled([
			authorizeCapabilityDispatch(selected, policy, options),
			authorizeCapabilityDispatch(selected, policy, options),
		]);

		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
			1,
		);
		expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
			1,
		);
		const fulfilled = results.find(
			(result): result is PromiseFulfilledResult<AuthorizedCapabilityRequest> =>
				result.status === "fulfilled",
		);
		expect(fulfilled?.value.confirmationId).toBe("confirm_create_event_1");
		expect(fulfilled?.value.policyDecisionDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(fulfilled?.value.confirmationGrantDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("burns confirmation but refuses dispatch when policy expires during consume", async () => {
		const selected = bound();
		const coordinator = authorizationCoordinator();
		const rawDecision = decision(selected, {
			outcome: "confirmation_required",
			confirmationId: "confirm_expiring",
			expiresAt: "2026-08-18T12:00:31.000Z",
		});
		delete rawDecision.confirmation;
		const policy = coordinator.register(rawDecision, selected, AUTHORIZED_NOW);
		const grant = {
			contractVersion: VERSION,
			confirmationId: "confirm_expiring",
			decisionId: policy.decisionId,
			requestDigest: selected.requestDigest,
			confirmedAt: CONFIRMED_AT,
			expiresAt: "2026-08-18T12:00:31.000Z",
		};
		const clockValues = [
			AUTHORIZED_NOW,
			Date.parse("2026-08-18T12:00:32.000Z"),
		];
		let consumed = 0;

		await expect(
			authorizeCapabilityDispatch(selected, policy, {
				confirmationGrant: grant,
				authorizationConsumer: {
					async consume() {
						consumed += 1;
					},
				},
				clock: () => clockValues.shift() ?? Number.NaN,
			}),
		).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });
		expect(consumed).toBe(1);
	});

	it("burns consumed authority when the trusted clock moves backward", async () => {
		const selected = bound();
		const policy = normalizeCapabilityPolicyDecision(decision(selected));
		const clockValues = [
			AUTHORIZED_NOW,
			Date.parse("2026-08-18T12:00:29.000Z"),
		];
		let consumed = 0;

		await expect(
			authorizeCapabilityDispatch(selected, policy, {
				authorizationConsumer: {
					async consume() {
						consumed += 1;
					},
				},
				clock: () => clockValues.shift() ?? Number.NaN,
			}),
		).rejects.toMatchObject({ code: "STALE_CAPABILITY_AUTHORIZATION" });
		expect(consumed).toBe(1);
	});

	it("rejects confirmation substitution by account, operation, input, or decision", async () => {
		const selected = bound();
		const coordinator = authorizationCoordinator();
		const rawDecision = decision(selected, {
			outcome: "confirmation_required",
			confirmationId: "confirm_create_event_2",
		});
		delete rawDecision.confirmation;
		const policy = coordinator.register(rawDecision, selected, AUTHORIZED_NOW);
		const grant = coordinator.issue(
			"confirm_create_event_2",
			policy,
			selected,
			CONFIRMED_AT,
			AUTHORIZED_NOW,
		);

		for (const altered of [
			bound({ accountId: "conn_other" }, { accountId: "conn_other" }),
			bound({ operation: "calendar.event.delete" }),
			bound({ inputDigest: OTHER_DIGEST }),
		]) {
			await expect(
				authorizeCapabilityDispatch(altered, policy, {
					authorizationConsumer: coordinator,
					confirmationGrant: grant,
					now: AUTHORIZED_NOW,
				}),
			).rejects.toMatchObject({ code: "UNTRUSTED_CAPABILITY_POLICY_DECISION" });
		}
	});

	it("binds effect proof to immutable authority and excludes private input", async () => {
		const authorization = await allowedAuthorization();
		const receipt = normalizeCapabilityActionReceipt(
			appliedReceipt(authorization),
			{
				authorization,
				now: Date.parse("2026-08-18T12:01:00.000Z"),
			},
		);
		const wire = JSON.stringify(receipt);

		expect(receipt.effect.outcome).toBe("applied");
		expect(receipt.effect.idempotency.key).toBe(authorization.requestDigest);
		expect(wire).not.toMatch(/private meeting|token|secret|credential/i);
	});

	it("rejects old receipt relabeling and every authority substitution", async () => {
		const authorization = await allowedAuthorization();
		const base = appliedReceipt(authorization);
		const mutations: Record<string, unknown>[] = [
			{ authorizationId: "old_authorization" },
			{ policyDecisionId: "other_decision" },
			{ policyDecisionDigest: OTHER_DIGEST },
			{ confirmationId: "other_confirmation" },
			{ confirmationGrantDigest: OTHER_DIGEST },
			{ requestDigest: OTHER_DIGEST },
			{ accountId: "conn_other" },
			{ capabilityId: "calendar.events.delete" },
			{ operation: "calendar.event.delete" },
			{ inputDigest: OTHER_DIGEST },
			{
				effect: {
					...(base.effect as Record<string, unknown>),
					operation: "calendar.event.delete",
				},
			},
			{
				effect: {
					...(base.effect as Record<string, unknown>),
					idempotency: { key: OTHER_DIGEST, replayed: false },
				},
			},
		];

		for (const mutation of mutations) {
			expect(() =>
				normalizeCapabilityActionReceipt(
					{ ...base, ...mutation },
					{
						authorization,
						now: Date.parse("2026-08-18T12:01:00.000Z"),
					},
				),
			).toThrow(/does not match/);
		}
	});

	it("rejects pre-authorization proof and fabricated authorization objects", async () => {
		const authorization = await allowedAuthorization();
		const base = appliedReceipt(authorization);
		expect(() =>
			normalizeCapabilityActionReceipt(
				{
					...base,
					effect: {
						...(base.effect as Record<string, unknown>),
						observedAt: "2026-08-18T12:00:29.000Z",
					},
				},
				{
					authorization,
					now: Date.parse("2026-08-18T12:01:00.000Z"),
				},
			),
		).toThrow(/chronology/);
		expect(() =>
			normalizeCapabilityActionReceipt(
				{
					...base,
					effect: {
						...(base.effect as Record<string, unknown>),
						commit: {
							kind: "provider_accepted",
							id: "old_provider_commit",
							committedAt: "2026-08-18T12:00:29.000Z",
						},
					},
				},
				{
					authorization,
					now: Date.parse("2026-08-18T12:01:00.000Z"),
				},
			),
		).toThrow(/commit chronology/);
		expect(() =>
			normalizeCapabilityActionReceipt(base, {
				authorization: {
					...authorization,
				} as AuthorizedCapabilityRequest,
				now: Date.parse("2026-08-18T12:01:00.000Z"),
			}),
		).toThrow(/trusted dispatch authority/);

		const relabeledAccount = {
			...authorization.account,
			accountId: "conn_other",
		};
		const symbolBrandedForgery = {
			...authorization,
			account: relabeledAccount,
		} as AuthorizedCapabilityRequest;
		for (const symbol of Object.getOwnPropertySymbols(authorization)) {
			Object.defineProperty(symbolBrandedForgery, symbol, {
				value: authorization[symbol as keyof typeof authorization],
			});
		}
		expect(() =>
			normalizeCapabilityActionReceipt(
				{
					...base,
					accountId: "conn_other",
				},
				{
					authorization: symbolBrandedForgery,
					now: Date.parse("2026-08-18T12:01:00.000Z"),
				},
			),
		).toThrow(/trusted dispatch authority/);
	});

	it("keeps designed-empty, unavailable, and error outcomes distinct", () => {
		const normalizeString = (value: unknown): string => {
			if (typeof value !== "string") throw new TypeError("expected string");
			return value;
		};
		expect(
			normalizeCapabilityExecutionOutcome(
				{ contractVersion: VERSION, status: "success", value: "result" },
				normalizeString,
			),
		).toMatchObject({ status: "success", value: "result" });
		expect(
			normalizeCapabilityExecutionOutcome(
				{ contractVersion: VERSION, status: "empty" },
				normalizeString,
			),
		).toMatchObject({ status: "empty" });
		expect(
			normalizeCapabilityExecutionOutcome(
				{
					contractVersion: VERSION,
					status: "unavailable",
					code: "needs_scope",
					retryable: true,
				},
				normalizeString,
			),
		).toMatchObject({ status: "unavailable", code: "needs_scope" });
		expect(
			normalizeCapabilityExecutionOutcome(
				{
					contractVersion: VERSION,
					status: "error",
					code: "UPSTREAM_SCHEMA_DRIFT",
					retryable: false,
				},
				normalizeString,
			),
		).toMatchObject({ status: "error", code: "UPSTREAM_SCHEMA_DRIFT" });
	});
});
