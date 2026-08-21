/**
 * Exercises Discord desktop OAuth deadlines through DiscordLocalService with
 * deterministic IPC, storage, fetch, and abort boundaries; no live Discord.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordLocalService } from "../discord-local-service.ts";

const sessionDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
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

function service(): DiscordLocalService {
	vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	const instance = new DiscordLocalService(makeRuntime());
	Object.assign(instance, { sessionPath: tempSessionPath() });
	installRpcStubs(instance);
	return instance;
}

function installRpcStubs(instance: DiscordLocalService): void {
	Object.assign(instance, {
		ensureRpcConnection: async () => undefined,
		sendRpcCommand: async (cmd: string) => {
			if (cmd === "AUTHORIZE") return { data: { code: "oauth-code" } };
			if (cmd === "AUTHENTICATE") {
				return { data: { user: { id: "1", username: "ada" } } };
			}
			if (cmd === "GET_GUILDS") return { data: [] };
			return { data: {} };
		},
	});
}

function seedExpiredSession(instance: DiscordLocalService): void {
	Object.assign(instance, {
		session: {
			accessToken: "old-token",
			refreshToken: "refresh-me",
			expiresAt: Date.now() - 1_000,
			scopes: ["rpc", "identify", "rpc.notifications.read"],
		},
	});
}

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected Discord OAuth abort signal");
			const onAbort = () => reject(signal.reason);
			if (signal.aborted) return onAbort();
			signal.addEventListener("abort", onAbort, { once: true });
		})) as typeof fetch;
}

describe("Discord local OAuth request deadlines", () => {
	it("aborts a stalled authorization-code exchange", async () => {
		const controller = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		vi.stubGlobal("fetch", stallUntilAborted());

		const pending = service().authorize();
		controller.abort(new DOMException("deadline", "TimeoutError"));

		await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
		expect(timeout).toHaveBeenCalledWith(15_000);
	});

	it("aborts a stalled refresh before listing guilds", async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		vi.stubGlobal("fetch", stallUntilAborted());
		const instance = service();
		seedExpiredSession(instance);

		const pending = instance.listGuilds();
		controller.abort(new DOMException("deadline", "TimeoutError"));

		await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("preserves completed provider error translation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("invalid_grant", {
						status: 401,
						statusText: "Unauthorized",
					}),
			),
		);

		await expect(service().authorize()).rejects.toThrow(
			"Discord OAuth token exchange failed with 401",
		);
	});

	it("persists a successful token response through authorize", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				access_token: "tok",
				refresh_token: "ref",
				expires_in: 3600,
				scope: "rpc identify",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const instance = service();
		const sessionPath = (instance as unknown as { sessionPath: string })
			.sessionPath;

		await expect(instance.authorize()).resolves.toMatchObject({
			authenticated: true,
			currentUser: { id: "1", username: "ada" },
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://discord.com/api/v10/oauth2/token",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		const stored = JSON.parse(readFileSync(sessionPath, "utf8")) as {
			accessToken: string;
		};
		expect(stored.accessToken).toBe("tok");
	});
});
