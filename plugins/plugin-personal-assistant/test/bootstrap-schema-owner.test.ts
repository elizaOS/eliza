/**
 * Verifies LifeOps schema bootstrap preserves the host `eliza` plugin's full
 * schema owner instead of replacing it with a partial knowledge-graph schema.
 * Migration registration is mocked; compatibility probes use a real empty PGlite database.
 */
import { PGlite } from "@electric-sql/pglite";
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsRepository } from "../src/lifeops/repository";

let pg: PGlite | undefined;
afterEach(async () => {
  await pg?.close();
  pg = undefined;
  vi.restoreAllMocks();
});

describe("LifeOpsRepository schema owner bootstrap", () => {
  it("reuses the runtime eliza plugin's authoritative full schema", async () => {
    pg = new PGlite();
    await pg.exec(
      "CREATE SCHEMA app_lifeops; CREATE TABLE app_lifeops.life_audit_events (agent_id TEXT, event_type TEXT)",
    );
    const runPluginMigrations = vi.fn(async () => {});
    const fullElizaSchema = {
      knowledgeGraphEntities: { id: "graph" },
      pendantSessions: { id: "pendant" },
    };
    const runtime = {
      adapter: {
        db: drizzle(pg),
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
