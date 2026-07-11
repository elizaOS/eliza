/**
 * Covers the guard clauses and error paths of DiscordService.registerSlashCommands
 * that slash-command-registration-scope.test.ts doesn't reach: no client
 * application yet, no commands to register, a command missing name/description,
 * a failed global commands.set() call, and the commandRegistrationQueue
 * serializing two concurrent registrations while surfacing a queue failure to
 * BOTH the caller and the logger. Same in-memory Discord API double pattern as
 * slash-command-registration-scope.test.ts.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DiscordService } from "../service";
import type { DiscordSlashCommand } from "../types";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function command(name: string): DiscordSlashCommand {
	return {
		name,
		description: `${name} command`,
		execute: vi.fn(async () => undefined),
	} as unknown as DiscordSlashCommand;
}

function makeRuntime() {
	return {
		agentId: AGENT_ID,
		getSetting: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function makeService(state: Record<string, unknown>) {
	const runtime = makeRuntime();
	const service = Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		slashCommands: [],
		allowAllSlashCommands: new Set<string>(),
		commandRegistrationQueue: Promise.resolve(),
		requireAccountState: () => state,
	}) as DiscordService;
	return { runtime, service };
}

describe("DiscordService.registerSlashCommands — guard clauses", () => {
	it("warns and returns without touching Discord when the client application isn't ready", async () => {
		const { runtime, service } = makeService({
			accountId: "default",
			clientReadyPromise: Promise.resolve(),
			client: { application: null },
		});

		await service.registerSlashCommands([command("ask")]);

		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "default" }),
			expect.stringContaining("client application not available"),
		);
		expect(service.slashCommands).toHaveLength(0);
	});

	it("warns and returns when no commands are provided", async () => {
		const set = vi.fn(async () => undefined);
		const { runtime, service } = makeService({
			accountId: "default",
			clientReadyPromise: Promise.resolve(),
			client: {
				application: { commands: { set } },
				guilds: { cache: new Map() },
			},
		});

		await service.registerSlashCommands([]);

		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "default" }),
			expect.stringContaining("no commands provided"),
		);
		expect(set).not.toHaveBeenCalled();
	});

	it("warns and returns when a command is missing a name or description", async () => {
		const set = vi.fn(async () => undefined);
		const { runtime, service } = makeService({
			accountId: "default",
			clientReadyPromise: Promise.resolve(),
			client: {
				application: { commands: { set } },
				guilds: { cache: new Map() },
			},
		});
		const broken = { name: "no-description" } as unknown as DiscordSlashCommand;

		await service.registerSlashCommands([broken]);

		expect(runtime.logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "default" }),
			expect.stringContaining("invalid command"),
		);
		expect(set).not.toHaveBeenCalled();
	});

	it("logs and continues past a failed global commands.set() write instead of aborting registration", async () => {
		const set = vi.fn(async () => {
			throw new Error("50013: Missing Permissions");
		});
		const { runtime, service } = makeService({
			accountId: "default",
			clientReadyPromise: Promise.resolve(),
			client: {
				application: { commands: { set } },
				guilds: { cache: new Map() },
			},
		});

		await service.registerSlashCommands([command("ask")]);

		expect(runtime.logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "default" }),
			expect.stringContaining("Failed to register/clear global commands"),
		);
		// The command is still recorded even though the Discord write failed —
		// the queue continues past the caught error.
		expect(service.slashCommands.map((c) => c.name)).toEqual(["ask"]);
	});

	it("rejects the caller when the registration queue itself throws, without losing the next registration", async () => {
		const runtime = makeRuntime();
		// Two registrations fired back-to-back (not awaited between calls) both
		// pass the top guard clause while `client.application` is still present,
		// then queue onto the same commandRegistrationQueue. The first queued
		// closure's `commands.set()` clears `application` as a side effect; by
		// the time the second closure runs its own `client.application` re-read
		// (line 752-755), it is gone — reproducing a real "app state changed
		// while a registration was queued behind another" race, not just the
		// early guard clause already covered by the "not ready" test above.
		const mutableClient: {
			application: { commands: { set: ReturnType<typeof vi.fn> } } | undefined;
			guilds: { cache: Map<string, unknown> };
		} = {
			application: {
				commands: {
					set: vi.fn(async () => {
						mutableClient.application = undefined;
					}),
				},
			},
			guilds: { cache: new Map() },
		};
		const state = {
			accountId: "default",
			clientReadyPromise: Promise.resolve(),
			client: mutableClient,
		};
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			slashCommands: [],
			allowAllSlashCommands: new Set<string>(),
			commandRegistrationQueue: Promise.resolve(),
			requireAccountState: () => state,
		}) as DiscordService;

		const first = service.registerSlashCommands([command("first")]);
		const second = service.registerSlashCommands([command("second")]);

		await expect(first).resolves.toBeUndefined();
		await expect(second).rejects.toThrow(
			"Discord client application is not available",
		);
		expect(runtime.logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ accountId: "default" }),
			expect.stringContaining("Error registering Discord commands"),
		);
	});
});
