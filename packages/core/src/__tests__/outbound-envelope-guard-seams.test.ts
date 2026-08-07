/**
 * Exercises the fail-closed outbound envelope guard at the two AgentRuntime
 * delivery seams: the mandatory `outgoing_before_deliver` phase and the
 * `sendMessageToTarget` proactive-send chokepoint. A leaked security envelope
 * must never ship — the send carries the honest leak notice instead and the
 * block is observable via the reported-errors ring. Real in-memory
 * AgentRuntime; `agentVoiced: true` short-circuits the voice gate.
 */
import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../runtime";
import { wrapExternalContent } from "../security/external-content";
import { ENVELOPE_LEAK_NOTICE } from "../security/outbound-envelope-guard";
import type { Content, SendHandlerFunction, TargetInfo } from "../types";
import { outgoingPipelineHookContext } from "../types/pipeline-hooks";
import { stringToUuid } from "../utils";

function newRuntime(name: string): AgentRuntime {
	return new AgentRuntime({ character: { name } });
}

function leakedEnvelope(): string {
	return wrapExternalContent("deploy the blog app", {
		source: "api",
		includeWarning: true,
	});
}

function guardReports(runtime: AgentRuntime) {
	return runtime
		.getRecentReportedErrors()
		.filter((entry) => entry.scope === "outbound-envelope-guard");
}

describe("outbound envelope guard at the runtime seams", () => {
	it("blocks a leaked envelope at the outgoing_before_deliver phase", async () => {
		const runtime = newRuntime("envelope-guard-phase");
		const content: Content = { text: leakedEnvelope() };

		await runtime.applyPipelineHooks(
			"outgoing_before_deliver",
			outgoingPipelineHookContext(content, {
				source: "simple",
				roomId: stringToUuid("envelope-guard-phase-room"),
			}),
		);

		expect(content.text).toBe(ENVELOPE_LEAK_NOTICE);
		expect(guardReports(runtime)).toHaveLength(1);
	});

	it("passes clean text through the phase untouched", async () => {
		const runtime = newRuntime("envelope-guard-phase-clean");
		const content: Content = { text: "your app is live!" };

		await runtime.applyPipelineHooks(
			"outgoing_before_deliver",
			outgoingPipelineHookContext(content, {
				source: "simple",
				roomId: stringToUuid("envelope-guard-phase-clean-room"),
			}),
		);

		expect(content.text).toBe("your app is live!");
		expect(guardReports(runtime)).toHaveLength(0);
	});

	it("blocks a leaked envelope at the sendMessageToTarget dispatch shim", async () => {
		const runtime = newRuntime("envelope-guard-send");
		const dispatched: Content[] = [];
		const sendHandler: SendHandlerFunction = async (
			_runtime,
			_target,
			content,
		) => {
			dispatched.push(content);
			return undefined;
		};
		runtime.registerSendHandler("guard-probe", sendHandler);

		const target: TargetInfo = {
			source: "guard-probe",
			channelId: "guard-probe-channel",
			roomId: stringToUuid("envelope-guard-send-room"),
		};
		await runtime.sendMessageToTarget(target, {
			text: leakedEnvelope(),
			agentVoiced: true,
		});

		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].text).toBe(ENVELOPE_LEAK_NOTICE);
		expect(dispatched[0].agentVoiced).toBe(true);
		expect(guardReports(runtime)).toHaveLength(1);
	});

	it("blocks case/Unicode marker variants on proactive sends", async () => {
		const runtime = newRuntime("envelope-guard-send-variants");
		const dispatched: Content[] = [];
		const sendHandler: SendHandlerFunction = async (
			_runtime,
			_target,
			content,
		) => {
			dispatched.push(content);
			return undefined;
		};
		runtime.registerSendHandler("guard-probe", sendHandler);
		const target: TargetInfo = {
			source: "guard-probe",
			channelId: "guard-probe-channel",
			roomId: stringToUuid("envelope-guard-send-variants-room"),
		};

		await runtime.sendMessageToTarget(target, {
			text: 'quoting: "＜＜＜ＥＸＴＥＲＮＡＬ＿ＵＮＴＲＵＳＴＥＤ＿ＣＯＮＴＥＮＴ＞＞＞"',
			agentVoiced: true,
		});
		await runtime.sendMessageToTarget(target, {
			text: "partial echo <<<external_untrusted",
			agentVoiced: true,
		});

		expect(dispatched.map((c) => c.text)).toEqual([
			ENVELOPE_LEAK_NOTICE,
			ENVELOPE_LEAK_NOTICE,
		]);
		expect(guardReports(runtime)).toHaveLength(2);
	});
});
