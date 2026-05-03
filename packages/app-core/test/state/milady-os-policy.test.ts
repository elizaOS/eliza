/**
 * `createMiladyOSPolicy()` is the policy used by the startup coordinator
 * when the APK is running on the MiladyOS variant. It exists because the
 * vanilla `createMobilePolicy()` 15s `backendTimeoutMs` dead-ends the
 * splash on a "Backend Timeout" card before the on-device agent finishes
 * its cold-boot sequence (~60–90s observed on cuttlefish: PGlite
 * migration + plugin load + agent registration).
 *
 * These tests pin the values that matter for the MiladyOS boot path:
 *   - `supportsLocalRuntime: true`  — the device IS the agent
 *   - `defaultTarget: "embedded-local"` — no cloud fallback
 *   - `backendTimeoutMs >= 120_000` — long enough for cold boot
 *   - `agentReadyTimeoutMs >= 180_000` — long enough for first chat
 *
 * If any of these regress, the splash starts dead-ending again on
 * cuttlefish and a manual "Retry Startup" tap becomes mandatory.
 */

import { describe, expect, it } from "vitest";
import {
  createMiladyOSPolicy,
  createMobilePolicy,
} from "../../src/state/startup-coordinator";

describe("createMiladyOSPolicy", () => {
  it("declares local runtime support so the on-device agent is the default", () => {
    const policy = createMiladyOSPolicy();
    expect(policy.supportsLocalRuntime).toBe(true);
    expect(policy.defaultTarget).toBe("embedded-local");
  });

  it("uses a backend timeout long enough for cold-boot agent init", () => {
    const policy = createMiladyOSPolicy();
    // Cuttlefish observation: 60–90s before /api/auth/status is reachable
    // after the agent service starts. 120s is the floor; we ship 180s.
    expect(policy.backendTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("uses an agent-ready timeout long enough for first-chat warmup", () => {
    const policy = createMiladyOSPolicy();
    expect(policy.agentReadyTimeoutMs).toBeGreaterThanOrEqual(180_000);
  });

  it("differs from createMobilePolicy on the load-bearing fields", () => {
    const mobile = createMobilePolicy();
    const miladyOS = createMiladyOSPolicy();
    // The vanilla mobile policy was built for cloud-only iOS / Play Store
    // installs. Both invariants below would dead-end the MiladyOS splash
    // if applied as-is — that's why this branch exists.
    expect(mobile.supportsLocalRuntime).toBe(false);
    expect(miladyOS.supportsLocalRuntime).toBe(true);
    expect(miladyOS.backendTimeoutMs).toBeGreaterThan(mobile.backendTimeoutMs);
  });
});
