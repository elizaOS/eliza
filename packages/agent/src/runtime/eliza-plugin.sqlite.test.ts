/** Boots the built-in host plugin and its actual services on an isolated native SQLite runtime. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { KnowledgeGraphService } from "@elizaos/plugin-relationships/knowledge-graph";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, it, vi } from "vitest";
import { preparePluginForSelectedDatabase } from "./database-selection.ts";
import { createElizaPlugin } from "./eliza-plugin.ts";

it("initializes the selected native host and persists graph state in its existing database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-sqlite-host-"));
  vi.stubEnv("ELIZA_DATABASE_PROVIDER", "sqlite");
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  const agentId = randomUUID() as UUID;
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  const plugin = createElizaPlugin({
    workspaceDir: join(directory, "workspace"),
    sessionStorePath: join(directory, "sessions.json"),
    agentId,
  });
  const runtime = new AgentRuntime({
    agentId,
    adapter,
    character: { name: "Synthetic SQLite host" },
    plugins: [plugin],
  });
  try {
    await runtime.initialize();
    await Promise.all(
      (plugin.services ?? []).map((service) =>
        runtime.getServiceLoadPromise(service.serviceType),
      ),
    );
    const graph = runtime.getService<KnowledgeGraphService>(
      KnowledgeGraphService.serviceType,
    );
    if (!graph)
      throw new Error("The host failed to register its canonical graph");
    await graph.getEntityStore().ensureSelf();
    expect(await graph.getEntityStore().get("self")).toMatchObject({
      entityId: "self",
    });
    expect(() =>
      preparePluginForSelectedDatabase({
        name: "unported",
        description: "Synthetic incompatible storage plugin",
        schema: { unported: {} },
      }),
    ).toThrow(/cannot activate/);
  } finally {
    await runtime.stop();
    await adapter.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
