/**
 * Integration tests for runShortcutGate, the explicit-protocol pre-LLM gate.
 * Slash commands dispatch straight to their target action while ordinary
 * language always falls through to the planner; role gates, validation
 * failures, and the disable flag remain covered.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutRegistry } from "../runtime/shortcut-registry";
import {
	getStreamingContext,
	runWithStreamingContext,
} from "../streaming-context";
import type { Action } from "../types/components";
import type { EffectReceipt } from "../types/effects";
import { EventType } from "../types/events";
import type { Memory, State, UUID } from "../types/index";
import { runShortcutGate } from "./message";

function echoAction(
	opts: {
		validate?: () => Promise<boolean>;
		onOptions?: (options: Record<string, unknown> | undefined) => void;
		parameters?: Action["parameters"];
	} = {},
): Action {
	return {
		name: "ECHO_COMMAND",
		description: "echo",
		...(opts.parameters ? { parameters: opts.parameters } : {}),
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
		getRoom: vi.fn(async () => null),
		reportError: vi.fn(),
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
		// The shared executor emits lifecycle events as well as the interaction.
		const interactionEvents = emitEvent.mock.calls.filter(
			(call) => call[0] === EventType.SLASH_COMMAND_INVOKED,
		);
		expect(interactionEvents).toHaveLength(1);
		const [eventType, payload] = interactionEvents[0] as [
			string,
			Record<string, unknown>,
		];
		expect(eventType).toBe(EventType.SLASH_COMMAND_INVOKED);
		expect(payload.command).toBe("echo");
		expect(payload.initiatedBy).toBe("user");
		expect(emitEvent.mock.calls.map((call) => call[0])).toEqual([
			EventType.ACTION_STARTED,
			EventType.ACTION_COMPLETED,
			EventType.SLASH_COMMAND_INVOKED,
		]);
	});

	it("publishes a receipt-backed shortcut settlement before later turn work", async () => {
		const receipt: EffectReceipt = {
			receiptId: "receipt-shortcut-create-1",
			operation: "test.shortcut.create",
			resource: { kind: "test.shortcut", id: "created-1" },
			artifacts: [],
			idempotency: { key: "shortcut-create-1", replayed: false },
			observedAt: "2026-07-31T19:00:00.000Z",
			outcome: "applied",
			commit: {
				kind: "durable",
				id: "created-1",
				committedAt: "2026-07-31T19:00:00.000Z",
			},
		};
		const text = "Shortcut item created.";
		const action = echoAction();
		action.tags = ["capability:write", "effect:receipt-required"];
		action.handler = async (_rt, _message, _state, _options, callback) => {
			await callback?.({ text });
			return {
				success: true,
				text,
				userFacingText: text,
				verifiedUserFacing: true,
				effectReceipts: [receipt],
				userFacingEffectReceiptIds: [receipt.receiptId],
			};
		};
		const onSettledActionResult = vi.fn();
		const { runtime } = makeRuntime({ actions: [action] });

		const result = await runShortcutGate({
			// biome-ignore lint/suspicious/noExplicitAny: minimal fake runtime
			runtime: runtime as any,
			message: msg("/echo create"),
			state: {} as State,
			responseId,
			senderRole: "OWNER",
			onSettledActionResult,
		});

		expect(result?.kind).toBe("direct_reply");
		expect(onSettledActionResult).toHaveBeenCalledTimes(1);
		expect(onSettledActionResult).toHaveBeenCalledWith(
			expect.objectContaining({
				success: true,
				effectReceipts: [
					expect.objectContaining({ receiptId: receipt.receiptId }),
				],
			}),
		);
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

	it("falls through and logs when an explicit shortcut action validate() throws", async () => {
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
		// A crashing validate() falls through without invoking the model, while
		// remaining observable because no planner transcript receives it.
		expect(result).toBeNull();
		expect(validate).toHaveBeenCalledTimes(1);
		expect(useModel).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toMatchObject({
			src: "shortcut-gate",
			shortcut: "cmd:echo",
			action: "ECHO_COMMAND",
			err: boom,
		});
		expect(warn.mock.calls[0]?.[1]).toContain("failed");
	});

	it("never dispatches a registered natural-language shortcut before inference", async () => {
		const validate = vi.fn(async () => true);
		const { runtime, useModel, emitEvent } = makeRuntime({
			actions: [
				echoAction({
					validate,
					parameters: [
						{
							name: "what",
							description: "Text to echo",
							required: true,
							schema: { type: "string" },
						},
					],
				}),
			],
		});
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
		expect(result).toBeNull();
		expect(validate).not.toHaveBeenCalled();
		expect(useModel).not.toHaveBeenCalled();
		const shortcutEvents = emitEvent.mock.calls.filter(
			(c) => c[0] === EventType.SHORTCUT_FIRED,
		);
		expect(shortcutEvents).toHaveLength(0);
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

	// #16230: a shortcut action's internal model call must not stream into the turn's visible
	// reply. runShortcutGate runs the handler inside runWithSuppressedModelStream,
	// so intermediate model output never reaches the chat SSE sink; the designed
	// reply reaches the client through the captured callback text.
	it("keeps a shortcut action's internal model output off the visible stream, surfacing only the reply (#16230)", async () => {
		const LEDGER = '```json\n{"state":{"facts":["internal fact"]}}\n```';
		const SUMMARY = "Shortcut completed.";
		const visibleSink = vi.fn();

		const registry = new ShortcutRegistry();
		registry.register({
			id: "cmd:probe",
			kind: "explicit",
			aliases: ["/probe"],
			target: { kind: "action", name: "PROBE" },
		});
		const probeAction: Action = {
			name: "PROBE",
			description: "exercise shortcut stream suppression",
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
			actions: [probeAction],
			shortcutRegistry: registry,
			getRoom: vi.fn(async () => null),
			reportError: vi.fn(),
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
					message: msg("/probe"),
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
				data: { actionName: "PROBE" },
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
