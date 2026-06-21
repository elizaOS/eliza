import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutRegistry } from "../runtime/shortcut-registry";
import type { Action } from "../types/components";
import { EventType } from "../types/events";
import type { Memory, State, UUID } from "../types/index";
import { runShortcutGate } from "./message";

/**
 * Integration test for the pre-LLM shortcut gate (#8791): a confident match
 * runs the target action and returns its reply with ZERO model calls. The fake
 * runtime's useModel throws, so any inference attempt fails the test.
 */
function echoAction(
	opts: {
		validate?: () => Promise<boolean>;
		onOptions?: (options: Record<string, unknown> | undefined) => void;
	} = {},
): Action {
	return {
		name: "ECHO_COMMAND",
		description: "echo",
		validate: opts.validate ?? (async () => true),
		handler: async (_rt, message, _state, options, callback) => {
			opts.onOptions?.(options);
			const text = `echoed: ${message.content.text}`;
			if (callback) await callback({ text });
			return { success: true, text };
		},
	};
}

function makeRuntime(opts: { actions?: Action[] } = {}) {
	const registry = new ShortcutRegistry();
	registry.register({
		id: "cmd:echo",
		kind: "explicit",
		aliases: ["/echo"],
		target: { kind: "action", name: "ECHO_COMMAND" },
	});
	registry.register({
		id: "nav:home",
		kind: "explicit",
		aliases: ["/home"],
		target: { kind: "navigate", path: "/home" },
	});
	const emitEvent = vi.fn(async () => undefined);
	const useModel = vi.fn(async () => {
		throw new Error("useModel must NOT be called on a shortcut turn");
	});
	const runtime = {
		agentId: "00000000-0000-0000-0000-0000000000a1" as UUID,
		actions: opts.actions ?? [echoAction()],
		shortcutRegistry: registry,
		emitEvent,
		useModel,
		logger: { debug: () => {}, warn: () => {} },
	};
	return { runtime, emitEvent, useModel };
}

function msg(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-0000000000b1" as UUID,
		entityId: "00000000-0000-0000-0000-0000000000c1" as UUID,
		roomId: "00000000-0000-0000-0000-0000000000d1" as UUID,
		content: { text },
	} as unknown as Memory;
}

const responseId = "00000000-0000-0000-0000-0000000000e1" as UUID;

afterEach(() => {
	delete process.env.ELIZA_SHORTCUTS_DISABLED;
	delete process.env.ELIZA_SHORTCUTS_NL;
});

describe("runShortcutGate (#8791 pre-LLM gate)", () => {
	it("dispatches a slash command to its action with zero model calls", async () => {
		const { runtime, useModel, emitEvent } = makeRuntime();
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo hi"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("direct_reply");
		expect(result?.result.responseContent.text).toBe("echoed: /echo hi");
		expect(useModel).not.toHaveBeenCalled();
		// #8792: a SLASH_COMMAND_INVOKED interaction event is emitted.
		expect(emitEvent).toHaveBeenCalledTimes(1);
		const [eventType, payload] = emitEvent.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(eventType).toBe(EventType.SLASH_COMMAND_INVOKED);
		expect(payload.command).toBe("echo");
		expect(payload.initiatedBy).toBe("user");
	});

	it("returns null for a non-command message (turn proceeds to the LLM)", async () => {
		const { runtime, useModel } = makeRuntime();
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("hello there"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result).toBeNull();
		expect(useModel).not.toHaveBeenCalled();
	});

	it("ignores navigate-target shortcuts (resolved client-side)", async () => {
		const { runtime } = makeRuntime();
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/home"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result).toBeNull();
	});

	it("bypasses entirely when ELIZA_SHORTCUTS_DISABLED=1 (byte-identical fallback)", async () => {
		process.env.ELIZA_SHORTCUTS_DISABLED = "1";
		const { runtime } = makeRuntime();
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo hi"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result).toBeNull();
	});

	it("falls through when the target action is missing (no misfire)", async () => {
		const { runtime } = makeRuntime({ actions: [] });
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo hi"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result).toBeNull();
	});

	it("falls through when an explicit shortcut action fails validate", async () => {
		const validate = vi.fn(async () => false);
		const { runtime, useModel } = makeRuntime({
			actions: [echoAction({ validate })],
		});
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo hi"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result).toBeNull();
		expect(validate).toHaveBeenCalledTimes(1);
		expect(useModel).not.toHaveBeenCalled();
	});

	it("fires a natural-language shortcut only when ELIZA_SHORTCUTS_NL=1 (voice/typed parity)", async () => {
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { runtime, useModel, emitEvent } = makeRuntime({
			actions: [
				echoAction({
					onOptions: (options) => seenOptions.push(options),
				}),
			],
		});
		// A natural shortcut targeting ECHO_COMMAND, eligible only when NL is on.
		(runtime.shortcutRegistry as ShortcutRegistry).register({
			id: "nl:echo",
			kind: "natural",
			patterns: [{ template: "echo {what}" }],
			target: { kind: "action", name: "ECHO_COMMAND" },
		});

		// Default: NL disabled → no match (the turn would proceed to the LLM).
		const off = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("echo hello there"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(off).toBeNull();

		// Enabled (mirrors a typed message and an ASR transcript): fires the action.
		process.env.ELIZA_SHORTCUTS_NL = "1";
		const on = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("echo hello there"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(on?.kind).toBe("direct_reply");
		expect(seenOptions[0]).toEqual({ what: "hello there", mode: "simple" });
		expect(useModel).not.toHaveBeenCalled();
		const shortcutEvents = emitEvent.mock.calls.filter(
			(c) => c[0] === EventType.SHORTCUT_FIRED,
		);
		expect(shortcutEvents).toHaveLength(1);
	});
});
