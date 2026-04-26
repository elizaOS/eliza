import { describe, expect, it } from "vitest";
import type { LifeOpsTaskDefinition } from "@elizaos/shared";
import { materializeDefinitionOccurrences } from "../src/lifeops/engine.ts";

function buildBaseDefinition(): Omit<LifeOpsTaskDefinition, "cadence"> {
  const now = "2026-04-19T00:00:00.000Z";
  return {
    id: "def-1",
    agentId: "agent-1",
    domain: "health",
    subjectType: "owner",
    subjectId: "owner-1",
    visibilityScope: "private",
    contextPolicy: "owner_only",
    kind: "habit",
    title: "Test habit",
    description: "Test habit description",
    originalIntent: "test intent",
    timezone: "America/Los_Angeles",
    status: "active",
    priority: 1,
    windowPolicy: {
      timezone: "America/Los_Angeles",
      windows: [],
    },
    progressionRule: {
      kind: "none",
    },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "test",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("lifeops engine cadence guards", () => {
  it("does not throw when a daily cadence arrives without windows", () => {
    const definition = {
      ...buildBaseDefinition(),
      cadence: {
        kind: "daily",
      },
    } as LifeOpsTaskDefinition;

    expect(() =>
      materializeDefinitionOccurrences(definition, [], {
        now: new Date("2026-04-19T12:00:00.000Z"),
        lookbackDays: 0,
        lookaheadDays: 0,
      }),
    ).not.toThrow();
    expect(
      materializeDefinitionOccurrences(definition, [], {
        now: new Date("2026-04-19T12:00:00.000Z"),
        lookbackDays: 0,
        lookaheadDays: 0,
      }),
    ).toEqual([]);
  });

  it("does not throw when a weekly cadence arrives without windows", () => {
    const definition = {
      ...buildBaseDefinition(),
      cadence: {
        kind: "weekly",
        weekdays: ["monday"],
      },
    } as LifeOpsTaskDefinition;

    expect(() =>
      materializeDefinitionOccurrences(definition, [], {
        now: new Date("2026-04-19T12:00:00.000Z"),
        lookbackDays: 0,
        lookaheadDays: 0,
      }),
    ).not.toThrow();
    expect(
      materializeDefinitionOccurrences(definition, [], {
        now: new Date("2026-04-19T12:00:00.000Z"),
        lookbackDays: 0,
        lookaheadDays: 0,
      }),
    ).toEqual([]);
  });

  it("does not throw when an interval cadence arrives without windows", () => {
    const definition = {
      ...buildBaseDefinition(),
      cadence: {
        kind: "interval",
        everyMinutes: 60,
      },
    } as LifeOpsTaskDefinition;

    expect(() =>
      materializeDefinitionOccurrences(definition, [], {
        now: new Date("2026-04-19T12:00:00.000Z"),
        lookbackDays: 0,
        lookaheadDays: 0,
      }),
    ).not.toThrow();
    expect(
      materializeDefinitionOccurrences(definition, [], {
        now: new Date("2026-04-19T12:00:00.000Z"),
        lookbackDays: 0,
        lookaheadDays: 0,
      }),
    ).toEqual([]);
  });
});
