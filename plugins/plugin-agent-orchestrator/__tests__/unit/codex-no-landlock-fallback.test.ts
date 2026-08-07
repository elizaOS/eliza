/**
 * Pins the fail-closed no-Landlock Codex sandbox policy without loading AcpService:
 * empty/invalid overrides must not silently widen to host access; explicit
 * operator overrides still resolve.
 */

import { describe, expect, it } from "vitest";
import {
  CODEX_NO_LANDLOCK_SANDBOX_MODE_ENV,
  noLandlockFallbackRequiredMessage,
  resolveNoLandlockSandboxMode,
} from "../../src/services/codex-sandbox.js";

describe("resolveNoLandlockSandboxMode fail-closed policy", () => {
  it("returns undefined when the override is unset (caller must throw)", () => {
    expect(resolveNoLandlockSandboxMode(undefined)).toBeUndefined();
    expect(resolveNoLandlockSandboxMode("")).toBeUndefined();
    expect(resolveNoLandlockSandboxMode("   ")).toBeUndefined();
  });

  it("returns only explicit documented operator overrides", () => {
    expect(resolveNoLandlockSandboxMode("read-only")).toBe("read-only");
    expect(resolveNoLandlockSandboxMode("workspace-write")).toBe(
      "workspace-write",
    );
    expect(resolveNoLandlockSandboxMode("danger-full-access")).toBe(
      "danger-full-access",
    );
  });

  it("rejects legacy disabled aliases instead of widening to host access", () => {
    for (const value of ["off", "false", "0", "none", "disabled"]) {
      expect(resolveNoLandlockSandboxMode(value)).toBeUndefined();
    }
  });

  it("returns undefined for aliases and garbage rather than inventing a default", () => {
    expect(resolveNoLandlockSandboxMode("readonly")).toBeUndefined();
    expect(resolveNoLandlockSandboxMode("workspace")).toBeUndefined();
    expect(resolveNoLandlockSandboxMode("totally-not-a-mode")).toBeUndefined();
    expect(resolveNoLandlockSandboxMode("host-access")).toBeUndefined();
  });

  it("documents the env var operators must set", () => {
    expect(CODEX_NO_LANDLOCK_SANDBOX_MODE_ENV).toBe(
      "ELIZA_CODEX_ACP_NO_LANDLOCK_SANDBOX_MODE",
    );
    expect(noLandlockFallbackRequiredMessage()).toContain(
      CODEX_NO_LANDLOCK_SANDBOX_MODE_ENV,
    );
    expect(noLandlockFallbackRequiredMessage()).toMatch(
      /read-only|workspace-write|danger-full-access/,
    );
  });
});
