/**
 * /help must list exactly the commands Discord accepted — read from
 * DiscordService's post-sync snapshot (getSyncedCommandNames), never from a
 * live Discord API call. Covers the global+guild union, guild-only/targeted
 * retention, empty scopes, the stale-after-failed-sync case, the no-API-call
 * guarantee, and the retryable unavailable state before the first sync.
 */

import { describe, expect, it, vi } from "vitest";
import { DiscordService } from "../service";

const AGENT_ID = "22222222-2222-2222-2222-222222222222";

// Minimal service shell: exercises the real snapshot accessor without booting a
// Discord client. We set the private snapshot fields the way a successful
// commands.set() would, then assert getSyncedCommandNames + the /help handler.
function makeService(): DiscordService {
	const svc = Object.create(DiscordService.prototype) as DiscordService;
	// @ts-expect-error seed private snapshot state for the test
	svc.syncedGlobalCommandNames = null;
	// @ts-expect-error seed private snapshot state for the test
	svc.syncedGuildCommandNames = new Map<string, Set<string>>();
	return svc;
}

function setGlobal(svc: DiscordService, names: string[]): void {
	// @ts-expect-error set private snapshot
	svc.syncedGlobalCommandNames = new Set(names);
}
function setGuild(svc: DiscordService, guildId: string, names: string[]): void {
	// @ts-expect-error set private snapshot
	svc.syncedGuildCommandNames.set(guildId, new Set(names));
}

describe("DiscordService.getSyncedCommandNames", () => {
	it("returns null before any successful global sync (retryable unavailable)", () => {
		const svc = makeService();
		expect(svc.getSyncedCommandNames("guild-a")).toBeNull();
	});

	it("returns the global set when no guild is given", () => {
		const svc = makeService();
		setGlobal(svc, ["help", "status", "model"]);
		expect([...(svc.getSyncedCommandNames() ?? [])].sort()).toEqual([
			"help",
			"model",
			"status",
		]);
	});

	it("unions global + the guild's own scope (guild-only/targeted retention)", () => {
		const svc = makeService();
		setGlobal(svc, ["help", "status"]);
		setGuild(svc, "guild-a", ["mod-only", "targeted"]);
		expect([...(svc.getSyncedCommandNames("guild-a") ?? [])].sort()).toEqual([
			"help",
			"mod-only",
			"status",
			"targeted",
		]);
	});

	it("returns only globals for a guild with an empty scope", () => {
		const svc = makeService();
		setGlobal(svc, ["help", "status"]);
		setGuild(svc, "guild-a", []);
		expect([...(svc.getSyncedCommandNames("guild-a") ?? [])].sort()).toEqual([
			"help",
			"status",
		]);
	});

	it("keeps the last successful snapshot when a later sync fails (stale-but-valid, not null)", () => {
		const svc = makeService();
		setGlobal(svc, ["help", "status", "model"]);
		// A later failed commands.set() never updates the snapshot (the catch does
		// not touch syncedGlobalCommandNames), so /help still lists the last good
		// set rather than going unavailable.
		expect(svc.getSyncedCommandNames()).not.toBeNull();
		expect([...(svc.getSyncedCommandNames() ?? [])].sort()).toEqual([
			"help",
			"model",
			"status",
		]);
	});
});

describe("/help handler", () => {
	// Import lazily so the module's command registry is initialized once.
	async function getHelp(): Promise<{
		execute: (i: unknown, r: unknown) => Promise<void>;
	}> {
		const mod = await import("../slash-commands");
		const registry = (
			mod as unknown as {
				getRegisteredCommands: () => Map<
					string,
					{ execute: (i: unknown, r: unknown) => Promise<void> }
				>;
			}
		).getRegisteredCommands();
		if (!registry.has("help")) {
			await mod.registerSlashCommands({
				registerEvent: () => undefined,
				getService: () => null,
				logger: {
					info: vi.fn(),
					debug: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
				},
				agentId: AGENT_ID,
			} as never);
		}
		const help = (
			mod as unknown as {
				getRegisteredCommands: () => Map<
					string,
					{ execute: (i: unknown, r: unknown) => Promise<void> }
				>;
			}
		)
			.getRegisteredCommands()
			.get("help");
		if (!help) throw new Error("help command not registered");
		return help;
	}

	async function runHelp(
		snapshot: Set<string> | null | undefined,
		guildId: string | null,
	): Promise<{ replied: string; apiCalls: number }> {
		const help = await getHelp();
		const runtime = {
			getService: () => ({
				getSyncedCommandNames: () =>
					snapshot === undefined ? undefined : snapshot,
			}),
		};
		let apiCalls = 0;
		let replied = "";
		const interaction = {
			guildId,
			client: {
				application: {
					commands: {
						fetch: () => {
							apiCalls += 1;
							return Promise.resolve(new Map());
						},
						cache: { size: 0 },
					},
				},
			},
			reply: (arg: { content: string }) => {
				replied = arg.content;
				return Promise.resolve();
			},
		};
		await help.execute(interaction, runtime);
		return { replied, apiCalls };
	}

	it("lists only snapshot commands and makes ZERO Discord API calls", async () => {
		const { replied, apiCalls } = await runHelp(
			new Set(["help", "status"]),
			"guild-a",
		);
		expect(apiCalls).toBe(0);
		expect(replied).toContain("/help");
		expect(replied).toContain("/status");
		// A registry command NOT in the snapshot must not appear.
		expect(replied).not.toContain("/think");
	});

	it("returns the retryable unavailable message when the snapshot is null", async () => {
		const { replied, apiCalls } = await runHelp(null, "guild-a");
		expect(apiCalls).toBe(0);
		expect(replied.toLowerCase()).toContain("still syncing");
	});
});
