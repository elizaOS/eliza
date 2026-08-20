/**
 * Deterministic domain-boundary coverage for completed occurrence attribution.
 * The harness uses the real definitions service with injected repository
 * collaborators and verifies the timestamp produced by the mutation boundary.
 */
import { describe, expect, it, vi } from "vitest";
import type { LifeOpsOccurrence } from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type DefinitionsDeps,
  DefinitionsDomain,
} from "./definitions-service.js";

describe("DefinitionsDomain completion attribution", () => {
  it("attributes completion with the authoritative mutation timestamp", async () => {
    const completedAt = "2026-08-19T22:15:00.000Z";
    const occurrence = {
      id: "occurrence-1",
      agentId: "agent-1",
      definitionId: "definition-1",
      occurrenceKey: "2026-08-19",
      state: "pending",
      snoozedUntil: null,
      completionPayload: null,
      updatedAt: "2026-08-19T21:00:00.000Z",
    } as unknown as LifeOpsOccurrence;
    const view = { occurrence: { id: occurrence.id } };
    const repository = {
      updateOccurrence: vi.fn(async (updated: LifeOpsOccurrence) => {
        // Persistence adapters may serialize the generic JSON payload. Event
        // attribution must retain the typed timestamp created before this call.
        (updated as { completionPayload: unknown }).completionPayload = null;
      }),
      getOccurrenceView: vi.fn(async () => view),
      attributeBriefItemEngagement: vi.fn(async () => null),
    };
    const ctx = {
      agentId: () => "agent-1",
      repository,
      recordAudit: vi.fn(async () => undefined),
      runtime: { reportError: vi.fn() },
    } as unknown as LifeOpsContext;
    const deps = {
      getFreshOccurrence: vi.fn(async () => ({
        definition: { id: "definition-1" },
        occurrence,
      })),
      awardWebsiteAccessGrant: vi.fn(async () => undefined),
      refreshDefinitionOccurrences: vi.fn(async () => undefined),
      syncWebsiteAccessState: vi.fn(async () => undefined),
      resolveReminderEscalation: vi.fn(async () => undefined),
    } as unknown as DefinitionsDeps;

    const result = await new DefinitionsDomain(ctx, deps).completeOccurrence(
      occurrence.id,
      {},
      new Date(completedAt),
    );

    expect(result).toBe(view);
    expect(repository.attributeBriefItemEngagement).toHaveBeenCalledWith(
      expect.objectContaining({
        eventAt: completedAt,
        domainEventId: `occurrence_completed:${occurrence.id}:${completedAt}`,
      }),
    );
    expect(deps.resolveReminderEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedAt: completedAt }),
    );
  });
});
