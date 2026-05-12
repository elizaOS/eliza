import { expect, it } from "vitest";

import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";
import { handleTextSmall } from "../models/text";

interface TextResult {
  text?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

function expectTextResult(value: unknown): asserts value is TextResult {
  expect(value).toEqual(expect.objectContaining({ text: expect.any(String) }));
}

describeLive(
  "OpenAI native plumbing (live)",
  { requiredEnv: ["OPENAI_API_KEY"] },
  ({ harness }) => {
    it("returns real text and populated usage from a native messages call", async () => {
      const { runtime } = harness();
      const result = await handleTextSmall(runtime, {
        messages: [
          { role: "system", content: "Reply with one short sentence." },
          { role: "user", content: "Say hello." },
        ],
      } as never);
      expectTextResult(result);

      expect(typeof result.text).toBe("string");
      expect((result.text ?? "").length).toBeGreaterThan(0);
      expect(result.usage?.promptTokens ?? 0).toBeGreaterThan(0);
      expect(result.usage?.completionTokens ?? 0).toBeGreaterThan(0);
      expect(result.usage?.totalTokens ?? 0).toBeGreaterThan(0);
    }, 120_000);
  }
);
