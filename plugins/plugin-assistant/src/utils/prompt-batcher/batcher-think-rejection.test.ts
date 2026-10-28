import type { IAgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { PromptBatcher } from "./batcher";

it("reports a rejected recurring registration after disposal", async () => {
  const reportError = vi.fn();
  const runtime = {
    initPromise: Promise.resolve(),
    reportError,
  } as unknown as IAgentRuntime;
  const batcher = new PromptBatcher(runtime, {} as never, {} as never);
  batcher.dispose();
  batcher.think("stopped", {
    contextBuilder: () => "context",
    preamble: "think",
    schema: [],
    onResult: () => {},
  });
  await Promise.resolve();
  expect(reportError).toHaveBeenCalledWith(
    "PromptBatcher.think",
    expect.any(Error),
    { sectionId: "stopped" },
  );
});
