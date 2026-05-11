import { describe, expect, test } from "vitest";
import { paymentsPlugin } from "./plugin";

describe("paymentsPlugin", () => {
	test("registers all six atomic payment actions under stable names", () => {
		expect(paymentsPlugin.name).toBe("payments");
		const actionNames = (paymentsPlugin.actions ?? []).map((a) => a.name);
		expect(actionNames.sort()).toEqual(
			[
				"AWAIT_PAYMENT_CALLBACK",
				"CANCEL_PAYMENT_REQUEST",
				"CREATE_PAYMENT_REQUEST",
				"DELIVER_PAYMENT_LINK",
				"SETTLE_PAYMENT",
				"VERIFY_PAYMENT_PAYLOAD",
			].sort(),
		);
	});

	test("does not register any services, providers, or evaluators", () => {
		expect(paymentsPlugin.services ?? []).toHaveLength(0);
		expect(paymentsPlugin.providers ?? []).toHaveLength(0);
		expect(paymentsPlugin.evaluators ?? []).toHaveLength(0);
	});
});
