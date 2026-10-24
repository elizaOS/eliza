/**
 * AgentEventService numbers events per run id. Many emitters use a run id
 * that never ends (each inbound message, each notification), so the sequence
 * map must stay bounded while a run that keeps emitting keeps counting.
 */
import { describe, expect, it } from "vitest";
import { AgentEventService } from "../src/services/agent-event.ts";
import type { IAgentRuntime } from "../src/types/runtime.ts";

describe("AgentEventService run sequence", () => {
	it("forgets one-off run ids but keeps counting for a run that is still emitting", async () => {
		const runtime = {
			reportError: () => undefined,
		} as unknown as IAgentRuntime;
		const service = (await AgentEventService.start(
			runtime,
		)) as AgentEventService;

		for (let index = 0; index < 100_000; index++) {
			service.emitLifecycle(`message-${index}`, { type: "run_start" });
			if (index % 1000 === 0) {
				service.emitLifecycle("long-run", { type: "step_start" });
			}
		}

		// The run that kept emitting has every event counted (100 of them).
		expect(service.getCurrentSeq("long-run")).toBe(100);
		// One-off run ids from long ago are no longer held.
		expect(service.getCurrentSeq("message-0")).toBe(0);
		// The most recent one-off run id still has its sequence.
		expect(service.getCurrentSeq("message-99999")).toBe(1);
		await service.stop();
	});
});
