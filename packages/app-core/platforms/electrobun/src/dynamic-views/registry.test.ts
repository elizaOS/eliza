import { describe, expect, it } from "vitest";
import { DynamicViewError } from "./errors";
import { DynamicViewRegistry } from "./registry";
import type { DynamicViewManifest } from "./types";

function manifest(id = "agent.run.trace"): DynamicViewManifest {
  return {
    id,
    title: "Agent Run Trace",
    source: "agent",
    entrypoint: "./trace.html",
    placement: "floating",
    requiredSatellites: ["eliza.runtime"],
    eventSubscriptions: [{ satelliteId: "eliza.runtime" }],
    invokeTargets: ["eliza.runtime"],
  };
}

describe("DynamicViewRegistry", () => {
  it("registers, lists, gets, and unregisters manifests", () => {
    const registry = new DynamicViewRegistry();
    const registered = registry.register(manifest());

    expect(registered.id).toBe("agent.run.trace");
    expect(registry.get("agent.run.trace")?.title).toBe("Agent Run Trace");
    expect(registry.list()).toHaveLength(1);
    expect(registry.unregister("agent.run.trace")).toBe(true);
    expect(registry.get("agent.run.trace")).toBeNull();
  });

  it("rejects duplicate manifests unless update is explicit", () => {
    const registry = new DynamicViewRegistry();
    registry.register(manifest());

    expect(() => registry.register(manifest())).toThrow(DynamicViewError);
    const updated = registry.register(
      { ...manifest(), title: "Updated Trace" },
      { update: true },
    );

    expect(updated.title).toBe("Updated Trace");
    expect(registry.list()).toHaveLength(1);
  });

  it("rejects invalid manifests", () => {
    const registry = new DynamicViewRegistry();

    expect(() =>
      registry.register({
        ...manifest(),
        id: "",
      }),
    ).toThrow(DynamicViewError);
  });
});
