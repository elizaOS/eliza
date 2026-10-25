// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  __resetFamilyRegistryForTests,
  APP_LIFEOPS_BUS_FAMILIES,
  createFamilyRegistry,
  getFamilyRegistry,
  registerAppLifeOpsBusFamilies,
  registerFamilyRegistry,
} from "../src/lifeops/registries/family-registry.js";

/**
 * The bus FamilyRegistry tracks which activity-signal families flow through
 * LifeOps. register guards duplicates/empties; list filters by namespace; and
 * per-runtime registration is WeakMap-scoped so it never leaks across runtimes.
 */

describe("createFamilyRegistry", () => {
  it("registers, looks up, and guards duplicates / empty family", () => {
    const reg = createFamilyRegistry();
    reg.register({ family: "x.test", description: "d", source: "app-lifeops" });
    expect(reg.has("x.test")).toBe(true);
    expect(reg.has("y.nope")).toBe(false);
    expect(reg.get("x.test")?.source).toBe("app-lifeops");
    expect(() =>
      reg.register({ family: "x.test", description: "d", source: "s" }),
    ).toThrow(/already registered/);
    expect(() =>
      reg.register({ family: "", description: "d", source: "s" } as never),
    ).toThrow(/required/);
  });
});

describe("registerAppLifeOpsBusFamilies", () => {
  it("registers the calendar + time families and filters by namespace", () => {
    const reg = createFamilyRegistry();
    registerAppLifeOpsBusFamilies(reg);
    expect(reg.has("calendar.meeting.ended")).toBe(true);
    expect(reg.has("time.morning.start")).toBe(true);
    expect(reg.list().length).toBe(APP_LIFEOPS_BUS_FAMILIES.length);
    expect(reg.list({ namespace: "time" }).length).toBe(3);
    expect(reg.list({ namespace: "calendar" }).length).toBe(1);
  });
});

describe("per-runtime registry", () => {
  it("stores, retrieves, and resets a runtime-scoped registry", () => {
    const runtime = {} as IAgentRuntime;
    expect(getFamilyRegistry(runtime)).toBeNull();
    const reg = createFamilyRegistry();
    registerFamilyRegistry(runtime, reg);
    expect(getFamilyRegistry(runtime)).toBe(reg);
    __resetFamilyRegistryForTests(runtime);
    expect(getFamilyRegistry(runtime)).toBeNull();
  });
});
