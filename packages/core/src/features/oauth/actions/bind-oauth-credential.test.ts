/**
 * Unit tests for the BIND_OAUTH_CREDENTIAL action's validation and bind
 * transition. The deterministic harness supplies only the runtime service
 * boundary while exercising the real action metadata, parameter parsing,
 * scope normalization, failure responses, and successful result shaping.
 */
import { describe, expect, test, vi } from "vitest";
import {
	OAUTH_INTENTS_CLIENT_SERVICE,
	type OAuthBindResult,
	type OAuthIntentsClient,
} from "../types";
import { bindOAuthCredentialAction } from "./bind-oauth-credential";

function createClient(bind = vi.fn()): OAuthIntentsClient {
	return {
		create: vi.fn(),
		get: vi.fn(),
		cancel: vi.fn(),
		bind,
		revoke: vi.fn(),
	};
}

function createRuntime(client: OAuthIntentsClient | null) {
	return {
		getService: (name: string) =>
			name === OAUTH_INTENTS_CLIENT_SERVICE ? client : null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("BIND_OAUTH_CREDENTIAL", () => {
	test("declares the expected action metadata", () => {
		expect(bindOAuthCredentialAction.name).toBe("BIND_OAUTH_CREDENTIAL");
		expect(bindOAuthCredentialAction.suppressPostActionContinuation).toBe(true);
		expect(bindOAuthCredentialAction.similes).toEqual([
			"CONFIRM_OAUTH_BIND",
			"FINALIZE_OAUTH_BIND",
		]);
		expect(bindOAuthCredentialAction.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "oauthIntentId", required: true }),
				expect.objectContaining({
					name: "connectorIdentityId",
					required: true,
				}),
				expect.objectContaining({ name: "scopesGranted", required: false }),
			]),
		);
	});

	test("validates nested parameters when the client service is available", async () => {
		const valid = await bindOAuthCredentialAction.validate?.(
			createRuntime(createClient()) as never,
			message() as never,
			undefined,
			{
				parameters: {
					oauthIntentId: "oauth_1",
					connectorIdentityId: "google-user-1",
				},
			} as never,
		);

		expect(valid).toBe(true);
	});

	test.each([
		["missing service", null, "oauth_1", "google-user-1"],
		["missing OAuth intent id", createClient(), undefined, "google-user-1"],
		["empty OAuth intent id", createClient(), "", "google-user-1"],
		["non-string OAuth intent id", createClient(), 42, "google-user-1"],
		["missing connector identity id", createClient(), "oauth_1", undefined],
		["empty connector identity id", createClient(), "oauth_1", ""],
		["non-string connector identity id", createClient(), "oauth_1", false],
	])(
		"rejects validation for %s",
		async (_case, client, oauthIntentId, connectorIdentityId) => {
			const valid = await bindOAuthCredentialAction.validate?.(
				createRuntime(client) as never,
				message() as never,
				undefined,
				{ parameters: { oauthIntentId, connectorIdentityId } } as never,
			);

			expect(valid).toBe(false);
		},
	);

	test("returns a structured failure when the client service is unavailable", async () => {
		const result = await bindOAuthCredentialAction.handler(
			createRuntime(null) as never,
			message() as never,
			undefined,
			{
				parameters: {
					oauthIntentId: "oauth_1",
					connectorIdentityId: "google-user-1",
				},
			} as never,
		);

		expect(result).toEqual({
			success: false,
			text: "OAuthIntentsClient not available",
			data: { actionName: "BIND_OAUTH_CREDENTIAL" },
		});
	});

	test.each([
		[undefined, "google-user-1"],
		["oauth_1", undefined],
		["", "google-user-1"],
		["oauth_1", ""],
		[42, "google-user-1"],
		["oauth_1", false],
	])(
		"does not bind when required parameters are invalid",
		async (oauthIntentId, connectorIdentityId) => {
			const bind = vi.fn();
			const result = await bindOAuthCredentialAction.handler(
				createRuntime(createClient(bind)) as never,
				message() as never,
				undefined,
				{ parameters: { oauthIntentId, connectorIdentityId } } as never,
			);

			expect(result).toEqual({
				success: false,
				text: "Missing required parameters: oauthIntentId, connectorIdentityId",
				data: { actionName: "BIND_OAUTH_CREDENTIAL" },
			});
			expect(bind).not.toHaveBeenCalled();
		},
	);

	test("binds direct parameters and filters invalid granted scopes", async () => {
		const bindResult: OAuthBindResult = {
			oauthIntentId: "oauth_1",
			provider: "google",
			connectorIdentityId: "google-user-1",
			scopesGranted: ["email", "profile"],
		};
		const bind = vi.fn().mockResolvedValue(bindResult);
		const callback = vi.fn();

		const result = await bindOAuthCredentialAction.handler(
			createRuntime(createClient(bind)) as never,
			message() as never,
			undefined,
			{
				oauthIntentId: "oauth_1",
				connectorIdentityId: "google-user-1",
				scopesGranted: ["email", "", 42, false, "profile"],
			} as never,
			callback,
		);

		expect(bind).toHaveBeenCalledOnce();
		expect(bind).toHaveBeenCalledWith({
			oauthIntentId: "oauth_1",
			connectorIdentityId: "google-user-1",
			scopesGranted: ["email", "profile"],
		});
		expect(callback).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: true,
			text: "Bound OAuth intent oauth_1 to google-user-1.",
			data: { actionName: "BIND_OAUTH_CREDENTIAL", bind: bindResult },
		});
	});

	test("omits scopes when the granted-scope value is not an array", async () => {
		const bindResult: OAuthBindResult = {
			oauthIntentId: "oauth_2",
			provider: "github",
			connectorIdentityId: "github-user-2",
		};
		const bind = vi.fn().mockResolvedValue(bindResult);

		await bindOAuthCredentialAction.handler(
			createRuntime(createClient(bind)) as never,
			message() as never,
			undefined,
			{
				parameters: {
					oauthIntentId: "oauth_2",
					connectorIdentityId: "github-user-2",
					scopesGranted: "repo",
				},
			} as never,
		);

		expect(bind).toHaveBeenCalledWith({
			oauthIntentId: "oauth_2",
			connectorIdentityId: "github-user-2",
			scopesGranted: undefined,
		});
	});

	test("prefers nested parameters over direct option fields", async () => {
		const bind = vi.fn().mockResolvedValue({
			oauthIntentId: "nested-oauth",
			provider: "slack",
			connectorIdentityId: "nested-identity",
		});

		await bindOAuthCredentialAction.handler(
			createRuntime(createClient(bind)) as never,
			message() as never,
			undefined,
			{
				oauthIntentId: "direct-oauth",
				connectorIdentityId: "direct-identity",
				parameters: {
					oauthIntentId: "nested-oauth",
					connectorIdentityId: "nested-identity",
				},
			} as never,
		);

		expect(bind).toHaveBeenCalledWith({
			oauthIntentId: "nested-oauth",
			connectorIdentityId: "nested-identity",
			scopesGranted: undefined,
		});
	});

	test("propagates a client bind rejection", async () => {
		const failure = new Error("provider bind failed");
		const bind = vi.fn().mockRejectedValue(failure);

		await expect(
			bindOAuthCredentialAction.handler(
				createRuntime(createClient(bind)) as never,
				message() as never,
				undefined,
				{
					parameters: {
						oauthIntentId: "oauth_1",
						connectorIdentityId: "google-user-1",
					},
				} as never,
			),
		).rejects.toBe(failure);
	});
});
