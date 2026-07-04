/**
 * Coverage for `resolveOwnerTimeZone` (#13509): the canonical owner-effective
 * timezone resolver used by the conversational reminder-create path and by
 * reminder window/dueness processing.
 *
 * Before this helper, both lanes anchored owner-local wall time to the HOST
 * clock (`resolveDefaultTimeZone()` = `Intl` host tz; `UTC` on shared-server /
 * `TZ=UTC` containers), so "remind me tomorrow at 9am" for a Chicago owner was
 * stored at 09:00 UTC = 04:00 America/Chicago. These tests pin that the stored
 * owner-fact timezone is consulted, that it falls back to the host zone only
 * when no fact is stored (never fabricated), and that an active-travel
 * destination zone overrides the home zone while travel is live.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveDefaultTimeZone } from "../defaults.js";
import {
  createOwnerFactStore,
  type OwnerFactProvenance,
  registerOwnerFactStore,
  resolveOwnerFactStore,
  resolveOwnerTimeZone,
} from "./fact-store.js";

function makeCacheRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "44444444-4444-4444-4444-444444444444" as UUID,
    async getCache<T>(key: string): Promise<T | null> {
      const value = cache.get(key);
      return value === undefined ? null : (value as T);
    },
    async setCache<T>(key: string, value: T): Promise<boolean> {
      cache.set(key, value);
      return true;
    },
    async deleteCache(key: string): Promise<boolean> {
      return cache.delete(key);
    },
  } as unknown as IAgentRuntime;
}

function makeRuntimeWithStore(): IAgentRuntime {
  const runtime = makeCacheRuntime();
  registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
  return runtime;
}

const provenance: OwnerFactProvenance = {
  source: "profile_save",
  recordedAt: "2026-07-04T00:00:00.000Z",
};

const NOW = new Date("2026-07-04T12:00:00.000Z");

describe("resolveOwnerTimeZone (#13509)", () => {
  it("returns the host default when no owner timezone fact is stored (never fabricated)", async () => {
    const runtime = makeRuntimeWithStore();
    const tz = await resolveOwnerTimeZone(runtime, NOW);
    expect(tz).toBe(resolveDefaultTimeZone());
  });

  it("returns the owner's stored timezone fact over the host default", async () => {
    const runtime = makeRuntimeWithStore();
    await resolveOwnerFactStore(runtime).update(
      { timezone: "America/Chicago" },
      provenance,
    );
    const tz = await resolveOwnerTimeZone(runtime, NOW);
    expect(tz).toBe("America/Chicago");
  });

  it("prefers the active-travel destination zone over the stored home zone while travel is live", async () => {
    const runtime = makeRuntimeWithStore();
    const store = resolveOwnerFactStore(runtime);
    await store.update({ timezone: "America/Chicago" }, provenance);
    await store.setActiveTravel(
      {
        startIso: "2026-07-01T00:00:00.000Z",
        endIso: "2026-07-10T00:00:00.000Z",
        destinationTimezone: "Asia/Tokyo",
      },
      provenance,
    );
    // NOW (2026-07-04) falls inside the travel window.
    const tz = await resolveOwnerTimeZone(runtime, NOW);
    expect(tz).toBe("Asia/Tokyo");
  });

  it("falls back to the host zone when the stored timezone fact is not a valid IANA zone (write path accepts any non-empty string)", async () => {
    // OwnerFactStore.update only guards timezone with a non-empty-string check,
    // so a colloquial/garbage value can persist. The reminder date/window math
    // downstream expects a valid IANA zone and would throw on a bad one, so the
    // resolver must reject it and fall back rather than propagate it.
    const runtime = makeRuntimeWithStore();
    await resolveOwnerFactStore(runtime).update(
      { timezone: "Central Time (definitely not IANA)" },
      provenance,
    );
    const tz = await resolveOwnerTimeZone(runtime, NOW);
    expect(tz).toBe(resolveDefaultTimeZone());
  });

  it("degrades to the host zone when the fact-store read throws (no cache backend), never crashing time resolution", async () => {
    // A runtime with no cache methods: `resolveOwnerFactStore(...).read()`
    // throws. The resolver must swallow that into the host-zone fallback so a
    // reminder create can still schedule (against the host clock) instead of
    // failing the whole request.
    const runtimeNoCache = {
      agentId: "55555555-5555-5555-5555-555555555555" as UUID,
    } as unknown as IAgentRuntime;
    const tz = await resolveOwnerTimeZone(runtimeNoCache, NOW);
    expect(tz).toBe(resolveDefaultTimeZone());
  });

  it("falls back to the stored home zone once the travel window has lapsed", async () => {
    const runtime = makeRuntimeWithStore();
    const store = resolveOwnerFactStore(runtime);
    await store.update({ timezone: "America/Chicago" }, provenance);
    await store.setActiveTravel(
      {
        startIso: "2026-06-01T00:00:00.000Z",
        endIso: "2026-06-10T00:00:00.000Z",
        destinationTimezone: "Asia/Tokyo",
      },
      provenance,
    );
    // NOW (2026-07-04) is AFTER the travel window ended: home zone wins.
    const tz = await resolveOwnerTimeZone(runtime, NOW);
    expect(tz).toBe("America/Chicago");
  });
});
