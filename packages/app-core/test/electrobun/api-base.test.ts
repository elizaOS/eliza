/** Exercises api base behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  resolveDesktopRuntimeMode,
  resolveDesktopRuntimeModeSignal,
} from "../../platforms/electrobun/src/api-base";

describe("resolveDesktopRuntimeModeSignal", () => {
  it("returns null by default (no cloud-only opt-in)", () => {
    expect(resolveDesktopRuntimeModeSignal({})).toBeNull();
    expect(
      resolveDesktopRuntimeModeSignal({
        ELIZA_DESKTOP_RUNTIME_MODE: "external",
      }),
    ).toBeNull();
  });

  it("returns 'cloud' when ELIZA_DESKTOP_RUNTIME_MODE is cloud/elizacloud", () => {
    expect(
      resolveDesktopRuntimeModeSignal({ ELIZA_DESKTOP_RUNTIME_MODE: "cloud" }),
    ).toBe("cloud");
    expect(
      resolveDesktopRuntimeModeSignal({
        ELIZA_DESKTOP_RUNTIME_MODE: "  ElizaCloud ",
      }),
    ).toBe("cloud");
  });

  it("returns 'cloud' for the ELIZA_DESKTOP_CLOUD_ONLY boolean flag", () => {
    for (const v of ["1", "true", "yes", "on"]) {
      expect(
        resolveDesktopRuntimeModeSignal({ ELIZA_DESKTOP_CLOUD_ONLY: v }),
      ).toBe("cloud");
    }
    expect(
      resolveDesktopRuntimeModeSignal({ ELIZA_DESKTOP_CLOUD_ONLY: "0" }),
    ).toBeNull();
  });

  it("does not change where-the-agent-runs (resolveDesktopRuntimeMode) — orthogonal", () => {
    // The cloud-only opt-in must NOT flip the agent topology; the loopback agent
    // still runs (as the cloud-login proxy) under cloud-only mode.
    const cloudEnv = { ELIZA_DESKTOP_CLOUD_ONLY: "1" };
    expect(resolveDesktopRuntimeMode(cloudEnv).mode).toBe("local");
    expect(
      resolveDesktopRuntimeMode({
        ...cloudEnv,
        ELIZA_DESKTOP_API_BASE: "http://127.0.0.1:31337",
      }).mode,
    ).toBe("external");
  });
});
