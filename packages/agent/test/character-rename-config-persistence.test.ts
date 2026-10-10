import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { handleCharacterRoutes } from "../src/api/character-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { CharacterSchema } from "../src/config/zod-schema.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";

it("keeps a character-editor rename and username after the config is rebuilt on restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "character-rename-"));
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
    const state = {
      runtime,
      agentName: "Eliza",
      config: loadElizaConfig(),
    };
    let status = 0;
    const handled = await handleCharacterRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "PUT",
      pathname: "/api/character",
      state,
      readJsonBody: async <T extends object>() =>
        ({ name: "Nova", username: "nova" }) as unknown as T,
      json: (_res, _data, code = 200) => {
        status = code;
      },
      error: (_res, message) => {
        throw new Error(message);
      },
      pickRandomNames: () => [],
      saveConfig: saveElizaConfig,
      validateCharacter: (body) => CharacterSchema.safeParse(body),
    });
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(runtime.character.name).toBe("Nova");

    const rebuilt = buildCharacterFromConfig(loadElizaConfig());
    expect({ name: rebuilt.name, username: rebuilt.username }).toEqual({
      name: "Nova",
      username: "nova",
    });
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
