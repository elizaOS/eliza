/**
 * Error-policy tests for the LifeOps automation-node contributor's native
 * Calendar permission resolver (#12273). Asserts the fast-fail behavior: a live
 * permission-check failure falls back to the cached read (a legitimate degraded
 * value), while a *total* failure (both check and cached read broken) surfaces
 * via `runtime.reportError` rather than silently collapsing into the same `null`
 * a missing permission system returns. Deterministic: the permissions registry
 * is a hand-built fake, no live OS permission bridge.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { PermissionState } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";

// The module under test pulls a value import from app-core's registration seam;
// stub it so this unit test does not require app-core to be built.
vi.mock("@elizaos/shared/automation-node-contributors", () => ({
  registerAutomationNodeContributor: vi.fn(),
}));

import { resolveNativeCalendarPermission } from "./automation-node-contributor.js";

function cachedState(): PermissionState {
  return {
    id: "calendar",
    status: "granted",
    lastChecked: Date.now(),
    canRequest: false,
    platform: "darwin",
  };
}

function makeRuntime(registry: unknown): {
  runtime: IAgentRuntime;
  reportError: ReturnType<typeof vi.fn>;
} {
  const reportError = vi.fn();
  const runtime = {
    getService: (serviceType: string) =>
      serviceType === "eliza_permissions_registry" ? registry : null,
    reportError,
  } as unknown as IAgentRuntime;
  return { runtime, reportError };
}

describe("resolveNativeCalendarPermission error policy", () => {
  it("returns the cached value when the live check fails but the cache is readable", async () => {
    const cached = cachedState();
    const registry = {
      check: vi.fn().mockRejectedValue(new Error("live probe unavailable")),
      get: vi.fn().mockReturnValue(cached),
    };
    const { runtime, reportError } = makeRuntime(registry);

    const result = await resolveNativeCalendarPermission(runtime);

    expect(result).toBe(cached);
    expect(registry.get).toHaveBeenCalledWith("calendar");
    // Falling back to a legitimate cached value is not a reportable failure.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports the error and returns null when both the live check and the cached read fail", async () => {
    const checkError = new Error("live probe unavailable");
    const getError = new Error("cache backend down");
    const registry = {
      check: vi.fn().mockRejectedValue(checkError),
      get: vi.fn().mockImplementation(() => {
        throw getError;
      }),
    };
    const { runtime, reportError } = makeRuntime(registry);

    const result = await resolveNativeCalendarPermission(runtime);

    // Unknown, not fabricated-authorized/denied.
    expect(result).toBeNull();
    // The total failure is surfaced (drives ERROR_REPORTED + the recent-errors
    // provider), not swallowed.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "PersonalAssistant.calendarPermission",
      getError,
      { via: "check+get" },
    );
  });

  it("returns null without reporting when no permissions registry is present", async () => {
    const { runtime, reportError } = makeRuntime(undefined);

    const result = await resolveNativeCalendarPermission(runtime);

    // Absence of the permission system is a legitimate null, not a failure.
    expect(result).toBeNull();
    expect(reportError).not.toHaveBeenCalled();
  });
});
