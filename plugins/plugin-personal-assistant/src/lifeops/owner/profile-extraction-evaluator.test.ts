/**
 * Deterministic owner-profile extraction tests covering explicit names, stable
 * home locations, valid time zones, and false positives that must not become
 * durable owner facts. The suite uses the pure extractor without a model.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createOwnerFactStore } from "./fact-store.js";
import { extractProfileDetails } from "./profile-extraction-evaluator.js";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function factsFrom(text: string) {
  return extractProfileDetails(text, NOW).facts;
}

function makeCacheRuntime(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID,
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

describe("owner profile explicit fact extraction", () => {
  it("prefers an explicit call-me name and preserves internal apostrophes", () => {
    expect(factsFrom("My name is Siobhan O'Connor, but call me Shiv.")).toEqual(
      {
        preferredName: "Shiv",
      },
    );
    expect(factsFrom("I go by D'Andre.")).toEqual({
      preferredName: "D'Andre",
    });
  });

  it("does not mistake scheduling or channel instructions for a name", () => {
    expect(factsFrom("Call me at 5 tomorrow.")).toEqual({});
    expect(factsFrom("Call me on Telegram.")).toEqual({});
  });

  it("extracts only stable home/base location declarations", () => {
    expect(factsFrom("I'm based in Berlin.")).toEqual({ location: "Berlin" });
    expect(factsFrom("My home base is in São Paulo.")).toEqual({
      location: "São Paulo",
    });
    expect(factsFrom("I moved to Chicago, and I love it.")).toEqual({
      location: "Chicago",
    });
  });

  it("does not persist transient presence as the owner's home location", () => {
    expect(factsFrom("I'm in Tokyo for the weekend.")).toEqual({});
    expect(factsFrom("I am in a meeting right now.")).toEqual({});
    expect(factsFrom("My location is gate B12.")).toEqual({});
  });

  it("extracts explicit valid IANA zones and canonicalizes UTC aliases", () => {
    expect(factsFrom("My timezone is America/Los_Angeles.")).toEqual({
      timezone: "America/Los_Angeles",
    });
    expect(factsFrom("Set Europe/Paris as my time zone.")).toEqual({
      timezone: "Europe/Paris",
    });
    expect(factsFrom("Use my timezone to GMT+00:00.")).toEqual({
      timezone: "UTC",
    });
  });

  it("rejects ambiguous abbreviations and invalid zones", () => {
    expect(factsFrom("My timezone is PST.")).toEqual({});
    expect(factsFrom("My timezone is Moon/Sea_of_Tranquility.")).toEqual({});
  });
});

describe("owner fact provenance", () => {
  it("round-trips explicit-owner provenance and bounded confidence", async () => {
    const runtime = makeCacheRuntime();
    const store = createOwnerFactStore(runtime);
    await store.update(
      { timezone: "America/Chicago" },
      {
        source: "owner_explicit",
        recordedAt: "2026-08-18T12:00:00.000Z",
        confidence: 0.98,
      },
    );

    const reread = await createOwnerFactStore(runtime).read();
    expect(reread.timezone).toEqual({
      value: "America/Chicago",
      provenance: {
        source: "owner_explicit",
        recordedAt: "2026-08-18T12:00:00.000Z",
        confidence: 0.98,
      },
    });
  });
});
