/** Verifies describeProvisioningWait through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit coverage for the provisioning/cold-boot wait narration
 * (`describeProvisioningWait` / `describeAgentWakeWait`): the staged copy that
 * replaced the raw `Status: pending...` / `(status) — Ns elapsed...` internals
 * (the "static spinner during a 30s+ provision" QA class, 2026-07-22). Pure
 * functions, no harness.
 */

import { describe, expect, it } from "vitest";

import {
  describeAgentWakeWait,
  describeProvisioningWait,
} from "./client-cloud";

describe("describeProvisioningWait", () => {
  it("never leaks a raw backend job status token", () => {
    for (const status of [
      "pending",
      "in_progress",
      "processing",
      "retrying",
      undefined,
    ]) {
      for (const elapsed of [0, 25_000, 70_000]) {
        const copy = describeProvisioningWait(status, elapsed);
        expect(copy).not.toMatch(/status:/i);
        expect(copy).not.toContain("in_progress");
        expect(copy).not.toContain("pending");
      }
    }
  });

  it("stages queued vs active work early in the wait", () => {
    expect(describeProvisioningWait(undefined, 2_000)).toBe(
      "Getting your agent's environment ready…",
    );
    expect(describeProvisioningWait("queued", 2_000)).toBe(
      "Getting your agent's environment ready…",
    );
    expect(describeProvisioningWait("in_progress", 2_000)).toBe(
      "Starting your agent…",
    );
    expect(describeProvisioningWait("retrying", 2_000)).toBe(
      "Starting your agent…",
    );
  });

  it("advances to reassurance copy past the typical-wait threshold", () => {
    expect(describeProvisioningWait("in_progress", 25_000)).toContain(
      "usually takes under a minute",
    );
    expect(describeProvisioningWait("queued", 25_000)).toContain(
      "Waiting for a sandbox slot",
    );
  });

  it("names elapsed time on a long (degraded) wait, bucketed to 30s steps", () => {
    // Bucketing: consumers seed one chat turn per unique status text, so the
    // long-wait copy must NOT change every 2s poll tick.
    expect(describeProvisioningWait("in_progress", 61_000)).toBe(
      describeProvisioningWait("in_progress", 89_000),
    );
    expect(describeProvisioningWait("in_progress", 61_000)).toContain(
      "about 60s in",
    );
    expect(describeProvisioningWait("in_progress", 95_000)).toContain(
      "about 90s in",
    );
  });
});

describe("describeAgentWakeWait", () => {
  it("uses stable expectation-setting copy for the first minute", () => {
    expect(describeAgentWakeWait(5_000)).toBe(describeAgentWakeWait(55_000));
    expect(describeAgentWakeWait(5_000)).toContain("cold boot");
  });

  it("advances by minute buckets on a long wait (no per-tick counter)", () => {
    expect(describeAgentWakeWait(65_000)).toBe(describeAgentWakeWait(115_000));
    expect(describeAgentWakeWait(65_000)).toContain("about 1 minute in");
    expect(describeAgentWakeWait(125_000)).toContain("about 2 minutes in");
  });

  it("never leaks a raw backend status token", () => {
    for (const elapsed of [0, 30_000, 61_000, 200_000]) {
      expect(describeAgentWakeWait(elapsed)).not.toMatch(
        /\((?:pending|unknown|stopped)\)/,
      );
    }
  });
});
