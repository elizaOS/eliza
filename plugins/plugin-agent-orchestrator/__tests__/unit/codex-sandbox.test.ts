/**
 * Verifies codex ACP sandbox helpers.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import {
  detectLandlockAvailability,
  isCodexLandlockPanic,
  normalizeCodexSandboxMode,
} from "../../src/services/codex-sandbox.js";

describe("codex ACP sandbox helpers", () => {
  it("normalizes supported sandbox modes and off aliases", () => {
    expect(normalizeCodexSandboxMode("read-only")).toBe("read-only");
    expect(normalizeCodexSandboxMode("readonly")).toBe("read-only");
    expect(normalizeCodexSandboxMode("workspace")).toBe("workspace-write");
    expect(normalizeCodexSandboxMode("off")).toBe("danger-full-access");
    expect(normalizeCodexSandboxMode("bogus")).toBeUndefined();
  });

  it("detects Landlock from Linux LSM state without treating unknown as unavailable", () => {
    expect(
      detectLandlockAvailability({
        platform: "linux",
        existsSync: (path) => path === "/sys/kernel/security/lsm",
        readFileSync: () => "lockdown,capability,landlock,yama",
      }),
    ).toBe("available");
    expect(
      detectLandlockAvailability({
        platform: "linux",
        existsSync: (path) => path === "/sys/kernel/security/lsm",
        readFileSync: () => "lockdown,capability,yama",
      }),
    ).toBe("unavailable");
    expect(
      detectLandlockAvailability({
        platform: "linux",
        existsSync: () => false,
      }),
    ).toBe("unknown");
    expect(
      detectLandlockAvailability({
        platform: "darwin",
      }),
    ).toBe("not-linux");
  });

  it("honors explicit Landlock availability overrides", () => {
    expect(
      detectLandlockAvailability({
        platform: "darwin",
        env: { ELIZA_CODEX_ACP_LANDLOCK: "0" },
      }),
    ).toBe("unavailable");
    expect(
      detectLandlockAvailability({
        platform: "linux",
        existsSync: () => false,
        env: { ELIZA_CODEX_LANDLOCK: "true" },
      }),
    ).toBe("available");
  });

  it("recognizes Codex Landlock panic text", () => {
    expect(
      isCodexLandlockPanic(
        "ACP agent exited with code 101: thread 'main' panicked: permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock",
      ),
    ).toBe(true);
    expect(isCodexLandlockPanic("Authentication required")).toBe(false);
  });
});
