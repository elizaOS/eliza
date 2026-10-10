/**
 * The pre-Stage-1 reply-recovery view on the real message pipeline
 * (AgentRuntime + SQLite; only the model surface is a deterministic registered
 * handler). It is captured when a delivery needs it.
 */

import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createRealRuntimeHarness } from "./__tests__/real-runtime-harness.ts";

const EARLIER = "the picnic moved to the north lawn";
const QUESTION = "where is the picnic now?";

describe("pre-Stage-1 reply recovery", () => {
  it("captures the complete pre-Stage-1 view when a failure reply must be regrounded", async () => {
    const h = await createRealRuntimeHarness(() => {
      throw new Error("upstream exploded");
    });
    await h.runtime.createMemory(
      { ...h.makeMessage(EARLIER), createdAt: Date.now() - 60_000 },
      "messages",
    );
    // The failure-reply model claims an unreceipted effect, so delivery must
    // reground it from the turn's recovery before Stage 1 published one.
    const prompts: string[] = [];
    h.runtime.registerModel(
      ModelType.TEXT_LARGE,
      async (_runtime, params) => {
        prompts.push(String(params.prompt));
        return "All right, I have scheduled the check-in.";
      },
      "deterministic-test",
    );
    // This fixture keeps claiming the effect, so regrounding cannot settle;
    // only what the recovery captured matters here.
    await expect(
      h.service.handleMessage(
        h.runtime,
        h.makeMessage(QUESTION),
        async () => [],
      ),
    ).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
    // After the failure reply's own prompt, the regrounding prompt carries
    // the captured view.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(EARLIER);
    expect(prompts[1]).toContain(QUESTION);
  });
});
