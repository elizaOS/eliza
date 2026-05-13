/**
 * Typed-RPC contract tests for getConfig, getAuthStatus, getAuthMe.
 *
 * The composers throw `AgentNotReadyError` instead of fabricating
 * placeholder snapshots when the agent isn't ready — see the file
 * header in config-and-auth-rpc.ts for the rationale. Tests below
 * pin that semantic.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	AgentNotReadyError,
	type AuthMeReader,
	type AuthStatusReader,
	type ConfigReader,
	type ConfigSchemaReader,
	composeAuthMeSnapshot,
	composeAuthStatusSnapshot,
	composeConfigSchemaSnapshot,
	composeConfigSnapshot,
	readAuthMeViaHttp,
	readAuthStatusViaHttp,
	readConfigSchemaViaHttp,
	readConfigViaHttp,
} from "./config-and-auth-rpc";
import type {
	AuthMeSnapshot,
	AuthStatusSnapshot,
	ConfigSchemaSnapshot,
	ConfigSnapshot,
} from "./rpc-schema";

const noConfigReader: ConfigReader = async () => null;
const noConfigSchemaReader: ConfigSchemaReader = async () => null;
const noStatusReader: AuthStatusReader = async () => null;
const noMeReader: AuthMeReader = async () => null;

const originalFetch = globalThis.fetch;
function installFetch(handler: (url: string) => Response): void {
	(globalThis as { fetch: typeof fetch }).fetch = (async (
		input: RequestInfo | URL,
	): Promise<Response> => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		return handler(url);
	}) as typeof fetch;
}
afterEach(() => {
	(globalThis as { fetch: typeof fetch }).fetch = originalFetch;
});

describe("getConfig typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeConfigSnapshot(null, noConfigReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("throws AgentNotReadyError when reader returns null", async () => {
		await expect(
			composeConfigSnapshot(31337, noConfigReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards a redacted config object verbatim", async () => {
		const reader: ConfigReader = async () => ({
			cloud: { provider: "openai" },
			theme: "dark",
		});
		const snap = await composeConfigSnapshot(31337, reader);
		const _typed: ConfigSnapshot = snap;
		void _typed;
		expect(snap).toEqual({ cloud: { provider: "openai" }, theme: "dark" });
	});

	it("readConfigViaHttp drops non-object bodies", async () => {
		installFetch(() => Response.json("not an object"));
		expect(await readConfigViaHttp(31337)).toBeNull();
	});

	it("readConfigViaHttp returns null on 500", async () => {
		installFetch(() => new Response("server error", { status: 500 }));
		expect(await readConfigViaHttp(31337)).toBeNull();
	});
});

describe("getConfigSchema typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeConfigSchemaSnapshot(null, noConfigSchemaReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards a valid config schema response", async () => {
		const reader: ConfigSchemaReader = async () => ({
			schema: { type: "object" },
			uiHints: { theme: { label: "Theme" } },
			version: "1",
			generatedAt: "2026-05-12T00:00:00.000Z",
		});
		const snap = await composeConfigSchemaSnapshot(31337, reader);
		const _typed: ConfigSchemaSnapshot = snap;
		void _typed;
		expect(snap.schema).toEqual({ type: "object" });
		expect(snap.uiHints).toEqual({ theme: { label: "Theme" } });
	});

	it("readConfigSchemaViaHttp returns null when required fields are missing", async () => {
		installFetch(() =>
			Response.json({
				schema: { type: "object" },
				uiHints: {},
				version: "1",
			}),
		);
		expect(await readConfigSchemaViaHttp(31337)).toBeNull();
	});

	it("readConfigSchemaViaHttp captures the schema envelope", async () => {
		installFetch(() =>
			Response.json({
				schema: { type: "object" },
				uiHints: { cloud: { label: "Cloud" } },
				version: "1",
				generatedAt: "2026-05-12T00:00:00.000Z",
			}),
		);
		expect(await readConfigSchemaViaHttp(31337)).toEqual({
			schema: { type: "object" },
			uiHints: { cloud: { label: "Cloud" } },
			version: "1",
			generatedAt: "2026-05-12T00:00:00.000Z",
		});
	});
});

describe("getAuthStatus typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeAuthStatusSnapshot(null, noStatusReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("forwards required + pairingEnabled + expiresAt", async () => {
		const reader: AuthStatusReader = async () => ({
			required: true,
			pairingEnabled: true,
			expiresAt: 1700000000000,
			authenticated: false,
		});
		const snap = await composeAuthStatusSnapshot(31337, reader);
		const _typed: AuthStatusSnapshot = snap;
		void _typed;
		expect(snap.required).toBe(true);
		expect(snap.pairingEnabled).toBe(true);
		expect(snap.expiresAt).toBe(1700000000000);
		expect(snap.authenticated).toBe(false);
	});

	it("readAuthStatusViaHttp coerces missing/wrong-typed fields to defaults", async () => {
		installFetch(() =>
			Response.json({
				required: "yes",
				pairingEnabled: true,
				expiresAt: "soon",
			}),
		);
		const result = await readAuthStatusViaHttp(31337);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.required).toBe(false);
		expect(result.pairingEnabled).toBe(true);
		expect(result.expiresAt).toBeNull();
	});
});

describe("getAuthMe typed RPC", () => {
	it("throws AgentNotReadyError when port is null", async () => {
		await expect(
			composeAuthMeSnapshot(null, noMeReader),
		).rejects.toBeInstanceOf(AgentNotReadyError);
	});

	it("captures structured 401 body into `unauthorized`", async () => {
		installFetch(
			() =>
				new Response(
					JSON.stringify({
						reason: "remote_password_not_configured",
						access: {
							mode: "remote",
							passwordConfigured: false,
							ownerConfigured: false,
						},
					}),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				),
		);
		const result = await readAuthMeViaHttp(31337);
		expect(result).not.toBeNull();
		if (!result) return;
		const _typed: AuthMeSnapshot = result;
		void _typed;
		expect(result.unauthorized?.reason).toBe("remote_password_not_configured");
		expect(result.unauthorized?.access.mode).toBe("remote");
		expect(result.identity).toBeUndefined();
	});

	it("captures identity + session + access on 200", async () => {
		installFetch(() =>
			Response.json({
				identity: {
					id: "local-loopback",
					displayName: "Local",
					kind: "owner",
				},
				session: { id: "local-loopback", kind: "local", expiresAt: null },
				access: {
					mode: "local",
					passwordConfigured: false,
					ownerConfigured: false,
				},
			}),
		);
		const result = await readAuthMeViaHttp(31337);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.identity?.id).toBe("local-loopback");
		expect(result.session?.id).toBe("local-loopback");
		expect(result.access?.mode).toBe("local");
		expect(result.unauthorized).toBeUndefined();
	});

	it("returns null on non-401 non-2xx — composer then throws AgentNotReadyError", async () => {
		installFetch(() => new Response("server error", { status: 500 }));
		const reader: AuthMeReader = async (port) => readAuthMeViaHttp(port);
		await expect(composeAuthMeSnapshot(31337, reader)).rejects.toBeInstanceOf(
			AgentNotReadyError,
		);
	});

	it("AgentNotReadyError carries the method name", async () => {
		try {
			await composeAuthMeSnapshot(null, noMeReader);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentNotReadyError);
			expect((err as Error).message).toContain("getAuthMe");
			return;
		}
		throw new Error("expected throw");
	});
});
