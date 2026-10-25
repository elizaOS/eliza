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
    await runtime.adapter.updateAgents([
      { agentId, agent: { name: "Persisted runtime identity" } },
    ]);
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
  } finally {
    await runtime.stop();
    await runtime.adapter?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
