import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
	detectCommand,
	extractCommand,
	hasCommand,
	isCommandOnly,
	normalizeCommandBody,
	parseCommand,
} from "../src/parser";
import { findCommandByKey, registerCommand, resetCommands } from "../src/registry";
import type { CommandDefinition } from "../src/types";

const customCommand: CommandDefinition = {
	key: "deploy",
	description: "Deploy a target",
	textAliases: ["/deploy", "!deploy"],
	scope: "text",
	acceptsArgs: true,
	args: [
		{ name: "target", description: "Deployment target" },
		{ name: "notes", description: "Deployment notes", captureRemaining: true },
	],
};

describe("command parser", () => {
	afterEach(() => {
		resetCommands();
	});

	it("detects enabled default commands by alias without matching ordinary chat text", () => {
		expect(hasCommand("/help")).toBe(true);
		expect(hasCommand("/h")).toBe(true);
		expect(hasCommand("please /help")).toBe(false);
		expect(hasCommand("/debug")).toBe(false);
		expect(detectCommand("/unknown")).toEqual({ isCommand: false });
	});

	it("parses colon syntax and normalizes bot mention prefixes", () => {
		const normalized = normalizeCommandBody("@Eliza /think: high", "eliza");

		expect(normalized).toBe("/think high");
		expect(detectCommand(normalized)).toEqual({
			isCommand: true,
			command: {
				key: "think",
				canonical: "/think",
				args: ["high"],
				rawArgs: "high",
			},
		});
	});

	it("tokenizes quoted positional args and captures remaining text", () => {
		registerCommand(customCommand);

		expect(detectCommand('/deploy "prod west" verify after deploy')).toEqual({
			isCommand: true,
			command: {
				key: "deploy",
				canonical: "/deploy",
				args: ["prod west", "verify after deploy"],
				rawArgs: '"prod west" verify after deploy',
			},
		});
	});

	it("returns the whole argument string for commands using argsParsing none", () => {
		const command: CommandDefinition = {
			key: "note",
			description: "Capture a note",
			textAliases: ["/note"],
			scope: "text",
			acceptsArgs: true,
			argsParsing: "none",
		};

		expect(parseCommand("/note keep  exact  spacing", command)).toEqual({
			key: "note",
			canonical: "/note",
			args: ["keep  exact  spacing"],
			rawArgs: "keep  exact  spacing",
		});
	});

	it("extracts remaining command text and distinguishes command-only messages", () => {
		expect(isCommandOnly("/help")).toBe(true);
		expect(isCommandOnly("/think high")).toBe(false);
		expect(extractCommand("/bash bun test --filter parser")).toEqual({
			command: {
				key: "bash",
				canonical: "/bash",
				args: ["bun test --filter parser"],
				rawArgs: "bun test --filter parser",
			},
			remainingText: "bun test --filter parser",
		});
	});

	it("ignores registered disabled commands", () => {
		registerCommand({
			...customCommand,
			enabled: false,
		});

		expect(findCommandByKey("deploy")?.enabled).toBe(false);
		expect(detectCommand("/deploy production")).toEqual({ isCommand: false });
	});

	it("fuzzes non-command prefixes without accidentally invoking command parsing", () => {
		fc.assert(
			fc.property(
				fc.string({ maxLength: 200 }).filter((value) => {
					const trimmed = value.trim();
					return !trimmed.startsWith("/") && !trimmed.startsWith("!");
				}),
				(text) => {
					expect(hasCommand(text)).toBe(false);
					expect(detectCommand(text)).toEqual({ isCommand: false });
					expect(extractCommand(text)).toBeNull();
				},
			),
			{ numRuns: 500 },
		);
	});

	it("fuzzes quoted command args without throwing or emitting phantom commands", () => {
		registerCommand(customCommand);

		fc.assert(
			fc.property(fc.string({ maxLength: 120 }), (suffix) => {
				const text = `/deploy "prod ${suffix}`;

				expect(() => detectCommand(text)).not.toThrow();
				const result = detectCommand(text);
				expect(result.isCommand).toBe(true);
				expect(result.command?.key).toBe("deploy");
				expect(result.command?.args.join(" ").length).toBeLessThanOrEqual(
					text.length,
				);
			}),
			{ numRuns: 300 },
		);
	});
});
