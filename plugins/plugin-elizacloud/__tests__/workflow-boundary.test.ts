/** Verifies Eliza Cloud exposes native capabilities without foreign workflow credential adapters. */
import { describe, expect, it } from "vitest";
import { elizaOSCloudPlugin } from "../src/index";

describe("Eliza Cloud workflow boundary", () => {
  it("does not claim a legacy workflow credential-provider service slot", () => {
    expect(elizaOSCloudPlugin.services?.map((service) => service.serviceType)).not.toContain(
      "workflow_credential_provider"
    );
  });
});
