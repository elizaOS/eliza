/**
 * Covers the plain command-registry surface of `slash-commands.ts` that
 * `ask-command-and-groupdm.test.ts` and the dispatch/registration suites
 * don't reach: `addCommand`/`removeCommand` mutating the shared registry,
 * and `handleAutocomplete`'s three branches (no autocomplete handler, a
 * successful respond, and a thrown error falling back to an empty respond).
 */
import type { IAgentRuntime } from "@elizaos/core";
import type { AutocompleteInteraction } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addCommand,
	getRegisteredCommands,
	handleAutocomplete,
	registerSlashCommands,
	removeCommand,
} from "../slash-commands";
import type { DiscordSlashCommand } from "../types";

describe("registerSlashCommands event emission", () => {
	it("emits DISCORD_REGISTER_COMMANDS with every registered command transformed", async () => {
		const emitted: Array<{ events: string[]; payload: unknown }> = [];
		const runtime = {
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
			emitEvent: vi.fn(async (events: string[], payload: unknown) => {
				emitted.push({ events, payload });
			}),
		} as unknown as IAgentRuntime;

		await registerSlashCommands(runtime);

		expect(emitted).toHaveLength(1);
		expect(emitted[0].events).toEqual(["DISCORD_REGISTER_COMMANDS"]);
		const { commands } = emitted[0].payload as {
			commands: Array<{ name: string; description: string }>;
		};
		// Every built-in reaches the service's registration listener with the
		// transport shape (name + description survive the transform).
		expect(commands.length).toBe(getRegisteredCommands().size);
		const ask = commands.find((c) => c.name === "ask");
		expect(ask?.description).toBeTruthy();
	});
});

describe("slash-commands registry", () => {
	afterEach(() => {
		removeCommand("registry-test-command");
	});

	it("adds and removes a command from the shared registry", () => {
		expect(getRegisteredCommands().has("registry-test-command")).toBe(false);

		addCommand({
			name: "registry-test-command",
			description: "test",
		} as DiscordSlashCommand);
		expect(getRegisteredCommands().has("registry-test-command")).toBe(true);

		const removed = removeCommand("registry-test-command");
		expect(removed).toBe(true);
		expect(getRegisteredCommands().has("registry-test-command")).toBe(false);
	});

	it("reports false when removing a command that isn't registered", () => {
		expect(removeCommand("does-not-exist")).toBe(false);
	});
});

describe("handleAutocomplete", () => {
	function makeInteraction(commandName: string) {
		return {
			commandName,
			respond: vi.fn(async () => undefined),
		} as unknown as AutocompleteInteraction & {
			respond: ReturnType<typeof vi.fn>;
		};
	}

	it("responds with an empty list when the command has no autocomplete handler", async () => {
		const interaction = makeInteraction("help");
		await handleAutocomplete(interaction);
		expect(interaction.respond).toHaveBeenCalledWith([]);
	});

	it("delegates to the command's autocomplete handler when present", async () => {
		const autocomplete = vi.fn(async (i: AutocompleteInteraction) => {
			await i.respond([{ name: "match", value: "match" }]);
		});
		addCommand({
			name: "registry-test-command",
			description: "test",
			autocomplete,
		} as DiscordSlashCommand);

		const interaction = makeInteraction("registry-test-command");
		await handleAutocomplete(interaction);

		expect(autocomplete).toHaveBeenCalledWith(interaction);
		expect(interaction.respond).toHaveBeenCalledWith([
			{ name: "match", value: "match" },
		]);
	});

	it("falls back to an empty respond when the autocomplete handler throws", async () => {
		addCommand({
			name: "registry-test-command",
			description: "test",
			autocomplete: vi.fn(async () => {
				throw new Error("boom");
			}),
		} as DiscordSlashCommand);

		const interaction = makeInteraction("registry-test-command");
		await handleAutocomplete(interaction);

		expect(interaction.respond).toHaveBeenLastCalledWith([]);
	});

	it("swallows an error from the fallback respond on an expired interaction", async () => {
		addCommand({
			name: "registry-test-command",
			description: "test",
			autocomplete: vi.fn(async () => {
				throw new Error("boom");
			}),
		} as DiscordSlashCommand);

		const interaction = makeInteraction("registry-test-command");
		interaction.respond.mockRejectedValueOnce(new Error("Unknown interaction"));

		await expect(handleAutocomplete(interaction)).resolves.toBeUndefined();
	});
});
