/**
 * Covers handleSlashCommand's non-role-gate branches that
 * slash-commands.test.ts leaves untouched: unknown command names, the
 * per-user cooldown window (reject while active, clear after expiry), the
 * happy-path execute call, the execute-error recovery reply (both deferred
 * and fresh-interaction variants, plus a swallowed already-closed-interaction
 * failure), and handleAutocomplete's respond/empty-list/error paths.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addCommand,
	handleAutocomplete,
	handleSlashCommand,
} from "../slash-commands";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function makeRuntime(): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getSetting: vi.fn(() => undefined),
		character: { name: "TestAgent" },
		logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
	} as unknown as IAgentRuntime;
}

function makeInteraction(commandName: string, userId = "user-1") {
	return {
		id: "interaction-1",
		commandName,
		user: { id: userId, username: "tester" },
		deferred: false,
		replied: false,
		reply: vi.fn(async () => undefined),
		editReply: vi.fn(async () => undefined),
		respond: vi.fn(async () => undefined),
	};
}

describe("handleSlashCommand — unknown command, cooldown, execute outcomes", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns silently for a command name that isn't registered", async () => {
		const interaction = makeInteraction("does-not-exist");
		await handleSlashCommand(interaction as never, makeRuntime());
		expect(interaction.reply).not.toHaveBeenCalled();
	});

	it("runs execute() on the happy path with no cooldown or role gate", async () => {
		const execute = vi.fn(async () => undefined);
		addCommand({ name: "plain_cmd", description: "plain", execute });
		const interaction = makeInteraction("plain_cmd");

		await handleSlashCommand(interaction as never, makeRuntime());

		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("blocks a second invocation within the cooldown window and lets it through after expiry", async () => {
		vi.useFakeTimers();
		const execute = vi.fn(async () => undefined);
		addCommand({
			name: "cooldown_cmd",
			description: "cooldown",
			cooldown: 10,
			execute,
		});
		const first = makeInteraction("cooldown_cmd", "same-user");
		await handleSlashCommand(first as never, makeRuntime());
		expect(execute).toHaveBeenCalledTimes(1);

		const second = makeInteraction("cooldown_cmd", "same-user");
		await handleSlashCommand(second as never, makeRuntime());
		expect(execute).toHaveBeenCalledTimes(1);
		expect(second.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("Please wait"),
				ephemeral: true,
			}),
		);

		vi.advanceTimersByTime(10_000);
		const third = makeInteraction("cooldown_cmd", "same-user");
		await handleSlashCommand(third as never, makeRuntime());
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("does not apply another user's cooldown to a different caller", async () => {
		vi.useFakeTimers();
		const execute = vi.fn(async () => undefined);
		addCommand({
			name: "cooldown_per_user",
			description: "cooldown",
			cooldown: 10,
			execute,
		});
		await handleSlashCommand(
			makeInteraction("cooldown_per_user", "user-a") as never,
			makeRuntime(),
		);
		await handleSlashCommand(
			makeInteraction("cooldown_per_user", "user-b") as never,
			makeRuntime(),
		);
		expect(execute).toHaveBeenCalledTimes(2);
	});

	it("edits the deferred reply with the error message when execute() throws", async () => {
		const execute = vi.fn(async () => {
			throw new Error("boom");
		});
		addCommand({ name: "throws_deferred", description: "x", execute });
		const interaction = makeInteraction("throws_deferred");
		interaction.deferred = true;

		await handleSlashCommand(interaction as never, makeRuntime());

		expect(interaction.editReply).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("boom") }),
		);
	});

	it("replies fresh with the error message when execute() throws on an undeferred interaction", async () => {
		const execute = vi.fn(async () => {
			throw new Error("kaboom");
		});
		addCommand({ name: "throws_fresh", description: "x", execute });
		const interaction = makeInteraction("throws_fresh");

		await handleSlashCommand(interaction as never, makeRuntime());

		expect(interaction.reply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("kaboom"),
				ephemeral: true,
			}),
		);
	});

	it("swallows a failure to deliver the error reply on an already-closed interaction", async () => {
		const execute = vi.fn(async () => {
			throw new Error("primary failure");
		});
		addCommand({ name: "throws_and_reply_fails", description: "x", execute });
		const interaction = makeInteraction("throws_and_reply_fails");
		interaction.reply.mockRejectedValueOnce(new Error("Unknown interaction"));

		await expect(
			handleSlashCommand(interaction as never, makeRuntime()),
		).resolves.toBeUndefined();
	});
});

describe("handleAutocomplete", () => {
	function makeAutocompleteInteraction(commandName: string) {
		return {
			commandName,
			respond: vi.fn(async () => undefined),
		};
	}

	beforeEach(() => {
		addCommand({
			name: "no_autocomplete_cmd",
			description: "x",
			execute: vi.fn(async () => undefined),
		});
		addCommand({
			name: "autocomplete_cmd",
			description: "x",
			execute: vi.fn(async () => undefined),
			autocomplete: vi.fn(
				async (interaction: { respond: (v: unknown[]) => Promise<void> }) => {
					await interaction.respond([{ name: "a", value: "a" }]);
				},
			),
		});
	});

	it("responds empty when the command has no autocomplete handler", async () => {
		const interaction = makeAutocompleteInteraction("no_autocomplete_cmd");
		await handleAutocomplete(interaction as never);
		expect(interaction.respond).toHaveBeenCalledWith([]);
	});

	it("responds empty when the command name is unknown", async () => {
		const interaction = makeAutocompleteInteraction("does-not-exist");
		await handleAutocomplete(interaction as never);
		expect(interaction.respond).toHaveBeenCalledWith([]);
	});

	it("delegates to the command's autocomplete handler when one is registered", async () => {
		const interaction = makeAutocompleteInteraction("autocomplete_cmd");
		await handleAutocomplete(interaction as never);
		expect(interaction.respond).toHaveBeenCalledWith([
			{ name: "a", value: "a" },
		]);
	});

	it("swallows an autocomplete handler error and falls back to an empty respond", async () => {
		addCommand({
			name: "autocomplete_throws",
			description: "x",
			execute: vi.fn(async () => undefined),
			autocomplete: vi.fn(async () => {
				throw new Error("expired");
			}),
		});
		const interaction = makeAutocompleteInteraction("autocomplete_throws");
		await expect(
			handleAutocomplete(interaction as never),
		).resolves.toBeUndefined();
		expect(interaction.respond).toHaveBeenCalledWith([]);
	});
});
