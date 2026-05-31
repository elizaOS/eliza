import { describe, expect, it } from "vitest";
import { verifyBlueBubblesWebhookSecret } from "../src/webhook-auth.js";

describe("verifyBlueBubblesWebhookSecret", () => {
	const secret = "operator-shared-secret";

	it("accepts a matching header value", () => {
		expect(verifyBlueBubblesWebhookSecret(secret, secret)).toBe(true);
	});

	it("rejects a missing header", () => {
		expect(verifyBlueBubblesWebhookSecret(secret, undefined)).toBe(false);
	});

	it("rejects a wrong secret", () => {
		expect(verifyBlueBubblesWebhookSecret(secret, "wrong")).toBe(false);
	});

	it("rejects when the configured secret is empty", () => {
		expect(verifyBlueBubblesWebhookSecret("", secret)).toBe(false);
	});
});
