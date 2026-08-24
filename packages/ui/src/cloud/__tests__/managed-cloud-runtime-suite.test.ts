/**
 * Unit tests for managed cloud runtime target detection.
 * Validates target string comparison and app-mode host fallback resolution.
 */
import { describe, expect, it } from "vitest";
import type { RuntimeTarget } from "../../state/startup-coordinator.ts";
import { isManagedCloudRuntime } from "../managed-cloud-runtime.ts";

describe("managed-cloud-runtime", () => {
  it("returns true when target is cloud-managed", () => {
    expect(isManagedCloudRuntime("cloud-managed")).toBe(true);
  });

  it("returns false for non-cloud runtime targets in non-browser env", () => {
    expect(
      isManagedCloudRuntime("embedded-direct" as unknown as RuntimeTarget),
    ).toBe(false);
    expect(isManagedCloudRuntime("remote" as unknown as RuntimeTarget)).toBe(
      false,
    );
  });

  it("returns false for null or undefined target in non-browser env", () => {
    expect(isManagedCloudRuntime(null)).toBe(false);
    expect(isManagedCloudRuntime(undefined)).toBe(false);
  });
});
