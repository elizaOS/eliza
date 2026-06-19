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
    requiredRemotes: ["eliza.runtime"],
    eventSubscriptions: [{ remoteId: "eliza.runtime" }],
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

  it("normalizes create and update manifests while preserving optional contracts", () => {
    const registry = new DynamicViewRegistry();

    const registered = registry.register({
      ...manifest("  agent.run.trace  "),
      title: "  Agent Run Trace  ",
      entrypoint: "  ./trace.html  ",
      description: "Remote/local trace window",
      permissions: ["filesystem.read"],
      requiredRemotes: ["eliza.runtime", "plugin.worker"],
      eventSubscriptions: [
        { remoteId: "eliza.runtime", events: ["trace.started"] },
      ],
      invokeTargets: ["eliza.runtime"],
      metadata: { stable: true, version: 1 },
    });

    expect(registered).toMatchObject({
      id: "agent.run.trace",
      title: "Agent Run Trace",
      entrypoint: "./trace.html",
      description: "Remote/local trace window",
      permissions: ["filesystem.read"],
      requiredRemotes: ["eliza.runtime", "plugin.worker"],
      eventSubscriptions: [
        { remoteId: "eliza.runtime", events: ["trace.started"] },
      ],
      invokeTargets: ["eliza.runtime"],
      metadata: { stable: true, version: 1 },
    });

    const updated = registry.register(
      { ...registered, title: "Edited Trace" },
      { update: true },
    );

    expect(updated.title).toBe("Edited Trace");
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("agent.run.trace")?.title).toBe("Edited Trace");
  });

  it.each([
    ["id", { id: " " }],
    ["title", { title: " " }],
    ["entrypoint", { entrypoint: " " }],
    ["source", { source: "external" }],
    ["placement", { placement: "sidebar" }],
    ["description", { description: " " }],
    ["permissions", { permissions: ["filesystem.read", ""] }],
    ["requiredRemotes", { requiredRemotes: ["eliza.runtime", " "] }],
    ["eventSubscriptions", { eventSubscriptions: "eliza.runtime" }],
    [
      "eventSubscriptions.remoteId",
      { eventSubscriptions: [{ remoteId: " " }] },
    ],
    [
      "eventSubscriptions.events",
      { eventSubscriptions: [{ remoteId: "r", events: ["ready", ""] }] },
    ],
    ["invokeTargets", { invokeTargets: ["eliza.runtime", ""] }],
  ])("rejects invalid manifest field: %s", (_field, patch) => {
    const registry = new DynamicViewRegistry();

    expect(() =>
      registry.register({
        ...manifest(),
        ...(patch as Partial<DynamicViewManifest>),
      }),
    ).toThrow(DynamicViewError);
  });

  it("rejects metadata that cannot be serialized to JSON", () => {
    const registry = new DynamicViewRegistry();
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;

    expect(() =>
      registry.register({
        ...manifest(),
        metadata: metadata as DynamicViewManifest["metadata"],
      }),
    ).toThrow(TypeError);
  });
});
