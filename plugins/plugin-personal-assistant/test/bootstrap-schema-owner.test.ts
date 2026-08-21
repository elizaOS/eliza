/**
 * Verifies LifeOps schema bootstrap preserves the host `eliza` plugin's full
 * schema owner instead of replacing it with a partial knowledge-graph schema.
 * Adapter migration and compatibility-column checks are deterministic mocks.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsRepository } from "../src/lifeops/repository";

const ENSURE_METHODS = [
  "ensureActivitySignalColumns",
  "ensureSchedulingNegotiationColumns",
  "ensureReminderReviewColumns",
  "ensureBrowserBridgeCompanionTokenColumns",
  "ensureConnectorAccountColumns",
  "ensureInboxCacheIndexes",
  "ensureWorkflowRunIdempotencyKey",
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LifeOpsRepository schema owner bootstrap", () => {
  it("reuses the runtime eliza plugin's authoritative full schema", async () => {
    for (const method of ENSURE_METHODS) {
      vi.spyOn(LifeOpsRepository, method).mockResolvedValue(undefined);
    }
    const runPluginMigrations = vi.fn(async () => {});
    const fullElizaSchema = {
      knowledgeGraphEntities: { id: "graph" },
      pendantSessions: { id: "pendant" },
    };
    const runtime = {
      adapter: {
        isReady: async () => true,
        runPluginMigrations,
      },
      plugins: [{ name: "eliza", schema: fullElizaSchema } as Plugin],
    } as unknown as IAgentRuntime;

    await LifeOpsRepository.bootstrapSchema(runtime);

    const requestedPlugins = runPluginMigrations.mock.calls[0]?.[0];
    expect(requestedPlugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "eliza",
          schema: fullElizaSchema,
        }),
      ]),
    );
  });
});
