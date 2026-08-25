import { describe, expect, it } from "vitest";
import {
  createAnchorRegistry,
  registerFallbackAnchors,
} from "./consolidation-policy.ts";

function anchor(key: string) {
  return {
    anchorKey: key,
    resolve: async () => ({ atIso: "2026-08-25T08:00:00.000Z" }),
  } as never;
}

describe("createAnchorRegistry", () => {
  it("registers and retrieves anchors", () => {
    const reg = createAnchorRegistry();
    reg.register(anchor("wake.confirmed"));
    expect(reg.get("wake.confirmed")).not.toBeNull();
    expect(reg.list()).toHaveLength(1);
  });

  it("rejects duplicate anchors without override", () => {
    const reg = createAnchorRegistry();
    reg.register(anchor("wake.confirmed"));
    expect(() => reg.register(anchor("wake.confirmed"))).toThrow(
      /duplicate anchorKey/,
    );
  });

  it("allows override", () => {
    const reg = createAnchorRegistry();
    reg.register(anchor("wake.confirmed"));
    expect(() =>
      reg.register(anchor("wake.confirmed"), { override: true }),
    ).not.toThrow();
  });

  it("rejects missing anchor keys", () => {
    const reg = createAnchorRegistry();
    expect(() => reg.register(anchor("") as never)).toThrow(/anchorKey/);
  });

  it("resolves anchors", async () => {
    const reg = createAnchorRegistry();
    reg.register(anchor("wake.confirmed"));
    const result = await reg.resolve("wake.confirmed", {} as never);
    expect(result?.atIso).toBe("2026-08-25T08:00:00.000Z");
    expect(await reg.resolve("missing", {} as never)).toBeNull();
  });
});

describe("registerFallbackAnchors", () => {
  it("registers the fallback wake anchor", () => {
    const reg = createAnchorRegistry();
    registerFallbackAnchors(reg);
    expect(reg.get("wake.confirmed")).not.toBeNull();
  });
});
