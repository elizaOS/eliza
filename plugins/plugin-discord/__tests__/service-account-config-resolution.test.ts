/**
 * Covers pure DiscordService helpers that translate per-account config into
 * runtime shapes: dedupeConnectorTargets' score-wins merge, and
 * resolveDiscordSettingsForAccount/resolveListenChannelIdsForAccount's
 * account-config-over-base-settings precedence. Private methods invoked via a
 * typed escape hatch (same `Object.create(DiscordService.prototype)` pattern
 * as slash-command-registration-scope.test.ts) since none of this depends on
 * a live Discord client.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DiscordService } from "../service";
import type { MessageConnectorTarget, ResolvedDiscordAccount } from "../types";

type PrivateAccess = {
	dedupeConnectorTargets(
		targets: MessageConnectorTarget[],
	): MessageConnectorTarget[];
	resolveDiscordSettingsForAccount(account: ResolvedDiscordAccount): {
		allowedChannelIds?: string[];
		dmPolicy?: string;
		allowFrom?: string[];
	};
	resolveListenChannelIdsForAccount(
		account: ResolvedDiscordAccount,
	): string[] | undefined;
};

function makeService(runtime: IAgentRuntime) {
	return Object.assign(Object.create(DiscordService.prototype), {
		runtime,
	}) as DiscordService & PrivateAccess;
}

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
	return {
		agentId: "11111111-1111-1111-1111-111111111111",
		character: { settings: { discord: {} } },
		getSetting: vi.fn((key: string) => settings[key]),
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

function target(
	key: string,
	score: number,
	channelId = "chan",
): MessageConnectorTarget {
	return {
		kind: "target",
		score,
		target: { channelId, entityId: key === "entity" ? "e1" : undefined },
	} as unknown as MessageConnectorTarget;
}

describe("DiscordService.dedupeConnectorTargets", () => {
	it("keeps the higher-scored target when two targets share the same identity key", () => {
		const service = makeService(makeRuntime());
		const result = service.dedupeConnectorTargets([
			target("a", 0.5),
			target("a", 0.9),
		]);
		expect(result).toHaveLength(1);
		expect(result[0].score).toBe(0.9);
	});

	it("keeps distinct targets and sorts by score descending", () => {
		const service = makeService(makeRuntime());
		const low = target("a", 0.1, "chan-1");
		const high = target("a", 0.8, "chan-2");
		const result = service.dedupeConnectorTargets([low, high]);
		expect(result).toEqual([high, low]);
	});
});

describe("DiscordService.resolveDiscordSettingsForAccount", () => {
	it("prefers account-level allowedChannelIds over the base settings", () => {
		const service = makeService(makeRuntime());
		const account = {
			config: { allowedChannelIds: ["c1", "c2"] },
		} as unknown as ResolvedDiscordAccount;
		const resolved = service.resolveDiscordSettingsForAccount(account);
		expect(resolved.allowedChannelIds).toEqual(["c1", "c2"]);
	});

	it("falls back to channelIds when allowedChannelIds is absent", () => {
		const service = makeService(makeRuntime());
		const account = {
			config: { channelIds: ["legacy-1"] },
		} as unknown as ResolvedDiscordAccount;
		const resolved = service.resolveDiscordSettingsForAccount(account);
		expect(resolved.allowedChannelIds).toEqual(["legacy-1"]);
	});

	it("trims and drops empty entries from an account-level dm.allowFrom list", () => {
		const service = makeService(makeRuntime());
		const account = {
			config: { dm: { allowFrom: [" 123 ", "", "456"] } },
		} as unknown as ResolvedDiscordAccount;
		const resolved = service.resolveDiscordSettingsForAccount(account);
		expect(resolved.allowFrom).toEqual(["123", "456"]);
	});

	it("uses the account-level dm.policy over the base dmPolicy", () => {
		const service = makeService(makeRuntime());
		const account = {
			config: { dm: { policy: "open" } },
		} as unknown as ResolvedDiscordAccount;
		const resolved = service.resolveDiscordSettingsForAccount(account);
		expect(resolved.dmPolicy).toBe("open");
	});
});

describe("DiscordService.resolveListenChannelIdsForAccount", () => {
	it("prefers the account-level listenChannelIds over the DISCORD_LISTEN_CHANNEL_IDS setting", () => {
		const service = makeService(
			makeRuntime({ DISCORD_LISTEN_CHANNEL_IDS: "env-1,env-2" }),
		);
		const account = {
			config: { listenChannelIds: ["acct-1"] },
		} as unknown as ResolvedDiscordAccount;
		expect(service.resolveListenChannelIdsForAccount(account)).toEqual([
			"acct-1",
		]);
	});

	it("falls back to the DISCORD_LISTEN_CHANNEL_IDS setting when no account override exists", () => {
		const service = makeService(
			makeRuntime({ DISCORD_LISTEN_CHANNEL_IDS: "env-1,env-2" }),
		);
		const account = { config: {} } as unknown as ResolvedDiscordAccount;
		expect(service.resolveListenChannelIdsForAccount(account)).toEqual([
			"env-1",
			"env-2",
		]);
	});

	it("returns undefined when neither source is configured", () => {
		const service = makeService(makeRuntime());
		const account = { config: {} } as unknown as ResolvedDiscordAccount;
		expect(service.resolveListenChannelIdsForAccount(account)).toBeUndefined();
	});
});
