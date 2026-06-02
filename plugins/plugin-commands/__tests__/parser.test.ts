import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { formatCommandResult, isAuthorized, isElevated } from "../src/index";
import {
	detectCommand,
	extractCommand,
	hasCommand,
	isCommandOnly,
	normalizeCommandBody,
	parseCommand,
} from "../src/parser";
import {
	findCommandByAlias,
	findCommandByKey,
	initForRuntime,
	registerCommand,
	resetCommands,
	unregisterCommand,
	useRuntime,
} from "../src/registry";
import type { CommandContext, CommandDefinition } from "../src/types";

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

	it("normalizes hostile bot mention strings literally instead of as regex", () => {
		const mention = ["bot.*+?^", "$", "{}()|[]", "\\"].join("");
		const normalized = normalizeCommandBody(`@${mention} /help`, mention);

		expect(normalized).toBe("/help");
		expect(normalizeCommandBody("@botx /help", "bot.")).toBe("@botx /help");
	});

	it("accepts whitespace and colon separators without merging commands into args", () => {
		expect(detectCommand("/think\thigh")).toMatchObject({
			isCommand: true,
			command: { key: "think", args: ["high"], rawArgs: "high" },
		});
		expect(detectCommand("/think\nhigh")).toMatchObject({
			isCommand: true,
			command: { key: "think", args: ["high"], rawArgs: "high" },
		});
		expect(normalizeCommandBody("!deploy: prod")).toBe("!deploy prod");
	});

	it("rejects malformed command prefixes and alias smuggling attempts", () => {
		for (const text of [
			"/",
			"!",
			"/ help",
			"/helpful",
			"/help--force",
			"/help/../../reset",
			"/debug: true",
		]) {
			expect(detectCommand(text)).toEqual({ isCommand: false });
			expect(extractCommand(text)).toBeNull();
		}
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

	it("invalidates alias cache when replacing and unregistering commands", () => {
		registerCommand(customCommand);
		expect(findCommandByAlias("/deploy")?.key).toBe("deploy");

		registerCommand({
			...customCommand,
			textAliases: ["/ship"],
		});
		expect(findCommandByAlias("/deploy")).toBeUndefined();
		expect(detectCommand("/deploy prod")).toEqual({ isCommand: false });
		expect(detectCommand("/ship prod")).toMatchObject({
			isCommand: true,
			command: { key: "deploy", args: ["prod"] },
		});

		unregisterCommand("deploy");
		expect(findCommandByAlias("/ship")).toBeUndefined();
		expect(detectCommand("/ship prod")).toEqual({ isCommand: false });
	});

	it("keeps per-runtime command changes isolated when switching runtimes", () => {
		initForRuntime("agent-a");
		registerCommand(customCommand);

		initForRuntime("agent-b");
		expect(detectCommand("/deploy prod")).toEqual({ isCommand: false });

		useRuntime("agent-a");
		expect(detectCommand("/deploy prod")).toMatchObject({
			isCommand: true,
			command: { key: "deploy", args: ["prod"] },
		});

		useRuntime("agent-b");
		expect(detectCommand("/deploy prod")).toEqual({ isCommand: false });
	});

	it("denies auth and elevated checks only for commands that require them", () => {
		const context: CommandContext = {
			isAuthorized: false,
			isElevated: false,
			roomId: "room-1",
		};

		expect(isAuthorized(context, customCommand)).toBe(true);
		expect(
			isAuthorized(context, { ...customCommand, requiresAuth: true }),
		).toBe(false);
		expect(isElevated(context, customCommand)).toBe(true);
		expect(
			isElevated(context, { ...customCommand, requiresElevated: true }),
		).toBe(false);
	});

	it("formats command error results before fallback replies", () => {
		expect(
			formatCommandResult({
				handled: true,
				shouldContinue: false,
				reply: "ok",
				error: "permission denied",
			}),
		).toBe("Error: permission denied");
		expect(formatCommandResult({ handled: true, shouldContinue: false })).toBe(
			"Command executed",
		);
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
