/**
 * Covers `services/agentEvent` directly: heartbeat indicator resolution,
 * per-run sequence numbering, session-key enrichment, run-context
 * registration/merge/clear rules, listener isolation with J7 diagnostics,
 * heartbeat fan-out, and the convenience emitter helpers. Deterministic unit
 * harness — the service under test is real; the runtime collaborator is a
 * minimal recorder that captures `reportError` calls.
 */
import { describe, expect, it } from "vitest";
import type {
	AgentEventPayload,
	HeartbeatStatus,
} from "../types/agentEvent.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import { ServiceType } from "../types/service.ts";
import { AgentEventService, resolveHeartbeatIndicator } from "./agentEvent.ts";

type Reported = Array<{
	scope: string;
	error: unknown;
	context?: Record<string, unknown>;
}>;

function createRecorder(): { runtime: IAgentRuntime; reported: Reported } {
	const reported: Reported = [];
	const runtime = {
		reportError: (
			scope: string,
			error: unknown,
			context?: Record<string, unknown>,
		) => {
			reported.push({ scope, error, context });
		},
	};
	return { runtime: runtime as unknown as IAgentRuntime, reported };
}

function createService(): {
	service: AgentEventService;
	reported: Reported;
} {
	const { runtime, reported } = createRecorder();
	return { service: new AgentEventService(runtime), reported };
}

describe("resolveHeartbeatIndicator", () => {
	it('maps "ok-empty" and "ok-token" to "ok"', () => {
		expect(resolveHeartbeatIndicator("ok-empty")).toBe("ok");
		expect(resolveHeartbeatIndicator("ok-token")).toBe("ok");
	});

	it('maps "sent" to "alert"', () => {
		expect(resolveHeartbeatIndicator("sent")).toBe("alert");
	});

	it('maps "failed" to "error"', () => {
		expect(resolveHeartbeatIndicator("failed")).toBe("error");
	});

	it('maps "skipped" to undefined', () => {
		expect(resolveHeartbeatIndicator("skipped")).toBeUndefined();
	});

	it("maps unrecognized statuses to undefined", () => {
		expect(
			resolveHeartbeatIndicator("mystery-status" as HeartbeatStatus),
		).toBeUndefined();
	});
});

