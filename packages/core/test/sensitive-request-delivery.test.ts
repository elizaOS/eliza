import { describe, expect, it } from "vitest";
import { resolveSensitiveRequestDelivery } from "../src/sensitive-request-policy.ts";

describe("resolveSensitiveRequestDelivery any-payer authenticated links", () => {
	it("marks a cloud authenticated link as authenticated", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "payment",
			paymentContext: "any_payer",
			source: "dm",
			environment: {
				cloud: { available: true, baseUrl: "https://cloud.example" },
			},
		});

		expect(plan.mode).toBe("cloud_authenticated_link");
		expect(plan.authenticated).toBe(true);
	});

	it("marks a tunnel authenticated link as authenticated", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "payment",
			paymentContext: "any_payer",
			source: "dm",
			environment: {
				tunnel: {
					available: true,
					url: "https://tunnel.example",
					authenticated: true,
				},
			},
		});

		expect(plan.mode).toBe("tunnel_authenticated_link");
		expect(plan.authenticated).toBe(true);
	});

	it("leaves a public any-payer link unauthenticated", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "payment",
			paymentContext: "any_payer",
			source: "public",
			environment: {
				cloud: { available: true, baseUrl: "https://cloud.example" },
			},
		});

		expect(plan.mode).toBe("public_link");
		expect(plan.authenticated).toBe(false);
	});

	it("matches the verified-payer cloud plan", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "payment",
			paymentContext: "verified_payer",
			source: "dm",
			environment: {
				cloud: { available: true, baseUrl: "https://cloud.example" },
			},
		});

		expect(plan.mode).toBe("cloud_authenticated_link");
		expect(plan.authenticated).toBe(true);
	});

	it("leaves the private-DM fallback unauthenticated", () => {
		const plan = resolveSensitiveRequestDelivery({
			kind: "payment",
			paymentContext: "any_payer",
			source: "dm",
			environment: {},
		});

		expect(plan.mode).toBe("private_dm");
		expect(plan.authenticated).toBe(false);
	});
});
