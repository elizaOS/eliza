/**
 * Deterministic domain-boundary coverage for explicitly undated LifeOps task
 * definitions. The harness uses the real definitions service with injected
 * repository collaborators so validation and persisted request shape remain
 * observable without a database runtime.
 */
import { describe, expect, it, vi } from "vitest";
import type { CreateLifeOpsDefinitionRequest } from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type DefinitionsDeps,
  DefinitionsDomain,
} from "./definitions-service.js";

function makeHarness(currentKind: "task" | "habit" | "routine" = "task") {
  const repository = {
    createDefinition: vi.fn(async () => undefined),
    updateDefinition: vi.fn(async () => undefined),
    listOccurrencesForDefinition: vi.fn(async () => []),
  };
  const ctx = {
    agentId: () => "00000000-0000-0000-0000-000000000001",
    normalizeOwnership: () => ({
      domain: "personal",
      subjectType: "owner",
      subjectId: "00000000-0000-0000-0000-000000000002",
      visibilityScope: "private",
      contextPolicy: { allowAmbient: false },
    }),
    repository,
    recordAudit: vi.fn(async () => undefined),
  } as unknown as LifeOpsContext;
  const deps = {
    getDefinitionRecord: vi.fn(async () => ({
      definition: {
        cadence: { kind: "daily", windows: ["morning"] },
        id: "definition-existing",
        kind: currentKind,
        timezone: "UTC",
      },
    })),
    ensureGoalExists: vi.fn(async () => null),
    syncReminderPlan: vi.fn(async () => null),
    syncGoalLink: vi.fn(async () => undefined),
    refreshDefinitionOccurrences: vi.fn(async () => []),
    syncNativeAppleReminderForDefinition: vi.fn(
      async ({ definition }) => definition,
    ),
    syncWebsiteAccessState: vi.fn(async () => undefined),
  } as unknown as DefinitionsDeps;
  return { deps, domain: new DefinitionsDomain(ctx, deps), repository };
}

function request(
  kind: CreateLifeOpsDefinitionRequest["kind"],
): CreateLifeOpsDefinitionRequest {
  return {
    cadence: { kind: "unscheduled" },
    kind,
    title: `Undated ${kind}`,
    timezone: "UTC",
  };
}

describe("DefinitionsDomain unscheduled cadence boundary", () => {
  it("persists an unscheduled task and observes zero materialized occurrences", async () => {
    const { deps, domain, repository } = makeHarness();

    const result = await domain.createDefinition(request("task"));

    expect(result.definition).toMatchObject({
      cadence: { kind: "unscheduled" },
      kind: "task",
      title: "Undated task",
    });
    expect(deps.refreshDefinitionOccurrences).toHaveBeenCalledWith(
      expect.objectContaining({
        cadence: { kind: "unscheduled" },
        kind: "task",
      }),
    );
    expect(repository.listOccurrencesForDefinition).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000001",
      result.definition.id,
    );
    expect(result.performance).toBeDefined();
  });

  it.each(["habit", "routine"] as const)(
    "rejects an unscheduled %s before persistence or occurrence refresh",
    async (kind) => {
      const { deps, domain, repository } = makeHarness();

      await expect(
        domain.createDefinition(request(kind)),
      ).rejects.toMatchObject({
        message: "unscheduled cadence is only valid for task definitions",
        status: 400,
      });
      expect(repository.createDefinition).not.toHaveBeenCalled();
      expect(deps.refreshDefinitionOccurrences).not.toHaveBeenCalled();
    },
  );

  it.each(["habit", "routine"] as const)(
    "rejects changing a %s to unscheduled before updating persistence",
    async (kind) => {
      const { domain, repository } = makeHarness(kind);

      await expect(
        domain.updateDefinition("definition-existing", {
          cadence: { kind: "unscheduled" },
        }),
      ).rejects.toMatchObject({
        message: "unscheduled cadence is only valid for task definitions",
        status: 400,
      });
      expect(repository.updateDefinition).not.toHaveBeenCalled();
    },
  );
});
