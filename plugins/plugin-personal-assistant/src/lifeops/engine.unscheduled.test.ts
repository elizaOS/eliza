/**
 * Pure-transform coverage for the explicitly-undated cadence: an
 * `unscheduled` definition is reviewable state that materializes no
 * occurrences, normalizes to its bare shape, and round-trips from the
 * extractor's `cadenceKind`. No runtime graph; deterministic.
 */
import { describe, expect, it } from "vitest";
import type { ExtractedTaskParams } from "../actions/lib/extract-task-plan.ts";
import { buildCadenceFromLlmParams } from "../actions/life.ts";
import type { LifeOpsTaskDefinition } from "../contracts/index.js";
import { DefinitionsDomain } from "./domains/definitions-service.ts";
import { materializeDefinitionOccurrences } from "./engine.ts";
import { normalizeCadence } from "./service-normalize-task.ts";

const unscheduledDefinition: LifeOpsTaskDefinition = {
  id: "def-unscheduled",
  agentId: "agent-1",
  domain: "personal",
  subjectType: "owner",
  subjectId: "owner-1",
  visibilityScope: "private",
  contextPolicy: { allowAmbient: false },
  kind: "task",
  title: "buy milk",
  description: "",
  originalIntent: "add a todo: buy milk, no due date",
  timezone: "UTC",
  status: "active",
  priority: 3,
  cadence: { kind: "unscheduled" },
  windowPolicy: { windows: [] },
  progressionRule: { kind: "none" },
  checkInPolicy: null,
  websiteAccess: null,
  reminderPlanId: null,
  goalId: null,
  source: "test",
  metadata: {},
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
} as unknown as LifeOpsTaskDefinition;

describe("unscheduled cadence", () => {
  it("materializes no occurrences and never fires", () => {
    const occurrences = materializeDefinitionOccurrences(
      unscheduledDefinition,
      [],
      { now: new Date("2026-08-15T12:00:00.000Z") },
    );
    expect(occurrences).toEqual([]);
  });

  it("normalizes to its bare shape without visibility math", () => {
    expect(normalizeCadence({ kind: "unscheduled" })).toEqual({
      kind: "unscheduled",
    });
  });

  it("builds from an explicit no-date extractor answer", () => {
    const params = {
      requestKind: null,
      title: "buy milk",
      description: null,
      cadenceKind: "unscheduled",
      windows: null,
      weekdays: null,
      timeOfDay: null,
      timeZone: null,
      everyMinutes: null,
      timesPerDay: null,
      priority: null,
      durationMinutes: null,
      dueDate: null,
      dueInDays: null,
      dueWeekday: null,
      dueInMinutes: null,
      multiStep: false,
    } as unknown as ExtractedTaskParams;
    expect(
      buildCadenceFromLlmParams(params, { allowUnscheduled: true }),
    ).toEqual({
      cadence: { kind: "unscheduled" },
    });
    expect(buildCadenceFromLlmParams(params)).toBeNull();
  });

  it("rejects unscheduled cadence for non-task definitions at the service boundary", async () => {
    const context = {
      agentId: () => "agent-1",
      normalizeOwnership: () => ({
        domain: "personal",
        subjectType: "owner",
        subjectId: "owner-1",
        visibilityScope: "private",
        contextPolicy: { allowAmbient: false },
      }),
    } as never;
    const domain = new DefinitionsDomain(context, {} as never);

    await expect(
      domain.createDefinition({
        kind: "habit",
        title: "A habit that can never fire",
        timezone: "UTC",
        cadence: { kind: "unscheduled" },
      }),
    ).rejects.toThrow("unscheduled cadence is only valid for task definitions");
  });
});
