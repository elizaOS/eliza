/**
 * Behavioural coverage for the payments feature's runtime surface:
 * `eligibleDeliveryTargetsFor`, the public-link eligibility gate the PAYMENT
 * action applies before dispatching a hosted link, plus the service-name
 * registry keys the actions resolve cloud clients through and the context-kind
 * enumeration fed into the action parameter schema. Drives the real module
 * directly; no mocks and no runtime harness.
 */

import { describe, expect, test } from "vitest";
import {
	eligibleDeliveryTargetsFor,
	PAYMENT_BUS_CLIENT_SERVICE,
	PAYMENT_CONTEXT_KINDS,
	PAYMENT_REQUESTS_CLIENT_SERVICE,
	PAYMENT_SETTLER_SERVICE,
} from "./types";

describe("eligibleDeliveryTargetsFor", () => {
	test("any_payer is the only context eligible for public_link delivery", () => {
		expect(eligibleDeliveryTargetsFor("any_payer")).toEqual([
			"public_link",
			"dm",
			"owner_app_inline",
			"cloud_authenticated_link",
			"tunnel_authenticated_link",
		]);
	});

	test.each(["verified_payer", "specific_payer"] as const)(
		"%s falls back to authenticated routes only",
		(kind) => {
			const targets = eligibleDeliveryTargetsFor(kind);
			expect(targets).not.toContain("public_link");
			expect(targets).toEqual([
				"dm",
				"owner_app_inline",
				"cloud_authenticated_link",
				"tunnel_authenticated_link",
			]);
		},
	);

	test("every registered context kind resolves to a non-empty target list", () => {
		for (const kind of PAYMENT_CONTEXT_KINDS) {
			const targets = eligibleDeliveryTargetsFor(kind);
			expect(targets.length).toBeGreaterThan(0);
			if (kind !== "any_payer") {
				expect(targets).not.toContain("public_link");
			}
		}
	});

	test("each call returns a fresh array so caller mutation cannot leak into later lookups", () => {
		const first = eligibleDeliveryTargetsFor("any_payer");
		const second = eligibleDeliveryTargetsFor("any_payer");
		expect(first).not.toBe(second);
		first.pop();
		expect(second).toContain("tunnel_authenticated_link");
		expect(eligibleDeliveryTargetsFor("any_payer")).toHaveLength(5);
	});
});

describe("payment service registry keys", () => {
	test("registers the cloud adapters under their stable getService keys", () => {
		expect(PAYMENT_REQUESTS_CLIENT_SERVICE).toBe("PaymentRequestsClient");
		expect(PAYMENT_BUS_CLIENT_SERVICE).toBe("PaymentBusClient");
		expect(PAYMENT_SETTLER_SERVICE).toBe("PaymentSettler");
	});

	test("registry keys are pairwise distinct", () => {
		const keys = [
			PAYMENT_REQUESTS_CLIENT_SERVICE,
			PAYMENT_BUS_CLIENT_SERVICE,
			PAYMENT_SETTLER_SERVICE,
		];
		expect(new Set(keys).size).toBe(keys.length);
	});
});

describe("PAYMENT_CONTEXT_KINDS", () => {
	test("carries no duplicates into the action parameter schema enum", () => {
		expect(new Set(PAYMENT_CONTEXT_KINDS).size).toBe(
			PAYMENT_CONTEXT_KINDS.length,
		);
		expect(PAYMENT_CONTEXT_KINDS).toContain("any_payer");
	});
});
