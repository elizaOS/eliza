/**
 * Covers the webhook shared-secret helpers: constant-time secret comparison,
 * case-insensitive/array header reads, runtime-setting-over-env precedence, and
 * end-to-end authorization gating. Deterministic stubs, no live server.
 */
import type { IAgentRuntime, RouteRequest } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BLUEBUBBLES_WEBHOOK_SECRET_HEADER,
	isBlueBubblesWebhookAuthorized,
	readRouteHeader,
	resolveBlueBubblesWebhookSecret,
	verifyBlueBubblesWebhookSecret,
} from "../src/webhook-auth.js";

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

describe("BlueBubbles webhook auth helpers", () => {
	afterEach(() => {
		delete process.env.BLUEBUBBLES_WEBHOOK_SECRET;
	});

	it("reads lowercase, original case, uppercase, and array route headers", () => {
		expect(
			readRouteHeader(
				{
					headers: {
						[BLUEBUBBLES_WEBHOOK_SECRET_HEADER.toLowerCase()]: "lower",
					},
				} as RouteRequest,
				BLUEBUBBLES_WEBHOOK_SECRET_HEADER,
			),
		).toBe("lower");
		expect(
			readRouteHeader(
				{
					headers: {
						[BLUEBUBBLES_WEBHOOK_SECRET_HEADER]: "original",
					},
				} as RouteRequest,
				BLUEBUBBLES_WEBHOOK_SECRET_HEADER,
			),
		).toBe("original");
		expect(
			readRouteHeader(
				{
					headers: {
						[BLUEBUBBLES_WEBHOOK_SECRET_HEADER.toUpperCase()]: [
							"first",
							"second",
						],
					},
				} as RouteRequest,
				BLUEBUBBLES_WEBHOOK_SECRET_HEADER,
			),
		).toBe("first");
	});

	it("prefers a trimmed runtime secret over the environment", () => {
		process.env.BLUEBUBBLES_WEBHOOK_SECRET = "env-secret";
		const runtime = {
			getSetting: vi.fn(() => " runtime-secret "),
		} as unknown as IAgentRuntime;

		expect(resolveBlueBubblesWebhookSecret(runtime)).toBe("runtime-secret");
	});

	it("falls back to a trimmed environment secret", () => {
		process.env.BLUEBUBBLES_WEBHOOK_SECRET = " env-secret ";
		const runtime = {
			getSetting: vi.fn(() => undefined),
		} as unknown as IAgentRuntime;

		expect(resolveBlueBubblesWebhookSecret(runtime)).toBe("env-secret");
	});

	it("authorizes only requests with the configured shared secret", () => {
		const runtime = {
			getSetting: vi.fn(() => "operator-shared-secret"),
		} as unknown as IAgentRuntime;

		expect(
			isBlueBubblesWebhookAuthorized(runtime, {
				headers: {
					[BLUEBUBBLES_WEBHOOK_SECRET_HEADER]: "operator-shared-secret",
				},
			} as RouteRequest),
		).toBe(true);
		expect(
			isBlueBubblesWebhookAuthorized(runtime, {
				headers: {
					[BLUEBUBBLES_WEBHOOK_SECRET_HEADER]: "wrong",
				},
			} as RouteRequest),
		).toBe(false);
	});
});
