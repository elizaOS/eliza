/**
 * Contract tests for provider-neutral account, policy, outcome, and receipt
 * serialization using deterministic untrusted wire objects.
 */

import { describe, expect, it } from "vitest";
import {
	normalizeCapabilityActionReceipt,
	normalizeCapabilityExecutionOutcome,
	normalizeCapabilityPolicyDecision,
	normalizeCapabilityRequest,
	normalizeConnectedAccount,
} from "./provider-integrations";

describe("provider integration contracts", () => {
	it("round-trips an opaque connected account without credential fields", () => {
		const account = normalizeConnectedAccount({
			accountId: "conn_opaque_01",
			providerId: "calendar",
			mode: "cloud",
			status: "connected",
			displayName: "Work calendar",
			capabilities: [
				{
					capabilityId: "calendar.events.read",
					riskLevel: "R1",
					status: "available",
				},
				{
					capabilityId: "calendar.events.write",
					riskLevel: "R2",
					status: "needs_scope",
				},
			],
			lastUsedAt: "2026-08-17T12:00:00.000Z",
		});

		const wire = JSON.stringify(account);
		expect(wire).not.toMatch(/token|secret|credential/i);
		expect(normalizeConnectedAccount(JSON.parse(wire))).toEqual(account);
	});

	it("rejects provider tokens and duplicate capability projections", () => {
		const base = {
			accountId: "conn_opaque_01",
			providerId: "calendar",
			mode: "cloud",
			status: "connected",
			displayName: null,
			capabilities: [],
			lastUsedAt: null,
		};
		expect(() =>
			normalizeConnectedAccount({ ...base, accessToken: "must-not-cross" }),
		).toThrow(/unsupported fields/);
		expect(() =>
			normalizeConnectedAccount({
				...base,
				capabilities: [
					{ capabilityId: "mail.read", riskLevel: "R1", status: "available" },
					{ capabilityId: "mail.read", riskLevel: "R1", status: "available" },
				],
			}),
		).toThrow(/unique IDs/);
	});

	it("keeps account selection optional in a normalized capability request", () => {
		expect(
			normalizeCapabilityRequest({
				requestId: "req_01",
				capabilityId: "maps.routes.read",
				operation: "route.plan",
				riskLevel: "R1",
				accountId: null,
			}),
		).toEqual({
			requestId: "req_01",
			capabilityId: "maps.routes.read",
			operation: "route.plan",
			riskLevel: "R1",
			accountId: null,
		});
	});

	it("preserves distinct allowed, confirmation, denied, and unavailable decisions", () => {
		const base = {
			decisionId: "decision_01",
			requestId: "req_01",
			riskLevel: "R3",
		};
		expect(
			normalizeCapabilityPolicyDecision({
				...base,
				outcome: "allowed",
				confirmation: "already_granted",
			}).outcome,
		).toBe("allowed");
		expect(
			normalizeCapabilityPolicyDecision({
				...base,
				outcome: "confirmation_required",
				confirmationId: "confirm_01",
				expiresAt: "2026-08-17T12:05:00.000Z",
			}).outcome,
		).toBe("confirmation_required");
		expect(
			normalizeCapabilityPolicyDecision({
				...base,
				outcome: "denied",
				reasonCode: "domain_policy",
			}).outcome,
		).toBe("denied");
		expect(
			normalizeCapabilityPolicyDecision({
				...base,
				outcome: "unavailable",
				code: "needs_admin",
				retryable: false,
			}),
		).toMatchObject({ outcome: "unavailable", code: "needs_admin" });
	});

	it("binds an existing effect receipt to account, capability, and policy", () => {
		const receipt = normalizeCapabilityActionReceipt({
			accountId: "conn_opaque_01",
			capabilityId: "calendar.events.write",
			policyDecisionId: "decision_01",
			effect: {
				receiptId: "receipt_01",
				operation: "calendar.event.create",
				resource: { kind: "calendar.event", id: "event_opaque_01" },
				artifacts: [],
				idempotency: { key: "request_01", replayed: false },
				observedAt: "2026-08-17T12:00:00.000Z",
				outcome: "preview",
			},
		});
		expect(receipt.effect.outcome).toBe("preview");
		expect(() =>
			normalizeCapabilityActionReceipt({
				...receipt,
				refreshToken: "forbidden",
			}),
		).toThrow(/unsupported fields/);
	});

	it("keeps designed-empty, unavailable, and error outcomes distinct", () => {
		const normalizeStringValue = (value: unknown) => {
			if (typeof value !== "string") throw new TypeError("expected string");
			return value;
		};
		expect(
			normalizeCapabilityExecutionOutcome(
				{ status: "success", value: "result" },
				normalizeStringValue,
			),
		).toEqual({ status: "success", value: "result" });
		expect(
			normalizeCapabilityExecutionOutcome(
				{ status: "empty" },
				normalizeStringValue,
			),
		).toEqual({ status: "empty" });
		expect(
			normalizeCapabilityExecutionOutcome(
				{ status: "unavailable", code: "needs_scope", retryable: true },
				normalizeStringValue,
			),
		).toMatchObject({ status: "unavailable", code: "needs_scope" });
		expect(
			normalizeCapabilityExecutionOutcome(
				{ status: "error", code: "UPSTREAM_SCHEMA_DRIFT", retryable: false },
				normalizeStringValue,
			),
		).toMatchObject({ status: "error", code: "UPSTREAM_SCHEMA_DRIFT" });
	});
});
