/**
 * Unit tests for the per-runtime AnchorRegistry binding: registration,
 * retrieval, the built-in `APP_LIFEOPS_ANCHORS`, and the test-reset hook.
 * Deterministic, mock runtime.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { AnchorContext } from "../scheduled-task/types.js";
import {
  __resetAnchorRegistryForTests,
  APP_LIFEOPS_ANCHORS,
  createAnchorRegistry,
  getAnchorRegistry,
  registerAnchorRegistry,
  registerAppLifeOpsAnchors,
} from "./anchor-registry.js";

/**
 * Built-in LifeOps anchors resolve owner-window times into concrete fire
 * instants in the owner's timezone — the basis for `relative_to_anchor`
 * scheduling. The math must land on the correct UTC instant and degrade to
 * null on missing/invalid windows.
 */

const ctx = (
  overrides: Partial<AnchorContext["ownerFacts"]> & { nowIso?: string },
): AnchorContext => {
  const { nowIso, ...ownerFacts } = overrides;
  return {
    nowIso: nowIso ?? "2026-06-23T18:00:00.000Z",
    ownerFacts: { timezone: "UTC", ...ownerFacts },
  } as AnchorContext;
};

const anchor = (key: string) => {
  const found = APP_LIFEOPS_ANCHORS.find((a) => a.anchorKey === key);
  if (!found) throw new Error(`anchor ${key} missing`);
  return found;
};

describe("built-in anchors", () => {
  it("lists the four canonical anchor keys", () => {
    expect(APP_LIFEOPS_ANCHORS.map((a) => a.anchorKey).sort()).toEqual([
      "lunch.start",
      "meeting.ended",
      "morning.start",
      "night.start",
    ]);
  });

  it("resolves morning.start to the owner window in UTC", () => {
    expect(
      anchor("morning.start").resolve(
        ctx({ morningWindow: { start: "07:00" } }),
      ),
    ).toEqual({ atIso: "2026-06-23T07:00:00.000Z" });
  });

  it("applies the owner timezone offset (America/New_York, EDT = UTC-4)", () => {
    expect(
      anchor("morning.start").resolve(
        ctx({
          timezone: "America/New_York",
          morningWindow: { start: "07:00" },
        }),
      ),
    ).toEqual({ atIso: "2026-06-23T11:00:00.000Z" });
  });

  it("resolves lunch.start to local noon", () => {
    expect(anchor("lunch.start").resolve(ctx({}))).toEqual({
      atIso: "2026-06-23T12:00:00.000Z",
    });
  });

  it("returns null on a missing window or malformed time", () => {
    expect(anchor("morning.start").resolve(ctx({}))).toBeNull();
    expect(
      anchor("night.start").resolve(ctx({ eveningWindow: { start: "25:61" } })),
    ).toBeNull();
  });

  it("treats meeting.ended as event-driven (always null here)", () => {
    expect(anchor("meeting.ended").resolve(ctx({}))).toBeNull();
  });
});

describe("registerAppLifeOpsAnchors", () => {
  it("registers all built-ins and is idempotent", () => {
    const reg = createAnchorRegistry();
    registerAppLifeOpsAnchors(reg);
    expect(reg.list()).toHaveLength(4);
    expect(reg.get("morning.start")?.anchorKey).toBe("morning.start");
    expect(() => registerAppLifeOpsAnchors(reg)).not.toThrow();
    expect(reg.list()).toHaveLength(4);
  });
});

describe("per-runtime anchor registry", () => {
  it("stores, retrieves, and resets a runtime-scoped registry", () => {
    const runtime = {} as IAgentRuntime;
    expect(getAnchorRegistry(runtime)).toBeNull();
    const reg = createAnchorRegistry();
    registerAnchorRegistry(runtime, reg);
    expect(getAnchorRegistry(runtime)).toBe(reg);
    __resetAnchorRegistryForTests(runtime);
    expect(getAnchorRegistry(runtime)).toBeNull();
  });
});
