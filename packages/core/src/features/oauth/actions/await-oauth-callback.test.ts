/**
 * Unit tests for the AWAIT_OAUTH_CALLBACK action and its contract with the
 * real in-process callback bus. The deterministic harness covers validation,
 * parameter parsing, timeout selection, result shaping, and failure states
 * without a live OAuth provider or network.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { IAgentRuntime, Memory } from "../../../types/index.ts";
import { LocalOAuthCallbackBus } from "../local-callback-bus.ts";
import {
	OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
	type OAuthCallbackResult,
} from "../types.ts";
import { awaitOAuthCallbackAction } from "./await-oauth-callback.ts";

function createRuntime(bus: LocalOAuthCallbackBus | null): IAgentRuntime {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === OAUTH_CALLBACK_BUS_CLIENT_SERVICE ? bus : null,
	} as unknown as IAgentRuntime;
}

function message(): Memory {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "" },
	} as Memory;
}

function createBus(): LocalOAuthCallbackBus {
	return new LocalOAuthCallbackBus(createRuntime(null));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("AWAIT_OAUTH_CALLBACK", () => {
	test("validates nested and direct parameters only when the callback bus is available", async () => {
		const bus = createBus();
		const runtime = createRuntime(bus);

		await expect(
			awaitOAuthCallbackAction.validate?.(runtime, message(), undefined, {
				parameters: { oauthIntentId: "oauth_nested" },
			} as never),
		).resolves.toBe(true);
		await expect(
			awaitOAuthCallbackAction.validate?.(runtime, message(), undefined, {
				oauthIntentId: "oauth_direct",
			} as never),
		).resolves.toBe(true);
		await expect(
			awaitOAuthCallbackAction.validate?.(
				createRuntime(null),
				message(),
				undefined,
				{ parameters: { oauthIntentId: "oauth_1" } } as never,
			),
		).resolves.toBe(false);

		for (const oauthIntentId of ["", 42, undefined]) {
			await expect(
				awaitOAuthCallbackAction.validate?.(runtime, message(), undefined, {
					parameters: { oauthIntentId },
				} as never),
			).resolves.toBe(false);
		}
	});

	test("returns a failure when the callback bus is unavailable", async () => {
		const result = await awaitOAuthCallbackAction.handler(
			createRuntime(null),
			message(),
			undefined,
			{ parameters: { oauthIntentId: "oauth_1" } } as never,
		);

		expect(result).toEqual({
			success: false,
			text: "OAuthCallbackBusClient not available",
			data: { actionName: "AWAIT_OAUTH_CALLBACK" },
		});
	});

	test("rejects a missing intent id without starting a wait", async () => {
		const bus = createBus();
		const result = await awaitOAuthCallbackAction.handler(
			createRuntime(bus),
			message(),
			undefined,
			{ parameters: { oauthIntentId: 42 } } as never,
		);

		expect(result).toEqual({
			success: false,
			text: "Missing required parameter: oauthIntentId",
			data: { actionName: "AWAIT_OAUTH_CALLBACK" },
		});
		expect(bus.isWaiting("")).toBe(false);
	});

	test("returns a sanitized successful result when the real bus publishes a binding", async () => {
		const bus = createBus();
		const resultPromise = awaitOAuthCallbackAction.handler(
			createRuntime(bus),
			message(),
			undefined,
			{
				parameters: { oauthIntentId: "oauth_bound", timeoutMs: 5_000 },
			} as never,
		);
		const callback: OAuthCallbackResult & { accessToken: string } = {
			oauthIntentId: "oauth_bound",
			provider: "github",
			status: "bound",
			connectorIdentityId: "identity-42",
			scopesGranted: ["repo"],
			receivedAt: 123,
			accessToken: "must-not-leak",
		};

		expect(bus.publish(callback)).toBe(true);
		const result = await resultPromise;

		expect(result.success).toBe(true);
		expect(result.text).toBe("OAuth intent oauth_bound bound.");
		expect(result.data).toEqual({
			actionName: "AWAIT_OAUTH_CALLBACK",
			callback: {
				oauthIntentId: "oauth_bound",
				provider: "github",
				status: "bound",
				connectorIdentityId: "identity-42",
				scopesGranted: ["repo"],
				error: undefined,
				receivedAt: 123,
			},
		});
		expect(result.data?.callback).not.toHaveProperty("accessToken");
	});

	test("reports a denied callback and includes its error", async () => {
		const bus = createBus();
		const resultPromise = awaitOAuthCallbackAction.handler(
			createRuntime(bus),
			message(),
			undefined,
			{ oauthIntentId: "oauth_denied", timeoutMs: 5_000 } as never,
		);

		bus.publish({
			oauthIntentId: "oauth_denied",
			provider: "google",
			status: "denied",
			error: "user declined",
		});

		const result = await resultPromise;
		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"OAuth intent oauth_denied ended in status denied: user declined.",
		);
	});

	test("forwards a positive finite timeout to the callback bus", async () => {
		vi.useFakeTimers();
		const bus = createBus();
		const resultPromise = awaitOAuthCallbackAction.handler(
			createRuntime(bus),
			message(),
			undefined,
			{ parameters: { oauthIntentId: "oauth_short", timeoutMs: 25 } } as never,
		);

		await vi.advanceTimersByTimeAsync(25);
		const result = await resultPromise;

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"OAuth intent oauth_short ended in status expired: timed out after 25ms.",
		);
	});

	test.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "25"])(
		"uses the default timeout for invalid timeout value %s",
		async (timeoutMs) => {
			vi.useFakeTimers();
			const bus = createBus();
			const resultPromise = awaitOAuthCallbackAction.handler(
				createRuntime(bus),
				message(),
				undefined,
				{
					parameters: { oauthIntentId: "oauth_default", timeoutMs },
				} as never,
			);

			await vi.advanceTimersByTimeAsync(600_000);
			const result = await resultPromise;

			expect(result.text).toContain("timed out after 600000ms");
		},
	);

	test("omits an error suffix when an expired result has no error", async () => {
		const bus = createBus();
		const resultPromise = awaitOAuthCallbackAction.handler(
			createRuntime(bus),
			message(),
			undefined,
			{ parameters: { oauthIntentId: "oauth_expired" } } as never,
		);

		bus.publish({ oauthIntentId: "oauth_expired", status: "expired" });

		const result = await resultPromise;
		expect(result.text).toBe(
			"OAuth intent oauth_expired ended in status expired.",
		);
	});
});
