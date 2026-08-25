/**
 * Unit tests for the REVOKE_OAUTH_CREDENTIAL action's validation and revoke
 * transition. The deterministic harness supplies only the runtime service
 * boundary while exercising the real action metadata, parameter parsing,
 * reason normalization, failure responses, and result shaping.
 */
import { describe, expect, test, vi } from "vitest";
import {
	OAUTH_INTENTS_CLIENT_SERVICE,
	type OAuthIntentsClient,
	type OAuthRevokeResult,
} from "../types";
import { revokeOAuthCredentialAction } from "./revoke-oauth-credential";

function createClient(revoke = vi.fn()): OAuthIntentsClient {
	return {
		create: vi.fn(),
		get: vi.fn(),
		cancel: vi.fn(),
		bind: vi.fn(),
		revoke,
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

describe("REVOKE_OAUTH_CREDENTIAL", () => {
	test("declares the expected action metadata", () => {
		expect(revokeOAuthCredentialAction.name).toBe("REVOKE_OAUTH_CREDENTIAL");
		expect(revokeOAuthCredentialAction.suppressPostActionContinuation).toBe(
			true,
		);
		expect(revokeOAuthCredentialAction.similes).toEqual([
			"REVOKE_OAUTH",
			"DISCONNECT_OAUTH",
		]);
		expect(revokeOAuthCredentialAction.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "oauthIntentId", required: true }),
				expect.objectContaining({ name: "reason", required: false }),
			]),
		);
	});

	test("validates nested parameters when the client service is available", async () => {
		const valid = await revokeOAuthCredentialAction.validate?.(
			createRuntime(createClient()) as never,
			message() as never,
			undefined,
			{ parameters: { oauthIntentId: "oauth_1" } } as never,
		);

		expect(valid).toBe(true);
	});

	test.each([
		["missing service", null, "oauth_1"],
		["missing OAuth intent id", createClient(), undefined],
		["empty OAuth intent id", createClient(), ""],
		["non-string OAuth intent id", createClient(), 42],
	])("rejects validation for %s", async (_case, client, oauthIntentId) => {
		const valid = await revokeOAuthCredentialAction.validate?.(
			createRuntime(client) as never,
			message() as never,
			undefined,
			{ parameters: { oauthIntentId } } as never,
		);

		expect(valid).toBe(false);
	});

	test("returns a structured failure when the client service is unavailable", async () => {
		const result = await revokeOAuthCredentialAction.handler(
			createRuntime(null) as never,
			message() as never,
			undefined,
			{ parameters: { oauthIntentId: "oauth_1" } } as never,
		);

		expect(result).toEqual({
			success: false,
			text: "OAuthIntentsClient not available",
			data: { actionName: "REVOKE_OAUTH_CREDENTIAL" },
		});
	});

	test.each([undefined, "", 42, false])(
		"does not revoke when the OAuth intent id is %s",
		async (oauthIntentId) => {
			const revoke = vi.fn();
			const result = await revokeOAuthCredentialAction.handler(
				createRuntime(createClient(revoke)) as never,
				message() as never,
				undefined,
				{ parameters: { oauthIntentId } } as never,
			);

			expect(result).toEqual({
				success: false,
				text: "Missing required parameter: oauthIntentId",
				data: { actionName: "REVOKE_OAUTH_CREDENTIAL" },
			});
			expect(revoke).not.toHaveBeenCalled();
		},
	);

	test("revokes direct parameters and trims the optional reason", async () => {
		const revokeResult: OAuthRevokeResult = {
			oauthIntentId: "oauth_1",
			provider: "google",
			revoked: true,
		};
		const revoke = vi.fn().mockResolvedValue(revokeResult);
		const callback = vi.fn();

		const result = await revokeOAuthCredentialAction.handler(
			createRuntime(createClient(revoke)) as never,
			message() as never,
			undefined,
			{ oauthIntentId: "oauth_1", reason: "  user disconnected  " } as never,
			callback,
		);

		expect(revoke).toHaveBeenCalledOnce();
		expect(revoke).toHaveBeenCalledWith({
			oauthIntentId: "oauth_1",
			reason: "user disconnected",
		});
		expect(callback).not.toHaveBeenCalled();
		expect(result).toEqual({
			success: true,
			text: "Revoked OAuth credential oauth_1.",
			data: {
				actionName: "REVOKE_OAUTH_CREDENTIAL",
				revoke: revokeResult,
			},
		});
	});

	test.each([undefined, "", "   ", 42])(
		"omits an unusable reason value of %s",
		async (reason) => {
			const revoke = vi.fn().mockResolvedValue({
				oauthIntentId: "oauth_2",
				provider: "github",
				revoked: true,
			});

			await revokeOAuthCredentialAction.handler(
				createRuntime(createClient(revoke)) as never,
				message() as never,
				undefined,
				{ parameters: { oauthIntentId: "oauth_2", reason } } as never,
			);

			expect(revoke).toHaveBeenCalledWith({
				oauthIntentId: "oauth_2",
				reason: undefined,
			});
		},
	);

	test("prefers nested parameters over direct option fields", async () => {
		const revoke = vi.fn().mockResolvedValue({
			oauthIntentId: "nested-oauth",
			provider: "slack",
			revoked: true,
		});

		await revokeOAuthCredentialAction.handler(
			createRuntime(createClient(revoke)) as never,
			message() as never,
			undefined,
			{
				oauthIntentId: "direct-oauth",
				reason: "direct reason",
				parameters: {
					oauthIntentId: "nested-oauth",
					reason: "nested reason",
				},
			} as never,
		);

		expect(revoke).toHaveBeenCalledWith({
			oauthIntentId: "nested-oauth",
			reason: "nested reason",
		});
	});

	test.each([
		[
			"with a provider error",
			"token already invalid",
			"Failed to revoke OAuth credential oauth_3: token already invalid.",
		],
		[
			"without a provider error",
			undefined,
			"Failed to revoke OAuth credential oauth_3.",
		],
	])("reports a failed revocation %s", async (_case, error, text) => {
		const revokeResult: OAuthRevokeResult = {
			oauthIntentId: "oauth_3",
			provider: "notion",
			revoked: false,
			error,
		};
		const revoke = vi.fn().mockResolvedValue(revokeResult);

		const result = await revokeOAuthCredentialAction.handler(
			createRuntime(createClient(revoke)) as never,
			message() as never,
			undefined,
			{ parameters: { oauthIntentId: "oauth_3" } } as never,
		);

		expect(result).toEqual({
			success: false,
			text,
			data: {
				actionName: "REVOKE_OAUTH_CREDENTIAL",
				revoke: revokeResult,
			},
		});
	});

	test("propagates a client revoke rejection", async () => {
		const failure = new Error("provider revoke failed");
		const revoke = vi.fn().mockRejectedValue(failure);

		await expect(
			revokeOAuthCredentialAction.handler(
				createRuntime(createClient(revoke)) as never,
				message() as never,
				undefined,
				{ parameters: { oauthIntentId: "oauth_1" } } as never,
			),
		).rejects.toBe(failure);
	});
});
