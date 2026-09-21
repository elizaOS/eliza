/** Exercises benchmark context delivery through the real message loop and PGlite with a deterministic model boundary. */
import { randomUUID } from "node:crypto";
import { ModelType } from "@elizaos/core";
import { createAssistantPlugin } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing";
import { expect, it } from "vitest";
import { runBenchmarkTask } from "./benchmark.ts";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.values(value).flatMap(strings);
  return [];
}

it("delivers complete task context to the planner without leaking it to later tasks", async () => {
  const { runtime, cleanup } = await createTestRuntime({
    embeddingDimensions: 384,
    plugins: [createAssistantPlugin()],
  });
  const plannerInputs: string[][] = [];
  const marker = randomUUID();
  const context = {
    evidence: `${"Complete evidence\n".repeat(2000)}${marker}`,
  };
  try {
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => Array(384).fill(0.01),
      "benchmark-context-test",
      10000,
    );
    runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => ({
        text: "",
        toolCalls: [
          {
            id: randomUUID(),
            name: "HANDLE_RESPONSE",
            arguments: {
              shouldRespond: "RESPOND",
              thought: "",
              contexts: ["general"],
              intents: ["answer using supplied context"],
              candidateActionNames: ["REPLY"],
              replyText: "",
              replyEffectStatus: "non_applied",
              facts: [],
              relationships: [],
              addressedTo: [],
              threadOps: [],
            },
          },
        ],
      }),
      "benchmark-context-test",
      10000,
    );
    runtime.registerModel(
      ModelType.ACTION_PLANNER,
      async (_runtime, params) => {
        plannerInputs.push(strings(params));
        return {
          text: "",
          toolCalls: [
            {
              id: randomUUID(),
              name: "REPLY",
              arguments: {
                text: "Benchmark request processed.",
                eliza_turn_scope: "final",
              },
            },
          ],
        };
      },
      "benchmark-context-test",
      10000,
    );
    for (const supplied of [context, {}, undefined]) {
      const before = plannerInputs.length;
      const result = await runBenchmarkTask(
        runtime,
        {
          id: randomUUID(),
          type: "research",
          prompt: "Report the supplied evidence.",
          ...(supplied === undefined ? {} : { context: supplied }),
        },
        new AbortController().signal,
      );
      expect(result.success).toBe(true);
      const inputs = plannerInputs.slice(before);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.flat().some((text) => text.includes(marker))).toBe(
        supplied === context,
      );
      const expectedText =
        supplied === undefined
          ? "Report the supplied evidence."
          : `Report the supplied evidence.\n\nTask context (JSON):\n${JSON.stringify(supplied)}`;
      // The planner carries the original message as a JSON record.
      expect(
        inputs
          .flat()
          .some((text) => text.includes(JSON.stringify(expectedText))),
      ).toBe(true);
    }
  } finally {
    await cleanup();
  }
}, 120_000);
