/**
 * Unit tests for the CloudAuth background API-key re-validation state machine
 * (`decideRevalidation`). This is the self-heal that fixes an agent going
 * 401-blind after its injected key is revoked: it retries transient
 * cloud-unreachability (so a boot-time outage doesn't leave the key unvalidated
 * forever), confirms a revoked key with a single loud actionable error
 * (debounced so a transient 5xx doesn't false-alarm), and steady-re-checks so a
 * post-boot revocation is caught and a later re-authorization self-heals.
 */
import { describe, expect, it } from "vitest";
import {
  decideRevalidation,
  type RevalidationConfig,
  type RevalidationState,
} from "../src/services/cloud-auth";

const CFG: RevalidationConfig = {
  retryMs: 1_000,
  steadyMs: 60_000,
  invalidThreshold: 2,
};
const UNKNOWN: RevalidationState = { keyState: "unknown", consecutiveInvalid: 0 };

describe("decideRevalidation", () => {
  it("valid probe → confirms the key, logs once, steady re-check", () => {
    const d = decideRevalidation(UNKNOWN, "valid", CFG);
    expect(d.state).toEqual({ keyState: "valid", consecutiveInvalid: 0 });
    expect(d.delayMs).toBe(CFG.steadyMs);
    expect(d.log).toEqual({ level: "info", message: expect.stringContaining("validated") });
  });

  it("valid again (already valid) → no duplicate log", () => {
    const d = decideRevalidation({ keyState: "valid", consecutiveInvalid: 0 }, "valid", CFG);
    expect(d.state.keyState).toBe("valid");
    expect(d.log).toBeNull();
    expect(d.delayMs).toBe(CFG.steadyMs);
  });

  it("unreachable at boot → keeps state unresolved + retries (the 37911a1e fix)", () => {
    const d = decideRevalidation(UNKNOWN, "unreachable", CFG);
    expect(d.state).toEqual(UNKNOWN); // still unknown — will keep probing
    expect(d.delayMs).toBe(CFG.retryMs);
    expect(d.log).toBeNull();
  });

  it("single invalid probe → NOT confirmed yet (debounce), re-probe soon, no error", () => {
    const d = decideRevalidation(UNKNOWN, "invalid", CFG);
    expect(d.state).toEqual({ keyState: "unknown", consecutiveInvalid: 1 });
    expect(d.delayMs).toBe(CFG.retryMs);
    expect(d.log).toBeNull();
  });

  it("second consecutive invalid → CONFIRMS revoked, logs a single error, steady re-check", () => {
    const d = decideRevalidation({ keyState: "unknown", consecutiveInvalid: 1 }, "invalid", CFG);
    expect(d.state).toEqual({ keyState: "invalid", consecutiveInvalid: 2 });
    expect(d.delayMs).toBe(CFG.steadyMs);
    expect(d.log?.level).toBe("error");
    expect(d.log?.message).toMatch(/REVOKED\/INVALID/);
  });

  it("invalid again (already invalid) → no duplicate error log", () => {
    const d = decideRevalidation({ keyState: "invalid", consecutiveInvalid: 2 }, "invalid", CFG);
    expect(d.state.keyState).toBe("invalid");
    expect(d.log).toBeNull();
  });

  it("a network blip between two rejections does NOT reset the confirmation count", () => {
    // invalid(1) → unreachable (blip) → invalid → should confirm on the 2nd real rejection
    let s = decideRevalidation(UNKNOWN, "invalid", CFG).state; // count=1
    s = decideRevalidation(s, "unreachable", CFG).state; // count preserved
    expect(s.consecutiveInvalid).toBe(1);
    const d = decideRevalidation(s, "invalid", CFG); // count=2 → confirmed
    expect(d.state.keyState).toBe("invalid");
    expect(d.log?.level).toBe("error");
  });

  it("self-heals: confirmed-invalid → valid re-authorization clears the state + logs recovery", () => {
    const d = decideRevalidation({ keyState: "invalid", consecutiveInvalid: 2 }, "valid", CFG);
    expect(d.state).toEqual({ keyState: "valid", consecutiveInvalid: 0 });
    expect(d.log).toEqual({ level: "info", message: expect.stringContaining("validated") });
    expect(d.delayMs).toBe(CFG.steadyMs);
  });

  it("uses the default config when none is passed", () => {
    const d = decideRevalidation(UNKNOWN, "valid");
    expect(d.state.keyState).toBe("valid");
    expect(d.delayMs).toBe(30 * 60_000);
  });
});
