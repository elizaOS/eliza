/**
 * Deterministic-handler coverage for the slash-command actions (`/help`,
 * `/status`, `/whoami`, runtime option setters). Exercises `runCommand` /
 * `resolveCommand` against an in-memory runtime stub — no live model.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	commandActions,
	commandShortcuts,
	dispatchCommandMessage,
	explicitCommandShortcuts,
	getCommandSettings,
	naturalShortcuts,
	resolveCommand,
} from "../src/actions";
import {
	getEnabledCommandsForRuntime,
	initForRuntime,
	registerCommand,
	useRuntime,
} from "../src/registry";

function makeRuntime(
	agentId = "agent-1",
	onGetCache?: (key: string) => void | Promise<void>,
	overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
	const cache = new Map<string, unknown>();
	let messages: Memory[] = [msg("first"), msg("second")];
	return {
		agentId,
		character: { name: "Eliza", settings: {} },
		actions: [],
		getSetting: () => null,
		setSetting: () => undefined,
		getCache: async (key: string) => {
			await onGetCache?.(key);
			return cache.get(key);
		},
		setCache: async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => cache.delete(key),
		countMemories: async () => messages.length,
		deleteAllMemories: async () => {
			messages = [];
		},
		useModel: async () => "",
		...overrides,
	} as unknown as IAgentRuntime;
}

function msg(text: string, source = "client_chat"): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		entityId: "00000000-0000-0000-0000-0000000000aa",
		roomId: "room-1",
		content: { text, source },
	} as unknown as Memory;
}

describe("runCommand / resolveCommand — deterministic handlers (#8790)", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-1");
		runtime = makeRuntime();
	});

	it("/help lists the registered commands deterministically", async () => {
		const r = await resolveCommand(runtime, msg("/help"));
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("Available commands");
		expect(r.reply).toContain("/help");
	});

	it("/status reports real runtime state", async () => {
		const r = await resolveCommand(runtime, msg("/status"));
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("Agent: Eliza");
		expect(r.reply).toContain("Commands enabled:");
	});

	it("/status keeps its runtime-scoped store across awaited settings reads", async () => {
		initForRuntime("agent-a");
		useRuntime("agent-a");
		registerCommand({
			key: "agent-a-only",
			description: "Runtime-local command",
			textAliases: ["/agent-a-only"],
			scope: "both",
			category: "skills",
		});
		initForRuntime("agent-b");

		const agentACommandCount = getEnabledCommandsForRuntime("agent-a").length;
		expect(agentACommandCount).toBe(
			getEnabledCommandsForRuntime("agent-b").length + 1,
		);

		const runtimeA = makeRuntime("agent-a", async () => {
			useRuntime("agent-b");
		});
		const r = await resolveCommand(runtimeA, msg("/status"));

		expect(r.handled).toBe(true);
		expect(r.reply).toContain(`Commands enabled: ${agentACommandCount}`);
	});

	it("/whoami reflects the sender context", async () => {
		const r = await resolveCommand(runtime, msg("/whoami"), {
			isAuthorized: true,
			isElevated: true,
			senderName: "Shaw",
		});
		expect(r.reply).toContain("You are Shaw");
		expect(r.reply).toContain("Authorized: yes");
	});

	it("deterministically persists runtime option commands", async () => {
		const cases = [
			["/think high", "Thinking set to high."],
			["/verbose on", "Verbose set to on."],
			["/reasoning stream", "Reasoning set to stream."],
			["/queue steer", "Queue mode set to steer."],
			["/elevated on", "Elevated mode set to on."],
			["/model Anthropic/Claude-Opus", "Model set to Anthropic/Claude-Opus."],
			["/tts off", "TTS set to off."],
		] as const;
		for (const [text, expectedReply] of cases) {
			const r = await resolveCommand(runtime, msg(text), {
				isAuthorized: true,
				isElevated: true,
			});
			expect(r.handled, text).toBe(true);
			expect(r.reply).toBe(expectedReply);
		}
		expect(await getCommandSettings(runtime, "room-1")).toEqual({
			thinking: "high",
			verbose: "on",
			reasoning: "stream",
			queue: "steer",
			elevated: "on",
			model: "Anthropic/Claude-Opus",
			tts: "off",
		});
	});

	it("rejects invalid option values deterministically", async () => {
		const r = await resolveCommand(runtime, msg("/think enormous"), {
			isAuthorized: true,
		});
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("Invalid thinking value");
	});

	it("deterministically handles lifecycle commands (reset/new/compact)", async () => {
		await resolveCommand(runtime, msg("/think high"), { isAuthorized: true });
		const reset = await resolveCommand(runtime, msg("/reset"), {
			isAuthorized: true,
		});
		expect(reset.handled).toBe(true);
		expect(reset.reply).toContain("cleared command settings");
		expect(reset.reply).toContain("2 message(s)");
		expect(await getCommandSettings(runtime, "room-1")).toEqual({});

		await resolveCommand(runtime, msg("/model gpt-5"));
		const next = await resolveCommand(runtime, msg("/new"), {
			isAuthorized: true,
		});
		expect(next.handled).toBe(true);
		expect(next.reply).toBe(
			"Started a new conversation context for this room.",
		);
		expect(await getCommandSettings(runtime, "room-1")).toEqual({});

		const compactRuntime = makeRuntime("agent-1", undefined, {
			actions: [
				{
					name: "COMPACT_CONVERSATION",
					description: "Compact",
					validate: async () => true,
					handler: async () => ({
						success: true,
						text: "Compacted 4 older message(s); preserved the latest 2.",
					}),
				},
			],
		});
		const compact = await resolveCommand(compactRuntime, msg("/compact"), {
			isAuthorized: true,
		});
		expect(compact.handled).toBe(true);
		expect(compact.reply).toContain("Compacted 4 older message(s)");
	});

	it("ignores non-command messages", async () => {
		expect((await resolveCommand(runtime, msg("hello world"))).handled).toBe(
			false,
		);
	});

	it("dispatchCommandMessage fires the callback with the reply", async () => {
		const calls: Array<{ text: string; source?: string }> = [];
		const handled = await dispatchCommandMessage(
			runtime,
			msg("/help"),
			(reply) => {
				calls.push(reply);
				return [];
			},
		);
		expect(handled).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.text).toContain("Available commands");
	});
});

describe("command actions — slash-only validate (#8790)", () => {
	let runtime: IAgentRuntime;
	beforeEach(() => {
		initForRuntime("agent-1");
		runtime = makeRuntime();
	});

	it("registers one action per deterministic command", () => {
		const names = new Set(commandActions.map((a) => a.name));
		expect(names.has("HELP_COMMAND")).toBe(true);
		expect(names.has("STATUS_COMMAND")).toBe(true);
		expect(names.has("THINK_COMMAND")).toBe(true);
		expect(names.has("MODEL_COMMAND")).toBe(true);
		expect(names.has("TTS_COMMAND")).toBe(true);
		expect(names.has("RESET_COMMAND")).toBe(true);
		expect(names.has("NEW_COMMAND")).toBe(true);
		expect(names.has("COMPACT_COMMAND")).toBe(true);
		expect(names.has("STOP_COMMAND")).toBe(false);
		expect(names.has("RESTART_COMMAND")).toBe(false);
	});

	it("validate() matches only its own slash command, never plain text", async () => {
		const help = commandActions.find((a) => a.name === "HELP_COMMAND");
		expect(help).toBeDefined();
		expect(await help?.validate(runtime, msg("/help"))).toBe(true);
		expect(await help?.validate(runtime, msg("/status"))).toBe(false);
		expect(await help?.validate(runtime, msg("I need help please"))).toBe(
			false,
		);
	});

	it("handler produces the deterministic reply via the callback", async () => {
		const status = commandActions.find((a) => a.name === "STATUS_COMMAND");
		const replies: string[] = [];
		const result = await status?.handler(
			runtime,
			msg("/status"),
			undefined,
			undefined,
			async (content) => {
				replies.push(String(content.text));
				return [];
			},
		);
		expect(result?.success).toBe(true);
		expect(replies[0]).toContain("Agent: Eliza");
	});

	it("similes are slash-only (no natural language)", () => {
		for (const action of commandActions) {
			for (const simile of action.similes ?? []) {
				expect(simile.startsWith("/")).toBe(true);
			}
		}
	});
});

describe("command shortcuts ↔ actions linkage (#8790 × #8791)", () => {
	it("every shortcut targets a registered command action", () => {
		const actionNames = new Set(commandActions.map((a) => a.name));
		expect(commandShortcuts.length).toBeGreaterThan(0);
		// commandShortcuts = explicit slash shortcuts + narrow natural ones.
		expect(commandShortcuts).toEqual([
			...explicitCommandShortcuts,
			...naturalShortcuts,
		]);
		for (const shortcut of commandShortcuts) {
			expect(shortcut.target.kind).toBe("action");
			if (shortcut.target.kind === "action") {
				expect(actionNames.has(shortcut.target.name)).toBe(true);
			}
		}
	});

	it("explicit slash shortcuts are explicit-only with slash aliases", () => {
		expect(explicitCommandShortcuts.length).toBeGreaterThan(0);
		for (const shortcut of explicitCommandShortcuts) {
			expect(shortcut.kind).toBe("explicit");
			expect(shortcut.aliases && shortcut.aliases.length > 0).toBe(true);
			for (const alias of shortcut.aliases ?? []) {
				expect(alias.startsWith("/")).toBe(true);
			}
		}
	});

	it("natural shortcuts carry no slash aliases (anchored patterns)", () => {
		for (const shortcut of naturalShortcuts) {
			expect(shortcut.kind).toBe("natural");
			expect(shortcut.aliases ?? []).toHaveLength(0);
			expect(shortcut.patterns && shortcut.patterns.length > 0).toBe(true);
		}
	});

	it("records every shortcut alias/action signature for the e2e coverage matrix", () => {
		const signatures = commandShortcuts
			.flatMap((shortcut) => {
				const target =
					shortcut.target.kind === "action"
						? shortcut.target.name
						: shortcut.target.kind;
				return (shortcut.aliases ?? []).map(
					(alias) => `${shortcut.id}:${alias}->${target}`,
				);
			})
			.sort();

		expect(signatures).toEqual([
			"cmd:commands:/cmds->COMMANDS_COMMAND",
			"cmd:commands:/commands->COMMANDS_COMMAND",
			"cmd:compact:/compact->COMPACT_COMMAND",
			"cmd:context:/context->CONTEXT_COMMAND",
			"cmd:context:/ctx->CONTEXT_COMMAND",
			"cmd:elevated:/elev->ELEVATED_COMMAND",
			"cmd:elevated:/elevated->ELEVATED_COMMAND",
			"cmd:help:/?->HELP_COMMAND",
			"cmd:help:/h->HELP_COMMAND",
			"cmd:help:/help->HELP_COMMAND",
			"cmd:model:/m->MODEL_COMMAND",
			"cmd:model:/model->MODEL_COMMAND",
			"cmd:models:/models->MODELS_COMMAND",
			"cmd:new:/new->NEW_COMMAND",
			"cmd:queue:/q->QUEUE_COMMAND",
			"cmd:queue:/queue->QUEUE_COMMAND",
			"cmd:reasoning:/reason->REASONING_COMMAND",
			"cmd:reasoning:/reasoning->REASONING_COMMAND",
			"cmd:reset:/reset->RESET_COMMAND",
			"cmd:status:/s->STATUS_COMMAND",
			"cmd:status:/status->STATUS_COMMAND",
			"cmd:think:/t->THINK_COMMAND",
			"cmd:think:/think->THINK_COMMAND",
			"cmd:think:/thinking->THINK_COMMAND",
			"cmd:tts:/tts->TTS_COMMAND",
			"cmd:tts:/voice->TTS_COMMAND",
			"cmd:usage:/usage->USAGE_COMMAND",
			"cmd:verbose:/v->VERBOSE_COMMAND",
			"cmd:verbose:/verbose->VERBOSE_COMMAND",
			"cmd:whoami:/who->WHOAMI_COMMAND",
			"cmd:whoami:/whoami->WHOAMI_COMMAND",
		]);
	});
});
