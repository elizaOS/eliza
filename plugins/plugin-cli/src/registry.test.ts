import { logger } from "@elizaos/core";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	addSubcommand,
	clearCliCommands,
	defineCliCommand,
	getCliCommand,
	listCliCommands,
	registerAllCommands,
	registerCliCommand,
	unregisterCliCommand,
} from "./registry.js";

describe("CLI command registry", () => {
	beforeEach(() => {
		clearCliCommands();
		vi.clearAllMocks();
	});

	it("replaces commands by name and warns about the replacement", () => {
		const first = defineCliCommand("run", "first", vi.fn());
		const second = defineCliCommand("run", "second", vi.fn());

		registerCliCommand(first);
		registerCliCommand(second);

		expect(getCliCommand("run")).toBe(second);
		expect(logger.warn).toHaveBeenCalledWith(
			'[CLI] Command "run" already registered, replacing',
		);
	});

	it("lists commands in ascending priority order with default priority last", () => {
		registerCliCommand(defineCliCommand("default", "default", vi.fn()));
		registerCliCommand(
			defineCliCommand("first", "first", vi.fn(), { priority: 1 }),
		);
		registerCliCommand(
			defineCliCommand("middle", "middle", vi.fn(), { priority: 50 }),
		);

		expect(listCliCommands().map((command) => command.name)).toEqual([
			"first",
			"middle",
			"default",
		]);
	});

	it("continues registering later commands when one command throws", () => {
		const firstRegister = vi.fn(() => {
			throw new Error("broken registration");
		});
		const secondRegister = vi.fn();
		const program = new Command();
		const ctx = { program, cliName: "elizaos", version: "1.0.0" };

		registerCliCommand(defineCliCommand("broken", "broken", firstRegister));
		registerCliCommand(defineCliCommand("healthy", "healthy", secondRegister));
		registerAllCommands(ctx);

		expect(firstRegister).toHaveBeenCalledWith(ctx);
		expect(secondRegister).toHaveBeenCalledWith(ctx);
		expect(logger.error).toHaveBeenCalledWith(
			'[CLI] Failed to register command "broken":',
			"broken registration",
		);
	});

	it("unregisters commands and creates described subcommands", () => {
		registerCliCommand(defineCliCommand("doctor", "doctor", vi.fn()));

		expect(unregisterCliCommand("doctor")).toBe(true);
		expect(getCliCommand("doctor")).toBeUndefined();
		expect(unregisterCliCommand("doctor")).toBe(false);

		const parent = new Command();
		const child = addSubcommand(parent, "status", "Show status");
		expect(child.name()).toBe("status");
		expect(child.description()).toBe("Show status");
	});
});
