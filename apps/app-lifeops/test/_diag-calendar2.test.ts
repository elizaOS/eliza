import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";
import { extractCalendarPlanWithLlm } from "../src/actions/calendar.js";
import type { AgentRuntime, State, UUID } from "@elizaos/core";
import { createMessageMemory } from "@elizaos/core";
import crypto from "node:crypto";

const provider = selectLiveProvider();
const describeWithLLM = provider ? describe : describe.skip;

describeWithLLM("diagnose regressions", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;

  beforeAll(async () => {
    testResult = await createLifeOpsTestRuntime({ withLLM: true });
    runtime = testResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await testResult.cleanup();
  });

  it("checks plans for three failing queries", async () => {
    const intents = [
      "puedes buscar en mi calendario y decirme si tengo un vuelo a denver",
      "what event do i have on April 20",
      "can you search my calendar and tell me if i have any flights to denver?",
    ];
    const results: Array<{ intent: string; plan: unknown }> = [];
    for (const intent of intents) {
      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: crypto.randomUUID() as UUID,
        roomId: crypto.randomUUID() as UUID,
        agentId: runtime.agentId as UUID,
        content: { text: intent, source: "discord" },
      });
      const state = { values: {}, data: {}, text: "" } as State;
      const plan = await extractCalendarPlanWithLlm(runtime, message, state, intent);
      results.push({ intent, plan });
    }
    const fs = await import("node:fs");
    fs.writeFileSync("/tmp/diag-calendar2.json", JSON.stringify(results, null, 2));
    expect(results).toHaveLength(3);
  }, 300_000);
});
