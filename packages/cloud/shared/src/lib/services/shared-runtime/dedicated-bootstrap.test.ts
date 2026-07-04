// Exercises dedicated bootstrap behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";

import { isDedicatedBootstrapWindow } from "./dedicated-bootstrap";

/**
 * isDedicatedBootstrapWindow gates whether the in-Worker shared runtime serves a
 * dedicated agent's chat while its container provisions (the first-run handoff).
 * It MUST stay tightly scoped to the genuine first-boot window so it never
 * hijacks a working flow (a running agent, an established-but-asleep agent).
 */
describe("isDedicatedBootstrapWindow", () => {
  const agent = (overrides: {
    execution_tier?: string;
    status?: string;
    bridge_url?: string | null;
  }) => ({
    execution_tier: "dedicated-always",
    status: "provisioning",
    bridge_url: null as string | null,
    ...overrides,
  });

  test("true for a freshly-created dedicated agent still provisioning", () => {
    expect(isDedicatedBootstrapWindow(agent({ status: "provisioning" }))).toBe(true);
    expect(isDedicatedBootstrapWindow(agent({ status: "pending" }))).toBe(true);
  });

  test("true for any dedicated tier in the boot window", () => {
    expect(isDedicatedBootstrapWindow(agent({ execution_tier: "dedicated-lazy" }))).toBe(true);
    expect(isDedicatedBootstrapWindow(agent({ execution_tier: "custom" }))).toBe(true);
  });

  test("false for a shared-tier agent (its own path serves it)", () => {
    expect(isDedicatedBootstrapWindow(agent({ execution_tier: "shared" }))).toBe(false);
  });

  test("false once the container is reachable (bridge_url set) — use the subdomain", () => {
    expect(
      isDedicatedBootstrapWindow(
        agent({ status: "provisioning", bridge_url: "https://x.internal" }),
      ),
    ).toBe(false);
  });

  test("false for a running agent — handoff already switched to the subdomain", () => {
    expect(isDedicatedBootstrapWindow(agent({ status: "running" }))).toBe(false);
  });

  test("false for an established agent that went down (proxy wakes it)", () => {
    for (const status of ["stopped", "sleeping", "disconnected"]) {
      expect(isDedicatedBootstrapWindow(agent({ status }))).toBe(false);
    }
  });

  test("false for an errored or deleting agent — surface the failure", () => {
    for (const status of ["error", "deletion_pending", "deletion_failed"]) {
      expect(isDedicatedBootstrapWindow(agent({ status }))).toBe(false);
    }
  });
});
