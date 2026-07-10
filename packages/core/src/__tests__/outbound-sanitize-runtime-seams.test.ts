/**
 * Exercises the two outbound sanitization seams that live on AgentRuntime
 * itself (#15888): the mandatory `outgoing_before_deliver` pipeline phase
 * (sanitize + redact even with no hooks registered) and the
 * `sendMessageToTarget` proactive-send chokepoint. Uses a real in-memory
 * AgentRuntime with a typed send-handler dispatch shim; no database or model —
 * `agentVoiced: true` short-circuits the humanness voice gate before any
 * model call.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Content, SendHandlerFunction, TargetInfo } from "../types";
import { outgoingPipelineHookContext } from "../types/pipeline-hooks";
import { stringToUuid } from "../utils";

function newRuntime(name: string): AgentRuntime {
	return new AgentRuntime({ character: { name } });
}

describe("outbound sanitization at the runtime seams (#15888)", () => {
	it("sanitizes machine syntax at the outgoing_before_deliver phase with no hooks registered", async () => {
		const runtime = newRuntime("outbound-seams-phase");
		const content: Content = {
			text: "Saved your note.<thinking>should I add more",
		};

		await runtime.applyPipelineHooks(
			"outgoing_before_deliver",
			outgoingPipelineHookContext(content, {
				source: "simple",
				roomId: stringToUuid("outbound-seams-phase-room"),
			}),
		);

		expect(content.text).toBe("Saved your note.");
	});

	it("preserves fenced examples at the phase boundary", async () => {
		const runtime = newRuntime("outbound-seams-fence");
		const fenced =
			"The format is:\n```xml\n<tool_call>get_weather</tool_call>\n```";
		const content: Content = { text: `${fenced}\n<|im_end|>` };

		await runtime.applyPipelineHooks(
			"outgoing_before_deliver",
			outgoingPipelineHookContext(content, {
				source: "simple",
				roomId: stringToUuid("outbound-seams-fence-room"),
			}),
		);

		expect(content.text).toBe(fenced);
	});

	it("coerces absent text to an empty string at the phase boundary (existing contract)", async () => {
		const runtime = newRuntime("outbound-seams-coerce");
		const content: Content = {};

		await runtime.applyPipelineHooks(
			"outgoing_before_deliver",
			outgoingPipelineHookContext(content, {
				source: "simple",
				roomId: stringToUuid("outbound-seams-coerce-room"),
			}),
		);

		expect(content.text).toBe("");
	});

	it("sanitizes agent-initiated sends at the sendMessageToTarget dispatch shim", async () => {
		const runtime = newRuntime("outbound-seams-send");
		const dispatched: Content[] = [];
		const sendHandler: SendHandlerFunction = async (
			_runtime,
			_target,
			content,
		) => {
			dispatched.push(content);
			return undefined;
		};
		runtime.registerSendHandler("sanitize-probe", sendHandler);

		const target: TargetInfo = {
			source: "sanitize-probe",
			channelId: "sanitize-probe-channel",
			roomId: stringToUuid("outbound-seams-send-room"),
		};
		// `agentVoiced: true` marks the text as already model-voiced so the
		// humanness voice gate passes it through — the sanitizer must still fire
		// after the gate.
		await runtime.sendMessageToTarget(target, {
			text: "Reminder sent.<tool_call>schedule_next</tool_call><|im_end|>",
			agentVoiced: true,
		});

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].text).toBe("Reminder sent.");
		expect(dispatched[0].agentVoiced).toBe(true);
	});

	it("dispatches text-free proactive sends untouched instead of fabricating a text field", async () => {
		const runtime = newRuntime("outbound-seams-textless");
		const dispatched: Content[] = [];
		const sendHandler: SendHandlerFunction = async (
			_runtime,
			_target,
			content,
		) => {
			dispatched.push(content);
			return undefined;
		};
		runtime.registerSendHandler("sanitize-probe", sendHandler);

		const attachmentOnly: Content = {
			attachments: [],
			agentVoiced: true,
		};
		await runtime.sendMessageToTarget(
			{
				source: "sanitize-probe",
				channelId: "sanitize-probe-channel",
				roomId: stringToUuid("outbound-seams-textless-room"),
			},
			attachmentOnly,
		);

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].text).toBeUndefined();
	});

	it("throws for an unregistered send target (existing contract)", async () => {
		const runtime = newRuntime("outbound-seams-unregistered");
		await expect(
			runtime.sendMessageToTarget(
				{ source: "nowhere", channelId: "c" },
				{ text: "hello", agentVoiced: true },
			),
		).rejects.toThrow("No send handler registered");
	});
});
