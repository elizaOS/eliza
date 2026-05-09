/**
 * Helper-function tests for W1-D default packs:
 *   - `deriveQuietObservations` (quiet-user-watcher)
 *   - `runQuietUserWatcher` (provider integration)
 *   - `deriveOverdueFollowupTasks` (followup-starter)
 *   - `buildFollowupTaskForRelationship`
 *   - `buildSeedingOfferMessage`
 *   - `assembleMorningBrief` parity wrapper signature
 */

import { describe, expect, it } from "vitest";
import {
  buildFollowupTaskForRelationship,
  buildSeedingOfferMessage,
  deriveOverdueFollowupTasks,
  deriveQuietObservations,
  HABIT_STARTER_KEYS,
  runQuietUserWatcher,
} from "../src/default-packs/index.js";
import type {
  RecentTaskStatesProvider,
  RecentTaskStatesSummary,
  RelationshipFilterStub,
  RelationshipStoreStub,
  RelationshipStub,
} from "../src/default-packs/index.js";

describe("deriveQuietObservations", () => {
  function summary(
    streaks: RecentTaskStatesSummary["streaks"],
  ): RecentTaskStatesSummary {
    return { summary: "test", streaks, notable: [] };
  }

  it("flags quiet_for_days when expired-checkin streak >= 3", () => {
    const observations = deriveQuietObservations(
      summary([
        { kind: "checkin", outcome: "expired", consecutive: 4 },
      ]),
    );
    expect(observations.find((o) => o.kind === "quiet_for_days")).toBeDefined();
  });

  it("does not flag quiet_for_days when streak < threshold", () => {
    const observations = deriveQuietObservations(
      summary([{ kind: "checkin", outcome: "expired", consecutive: 1 }]),
      { thresholdDays: 3 },
    );
    expect(observations.filter((o) => o.kind === "quiet_for_days")).toEqual([]);
  });

  it("flags missed_yesterday_checkin on a single expired checkin", () => {
    const observations = deriveQuietObservations(
      summary([{ kind: "checkin", outcome: "expired", consecutive: 1 }]),
    );
    expect(
      observations.find((o) => o.kind === "missed_yesterday_checkin"),
    ).toBeDefined();
  });

  it("respects custom threshold", () => {
    const observations = deriveQuietObservations(
      summary([{ kind: "checkin", outcome: "expired", consecutive: 4 }]),
      { thresholdDays: 5 },
    );
    expect(observations.filter((o) => o.kind === "quiet_for_days")).toEqual([]);
  });
});

describe("runQuietUserWatcher", () => {
  it("calls provider.summarize with checkin+followup kinds and 7-day lookback by default", async () => {
    const calls: Array<Parameters<RecentTaskStatesProvider["summarize"]>> = [];
    const provider: RecentTaskStatesProvider = {
      summarize: async (opts) => {
        calls.push([opts]);
        return { summary: "", streaks: [], notable: [] };
      },
    };
    await runQuietUserWatcher(provider);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      kinds: ["checkin", "followup"],
      lookbackDays: 7,
    });
  });

  it("returns derived observations from provider summary", async () => {
    const provider: RecentTaskStatesProvider = {
      summarize: async () => ({
        summary: "",
        streaks: [{ kind: "checkin", outcome: "expired", consecutive: 5 }],
        notable: [],
      }),
    };
    const observations = await runQuietUserWatcher(provider);
    expect(observations.length).toBeGreaterThan(0);
  });
});

describe("buildFollowupTaskForRelationship", () => {
  it("creates a followup task with subject={kind:relationship, id} and subject_updated check", () => {
    const seed = buildFollowupTaskForRelationship({
      relationshipId: "rel-1",
      fromEntityId: "ent-A",
      toEntityId: "ent-B",
      cadenceDays: 14,
    });
    expect(seed.kind).toBe("followup");
    expect(seed.subject).toEqual({ kind: "relationship", id: "rel-1" });
    expect(seed.completionCheck?.kind).toBe("subject_updated");
    expect(seed.metadata?.cadenceDays).toBe(14);
    expect(seed.idempotencyKey).toBe("default-pack:followup-starter:rel-1");
  });
});

describe("deriveOverdueFollowupTasks", () => {
  function makeOverdueRelationship(args: {
    id: string;
    cadenceDays?: number;
  }): RelationshipStub {
    return {
      relationshipId: args.id,
      fromEntityId: `ent-${args.id}-from`,
      toEntityId: `ent-${args.id}-to`,
      type: "follows",
      metadata:
        args.cadenceDays !== undefined ? { cadenceDays: args.cadenceDays } : {},
      state: { lastInteractionAt: "2026-01-01T00:00:00Z" },
      evidence: [],
      confidence: 1,
      source: "user_chat",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  it("emits one task per overdue relationship", async () => {
    const captured: RelationshipFilterStub[] = [];
    const store: RelationshipStoreStub = {
      list: async (filter) => {
        captured.push(filter ?? {});
        return [
          makeOverdueRelationship({ id: "r1", cadenceDays: 14 }),
          makeOverdueRelationship({ id: "r2", cadenceDays: 30 }),
        ];
      },
    };
    const seeds = await deriveOverdueFollowupTasks(store, {
      now: new Date("2026-01-15T07:00:00Z"),
    });
    expect(seeds.length).toBe(2);
    expect(seeds.map((s) => s.subject?.id).sort()).toEqual(["r1", "r2"]);
    expect(captured[0]?.cadenceOverdueAsOf).toBe("2026-01-15T07:00:00.000Z");
  });

  it("treats missing cadenceDays as 0", async () => {
    const store: RelationshipStoreStub = {
      list: async () => [makeOverdueRelationship({ id: "r-no-cadence" })],
    };
    const seeds = await deriveOverdueFollowupTasks(store);
    expect(seeds[0]!.metadata?.cadenceDays).toBe(0);
  });
});

describe("buildSeedingOfferMessage", () => {
  it("contains all 8 habit names in the offered list", () => {
    const message = buildSeedingOfferMessage();
    for (const name of [
      "brush teeth",
      "shower",
      "invisalign",
      "drink water",
      "stretch breaks",
      "vitamins",
      "workout",
      "shave",
    ]) {
      expect(message).toContain(name);
    }
  });

  it("ends with the customize hint", () => {
    expect(buildSeedingOfferMessage()).toMatch(/pick and choose/);
  });

  it("never embeds an absolute path or PII name", () => {
    const message = buildSeedingOfferMessage();
    expect(message).not.toMatch(/\b(Jill|Marco|Sarah|Suran|Samantha)\b/);
    expect(message).not.toMatch(/(?:^|\s)\//);
    expect(message).not.toMatch(/^~\//);
  });
});

describe("HABIT_STARTER_KEYS contract", () => {
  it("exposes 8 stable string keys", () => {
    const values = Object.values(HABIT_STARTER_KEYS);
    expect(values.length).toBe(8);
    expect(new Set(values).size).toBe(8);
  });
});
