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

	it("falls through and logs when an explicit shortcut action validate() throws (#9153)", async () => {
		const boom = new Error("validate exploded");
		const validate = vi.fn(async () => {
			throw boom;
		});
		const warn = vi.fn();
		const { runtime, useModel } = makeRuntime({
			actions: [echoAction({ validate })],
		});
		runtime.logger.warn = warn;
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo hi"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		// A crashing validate() must still fall through to the pipeline (return null)
		// without invoking the model — but the crash must be observable, not swallowed.
		expect(result).toBeNull();
		expect(validate).toHaveBeenCalledTimes(1);
		expect(useModel).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		const [context, message] = warn.mock.calls[0] as [
			Record<string, unknown>,
			string,
		];
		expect(context).toMatchObject({
			src: "shortcut-gate",
			shortcut: "cmd:echo",
			action: "ECHO_COMMAND",
			err: boom,
		});
		expect(message).toContain("validate");
	});

	it("fires a confident natural-language shortcut without an env gate (voice/typed parity)", async () => {
		const seenOptions: Array<Record<string, unknown> | undefined> = [];
		const { runtime, useModel, emitEvent } = makeRuntime({
			actions: [
				echoAction({
					onOptions: (options) => seenOptions.push(options),
				}),
			],
		});
		// A narrow natural shortcut targeting ECHO_COMMAND.
		(runtime.shortcutRegistry as ShortcutRegistry).register({
			id: "nl:echo",
			kind: "natural",
			patterns: [{ template: "echo {what}" }],
			target: { kind: "action", name: "ECHO_COMMAND" },
		});

		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("echo hello there"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result?.kind).toBe("direct_reply");
		expect(seenOptions[0]).toEqual({ what: "hello there", mode: "simple" });
		expect(useModel).not.toHaveBeenCalled();
		const shortcutEvents = emitEvent.mock.calls.filter(
			(c) => c[0] === EventType.SHORTCUT_FIRED,
		);
		expect(shortcutEvents).toHaveLength(1);
	});

	it("blocks a USER from an OWNER-gated action reached via a shortcut (#12088)", async () => {
		// The shortcut deliberately omits requiresElevated, so registry.match()
		// admits it for a USER — the target action's declared roleGate is now the
		// only thing standing between a USER and the OWNER-gated handler.
		const handler = vi.fn(async () => ({ success: true, text: "secret" }));
		const gatedAction: Action = {
			name: "OWNER_ONLY_ACTION",
			description: "owner only",
			roleGate: { minRole: "OWNER" },
			validate: async () => true,
			handler,
		};
		const { runtime, useModel } = makeRuntime({ actions: [gatedAction] });
		(runtime.shortcutRegistry as ShortcutRegistry).register({
			id: "cmd:owner",
			kind: "explicit",
			aliases: ["/owner"],
			target: { kind: "action", name: "OWNER_ONLY_ACTION" },
		});

		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/owner secrets"),
			state: {} as State,
			responseId,
			senderRole: "USER",
		});

		// getGateFailure rejects the USER before validate/handler run: the gate
		// falls through to the normal pipeline (which enforces the gate again).
		expect(result).toBeNull();
		expect(handler).not.toHaveBeenCalled();
		expect(useModel).not.toHaveBeenCalled();
	});

	it("still runs the same OWNER-gated shortcut action for an OWNER sender (#12088)", async () => {
		const handler = vi.fn(
			async (
				_rt: unknown,
				_m: unknown,
				_s: unknown,
				_o: unknown,
				callback?: (content: { text: string }) => Promise<unknown>,
			) => {
				if (callback) await callback({ text: "secret-value" });
				return { success: true, text: "secret-value" };
			},
		);
		const gatedAction: Action = {
			name: "OWNER_ONLY_ACTION",
			description: "owner only",
			roleGate: { minRole: "OWNER" },
			validate: async () => true,
			// biome-ignore lint/suspicious/noExplicitAny: handler spy shape
			handler: handler as any,
		};
		const { runtime } = makeRuntime({ actions: [gatedAction] });
		(runtime.shortcutRegistry as ShortcutRegistry).register({
			id: "cmd:owner",
			kind: "explicit",
			aliases: ["/owner"],
			target: { kind: "action", name: "OWNER_ONLY_ACTION" },
		});

		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/owner secrets"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});

		expect(result?.kind).toBe("direct_reply");
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
