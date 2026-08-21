/**
 * Live browser-lane evidence for canonical Cerebras small, large, and planner
 * routing through the OpenAI-compatible provider plugin.
 */
import { ModelType } from "@elizaos/core";
import { expect, it } from "vitest";

import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";

type TextResult = {
  text?: string;
  usage?: { promptTokens?: number; completionTokens?: number };
};

function requireModel(name: "CEREBRAS_SMALL_MODEL" | "CEREBRAS_LARGE_MODEL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this evidence lane`);
  return value;
}

function assertLiveText(result: unknown): void {
  const value = result as TextResult;
  expect(typeof value.text).toBe("string");
  expect(value.text?.trim().length ?? 0).toBeGreaterThan(0);
  expect(value.usage?.promptTokens ?? 0).toBeGreaterThan(0);
  expect(value.usage?.completionTokens ?? 0).toBeGreaterThan(0);
}

await describeLive(
  "browser lane canonical Cerebras routing",
  { provider: "cerebras", requiredEnv: ["CEREBRAS_API_KEY"] },
  ({ harness }) => {
    it("routes TEXT_SMALL, TEXT_LARGE, and ACTION_PLANNER to their canonical models", async () => {
      const { runtime } = harness();
      const small = requireModel("CEREBRAS_SMALL_MODEL");
      const large = requireModel("CEREBRAS_LARGE_MODEL");

      runtime.setSetting("OPENAI_SMALL_MODEL", small);
      runtime.setSetting("OPENAI_LARGE_MODEL", large);
      runtime.setSetting("OPENAI_ACTION_PLANNER_MODEL", large);

      expect(runtime.getSetting("OPENAI_BASE_URL")).toContain("cerebras.ai");
      expect(runtime.getSetting("OPENAI_SMALL_MODEL")).toBe(small);
      expect(runtime.getSetting("OPENAI_LARGE_MODEL")).toBe(large);
      expect(runtime.getSetting("OPENAI_ACTION_PLANNER_MODEL")).toBe(large);

      const common = {
        messages: [{ role: "user" as const, content: "Reply with exactly READY" }],
        prompt: "Reply with exactly READY",
        maxTokens: 128,
      };
      assertLiveText(await runtime.useModel(ModelType.TEXT_SMALL, common));
      assertLiveText(await runtime.useModel(ModelType.TEXT_LARGE, common));
      assertLiveText(await runtime.useModel(ModelType.ACTION_PLANNER, common));
    }, 180_000);
  }
);
