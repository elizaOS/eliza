import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetBlockerRegistryForTests,
  type BlockerContribution,
  createBlockerRegistry,
  getBlockerRegistry,
  registerBlockerRegistry,
} from "./blocker-registry";

type Runtime = { agentId: string };
const runtimeA = { agentId: "a" } as Runtime;
const runtimeB = { agentId: "b" } as Runtime;

function websiteContribution(
  label: string,
): BlockerContribution<unknown, unknown> {
  return {
    kind: "website",
    describe: { label },
    verifyAvailable: async () => ({
      available: true,
      reason: null,
      permission: "granted",
    }),
    start: async () => ({}),
    stop: async () => {},
    status: async () => ({ active: false, endsAt: null, text: "idle" }),
  };
}

describe("createBlockerRegistry", () => {
  it("starts empty with null lookups for every kind", () => {
    const registry = createBlockerRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.get("website")).toBeNull();
    expect(registry.get("app")).toBeNull();
  });

  it("returns a registered contribution by kind and lists it", () => {
    const registry = createBlockerRegistry();
    const website = websiteContribution("hosts-file");
    registry.register(website);
    expect(registry.get("website")).toBe(website);
    expect(registry.list()).toEqual([website]);
  });

  it("holds contributions of distinct kinds side by side", () => {
    const registry = createBlockerRegistry();
    const website = websiteContribution("hosts-file");
    const app = websiteContribution("family-controls");
    (app as { kind: string }).kind = "app";
    registry.register(website);
    registry.register(app);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("app")).toBe(app);
  });

  it("rejects duplicate kind registration instead of silently replacing", () => {
    const registry = createBlockerRegistry();
    registry.register(websiteContribution("first"));
    expect(() => registry.register(websiteContribution("second"))).toThrow(
      /kind "website" already registered/,
    );
    // The original enforcer must remain the dispatcher target.
    expect(registry.get("website")?.describe.label).toBe("first");
    expect(registry.list()).toHaveLength(1);
  });
});

describe("registerBlockerRegistry / getBlockerRegistry", () => {
  beforeEach(() => {
    __resetBlockerRegistryForTests(runtimeA);
    __resetBlockerRegistryForTests(runtimeB);
  });

  it("returns null for a runtime that never registered", () => {
    expect(getBlockerRegistry(runtimeA)).toBeNull();
  });

  it("returns the registry registered for the same runtime", () => {
    const registry = createBlockerRegistry();
    registerBlockerRegistry(runtimeA, registry);
    expect(getBlockerRegistry(runtimeA)).toBe(registry);
  });

  it("isolates registries per runtime (WeakMap keying, no cross-runtime leakage)", () => {
    const registryA = createBlockerRegistry();
    registerBlockerRegistry(runtimeA, registryA);
    expect(getBlockerRegistry(runtimeB)).toBeNull();
  });

  it("forgets a runtime after test reset", () => {
    const registry = createBlockerRegistry();
    registerBlockerRegistry(runtimeA, registry);
    __resetBlockerRegistryForTests(runtimeA);
    expect(getBlockerRegistry(runtimeA)).toBeNull();
  });
});
