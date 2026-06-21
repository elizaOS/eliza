import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	commandActions,
	commandShortcuts,
	dispatchCommandMessage,
	getCommandSettings,
	resolveCommand,
} from "../src/actions";
import { initForRuntime } from "../src/registry";

function makeRuntime(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		agentId: "agent-1",
		character: { name: "Eliza", settings: {} },
		getSetting: () => null,
		setSetting: () => undefined,
		getCache: async (key: string) => cache.get(key),
		setCache: async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => cache.delete(key),
		useModel: async () => "",
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

	it("/whoami reflects the sender context", async () => {
		const r = await resolveCommand(runtime, msg("/whoami"), {
			isAuthorized: true,
			isElevated: true,
			senderName: "Shaw",
		});
		expect(r.reply).toContain("You are Shaw");
		expect(r.reply).toContain("Authorized: yes");
	});

	it("/think <level> validates and persists real per-room state", async () => {
		const set = await resolveCommand(runtime, msg("/think high"));
		expect(set.reply).toBe("Thinking level set to high.");
		const stored = await getCommandSettings(runtime, "room-1");
		expect(stored.thinking).toBe("high");
		// Reading it back without an arg returns the persisted value.
		const show = await resolveCommand(runtime, msg("/think"));
		expect(show.reply).toContain("Thinking level is high.");
	});

	it("/think rejects an invalid level deterministically", async () => {
		const r = await resolveCommand(runtime, msg("/think bogus"));
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("Invalid thinking value");
		const stored = await getCommandSettings(runtime, "room-1");
		expect(stored.thinking).toBeUndefined();
	});

	it("/model preserves free-form casing", async () => {
		const r = await resolveCommand(
			runtime,
			msg("/model Anthropic/Claude-Opus"),
		);
		expect(r.reply).toBe("Model set to Anthropic/Claude-Opus.");
		expect((await getCommandSettings(runtime, "room-1")).model).toBe(
			"Anthropic/Claude-Opus",
		);
	});

	it("auth-gated /elevated fails closed for an unauthorized sender", async () => {
		const denied = await resolveCommand(runtime, msg("/elevated on"), {
			isAuthorized: false,
		});
		expect(denied.reply).toBe("This command requires authorization.");
		const allowed = await resolveCommand(runtime, msg("/elevated on"), {
			isAuthorized: true,
		});
		expect(allowed.reply).toBe("Elevated mode set to on.");
	});

	it("does NOT short-circuit lifecycle commands (reset/new/compact)", async () => {
		for (const text of ["/reset", "/new", "/compact"]) {
			const r = await resolveCommand(runtime, msg(text), {
				isAuthorized: true,
			});
			expect(r.handled).toBe(false);
		}
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

	it("registers one action per gate-safe command", () => {
		const names = new Set(commandActions.map((a) => a.name));
		expect(names.has("HELP_COMMAND")).toBe(true);
		expect(names.has("STATUS_COMMAND")).toBe(true);
		expect(names.has("THINK_COMMAND")).toBe(true);
		// Lifecycle commands are NOT gate-safe actions.
		expect(names.has("RESET_COMMAND")).toBe(false);
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
	it("every slash shortcut targets a registered command action", () => {
		const actionNames = new Set(commandActions.map((a) => a.name));
		expect(commandShortcuts.length).toBeGreaterThan(0);
		for (const shortcut of commandShortcuts) {
			expect(shortcut.kind).toBe("explicit");
			expect(shortcut.target.kind).toBe("action");
			if (shortcut.target.kind === "action") {
				expect(actionNames.has(shortcut.target.name)).toBe(true);
			}
		}
	});

	it("shortcut aliases match the command's text aliases (slash-only)", () => {
		for (const shortcut of commandShortcuts) {
			expect(shortcut.aliases && shortcut.aliases.length > 0).toBe(true);
			for (const alias of shortcut.aliases ?? []) {
				expect(alias.startsWith("/")).toBe(true);
			}
		}
	});
});
