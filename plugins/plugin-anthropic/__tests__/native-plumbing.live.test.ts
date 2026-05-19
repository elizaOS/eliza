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

describeLive(
  "Anthropic native plumbing (live)",
  { requiredEnv: ["ANTHROPIC_API_KEY"], provider: "anthropic" },
  ({ harness }) => {
    it("returns real text and populated usage from a native messages call", async () => {
      const { runtime } = harness();
      const result = (await handleTextSmall(runtime, {
        messages: [
          { role: "system", content: "Reply with one short sentence." },
          { role: "user", content: "Say hello." },
        ],
      } as never)) as TextResult;

      expect(typeof result.text).toBe("string");
      expect((result.text ?? "").length).toBeGreaterThan(0);
      expect(result.usage?.promptTokens ?? 0).toBeGreaterThan(0);
    }, 120_000);
  }
);
