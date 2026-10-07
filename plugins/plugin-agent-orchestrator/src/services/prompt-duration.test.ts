import { describe, expect, it } from "vitest";
import { recordedPromptDurationMs } from "./prompt-duration";

describe("recordedPromptDurationMs", () => {
  it("keeps a prompt that finished in 0ms", () => {
    expect(recordedPromptDurationMs(0, 5_000)).toBe(0);
  });

  it("uses elapsed time when the runner did not record a duration", () => {
    expect(recordedPromptDurationMs(undefined, 5_000)).toBe(5_000);
    expect(recordedPromptDurationMs(Number.NaN, 5_000)).toBe(5_000);
  });
});
