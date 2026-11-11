import { describe, expect, it } from "vitest";
import { redactSensitiveRequestMetadata } from "../src/sensitive-request-policy.ts";

describe("redactSensitiveRequestMetadata camelCase keys", () => {
	it("redacts secret words at camelCase boundaries", () => {
		const redacted = redactSensitiveRequestMetadata({
			accessToken: "SECRET1",
			privateKey: "SECRET2",
			clientSecret: "SECRET3",
			bearerToken: "SECRET4",
			myJwt: "SECRET5",
			refreshToken: "SECRET6",
			myTokenValue: "SECRET7",
			AccessToken: "SECRET8",
		}) as Record<string, unknown>;

		for (const key of Object.keys(redacted)) {
			expect(redacted[key]).toBe("[redacted]");
		}
	});

	it("keeps redacting separator and exact keys", () => {
		const redacted = redactSensitiveRequestMetadata({
			apiKey: "SECRET1",
			access_token: "SECRET2",
			password: "SECRET3",
			token: "SECRET4",
			ACCESS_TOKEN: "SECRET5",
		}) as Record<string, unknown>;

		for (const key of Object.keys(redacted)) {
			expect(redacted[key]).toBe("[redacted]");
		}
	});

	it("does not redact ordinary keys that merely contain a secret word", () => {
		const redacted = redactSensitiveRequestMetadata({
			secretary: "keep",
			tokenize: "keep",
			username: "keep",
			publicKey: "keep",
			displayName: "keep",
		}) as Record<string, unknown>;

		for (const key of Object.keys(redacted)) {
			expect(redacted[key]).toBe("keep");
		}
	});

	it("redacts camelCase keys inside nested objects and arrays", () => {
		const redacted = redactSensitiveRequestMetadata({
			nested: { refreshToken: "SECRET1", displayName: "keep" },
			list: [{ accessToken: "SECRET2" }],
		}) as {
			nested: Record<string, unknown>;
			list: Array<Record<string, unknown>>;
		};

		expect(redacted.nested.refreshToken).toBe("[redacted]");
		expect(redacted.nested.displayName).toBe("keep");
		expect(redacted.list[0].accessToken).toBe("[redacted]");
	});
});
