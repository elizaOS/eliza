/** Real config/database/history writes report partial completion honestly. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { handleCharacterRoutes } from "../src/api/character-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { CharacterSchema } from "../src/config/zod-schema.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";
import { ElizaCharacterPersistenceService } from "../src/services/character-persistence.ts";

it("records committed sinks and exposes a later storage failure without claiming rollback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "character-receipt-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  const runtime = new AgentRuntime({
    character: { name: "Before", bio: [] },
    logLevel: "fatal",
  });
  const adapter = SQLiteDatabaseAdapter.create(
    path.join(dir, "state.sqlite"),
    runtime.agentId,
  );
  runtime.registerDatabaseAdapter(adapter);
  try {
    await runtime.init();
    await runtime.createAgent({ ...runtime.character, id: runtime.agentId });
    const service = await ElizaCharacterPersistenceService.start(runtime);
    const complete = await service.persistCharacter({
      character: { name: "Saved", bio: [] },
      previousCharacter: runtime.character,
      source: "manual",
    });
    expect(complete).toMatchObject({
      success: true,
      persistence: {
        config: "committed",
        agent: "committed",
        history: "committed",
      },
    });
    expect((await runtime.getAgent(runtime.agentId))?.name).toBe("Saved");
    expect(
      (
        await runtime.getMemories({
          roomId: runtime.agentId,
          tableName: "character_modifications",
        })
      ).length,
    ).toBeGreaterThan(0);
    // A real SQLite constraint rejects only history insertion after the agent update.
    // The adapter owns an exclusive file lock. Release it before installing
    // the real failure constraint, then reopen through the owning adapter.
    await adapter.close();
    const connection = new DatabaseSync(path.join(dir, "state.sqlite"));
    try {
      connection.exec(
        "CREATE TRIGGER reject_history BEFORE INSERT ON records WHEN NEW.collection = 'memories' BEGIN SELECT RAISE(ABORT, 'history unavailable'); END",
      );
    } finally {
      connection.close();
    }
    await adapter.init();
    const historyFailure = await service.persistCharacter({
      character: { name: "History failed", bio: [] },
      previousCharacter: { name: "Saved", bio: [] },
      source: "manual",
    });
    expect(historyFailure).toMatchObject({
      success: false,
      persistence: {
        config: "committed",
        agent: "committed",
        history: "unknown",
      },
    });
    expect((await runtime.getAgent(runtime.agentId))?.name).toBe(
      "History failed",
    );
    expect(
      JSON.parse(await readFile(configPath, "utf8")).agents.list[0].name,
    ).toBe("History failed");
    await runtime.close();
    const partial = await service.persistCharacter({
      character: { name: "Saved on disk", bio: [] },
      previousCharacter: { name: "Saved", bio: [] },
      source: "manual",
    });
    expect(partial).toMatchObject({
      success: false,
      persistence: {
        config: "committed",
        agent: "unknown",
        history: "not-started",
      },
    });
    expect(partial.error).toContain("No rollback is claimed");
    expect(
      JSON.parse(await readFile(configPath, "utf8")).agents.list[0].name,
    ).toBe("Saved on disk");
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("refuses a character PUT whose agent row update was not confirmed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "character-put-receipt-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  saveElizaConfig({
    ui: { assistant: { name: "Eliza" } },
    agents: { list: [{ id: "main", default: true, name: "Eliza" }] },
  });
  const runtime = new AgentRuntime({
    character: buildCharacterFromConfig(loadElizaConfig()),
    logLevel: "fatal",
  });
  const adapter = SQLiteDatabaseAdapter.create(
    path.join(dir, "state.sqlite"),
    runtime.agentId,
  );
  runtime.registerDatabaseAdapter(adapter);
  try {
    await runtime.init();
    await runtime.createAgent({ ...runtime.character, id: runtime.agentId });
    // A restored database without this agent row: updateAgent() writes nothing
    // and reports false, exactly like the persistence service's receipt.
    await adapter.deleteAgents([runtime.agentId]);
    const replies: Array<{ status: number; message?: string }> = [];
    const handled = await handleCharacterRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "PUT",
      pathname: "/api/character",
      state: { runtime, agentName: "Eliza", config: loadElizaConfig() },
      readJsonBody: async <T extends object>() =>
        ({ name: "Nova" }) as unknown as T,
      json: (_res, _data, code = 200) => {
        replies.push({ status: code });
      },
      error: (_res, message, code = 500) => {
        replies.push({ status: code, message });
      },
      pickRandomNames: () => [],
      saveConfig: saveElizaConfig,
      validateCharacter: (body) => CharacterSchema.safeParse(body),
    });
    expect(handled).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.status).toBe(500);
    expect(replies[0]?.message).toContain("not confirmed");
    // NEITHER the live character NOR the config may claim the edit was saved.
    expect(runtime.character.name).toBe("Eliza");
    expect(
      (
        JSON.parse(await readFile(configPath, "utf8")) as {
          agents: { list: Array<{ name?: string }> };
        }
      ).agents.list[0]?.name,
    ).toBe("Eliza");
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
