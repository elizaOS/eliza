import { describe, expect, test, vi } from "vitest";
import {
	OAUTH_INTENTS_CLIENT_SERVICE,
	type OAuthIntentEnvelope,
	type OAuthIntentsClient,
} from "../types";
import { createOAuthIntentAction } from "./create-oauth-intent";

function envelope(
	overrides: Partial<OAuthIntentEnvelope> = {},
): OAuthIntentEnvelope {
	return {
		oauthIntentId: "oauth_1",
		provider: "google",
		scopes: ["email", "profile"],
		hostedUrl: "https://accounts.google.com/o/oauth2/auth?...",
		expiresAt: Date.now() + 60_000,
		status: "pending",
		...overrides,
	};
}

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("CREATE_OAUTH_INTENT", () => {
	test("creates an intent and returns eligible delivery targets", async () => {
		const create = vi.fn().mockResolvedValue(envelope());
		const callback = vi.fn();
		const client: OAuthIntentsClient = {
			create,
			get: vi.fn(),
			cancel: vi.fn(),
			bind: vi.fn(),
			revoke: vi.fn(),
		};

		const result = await createOAuthIntentAction.handler(
			createRuntime({ [OAUTH_INTENTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					action: "create",
					provider: "google",
					scopes: ["email", "profile"],
					stateTokenHash: "deadbeefdeadbeef0000000000000000",
				},
			} as never,
			callback,
		);

		expect(result.success).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ action: "CREATE_OAUTH_INTENT" }),
		);
		expect(result.data?.actionName).toBe("CREATE_OAUTH_INTENT");
		expect(result.data?.oauthIntentId).toBe("oauth_1");
		expect(result.data?.eligibleDeliveryTargets).toContain("dm");
		expect(result.data?.eligibleDeliveryTargets).toContain("public_link");
	});

	test("rejects an unknown provider", async () => {
		const client: OAuthIntentsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn(),
			bind: vi.fn(),
			revoke: vi.fn(),
		};

		const result = await createOAuthIntentAction.handler(
			createRuntime({ [OAUTH_INTENTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					provider: "facebook",
					scopes: ["email"],
					stateTokenHash: "deadbeefdeadbeef0000000000000000",
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("rejects when scopes are not strings", async () => {
		const client: OAuthIntentsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn(),
			bind: vi.fn(),
			revoke: vi.fn(),
		};

		const result = await createOAuthIntentAction.handler(
			createRuntime({ [OAUTH_INTENTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					provider: "google",
					scopes: [42, true],
					stateTokenHash: "deadbeefdeadbeef0000000000000000",
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("rejects when stateTokenHash is missing or too short", async () => {
		const client: OAuthIntentsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn(),
			bind: vi.fn(),
			revoke: vi.fn(),
		};

		const result = await createOAuthIntentAction.handler(
			createRuntime({ [OAUTH_INTENTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					provider: "google",
					scopes: ["email"],
					stateTokenHash: "tooshort",
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("validate fails when the OAuthIntentsClient service is missing", async () => {
		const ok = await createOAuthIntentAction.validate?.(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					provider: "google",
					scopes: ["email"],
					stateTokenHash: "deadbeefdeadbeef0000000000000000",
				},
			} as never,
		);
		expect(ok).toBe(false);
	});
});
