import { describe, expect, it } from "vitest";
import {
  appendCodexAcpSandboxConfig,
  commandHasCodexSandboxConfig,
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

  it("appends sandbox config without duplicating existing command settings", () => {
    expect(
      appendCodexAcpSandboxConfig(
        "codex-acp --stdio",
        "danger-full-access",
        "never",
      ),
    ).toBe(
      "codex-acp --stdio -c sandbox_mode=danger-full-access -c approval_policy=never",
    );
    expect(
      appendCodexAcpSandboxConfig(
        "codex-acp -c sandbox_mode=read-only -c approval_policy=on-request",
        "danger-full-access",
        "never",
      ),
    ).toBe("codex-acp -c sandbox_mode=read-only -c approval_policy=on-request");
    expect(commandHasCodexSandboxConfig("codex-acp -s workspace-write")).toBe(
      true,
    );
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
