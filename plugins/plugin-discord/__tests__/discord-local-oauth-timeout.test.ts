/**
 * Behavioral Discord local OAuth deadlines. Exercises token-exchange and
 * refresh through DiscordLocalService with a controlled delayed response
 * and the service's error translation — not a source-grep, no /tmp path.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	DISCORD_OAUTH_TIMEOUT_MS,
	DiscordLocalService,
} from "../discord-local-service.ts";

const sessionDirs: string[] = [];

afterEach(() => {
	while (sessionDirs.length > 0) {
		const dir = sessionDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function makeRuntime(): IAgentRuntime {
	return {
		getSetting(key: string) {
			if (key === "DISCORD_LOCAL_CLIENT_ID") return "discord-client";
			if (key === "DISCORD_LOCAL_CLIENT_SECRET") return "discord-secret";
			return undefined;
		},
	} as IAgentRuntime;
}

function tempSessionPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "discord-local-oauth-"));
	sessionDirs.push(dir);
	return join(dir, "session.json");
}

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected discord oauth abort signal");
			const onAbort = () => reject(signal.reason);
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		})) as typeof fetch;
}

function grantTypeOf(init?: RequestInit): string {
	const raw = init?.body;
	const body =
		typeof raw === "string"
			? raw
			: raw instanceof URLSearchParams
				? raw.toString()
				: "";
	return new URLSearchParams(body).get("grant_type") ?? "";
}

function installRpcStubs(service: DiscordLocalService): void {
	Object.assign(service, {
		ensureRpcConnection: async () => undefined,
		sendRpcCommand: async (cmd: string) => {
			if (cmd === "AUTHORIZE") {
				return { data: { code: "oauth-code" } };
			}
			if (cmd === "AUTHENTICATE") {
				return { data: { user: { id: "1", username: "ada" } } };
			}
			if (cmd === "GET_GUILDS") {
				return { data: [] };
			}
			return { data: {} };
		},
	});
}

function seedExpiredSession(service: DiscordLocalService): void {
	Object.assign(service, {
		session: {
			accessToken: "old-token",
			refreshToken: "refresh-me",
			expiresAt: Date.now() - 1_000,
			scopes: ["rpc", "identify", "rpc.notifications.read"],
		},
	});
}

describe("Discord local OAuth request deadlines", () => {
	it("keeps a documented OAuth budget", () => {
		expect(DISCORD_OAUTH_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled token exchange through authorize()", async () => {
		const service = new DiscordLocalService(makeRuntime(), {
			fetchImpl: stallUntilAborted(),
			oauthTimeoutMs: 10,
			sessionPath: tempSessionPath(),
		});
		installRpcStubs(service);

		await expect(service.authorize()).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});

	it("translates a completed token-exchange provider error", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("invalid_grant", {
				status: 401,
				statusText: "Unauthorized",
			});
		const service = new DiscordLocalService(makeRuntime(), {
			fetchImpl,
			oauthTimeoutMs: 1_000,
			sessionPath: tempSessionPath(),
		});
		installRpcStubs(service);

		await expect(service.authorize()).rejects.toThrow(
			"Discord OAuth token exchange failed with 401",
		);
	});

	it("exchanges an authorization code through authorize()", async () => {
		const signals: AbortSignal[] = [];
		const grants: string[] = [];
		const sessionPath = tempSessionPath();
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			grants.push(grantTypeOf(init));
			return Response.json({
				access_token: "tok",
				refresh_token: "ref",
				expires_in: 3600,
				scope: "rpc identify",
			});
		};
		const service = new DiscordLocalService(makeRuntime(), {
			fetchImpl,
			oauthTimeoutMs: 1_000,
			sessionPath,
		});
		installRpcStubs(service);

		const status = await service.authorize();

		expect(grants).toEqual(["authorization_code"]);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(status.authenticated).toBe(true);
		expect(status.currentUser).toMatchObject({ id: "1", username: "ada" });
		const stored = JSON.parse(readFileSync(sessionPath, "utf8")) as {
			accessToken: string;
		};
		expect(stored.accessToken).toBe("tok");
	});

	it("aborts a stalled refresh through listGuilds()", async () => {
		const service = new DiscordLocalService(makeRuntime(), {
			fetchImpl: stallUntilAborted(),
			oauthTimeoutMs: 10,
			sessionPath: tempSessionPath(),
		});
		installRpcStubs(service);
		seedExpiredSession(service);

		await expect(service.listGuilds()).rejects.toMatchObject({
			name: "TimeoutError",
		});
	});

	it("translates a completed refresh provider error", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("invalid_grant", {
				status: 400,
				statusText: "Bad Request",
			});
		const service = new DiscordLocalService(makeRuntime(), {
			fetchImpl,
			oauthTimeoutMs: 1_000,
			sessionPath: tempSessionPath(),
		});
		installRpcStubs(service);
		seedExpiredSession(service);

		await expect(service.listGuilds()).rejects.toThrow(
			"Discord OAuth refresh failed with 400",
		);
	});

	it("refreshes an expired session through listGuilds()", async () => {
		const signals: AbortSignal[] = [];
		const grants: string[] = [];
		const sessionPath = tempSessionPath();
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			grants.push(grantTypeOf(init));
			return Response.json({
				access_token: "new-tok",
				refresh_token: "new-ref",
				expires_in: 3600,
				scope: "rpc identify",
			});
		};
		const service = new DiscordLocalService(makeRuntime(), {
			fetchImpl,
			oauthTimeoutMs: 1_000,
			sessionPath,
		});
		installRpcStubs(service);
		seedExpiredSession(service);

		await expect(service.listGuilds()).resolves.toEqual([]);

		expect(grants).toEqual(["refresh_token"]);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		const stored = JSON.parse(readFileSync(sessionPath, "utf8")) as {
			accessToken: string;
		};
		expect(stored.accessToken).toBe("new-tok");
	});
});