describe("AgentEventService", () => {
	it("declares the AGENT_EVENT service type", () => {
		expect(AgentEventService.serviceType).toBe(ServiceType.AGENT_EVENT);
	});

	it("start() constructs a working instance", async () => {
		const { runtime } = createRecorder();
		const service = (await AgentEventService.start(
			runtime,
		)) as AgentEventService;
		expect(service).toBeInstanceOf(AgentEventService);
		expect(service.getLastHeartbeat()).toBeNull();
		expect(service.getCurrentSeq("run-a")).toBe(0);
	});

	it("assigns monotonic per-run sequence numbers starting at 1", () => {
		const { service } = createService();
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.emit({
			runId: "run-a",
			stream: "lifecycle",
			data: { type: "run_start" },
		});
		service.emit({
			runId: "run-a",
			stream: "lifecycle",
			data: { type: "run_end" },
		});
		expect(seen.map((event) => event.seq)).toEqual([1, 2]);
		expect(seen[0]?.ts).toEqual(expect.any(Number));
		expect(service.getCurrentSeq("run-a")).toBe(2);
	});

	it("keeps independent sequence counters for different runs", () => {
		const { service } = createService();
		const seqs: Array<{ runId: string; seq: number }> = [];
		service.subscribe((event) =>
			seqs.push({ runId: event.runId, seq: event.seq }),
		);
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		service.emit({ runId: "run-b", stream: "tool", data: {} });
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		expect(seqs).toEqual([
			{ runId: "run-a", seq: 1 },
			{ runId: "run-b", seq: 1 },
			{ runId: "run-a", seq: 2 },
		]);
		expect(service.getCurrentSeq("run-b")).toBe(1);
	});

	it("prefers a non-blank event session key over the run context", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { sessionKey: "ctx-key" });
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.emit({
			runId: "run-a",
			stream: "assistant",
			data: {},
			sessionKey: "direct-key",
		});
		expect(seen[0]?.sessionKey).toBe("direct-key");
	});

	it("falls back to the registered run context session key", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { sessionKey: "ctx-key" });
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.emit({ runId: "run-a", stream: "assistant", data: {} });
		expect(seen[0]?.sessionKey).toBe("ctx-key");
	});

	it("treats blank or whitespace-only event session keys as unset", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { sessionKey: "ctx-key" });
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.emit({
			runId: "run-a",
			stream: "assistant",
			data: {},
			sessionKey: "   ",
		});
		service.emit({
			runId: "run-a",
			stream: "assistant",
			data: {},
			sessionKey: "",
		});
		expect(seen[0]?.sessionKey).toBe("ctx-key");
		expect(seen[1]?.sessionKey).toBe("ctx-key");
	});

	it("leaves sessionKey undefined when no event key or context exists", () => {
		const { service } = createService();
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		expect(seen[0]?.sessionKey).toBeUndefined();
	});

	it("ignores run-context registrations for an empty run id", () => {
		const { service } = createService();
		service.registerRunContext("", { sessionKey: "ctx-key" });
		expect(service.getRunContext("")).toBeUndefined();
	});

	it("stores a defensive copy of the registered context", () => {
		const { service } = createService();
		const context = { sessionKey: "original", verboseLevel: "quiet" as const };
		service.registerRunContext("run-a", context);
		context.sessionKey = "mutated";
		expect(service.getRunContext("run-a")?.sessionKey).toBe("original");
	});

	it("returns undefined for an unregistered run id", () => {
		const { service } = createService();
		expect(service.getRunContext("nope")).toBeUndefined();
	});

	it("merges changed fields into an existing run context", () => {
		const { service } = createService();
		service.registerRunContext("run-a", {
			sessionKey: "old",
			verboseLevel: "quiet",
			isHeartbeat: false,
			agentId: "agent-1",
			roomId: "room-1",
		});
		service.registerRunContext("run-a", {
			sessionKey: "new",
			verboseLevel: "verbose",
			isHeartbeat: true,
			agentId: "agent-2",
			roomId: "room-2",
		});
		expect(service.getRunContext("run-a")).toEqual({
			sessionKey: "new",
			verboseLevel: "verbose",
			isHeartbeat: true,
			agentId: "agent-2",
			roomId: "room-2",
		});
	});

	it("preserves existing fields omitted from a merge", () => {
		const { service } = createService();
		service.registerRunContext("run-a", {
			sessionKey: "keep-me",
			verboseLevel: "debug",
		});
		service.registerRunContext("run-a", {});
		expect(service.getRunContext("run-a")).toEqual({
			sessionKey: "keep-me",
			verboseLevel: "debug",
		});
	});

	it("does not overwrite isHeartbeat when a merge omits it", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { isHeartbeat: true });
		service.registerRunContext("run-a", { sessionKey: "later" });
		expect(service.getRunContext("run-a")?.isHeartbeat).toBe(true);
	});

	it("overwrites isHeartbeat when a merge provides an explicit false", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { isHeartbeat: true });
		service.registerRunContext("run-a", { isHeartbeat: false });
		expect(service.getRunContext("run-a")?.isHeartbeat).toBe(false);
	});

	it("ignores blank session keys during merges", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { sessionKey: "keep-me" });
		service.registerRunContext("run-a", { sessionKey: "" });
		expect(service.getRunContext("run-a")?.sessionKey).toBe("keep-me");
	});

	it("clearRunContext drops both the context and the sequence counter", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { sessionKey: "ctx-key" });
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		expect(service.getCurrentSeq("run-a")).toBe(2);
		service.clearRunContext("run-a");
		expect(service.getRunContext("run-a")).toBeUndefined();
		expect(service.getCurrentSeq("run-a")).toBe(0);
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		expect(seen[0]?.seq).toBe(1);
	});

	it("clearAllRunContexts resets every run's context and counter", () => {
		const { service } = createService();
		service.registerRunContext("run-a", { sessionKey: "a" });
		service.registerRunContext("run-b", { sessionKey: "b" });
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		service.emit({ runId: "run-b", stream: "tool", data: {} });
		service.clearAllRunContexts();
		expect(service.getRunContext("run-a")).toBeUndefined();
		expect(service.getRunContext("run-b")).toBeUndefined();
		expect(service.getCurrentSeq("run-a")).toBe(0);
		expect(service.getCurrentSeq("run-b")).toBe(0);
	});

	it("unsubscribe stops delivery and repeated calls are safe", () => {
		const { service } = createService();
		const seen: AgentEventPayload[] = [];
		const unsubscribe = service.subscribe((event) => seen.push(event));
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		unsubscribe();
		unsubscribe();
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		expect(seen).toHaveLength(1);
	});

	it("a throwing listener does not starve its siblings", () => {
		const { service } = createService();
		const healthy: AgentEventPayload[] = [];
		service.subscribe(() => {
			throw new Error("observer exploded");
		});
		service.subscribe((event) => healthy.push(event));
		expect(() =>
			service.emit({ runId: "run-a", stream: "lifecycle", data: {} }),
		).not.toThrow();
		expect(healthy.map((event) => event.stream)).toEqual([
			"lifecycle",
			"error",
		]);
	});

	it("reports listener failures through runtime.reportError", () => {
		const { service, reported } = createService();
		const failure = new Error("observer exploded");
		service.subscribe(() => {
			throw failure;
		});
		service.emit({
			runId: "run-a",
			stream: "action",
			data: { actionName: "REPLY" },
		});
		const actionReports = reported.filter(
			(call) => call.context?.stream === "action",
		);
		expect(actionReports).toEqual([
			{
				scope: "AgentEventService.listener",
				error: failure,
				context: { stream: "action", runId: "run-a" },
			},
		]);
	});

	it("emits a recoverable LISTENER_ERROR warning after listener failures", () => {
		const { service } = createService();
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.subscribe(() => {
			throw new Error("observer exploded");
		});
		service.emit({
			runId: "run-a",
			stream: "lifecycle",
			data: {},
			sessionKey: "direct-key",
		});
		expect(seen.map((event) => event.stream)).toEqual(["lifecycle", "error"]);
		expect(seen[1]?.data).toMatchObject({
			type: "warning",
			message: "1 event listener(s) threw exceptions",
			code: "LISTENER_ERROR",
			recoverable: true,
		});
		expect(seen[1]?.sessionKey).toBe("direct-key");
	});

	it("advances the run sequence for the synthesized error event", () => {
		const { service } = createService();
		service.subscribe(() => {
			throw new Error("observer exploded");
		});
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		expect(service.getCurrentSeq("run-a")).toBe(2);
	});

	it("counts every failing listener in one warning", () => {
		const { service } = createService();
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.subscribe(() => {
			throw new Error("first observer failed");
		});
		service.subscribe(() => {
			throw new Error("second observer failed");
		});
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		const warnings = seen.filter((event) => event.stream === "error");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.data.message).toBe(
			"2 event listener(s) threw exceptions",
		);
	});

	it("never synthesizes an error event from a failing error-stream listener", () => {
		const { service, reported } = createService();
		const errorEvents: AgentEventPayload[] = [];
		service.subscribe((event) => {
			if (event.stream === "error") errorEvents.push(event);
		});
		service.subscribe(() => {
			throw new Error("error-stream observer failed");
		});
		service.emit({ runId: "run-a", stream: "error", data: {} });
		expect(errorEvents).toHaveLength(1);
		expect(reported).toHaveLength(1);
	});

	it("getLastHeartbeat is null before any heartbeat fires", () => {
		const { service } = createService();
		expect(service.getLastHeartbeat()).toBeNull();
	});

	it("stores the enriched heartbeat and derives indicatorType from status", () => {
		const { service } = createService();
		const seen: Array<Record<string, unknown>> = [];
		service.subscribeHeartbeat((event) => seen.push(event));
		service.emitHeartbeat({ status: "failed", reason: "timeout" });
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			status: "failed",
			reason: "timeout",
			indicatorType: "error",
		});
		expect(seen[0]?.ts).toEqual(expect.any(Number));
		expect(service.getLastHeartbeat()).toMatchObject({
			status: "failed",
			indicatorType: "error",
		});
	});

	it("honors an explicitly provided indicatorType over the resolved one", () => {
		const { service } = createService();
		service.emitHeartbeat({ status: "ok-token", indicatorType: "alert" });
		expect(service.getLastHeartbeat()?.indicatorType).toBe("alert");
	});

	it("leaves indicatorType undefined for statuses that resolve to none", () => {
		const { service } = createService();
		service.emitHeartbeat({ status: "skipped" });
		expect(service.getLastHeartbeat()?.indicatorType).toBeUndefined();
		expect(service.getLastHeartbeat()?.status).toBe("skipped");
	});

	it("isolates a throwing heartbeat listener without agent events", () => {
		const { service, reported } = createService();
		const agentEvents: AgentEventPayload[] = [];
		service.subscribe((event) => agentEvents.push(event));
		const heartbeats: Array<Record<string, unknown>> = [];
		service.subscribeHeartbeat(() => {
			throw new Error("heartbeat observer failed");
		});
		service.subscribeHeartbeat((event) => heartbeats.push(event));
		expect(() =>
			service.emitHeartbeat({ status: "sent", preview: "ping" }),
		).not.toThrow();
		expect(heartbeats).toHaveLength(1);
		expect(reported).toHaveLength(1);
		expect(reported[0]?.scope).toBe("AgentEventService.heartbeatListener");
		expect(agentEvents).toHaveLength(0);
	});

	it("stop() clears listeners, sequences, contexts, and the last heartbeat", async () => {
		const { service } = createService();
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		service.registerRunContext("run-a", { sessionKey: "ctx-key" });
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		service.emitHeartbeat({ status: "ok-empty" });
		await service.stop();
		expect(service.getCurrentSeq("run-a")).toBe(0);
		expect(service.getRunContext("run-a")).toBeUndefined();
		expect(service.getLastHeartbeat()).toBeNull();
		service.emit({ runId: "run-a", stream: "tool", data: {} });
		expect(seen).toHaveLength(1);
	});
});

