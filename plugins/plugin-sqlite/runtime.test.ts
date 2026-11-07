/** Exercises the actual runtime database registration and schema rejection boundary. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type UUID } from "@elizaos/core";
import { expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";
import { plugin } from "./index";

it("registers a real persistent adapter before runtime initialization and reopens its state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-sqlite-runtime-"));
  const agentId = randomUUID() as UUID;
  const character = {
    id: agentId,
    name: "SQLite runtime",
    bio: ["Synthetic storage validation"],
    settings: { SQLITE_DATABASE_PATH: join(directory, "agent.sqlite") },
  };
  let runtime = new AgentRuntime({ character, plugins: [plugin] });
  try {
    await runtime.initialize();
    // plugin-sql updateAgent returns true on any successful UPDATE, so an
    // update that matches a row and an empty update list both report success.
    expect(
      await runtime.adapter.updateAgents([
        { agentId, agent: { name: "Persisted runtime identity" } },
      ]),
    ).toBe(true);
    expect(await runtime.adapter.updateAgents([])).toBe(true);
    await runtime.adapter.setCaches([
      {
        key: "runtime-proof",
        value: { complete: "stored by real AgentRuntime" },
      },
    ]);
    await runtime.stop();
    await runtime.adapter.close();
    const restored = SQLiteDatabaseAdapter.create(
      character.settings.SQLITE_DATABASE_PATH,
      agentId,
    );
    await restored.initialize();
    expect((await restored.getAgentsByIds([agentId]))[0].name).toBe(
      "Persisted runtime identity",
    );
    await restored.close();
    runtime = new AgentRuntime({ character, plugins: [plugin] });
    await runtime.initialize();
    expect((await runtime.adapter.getAgentsByIds([agentId]))[0].name).toBe(
      character.name,
    );
    expect(
      (await runtime.adapter.getCaches(["runtime-proof"])).get("runtime-proof"),
    ).toEqual({ complete: "stored by real AgentRuntime" });
    // No agent row exists in a fresh database, but the update still succeeds,
    // like plugin-sql.
    const ghostDirectory = await mkdtemp(
      join(tmpdir(), "eliza-sqlite-update-agents-"),
    );
    const ghostId = randomUUID() as UUID;
    const ghost = SQLiteDatabaseAdapter.create(
      join(ghostDirectory, "agent.sqlite"),
      ghostId,
    );
    await ghost.initialize();
    try {
      expect(
        await ghost.updateAgents([
          { agentId: ghostId, agent: { name: "Ghost" } },
        ]),
      ).toBe(true);
    } finally {
      await ghost.close();
      await rm(ghostDirectory, { recursive: true, force: true });
    }
  } finally {
    await runtime.stop();
    await runtime.adapter?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
