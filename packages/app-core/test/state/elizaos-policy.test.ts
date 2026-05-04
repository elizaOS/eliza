/**
 * `createElizaOSPolicy()` is the policy used by the startup coordinator
 * when the APK is running on the ElizaOS variant. It exists because the
 * vanilla `createMobilePolicy()` 15s `backendTimeoutMs` dead-ends the
 * splash on a "Backend Timeout" card before the on-device agent finishes
 * its cold-boot sequence (~60–90s observed on cuttlefish: PGlite
 * migration + plugin load + agent registration).
 *
 * These tests pin the values that matter for the ElizaOS boot path:
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
  createElizaOSPolicy,
  createMobilePolicy,
} from "../../src/state/startup-coordinator";

describe("createElizaOSPolicy", () => {
  it("declares local runtime support so the on-device agent is the default", () => {
    const policy = createElizaOSPolicy();
    expect(policy.supportsLocalRuntime).toBe(true);
    expect(policy.defaultTarget).toBe("embedded-local");
  });

  it("uses a backend timeout long enough for cold-boot agent init", () => {
    const policy = createElizaOSPolicy();
    // Cuttlefish observation: 60–90s before /api/auth/status is reachable
    // after the agent service starts. 120s is the floor; we ship 180s.
    expect(policy.backendTimeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it("uses an agent-ready timeout long enough for first-chat warmup", () => {
    const policy = createElizaOSPolicy();
    expect(policy.agentReadyTimeoutMs).toBeGreaterThanOrEqual(180_000);
  });

  it("differs from createMobilePolicy on the load-bearing fields", () => {
    const mobile = createMobilePolicy();
    const elizaOS = createElizaOSPolicy();
    // The vanilla mobile policy was built for cloud-only iOS / Play Store
    // installs. Both invariants below would dead-end the ElizaOS splash
    // if applied as-is — that's why this branch exists.
    expect(mobile.supportsLocalRuntime).toBe(false);
    expect(elizaOS.supportsLocalRuntime).toBe(true);
    expect(elizaOS.backendTimeoutMs).toBeGreaterThan(mobile.backendTimeoutMs);
  });
});
