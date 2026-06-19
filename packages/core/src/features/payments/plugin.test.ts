import { describe, expect, test } from "vitest";
import { paymentsPlugin } from "./plugin";

describe("paymentsPlugin", () => {
	test("registers PAYMENT as the only canonical payment action", () => {
		expect(paymentsPlugin.name).toBe("payments");
		const actionNames = (paymentsPlugin.actions ?? []).map((a) => a.name);
		expect(actionNames).toEqual(["PAYMENT"]);
		const payment = paymentsPlugin.actions?.[0];
		const discriminator = payment?.parameters?.find((p) => p.name === "action");
		expect(discriminator?.schema).toMatchObject({
			enum: [
				"create_request",
				"deliver_link",
				"verify_payload",
				"settle",
				"await_callback",
				"cancel_request",
			],
		});
	});

	test("does not register any services, providers, or evaluators", () => {
		expect(paymentsPlugin.services ?? []).toHaveLength(0);
		expect(paymentsPlugin.providers ?? []).toHaveLength(0);
		expect(paymentsPlugin.evaluators ?? []).toHaveLength(0);
	});
});
