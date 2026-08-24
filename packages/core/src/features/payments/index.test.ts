/**
 * Public entry-point contract of the payments feature barrel: the eager
 * FEATURES_PAYMENTS_INDEX bundle-safety anchor, the delivery-target
 * eligibility policy, and live PAYMENT validate/handler behavior reached
 * through the re-exports. Deterministic: service lookups run against a stub
 * runtime; no model, database, or payment provider.
 */

import { describe, expect, test } from "vitest";
import {
	eligibleDeliveryTargetsFor,
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	paymentAction,
	paymentsPlugin,
} from "./index";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

function requestsClient() {
	return { create: () => {}, get: () => {}, cancel: () => {} };
}

describe("payments feature index", () => {
	test("anchors exactly the exported paymentAction and paymentsPlugin under FEATURES_PAYMENTS_INDEX", () => {
		const stashed = (globalThis as Record<string, unknown>)
			.__bundle_safety_FEATURES_PAYMENTS_INDEX__;
		expect(Array.isArray(stashed)).toBe(true);
		expect(stashed).toEqual([paymentAction, paymentsPlugin]);
	});

	test("registers the same PAYMENT action instance the plugin carries", () => {
		expect(paymentsPlugin.actions?.[0]).toBe(paymentAction);
	});

	test("keeps public_link eligible only for any_payer contexts", () => {
		expect(eligibleDeliveryTargetsFor("any_payer")).toEqual([
			"public_link",
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
		]);
	});

	test("restricts verified_payer and specific_payer to authenticated targets", () => {
		const authenticatedOnly = [
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
		];
		for (const kind of ["verified_payer", "specific_payer"] as const) {
			expect(eligibleDeliveryTargetsFor(kind)).toEqual(authenticatedOnly);
		}
	});

	test("falls back to authenticated-only targets for unrecognized kinds", () => {
		expect(eligibleDeliveryTargetsFor("not_a_kind" as never)).toEqual([
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
		]);
	});

	test("handler rejects an unrecognized discriminator without touching payment services", async () => {
		const result = await paymentAction.handler(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{ parameters: { action: "issue_refund" } } as never,
		);
		expect(result.success).toBe(false);
		expect(result.text).toContain("PAYMENT requires action");
	});

	test("handler rejects missing handler options with planner guidance", async () => {
		const result = await paymentAction.handler(
			createRuntime({}) as never,
			message() as never,
			undefined,
			undefined,
		);
		expect(result.success).toBe(false);
		expect(result.text).toContain("PAYMENT requires action");
	});

	test("validate accepts a well-formed create_request under the re-exported service key", async () => {
		const ok = await paymentAction.validate?.(
			createRuntime({
				[PAYMENT_REQUESTS_CLIENT_SERVICE]: requestsClient(),
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "create_request",
					provider: "stripe",
					amountCents: 2500,
					paymentContext: { kind: "any_payer" },
				},
			} as never,
		);
		expect(ok).toBe(true);
	});

	test("validate reads parameters given flat at the options root", async () => {
		const ok = await paymentAction.validate?.(
			createRuntime({
				[PAYMENT_REQUESTS_CLIENT_SERVICE]: requestsClient(),
			}) as never,
			message() as never,
			undefined,
			{
				action: "create_request",
				provider: "x402",
				amountCents: 100,
				paymentContext: { kind: "specific_payer", payerIdentityId: "payer-1" },
			} as never,
		);
		expect(ok).toBe(true);
	});

	test("validate rejects an unrecognized discriminator even with every service present", async () => {
		const ok = await paymentAction.validate?.(
			createRuntime({
				[PAYMENT_REQUESTS_CLIENT_SERVICE]: requestsClient(),
				PaymentBusClient: { waitFor: () => {}, verifyProof: () => {} },
				PaymentSettler: { settle: () => {} },
			}) as never,
			message() as never,
			undefined,
			{ parameters: { action: "refund_everything" } } as never,
		);
		expect(ok).toBe(false);
	});
});
