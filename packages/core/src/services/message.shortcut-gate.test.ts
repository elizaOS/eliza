/**
 * Integration tests for runShortcutGate, the pre-LLM shortcut gate: confident
 * slash-command and natural-language matches dispatch straight to the target
 * action with zero model calls, honoring role gates, validate() failures, and
 * the disable env flag. The fake runtime's useModel throws, so any inference
 * attempt fails the test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutRegistry } from "../runtime/shortcut-registry";
import {
	getStreamingContext,
	runWithStreamingContext,
} from "../streaming-context";
import type { Action } from "../types/components";
import { EventType } from "../types/events";
import type { Memory, State, UUID } from "../types/index";
import { runShortcutGate } from "./message";

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
		expect(result?.result.actionResults).toEqual([
			{
				success: true,
				text: "echoed: /echo hi",
				data: { actionName: "ECHO_COMMAND" },
			},
		]);
		expect(result?.result.state.data.actionResults).toEqual(
			result?.result.actionResults,
		);
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
		expect(result?.result.actionResults).toMatchObject([
			{ success: true, data: { actionName: "ECHO_COMMAND" } },
		]);
		expect(result?.result.responseContent.thought).toBe("Shortcut: nl:echo");
		expect(seenOptions[0]).toEqual({ what: "hello there", mode: "simple" });
		expect(useModel).not.toHaveBeenCalled();
		const shortcutEvents = emitEvent.mock.calls.filter(
			(c) => c[0] === EventType.SHORTCUT_FIRED,
		);
		expect(shortcutEvents).toHaveLength(1);
	});

	it("does not publish sensitive shortcut result data or values", async () => {
		const sensitiveAction: Action = {
			...echoAction(),
			suppressActionResultClipboard: true,
			handler: async (_rt, _message, _state, _options, callback) => {
				await callback?.({ text: "Sensitive action completed." });
				return {
					success: true,
					text: "Sensitive action completed.",
					values: { secret: "must-not-leak" },
					data: { credential: "must-not-leak" },
				};
			},
		};
		const { runtime } = makeRuntime({ actions: [sensitiveAction] });

		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo secret"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});

		expect(result?.result.actionResults).toEqual([
			{
				success: true,
				text: "Sensitive action completed.",
				data: { actionName: "ECHO_COMMAND" },
			},
		]);
	});

	it("honors dynamic shortcut suppression and preserves a failed outcome", async () => {
		const sensitiveAction: Action = {
			...echoAction(),
			handler: async (_rt, _message, _state, _options, callback) => {
				await callback?.({ text: "View edit did not start." });
				return {
					success: false,
					text: "View edit did not start.",
					userFacingText: "View edit did not start.",
					values: { workdir: "/private/must-not-leak" },
					data: {
						task: { sessionId: "must-not-leak" },
						suppressActionResultClipboard: true,
					},
				};
			},
		};
		const { runtime } = makeRuntime({ actions: [sensitiveAction] });

		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo edit view"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});

		expect(result?.result.actionResults).toEqual([
			{
				success: false,
				text: "View edit did not start.",
				userFacingText: "View edit did not start.",
				data: { actionName: "ECHO_COMMAND" },
			},
		]);
		expect(JSON.stringify(result)).not.toContain("must-not-leak");
	});

	// #12087 Item 3: the shortcut path enforces the target action's declared
	// roleGate before running its handler, so a shortcut targeting an OWNER-gated
	// action is unreachable by a USER whose shortcut lacks `requiresElevated`.
	function ownerGatedEcho(handler: Action["handler"]): Action {
		return {
			name: "ECHO_COMMAND",
			description: "owner-only echo",
			roleGate: { minRole: "OWNER" },
			validate: async () => true,
			handler,
		};
	}

	it("rejects a USER triggering an OWNER-gated shortcut action (never runs the handler)", async () => {
		const handler = vi.fn(async () => ({ success: true, text: "secret" }));
		const { runtime, useModel } = makeRuntime({
			actions: [ownerGatedEcho(handler)],
		});
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo hi"),
			state: {} as State,
			responseId,
			senderRole: "USER",
		});
		expect(result).toBeNull();
		expect(handler).not.toHaveBeenCalled();
		expect(useModel).not.toHaveBeenCalled();
	});

	// #16230: a shortcut action's INTERNAL model call (e.g. the /compact
	// compactor's ledger extraction) must not stream into the turn's visible
	// reply. runShortcutGate runs the handler inside runWithSuppressedModelStream,
	// so intermediate model output never reaches the chat SSE sink; the designed
	// reply reaches the client through the captured callback text.
	it("keeps a shortcut action's internal model output off the visible stream, surfacing only the reply (#16230)", async () => {
		const LEDGER = '```json\n{"state":{"facts":["internal fact"]}}\n```';
		const SUMMARY = "Compacted 8 older message(s); preserved the latest 4.";
		const visibleSink = vi.fn();

		const registry = new ShortcutRegistry();
		registry.register({
			id: "cmd:compact",
			kind: "explicit",
			aliases: ["/compact"],
			target: { kind: "action", name: "COMPACT_CONVERSATION" },
		});
		const compactAction: Action = {
			name: "COMPACT_CONVERSATION",
			description: "compact the conversation",
			validate: async () => true,
			handler: async (rt, _message, _state, _options, callback) => {
				// Internal model call: streaming happens inside useModel, which reads
				// the active streaming context — the leak vector.
				await rt.useModel("TEXT_LARGE" as never, {
					prompt: "extract the conversation ledger",
				});
				// The action's actual, user-visible reply.
				if (callback) await callback({ text: SUMMARY });
				return { success: true, text: SUMMARY };
			},
		};
		const runtime = {
			agentId: "00000000-0000-0000-0000-0000000000a1" as UUID,
			actions: [compactAction],
			shortcutRegistry: registry,
			emitEvent: vi.fn(async () => undefined),
			// A streaming model that pushes intermediate ledger JSON into whatever
			// streaming context is active during the call.
			useModel: async () => {
				const active = getStreamingContext();
				await active?.onStreamChunk?.(LEDGER, undefined, LEDGER);
				return LEDGER;
			},
			logger: { debug: () => {}, warn: () => {} },
		};

		const result = await runWithStreamingContext(
			{
				messageId: "00000000-0000-0000-0000-0000000000f1" as UUID,
				onStreamChunk: async (chunk: string) => {
					visibleSink(chunk);
				},
			} as never,
			() =>
				runShortcutGate({
					// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
					runtime: runtime as any,
					message: msg("/compact"),
					state: {} as State,
					responseId,
					senderRole: "OWNER",
				}),
		);

		// The internal ledger JSON never surfaced as a visible token...
		expect(visibleSink).not.toHaveBeenCalled();
		// ...and the designed summary is the reply.
		expect(result?.kind).toBe("direct_reply");
		expect(result?.result.responseContent.text).toBe(SUMMARY);
		expect(result?.result.actionResults).toMatchObject([
			{
				success: true,
				text: SUMMARY,
				data: { actionName: "COMPACT_CONVERSATION" },
			},
		]);
	});

	it("allows an OWNER to trigger the same OWNER-gated shortcut action", async () => {
		const handler = vi.fn(
			async (
				_rt: unknown,
				_m: unknown,
				_s: unknown,
				_o: unknown,
				cb?: (c: { text: string }) => Promise<unknown>,
			) => {
				if (cb) await cb({ text: "secret ok" });
				return { success: true, text: "secret ok" };
			},
		);
		const { runtime } = makeRuntime({
			actions: [ownerGatedEcho(handler as unknown as Action["handler"])],
		});
		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo hi"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
		});
		expect(result?.kind).toBe("direct_reply");
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