describe("AgentEventService convenience emitters", () => {
	function collect(service: AgentEventService): AgentEventPayload[] {
		const seen: AgentEventPayload[] = [];
		service.subscribe((event) => seen.push(event));
		return seen;
	}

	it("emitLifecycle routes data to the lifecycle stream", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitLifecycle("run-a", { type: "step_start", stepName: "plan" });
		expect(seen[0]).toMatchObject({
			runId: "run-a",
			stream: "lifecycle",
			data: { type: "step_start", stepName: "plan" },
		});
	});

	it("emitTool routes tool events with their name and payload", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitTool("run-a", {
			type: "tool_call",
			toolName: "web_search",
			input: { query: "elizaOS" },
		});
		expect(seen[0]).toMatchObject({
			runId: "run-a",
			stream: "tool",
			data: { type: "tool_call", toolName: "web_search" },
		});
	});

	it("emitAssistant routes assistant content", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitAssistant("run-a", {
			type: "message",
			content: "hello",
			role: "assistant",
		});
		expect(seen[0]).toMatchObject({
			runId: "run-a",
			stream: "assistant",
			data: { type: "message", content: "hello", role: "assistant" },
		});
	});

	it("emitError routes to the error stream", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitError("run-a", {
			type: "error",
			message: "boom",
			recoverable: false,
		});
		expect(seen[0]).toMatchObject({
			runId: "run-a",
			stream: "error",
			data: { type: "error", message: "boom", recoverable: false },
		});
	});

	it("emitMessageReceived stamps the received type on the message stream", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitMessageReceived("run-a", {
			content: "inbound",
			channel: "discord",
		});
		expect(seen[0]).toMatchObject({
			runId: "run-a",
			stream: "message",
			data: { type: "received", content: "inbound", channel: "discord" },
		});
	});

	it("emitMessageSent defaults deliveredAt and lets the caller override it", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitMessageSent("run-a", { content: "outbound" });
		service.emitMessageSent("run-a", {
			content: "scheduled",
			deliveredAt: 1234567890,
		});
		expect(seen[0]?.data.type).toBe("sent");
		expect(typeof seen[0]?.data.deliveredAt).toBe("number");
		expect(seen[1]?.data.deliveredAt).toBe(1234567890);
	});

	it("emitActionError stamps success false; complete passes success through", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitActionStart("run-a", { actionName: "TRANSFER" });
		service.emitActionComplete("run-a", {
			actionName: "TRANSFER",
			success: true,
			duration: 12,
		});
		service.emitActionError("run-a", {
			actionName: "TRANSFER",
			error: "insufficient funds",
		});
		expect(seen.map((event) => event.data.type)).toEqual([
			"start",
			"complete",
			"error",
		]);
		expect(seen[1]?.data).toMatchObject({
			actionName: "TRANSFER",
			success: true,
			duration: 12,
		});
		expect(seen[2]?.data).toMatchObject({
			actionName: "TRANSFER",
			success: false,
			error: "insufficient funds",
		});
	});

	it("emitEvaluator start/complete carry the evaluator name", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitEvaluatorStart("run-a", { evaluatorName: "fact_checker" });
		service.emitEvaluatorComplete("run-a", {
			evaluatorName: "fact_checker",
			validated: true,
		});
		expect(seen.map((event) => event.stream)).toEqual([
			"evaluator",
			"evaluator",
		]);
		expect(seen[1]?.data).toMatchObject({
			evaluatorName: "fact_checker",
			validated: true,
		});
	});

	it("emitProvider start/complete carry cache metadata", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitProviderStart("run-a", { providerName: "knowledge" });
		service.emitProviderComplete("run-a", {
			providerName: "knowledge",
			fromCache: true,
			tokens: 42,
		});
		expect(seen.map((event) => event.data.type)).toEqual(["start", "complete"]);
		expect(seen[1]?.data).toMatchObject({
			providerName: "knowledge",
			fromCache: true,
			tokens: 42,
		});
	});

	it("emitMemory helpers stamp success true on their stream types", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitMemoryCreate("run-a", { memoryId: "mem-1", preview: "note" });
		service.emitMemorySearch("run-a", { count: 3, tableName: "memories" });
		service.emitMemoryRetrieved("run-a", { memoryId: "mem-1", count: 1 });
		expect(
			seen.map((event) => [event.stream, event.data.type, event.data.success]),
		).toEqual([
			["memory", "create", true],
			["memory", "search", true],
			["memory", "retrieved", true],
		]);
	});

	it("convenience emitters forward an explicit session key", () => {
		const { service } = createService();
		const seen = collect(service);
		service.emitLifecycle("run-a", { type: "run_start" }, "sess-9");
		expect(seen[0]?.sessionKey).toBe("sess-9");
	});
});
