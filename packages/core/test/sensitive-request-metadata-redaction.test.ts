import { describe, expect, it } from "vitest";
import { redactSensitiveRequestMetadata } from "../src/sensitive-request-policy.ts";

/**
 * Regression guard for the sensitive-request metadata redaction contract:
 * `redactSensitiveRequestMetadata` masks any secret-looking key before the
 * metadata is logged, persisted, or returned. The mask decision is the union
 * of the separator-anchored words below and the shared credential-name policy
 * in `security/log-redaction.ts`, so camelCase compounds like `accessToken`
 * are masked alongside their snake_case twins, while the non-secret
 * diagnostics and documented id/url fields stay readable.
 */
describe("sensitive request metadata redaction", () => {
	it("masks camelCase credential keys together with their snake_case twins", () => {
		const redacted = redactSensitiveRequestMetadata({
			accessToken: "camel-access-token",
			refreshToken: "camel-refresh-token",
			clientSecret: "camel-client-secret",
			userPassword: "camel-password",
			sessionToken: "camel-session-token",
			refresh_token: "snake-refresh-token",
			"x-api-key": "kebab-api-key",
			apiKey: "camel-api-key",
			authorization: "bearer-authorization",
			authorizationHeader: "camel-authorization-header",
		}) as Record<string, unknown>;
		for (const [key, value] of Object.entries(redacted)) {
			expect(value, `${key} is masked`).toBe("[redacted]");
		}
	});

	it("keeps masked the series the anchored words already covered", () => {
		const redacted = redactSensitiveRequestMetadata({
			private: "private-field",
			request_signature: "signature-value",
			webhookUrl: "https://hooks.example/t",
			session: "session-value",
		}) as Record<string, unknown>;
		for (const [key, value] of Object.entries(redacted)) {
			expect(value, `${key} is masked`).toBe("[redacted]");
		}
	});

	it("keeps non-secret diagnostics and documented id/url fields readable", () => {
		const redacted = redactSensitiveRequestMetadata({
			idempotencyKey: "idem-1",
			tokenCount: 42,
			childSessionId: "session-id-1",
			requestId: "req-1",
			authorizationUrl: "https://consent.example/authorize?client_id=1",
			credentialScopeId: "vault://secrets/scope",
			channelId: "channel-1",
		}) as Record<string, unknown>;
		for (const [key, value] of Object.entries(redacted)) {
			expect(value, `${key} stays readable`).not.toBe("[redacted]");
		}
	});

	it("applies the mask at every nesting level and inside arrays", () => {
		const redacted = redactSensitiveRequestMetadata({
			http: {
				url: "https://cb.example/hook",
				headers: [
					{ accessToken: "camel-access-token" },
					{ kind: "text/plain", "x-api-key": "kebab-api-key" },
				],
			},
		}) as { http: { headers: Record<string, unknown>[] } };
		expect(redacted.http.headers[0]?.accessToken).toBe("[redacted]");
		expect(redacted.http.headers[1]?.["x-api-key"]).toBe("[redacted]");
		expect(redacted.http.headers[1]?.kind).toBe("text/plain");
		expect(redacted.http.url).toBe("https://cb.example/hook");
	});

	it("passes primitives through unchanged", () => {
		expect(redactSensitiveRequestMetadata("plain")).toBe("plain");
		expect(redactSensitiveRequestMetadata(7)).toBe(7);
		expect(redactSensitiveRequestMetadata(null)).toBeNull();
		expect(redactSensitiveRequestMetadata([1, "two"])).toEqual([1, "two"]);
	});
});
