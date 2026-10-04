/** Real config/database/history writes report partial completion honestly. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
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
