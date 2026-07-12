/** Exercises credential isolation for child processes used by live app-core tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveRuntimeChildEnv } from "./live-child-env.ts";

describe("createLiveRuntimeChildEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blanks an ambient Cloud key when isolating a different live provider", () => {
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_LIVE", "");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "ambient-cloud-key");

    const childEnv = createLiveRuntimeChildEnv({
      OPENAI_API_KEY: "selected-provider-key",
      ELIZA_STATE_DIR: undefined,
    });

    expect(childEnv.OPENAI_API_KEY).toBe("selected-provider-key");
    expect(childEnv.ELIZAOS_CLOUD_API_KEY).toBe("");
  });

  it("preserves the ambient Cloud key only in Cloud-live mode", () => {
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_LIVE", "1");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "cloud-live-key");

    const childEnv = createLiveRuntimeChildEnv({
      OPENAI_API_KEY: "selected-provider-key",
      ELIZA_STATE_DIR: undefined,
    });

    expect(childEnv.OPENAI_API_KEY).toBe("selected-provider-key");
    expect(childEnv.ELIZAOS_CLOUD_API_KEY).toBe("cloud-live-key");
  });

  it.each([
    ["missing", undefined],
    ["whitespace-only", " \t\n"],
  ])("does not preserve a %s Cloud key in Cloud-live mode", (_, cloudKey) => {
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_LIVE", "1");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", cloudKey);

    const childEnv = createLiveRuntimeChildEnv({
      OPENAI_API_KEY: "selected-provider-key",
      ELIZA_STATE_DIR: undefined,
    });

    expect(childEnv.ELIZAOS_CLOUD_API_KEY).toBe("");
  });
});
