import type { LifeOpsTaskDefinition } from "@elizaos/contracts";
import { expect, it } from "vitest";
import { materializeDefinitionOccurrences } from "./engine.js";
import { createLifeOpsTaskDefinition } from "./repository.js";

const due = "2026-09-30T10:00:00.000Z";
const snoozedUntil = "2026-09-30T10:10:02.000Z";
const definition = createLifeOpsTaskDefinition({
  agentId: "agent-1",
  domain: "user_lifeops",
  subjectType: "owner",
  subjectId: "owner-1",
  visibilityScope: "owner_only",
  contextPolicy: "explicit_only",
  kind: "habit",
  title: "Post-fire reminder",
  description: "",
  originalIntent: "Post-fire reminder",
  timezone: "UTC",
  status: "active",
  priority: 3,
  cadence: {
    kind: "once",
    dueAt: due,
    visibilityLeadMinutes: 0,
    visibilityLagMinutes: 1,
  },
  windowPolicy: { timezone: "UTC", windows: [] },
  progressionRule: { kind: "none" },
  websiteAccess: null,
  reminderPlanId: null,
  goalId: null,
  source: "manual",
  metadata: { ownerSurface: "OWNER_REMINDERS" },
});
const [original] = materializeDefinitionOccurrences(definition, [], {
  now: new Date(due),
});
const committed = {
  ...original,
  state: "snoozed" as const,
  snoozedUntil,
  metadata: { ...original.metadata, snoozedAt: "2026-09-30T10:00:02.000Z" },
};

it("extends only the effective end through the explicit snooze cycle, then expires", () => {
  const [atDeadline] = materializeDefinitionOccurrences(
    definition,
    [committed],
    {
      now: new Date(snoozedUntil),
    },
  );
  expect(atDeadline).toMatchObject({
    id: original.id,
    occurrenceKey: original.occurrenceKey,
    dueAt: due,
    scheduledAt: original.scheduledAt,
    relevanceStartAt: original.relevanceStartAt,
    relevanceEndAt: "2026-09-30T10:11:02.000Z",
    state: "visible",
  });
  const [expired] = materializeDefinitionOccurrences(definition, [atDeadline], {
    now: new Date("2026-09-30T10:11:02.001Z"),
  });
  expect(expired.state).toBe("expired");
  expect(definition.cadence).toMatchObject({ dueAt: due });
});

it.each([
  { metadata: { ownerSurface: "OWNER_TODOS" } },
  { domain: "agent_ops" },
  { subjectType: "agent" },
] satisfies Partial<LifeOpsTaskDefinition>[])(
  "keeps the original window outside the owner reminder scope: %j",
  (override) => {
    const [result] = materializeDefinitionOccurrences(
      { ...definition, ...override },
      [committed],
      { now: new Date(snoozedUntil) },
    );
    expect(result.relevanceEndAt).toBe(original.relevanceEndAt);
    expect(result.state).toBe("expired");
  },
);

it.each([undefined, "invalid", snoozedUntil, "2026-09-30T10:12:00.000Z"])(
  "does not extend from a missing or invalid committed snooze timestamp: %s",
  (snoozedAt) => {
    const [result] = materializeDefinitionOccurrences(
      definition,
      [{ ...committed, metadata: { ...original.metadata, snoozedAt } }],
      { now: new Date(snoozedUntil) },
    );
    expect(result.relevanceEndAt).toBe(original.relevanceEndAt);
    expect(result.state).toBe("expired");
  },
);

it("does not shorten the original window when the snoozed deadline is earlier", () => {
  const [result] = materializeDefinitionOccurrences(
    { ...definition, cadence: { kind: "once", dueAt: due } },
    [
      {
        ...committed,
        snoozedUntil: "2026-09-30T09:50:00.000Z",
        metadata: { snoozedAt: "2026-09-30T09:40:00.000Z" },
      },
    ],
    { now: new Date("2026-09-30T09:50:00.000Z") },
  );
  expect(result.relevanceEndAt).toBe("2026-09-30T16:00:00.000Z");
  expect(result.dueAt).toBe(due);
});

it("keeps recurring window expiry unchanged after an explicit snooze", () => {
  const daily: LifeOpsTaskDefinition = {
    ...definition,
    cadence: { kind: "daily", windows: ["morning"] },
    windowPolicy: {
      timezone: "UTC",
      windows: [
        { name: "morning", label: "Morning", startMinute: 600, endMinute: 660 },
      ],
    },
  };
  const [occurrence] = materializeDefinitionOccurrences(daily, [], {
    now: new Date(due),
    lookbackDays: 0,
    lookaheadDays: 0,
  });
  const deadline = new Date(Date.parse(occurrence.relevanceEndAt) + 600000);
  const [result] = materializeDefinitionOccurrences(
    daily,
    [
      {
        ...occurrence,
        state: "snoozed",
        snoozedUntil: deadline.toISOString(),
        metadata: committed.metadata,
      },
    ],
    {
      now: deadline,
      lookbackDays: 0,
      lookaheadDays: 0,
    },
  );
  expect(result.relevanceEndAt).toBe(occurrence.relevanceEndAt);
  expect(result.state).toBe("expired");
});

it.each(["completed", "skipped", "muted"] as const)(
  "preserves an actual terminal state through materialization: %s",
  (state) => {
    const [result] = materializeDefinitionOccurrences(
      definition,
      [{ ...committed, state }],
      { now: new Date(snoozedUntil) },
    );
    expect(result.state).toBe(state);
  },
);
