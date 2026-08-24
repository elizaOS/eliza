import { describe, expect, it } from "vitest";
import {
  buildFallbackDefaultPack,
  FALLBACK_DEFAULT_PACK_ID,
  FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS,
} from "./default-pack.ts";

describe("buildFallbackDefaultPack", () => {
  it("builds a fallback pack with the stable id", () => {
    const pack = buildFallbackDefaultPack({ createdBy: "seed-agent" });
    expect(pack.id).toBe(FALLBACK_DEFAULT_PACK_ID);
    expect(pack.fallback).toBe(true);
    // createdBy 应传播到任务
    expect(pack.tasks.length).toBeGreaterThan(0);
  });

  it("includes the good-morning reminder with a stable key", () => {
    const pack = buildFallbackDefaultPack({ createdBy: "seed-agent" });
    const keys = pack.tasks.map((t) => t.idempotencyKey);
    expect(keys).toContain(FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.goodMorning);
  });

  it("includes the weekly review recap", () => {
    const pack = buildFallbackDefaultPack({ createdBy: "seed-agent" });
    const keys = pack.tasks.map((t) => t.idempotencyKey);
    expect(keys).toContain(FALLBACK_DEFAULT_PACK_IDEMPOTENCY_KEYS.weeklyReview);
  });
});
