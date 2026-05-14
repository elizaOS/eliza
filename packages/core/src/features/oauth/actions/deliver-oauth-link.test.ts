import { describe, expect, test, vi } from "vitest";
import type { SensitiveRequestDispatchRegistry } from "../../../sensitive-requests/dispatch-registry";
import {
	OAUTH_INTENTS_CLIENT_SERVICE,
	type OAuthIntentEnvelope,
	type OAuthIntentsClient,
} from "../types";
import { deliverOAuthLinkAction } from "./deliver-oauth-link";

const SENSITIVE_DISPATCH_REGISTRY_SERVICE = "SensitiveRequestDispatchRegistry";

function envelope(overrides: Partial<OAuthIntentEnvelope> = {}): OAuthIntentEnvelope {
	return {
		oauthIntentId: "oauth_1",
		provider: "google",
		scopes: ["email"],
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

describe("DELIVER_OAUTH_LINK", () => {
	test("dispatches via the registered adapter", async () => {
		const deliver = vi
			.fn()
			.mockResolvedValue({ delivered: true, target: "dm", channelId: "r1" });
		const adapter = { target: "dm" as const, deliver };
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn().mockReturnValue(adapter),
			list: vi.fn().mockReturnValue([adapter]),
		};
		const client: OAuthIntentsClient = {
			create: vi.fn(),
			get: vi.fn().mockResolvedValue(envelope()),
			cancel: vi.fn(),
			bind: vi.fn(),
			revoke: vi.fn(),
		};

		const result = await deliverOAuthLinkAction.handler(
			createRuntime({
				[OAUTH_INTENTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { oauthIntentId: "oauth_1", target: "dm" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(deliver).toHaveBeenCalledTimes(1);
		const args = deliver.mock.calls[0][0];
		expect(args.request.id).toBe("oauth_1");
		expect(args.request.kind).toBe("oauth");
		expect(args.channelId).toBe("r1");
	});

	test("returns failure when the OAuth intent is not found", async () => {
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn(),
			list: vi.fn().mockReturnValue([]),
		};
		const client: OAuthIntentsClient = {
			create: vi.fn(),
			get: vi.fn().mockResolvedValue(null),
			cancel: vi.fn(),
			bind: vi.fn(),
			revoke: vi.fn(),
		};

		const result = await deliverOAuthLinkAction.handler(
			createRuntime({
				[OAUTH_INTENTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{ parameters: { oauthIntentId: "missing", target: "dm" } } as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("not found");
	});

	test("rejects ineligible delivery target", async () => {
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn(),
			list: vi.fn().mockReturnValue([]),
		};
		const client: OAuthIntentsClient = {
			create: vi.fn(),
			get: vi.fn().mockResolvedValue(envelope()),
			cancel: vi.fn(),
			bind: vi.fn(),
			revoke: vi.fn(),
		};

		const result = await deliverOAuthLinkAction.handler(
			createRuntime({
				[OAUTH_INTENTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{ parameters: { oauthIntentId: "oauth_1", target: "instruct_dm_only" } } as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("not eligible");
	});
});
