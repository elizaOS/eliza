import { describe, expect, it } from "vitest";
import { shouldEnable } from "../auto-enable";

type Ctx = Parameters<typeof shouldEnable>[0];

function ctxWith(
  env: Record<string, string | undefined>,
  features?: Record<string, unknown>,
): Ctx {
  return { env, config: { features } } as Ctx;
}

describe("plugin-coding-tools auto-enable gate", () => {
  it("enables when codingTools feature is on and the platform is desktop", () => {
    expect(shouldEnable(ctxWith({}, { codingTools: true }))).toBe(true);
  });

  it("keeps tools enabled when Android SDK env vars are present but the platform is not declared mobile", () => {
    // Regression: ANDROID_ROOT / ANDROID_DATA are exported by the Android SDK
    // on ordinary desktop dev shells; the previous heuristic treated them as a
    // mobile-platform declaration and silently disabled explicitly enabled
    // coding tools for those users.
    expect(
      shouldEnable(
        ctxWith({ ANDROID_ROOT: "/opt/android-sdk" }, { codingTools: true }),
      ),
    ).toBe(true);
    expect(
      shouldEnable(ctxWith({ ANDROID_DATA: "/data" }, { codingTools: true })),
    ).toBe(true);
  });

  it("disables on store builds", () => {
    expect(
      shouldEnable(
        ctxWith({ ELIZA_BUILD_VARIANT: "store" }, { codingTools: true }),
      ),
    ).toBe(false);
  });

  it("disables on Android unless local-yolo mode is set", () => {
    expect(
      shouldEnable(
        ctxWith({ ELIZA_PLATFORM: "android" }, { codingTools: true }),
      ),
    ).toBe(false);
    expect(
      shouldEnable(
        ctxWith(
          { ELIZA_PLATFORM: "android", ELIZA_RUNTIME_MODE: "local-yolo" },
          { codingTools: true },
        ),
      ),
    ).toBe(true);
  });

  it("disables on iOS even in local-yolo mode", () => {
    expect(
      shouldEnable(
        ctxWith(
          { ELIZA_PLATFORM: "ios", ELIZA_RUNTIME_MODE: "local-yolo" },
          { codingTools: true },
        ),
      ),
    ).toBe(false);
  });

  it("stays disabled without an explicit feature flag", () => {
    expect(shouldEnable(ctxWith({}))).toBe(false);
  });

  it("honors the legacy coding-agent and shell feature keys", () => {
    expect(shouldEnable(ctxWith({}, { "coding-agent": true }))).toBe(true);
    expect(shouldEnable(ctxWith({}, { shell: true }))).toBe(true);
  });

  it("stays disabled on mobile when only the feature flag is set", () => {
    expect(
      shouldEnable(ctxWith({ ELIZA_PLATFORM: "android" }, { shell: true })),
    ).toBe(false);
  });
});
