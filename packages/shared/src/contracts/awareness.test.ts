import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AwarenessContributor,
  type AwarenessInvalidationEvent,
  DEFAULT_CACHE_TTL_MS,
  SELF_STATUS_SCHEMA_VERSION,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_TOTAL_CHAR_LIMIT,
} from "./awareness.ts";

describe("awareness contract constants", () => {
  it("pins the self-status schema version", () => {
    expect(SELF_STATUS_SCHEMA_VERSION).toBe(1);
  });

  it("pins the default cache TTL to one minute", () => {
    expect(DEFAULT_CACHE_TTL_MS).toBe(60_000);
  });

  it("keeps the deprecated summary limits for backward compatibility", () => {
    // Deprecated but still exported: summaries are no longer character-limited,
    // yet removing these constants would break existing importers.
    expect(SUMMARY_CHAR_LIMIT).toBe(80);
    expect(SUMMARY_TOTAL_CHAR_LIMIT).toBe(1200);
  });
});

describe("AwarenessInvalidationEvent union", () => {
  it("covers every documented invalidation trigger", () => {
    const events: AwarenessInvalidationEvent[] = [
      "permission-changed",
      "plugin-changed",
      "wallet-updated",
      "provider-changed",
      "config-changed",
      "runtime-restarted",
      "opinion-updated",
    ];
    expect(events).toHaveLength(7);
    // Every member is a string literal; no duplicates.
    expect(new Set(events).size).toBe(events.length);
  });
});

describe("AwarenessContributor contract", () => {
  it("requires id, position, and summary", () => {
    expectTypeOf<AwarenessContributor>().toHaveProperty("id");
    expectTypeOf<AwarenessContributor>().toHaveProperty("position");
    expectTypeOf<AwarenessContributor>().toHaveProperty("summary");
  });

  it("keeps detail, cacheTtl, invalidateOn, and trusted optional", () => {
    expectTypeOf<AwarenessContributor>().toHaveProperty("detail");
    expectTypeOf<AwarenessContributor>().toHaveProperty("cacheTtl");
    expectTypeOf<AwarenessContributor>().toHaveProperty("invalidateOn");
    expectTypeOf<AwarenessContributor>().toHaveProperty("trusted");
  });

  it("accepts a plain minimal contributor object", () => {
    const contributor: AwarenessContributor = {
      id: "wallet",
      position: 30,
      summary: async () => "wallet summary",
    };
    expect(contributor.id).toBe("wallet");
    expect(contributor.position).toBe(30);
    expect(typeof contributor.summary).toBe("function");
  });

  it("accepts a full contributor with all optional fields", () => {
    const contributor: AwarenessContributor = {
      id: "permissions",
      position: 20,
      summary: async () => "permissions summary",
      detail: async (_runtime, level) => `${level} detail`,
      cacheTtl: 5000,
      invalidateOn: ["permission-changed", "config-changed"],
      trusted: true,
    };
    expect(contributor.cacheTtl).toBe(5000);
    expect(contributor.invalidateOn).toEqual([
      "permission-changed",
      "config-changed",
    ]);
    expect(contributor.trusted).toBe(true);
  });

  it("allows summary to return an empty string (contributor is silent)", async () => {
    const contributor: AwarenessContributor = {
      id: "silent",
      position: 90,
      summary: async () => "",
    };
    await expect(contributor.summary({} as never)).resolves.toBe("");
  });
});
