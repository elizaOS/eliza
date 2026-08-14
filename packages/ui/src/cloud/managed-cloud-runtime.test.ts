/** Verifies the management shell stays available independently of agent runtime startup. */

import { describe, expect, it } from "vitest";
import { managedCloudPageOwnsStartupFailure } from "./managed-cloud-runtime";

describe("managedCloudPageOwnsStartupFailure", () => {
  it("lets managed Cloud account pages own startup failures", () => {
    expect(managedCloudPageOwnsStartupFailure("/cloud", "cloud-managed")).toBe(
      true,
    );
    expect(
      managedCloudPageOwnsStartupFailure(
        "/cloud/agents/personal?tab=billing#balance",
        "cloud-managed",
      ),
    ).toBe(true);
  });

  it("does not bypass startup for lookalike or self-hosted routes", () => {
    expect(managedCloudPageOwnsStartupFailure("/cloudy", "cloud-managed")).toBe(
      false,
    );
    expect(
      managedCloudPageOwnsStartupFailure("/settings", "cloud-managed"),
    ).toBe(false);
    expect(managedCloudPageOwnsStartupFailure("/cloud", "remote-backend")).toBe(
      false,
    );
  });
});
