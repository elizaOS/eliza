import { describe, expect, test } from "bun:test";
import {
  getCloudCapabilities,
  getCloudCapabilitiesByCategory,
  getCloudProtocolCoverage,
} from "@/lib/cloud-capabilities";

describe("Cloud capability registry", () => {
  test("requires every Cloud capability to expose REST, MCP, A2A, and skill metadata", () => {
    const missing = getCloudCapabilities().flatMap((capability) => {
      return Object.entries(capability.surfaces)
        .filter(([, surface]) => !surface)
        .map(([surface]) => `${capability.id}:${surface}`);
    });

    expect(missing).toEqual([]);
  });

  test("keeps MCP and A2A names in the cloud namespace", () => {
    for (const capability of getCloudCapabilities()) {
      expect(capability.surfaces.mcp.tool.startsWith("cloud.")).toBe(true);
      expect(capability.surfaces.a2a.skill.startsWith("cloud.")).toBe(true);
    }
  });

  test("tracks admin-only capabilities separately from user operations", () => {
    const adminCapabilities = getCloudCapabilitiesByCategory("admin");

    expect(adminCapabilities.length).toBeGreaterThanOrEqual(3);
    expect(adminCapabilities.every((capability) => capability.auth.adminOnly === true)).toBe(true);
    expect(
      getCloudProtocolCoverage().filter((capability) => capability.adminOnly).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("covers wallet top-up, billing, cancellation, MCP, and A2A workstreams", () => {
    const ids = new Set(getCloudCapabilities().map((capability) => capability.id));

    expect(ids.has("credits.wallet_topup")).toBe(true);
    expect(ids.has("billing.active_resources")).toBe(true);
    expect(ids.has("billing.ledger")).toBe(true);
    expect(ids.has("billing.cancel_resource")).toBe(true);
    expect(ids.has("mcp.platform")).toBe(true);
    expect(ids.has("a2a.platform")).toBe(true);
  });

  test("does not advertise contract-only protocol surfaces", () => {
    for (const capability of getCloudCapabilities()) {
      expect(capability.surfaces.rest.status).toBe("implemented");
      expect(capability.surfaces.mcp.status).toBe("implemented");
      expect(capability.surfaces.a2a.status).toBe("implemented");
      expect(capability.surfaces.skill.status).toBe("implemented");
    }
  });
});
