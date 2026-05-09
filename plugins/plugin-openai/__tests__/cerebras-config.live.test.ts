import { ModelType } from "@elizaos/core";
import { expect, it } from "vitest";

import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";

interface UseModelResult {
  text?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

describeLive(
  "plugin-openai Cerebras live",
  { requiredEnv: ["CEREBRAS_API_KEY"] },
  ({ harness }) => {
    it(
      "uses TEXT_LARGE against Cerebras and returns real text + usage",
      async () => {
        const { runtime } = harness();
        expect(runtime.getSetting("OPENAI_BASE_URL")).toContain("cerebras.ai");

        const result = (await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Reply with the single word: ready",
        })) as string | UseModelResult;

        const text = typeof result === "string" ? result : (result.text ?? "");
        expect(text.length).toBeGreaterThan(0);
        if (typeof result !== "string") {
          expect(result.usage?.promptTokens ?? 0).toBeGreaterThan(0);
          expect(result.usage?.completionTokens ?? 0).toBeGreaterThan(0);
        }
      },
      120_000,
    );
  },
);
