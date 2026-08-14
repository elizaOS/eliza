/** Exercises credential isolation for child processes used by live app-core tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveRuntimeChildEnv,
  shouldSkipLiveStackAutoFirstRun,
} from "./live-child-env.ts";

describe("createLiveRuntimeChildEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blanks an ambient Cloud key when isolating a different live provider", () => {
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_LIVE", "");
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE", "");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "ambient-cloud-key");

    const childEnv = createLiveRuntimeChildEnv({
      OPENAI_API_KEY: "selected-provider-key",
      ELIZA_STATE_DIR: undefined,
    });

    expect(childEnv.OPENAI_API_KEY).toBe("selected-provider-key");
    expect(childEnv.ELIZAOS_CLOUD_API_KEY).toBe("");
    expect(childEnv.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
  });

  it("preserves the ambient Cloud key for Cloud onboarding without changing routing", () => {
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_LIVE", "1");
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE", "");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "cloud-live-key");

    const childEnv = createLiveRuntimeChildEnv({
      OPENAI_API_KEY: "selected-provider-key",
      ELIZA_STATE_DIR: undefined,
    });

    expect(childEnv.OPENAI_API_KEY).toBe("selected-provider-key");
    expect(childEnv.ELIZAOS_CLOUD_API_KEY).toBe("cloud-live-key");
    expect(childEnv.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
    expect(childEnv.ELIZAOS_CLOUD_USE_STT).toBeUndefined();
    expect(childEnv.ELIZAOS_CLOUD_USE_TTS).toBeUndefined();
  });

  it("preserves Cloud media while keeping the selected provider as text brain", () => {
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_LIVE", "");
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE", "1");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "cloud-media-key");

    const childEnv = createLiveRuntimeChildEnv({
      CEREBRAS_API_KEY: "selected-provider-key",
      ELIZA_STATE_DIR: undefined,
    });

    expect(childEnv.CEREBRAS_API_KEY).toBe("selected-provider-key");
    expect(childEnv.ELIZAOS_CLOUD_API_KEY).toBe("cloud-media-key");
    expect(childEnv.ELIZAOS_CLOUD_USE_INFERENCE).toBe("false");
    expect(childEnv.ELIZAOS_CLOUD_USE_STT).toBe("true");
    expect(childEnv.ELIZAOS_CLOUD_USE_TTS).toBe("true");
    expect(shouldSkipLiveStackAutoFirstRun()).toBe(false);
  });

  it("leaves first-run incomplete only for the Cloud onboarding lane", () => {
    expect(
      shouldSkipLiveStackAutoFirstRun({
        ELIZA_UI_SMOKE_CLOUD_LIVE: "1",
        ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE: "",
      }),
    ).toBe(true);
    expect(
      shouldSkipLiveStackAutoFirstRun({
        ELIZA_UI_SMOKE_CLOUD_LIVE: "",
        ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE: "1",
      }),
    ).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["whitespace-only", " \t\n"],
  ])("does not preserve a %s Cloud key in media-live mode", (_, cloudKey) => {
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_LIVE", "");
    vi.stubEnv("ELIZA_UI_SMOKE_CLOUD_MEDIA_LIVE", "1");
    if (cloudKey === undefined) {
      // Record the ambient value for `vi.unstubAllEnvs()`, then remove it.
      // `vi.stubEnv(key, undefined)` leaves an existing CI secret untouched.
      vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "");
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    } else {
      vi.stubEnv("ELIZAOS_CLOUD_API_KEY", cloudKey);
    }

    const childEnv = createLiveRuntimeChildEnv({
      OPENAI_API_KEY: "selected-provider-key",
      ELIZA_STATE_DIR: undefined,
    });

    expect(childEnv.ELIZAOS_CLOUD_API_KEY).toBe("");
    expect(childEnv.ELIZAOS_CLOUD_USE_INFERENCE).toBeUndefined();
    expect(childEnv.ELIZAOS_CLOUD_USE_STT).toBeUndefined();
    expect(childEnv.ELIZAOS_CLOUD_USE_TTS).toBeUndefined();
  });
});
