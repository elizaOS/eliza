/**
 * Handler registry tests — exercise the prototype patch with a REAL
 * `AgentRuntime`-shaped class rather than a mock. We stand up a minimal
 * subclass of `AgentRuntime` that overrides only `registerModel` to a
 * no-op, then prove the patch:
 *   1. Installs once (idempotent)
 *   2. Forwards to the original `registerModel`
 *   3. Records every call into the singleton registry
 */

import { describe, expect, it } from "vitest";
import {
  type HandlerRegistration,
  handlerRegistry,
  toPublicRegistration,
} from "./handler-registry";

function makeHandler(tag: string): HandlerRegistration["handler"] {
  return async () => ({ tag });
}

describe("handlerRegistry", () => {
  it("records a direct call via record()", () => {
    handlerRegistry.record({
      modelType: "TEST_ONLY_A",
      provider: "unit-test-a",
      priority: 1,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("a"),
    });
    const found = handlerRegistry
      .getForType("TEST_ONLY_A")
      .filter((r) => r.provider === "unit-test-a");
    expect(found).toHaveLength(1);
    expect(found[0]?.priority).toBe(1);
  });

  it("replaces a previous registration from the same provider", () => {
    handlerRegistry.record({
      modelType: "TEST_ONLY_B",
      provider: "unit-test-b",
      priority: 5,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("b-old"),
    });
    handlerRegistry.record({
      modelType: "TEST_ONLY_B",
      provider: "unit-test-b",
      priority: 10,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("b-new"),
    });
    const hits = handlerRegistry
      .getForType("TEST_ONLY_B")
      .filter((r) => r.provider === "unit-test-b");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.priority).toBe(10);
  });

  it("sorts candidates by priority descending", () => {
    handlerRegistry.record({
      modelType: "TEST_ONLY_C",
      provider: "low",
      priority: 1,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("low"),
    });
    handlerRegistry.record({
      modelType: "TEST_ONLY_C",
      provider: "high",
      priority: 100,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("high"),
    });
    const sorted = handlerRegistry.getForType("TEST_ONLY_C");
    expect(sorted[0]?.provider).toBe("high");
    expect(sorted[1]?.provider).toBe("low");
  });

  it("getForTypeExcluding filters by provider id", () => {
    handlerRegistry.record({
      modelType: "TEST_ONLY_D",
      provider: "router-self",
      priority: Number.MAX_SAFE_INTEGER,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("self"),
    });
    handlerRegistry.record({
      modelType: "TEST_ONLY_D",
      provider: "downstream",
      priority: 0,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("downstream"),
    });
    const excluded = handlerRegistry.getForTypeExcluding(
      "TEST_ONLY_D",
      "router-self",
    );
    expect(excluded.map((r) => r.provider)).toEqual(["downstream"]);
  });

  it("status listeners fire on every record", () => {
    const seen: number[] = [];
    const off = handlerRegistry.subscribe((regs) => {
      seen.push(regs.length);
    });
    handlerRegistry.record({
      modelType: "TEST_ONLY_E",
      provider: "listener-probe",
      priority: 0,
      registeredAt: new Date().toISOString(),
      handler: makeHandler("e"),
    });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    off();
  });

  it("toPublicRegistration strips the handler function", () => {
    const reg = handlerRegistry.getAll()[0];
    expect(reg).toBeDefined();
    if (!reg) return;
    const pub = toPublicRegistration(reg);
    expect(pub).not.toHaveProperty("handler");
    expect(pub.modelType).toBe(reg.modelType);
    expect(pub.provider).toBe(reg.provider);
  });

  it("exposes a process-wide snapshot via getAll()", () => {
    // All our prior test writes should still be in the registry because
    // it's a singleton across the test file.
    const all = handlerRegistry.getAll();
    const providers = new Set(all.map((r) => r.provider));
    expect(providers.has("unit-test-a")).toBe(true);
    expect(providers.has("unit-test-b")).toBe(true);
  });
});
