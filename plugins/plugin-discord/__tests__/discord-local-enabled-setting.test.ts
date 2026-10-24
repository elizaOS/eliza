/**
 * DISCORD_LOCAL_ENABLED reaches the service through runtime.getSetting, which
 * returns a stored "true"/"false" as a boolean. The subscribe route always
 * saves `connectors.discordLocal.enabled: true`.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordLocalService } from "../discord-local-service.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function startWithEnabled(enabled: unknown): DiscordLocalService {
	vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
	const runtime = {
		getSetting(key: string) {
			if (key === "DISCORD_LOCAL_CLIENT_ID") return "discord-client";
			if (key === "DISCORD_LOCAL_CLIENT_SECRET") return "discord-secret";
			if (key === "DISCORD_LOCAL_ENABLED") return enabled;
			return undefined;
		},
	} as IAgentRuntime;
	const instance = new DiscordLocalService(runtime);
	Object.assign(instance, {
		loadSession: async () => ({
			accessToken: "saved-token",
			refreshToken: "refresh",
			expiresAt: Date.now() + 3_600_000,
			scopes: ["rpc", "identify", "rpc.notifications.read"],
		}),
		ensureRpcConnection: async () => undefined,
		sendRpcCommand: async (cmd: string) => {
			if (cmd === "AUTHENTICATE") {
				return { data: { user: { id: "1", username: "ada" } } };
			}
			return { data: [] };
		},
		persistSession: async () => undefined,
	});
	return instance;
}

async function start(instance: DiscordLocalService): Promise<void> {
	await (
		instance as unknown as { startService(): Promise<void> }
	).startService();
}

describe("DISCORD_LOCAL_ENABLED", () => {
	it("restores the saved session when the setting is true", async () => {
		const instance = startWithEnabled(true);
		await start(instance);
		expect(instance.isAuthenticated()).toBe(true);
	});

	it("stays off when the setting is false", async () => {
		const instance = startWithEnabled(false);
		await start(instance);
		expect(instance.isAuthenticated()).toBe(false);
	});
});
