import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, parseAndValidateCharacter } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { handleCharacterRoutes } from "../src/api/character-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { CharacterSchema } from "../src/config/zod-schema.ts";
import {
  agentIdentityName,
  buildCharacterFromConfig,
} from "../src/runtime/build-character-config.ts";

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
    // The rename keeps the agent id and the name the chat ids came from.
    expect(loadElizaConfig().agents?.list?.[0]?.identityName).toBe("Eliza");
    expect(new AgentRuntime({ character: rebuilt }).agentId).toBe(
      runtime.agentId,
    );
    // A backup restore validates the character, which moves unknown settings
    // keys into settings.extra; the identity name must survive that.
    const restored = parseAndValidateCharacter(JSON.stringify(rebuilt));
    expect(restored.success).toBe(true);
    expect(agentIdentityName(restored.data ?? {})).toBe("Eliza");
    expect(restored.data?.id).toBe(runtime.agentId);

    // A second rename does not move the identity name.
    await handleCharacterRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "PUT",
      pathname: "/api/character",
      state,
      readJsonBody: async <T extends object>() =>
        ({ name: "Orion" }) as unknown as T,
      json: () => {},
      error: (_res, message) => {
        throw new Error(message);
      },
      pickRandomNames: () => [],
      saveConfig: saveElizaConfig,
      validateCharacter: (body) => CharacterSchema.safeParse(body),
    });
    expect(loadElizaConfig().agents?.list?.[0]?.identityName).toBe("Eliza");

    // A restored agent runs on the validated character, and its config can
    // have no identityName yet. A rename must still save the identity name.
    runtime.character.settings = restored.data?.settings;
    saveElizaConfig({
      agents: { list: [{ id: "main", default: true, name: "Orion" }] },
    });
    await handleCharacterRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method: "PUT",
      pathname: "/api/character",
      state: { ...state, config: loadElizaConfig() },
      readJsonBody: async <T extends object>() =>
        ({ name: "Vega" }) as unknown as T,
      json: () => {},
      error: (_res, message) => {
        throw new Error(message);
      },
      pickRandomNames: () => [],
      saveConfig: saveElizaConfig,
      validateCharacter: (body) => CharacterSchema.safeParse(body),
    });
    expect(loadElizaConfig().agents?.list?.[0]).toMatchObject({
      name: "Vega",
      identityName: "Eliza",
    });
    expect(
      new AgentRuntime({
        character: buildCharacterFromConfig(loadElizaConfig()),
      }).agentId,
    ).toBe(runtime.agentId);
  } finally {
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("trims a stored identity name, in settings and in settings.extra", () => {
  expect(
    agentIdentityName({ name: "Nova", settings: { identityName: " Eliza " } }),
  ).toBe("Eliza");
  expect(
    agentIdentityName({
      name: "Nova",
      settings: { extra: { identityName: "Eliza\t" } },
    }),
  ).toBe("Eliza");
  // A blank stored value is not an identity name.
  expect(
    agentIdentityName({ name: "Nova", settings: { identityName: "  " } }),
  ).toBe("Nova");
});

it("refuses a character save while the agent is stopped instead of reporting it saved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "character-stopped-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  saveElizaConfig({
    ui: { assistant: { name: "Eliza" } },
    agents: { list: [{ id: "main", default: true, name: "Eliza" }] },
  });
  try {
    // POST /api/agent/stop leaves the route state without a runtime.
    const state = {
      runtime: null,
      agentName: "Eliza",
      config: loadElizaConfig(),
    };
    const replies: Array<{ status: number; message?: string }> = [];
    for (const method of ["PUT", "GET"]) {
      await handleCharacterRoutes({
        req: {} as http.IncomingMessage,
        res: {} as http.ServerResponse,
        method,
        pathname: "/api/character",
        state,
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
    }

    expect(replies.map((reply) => reply.status)).toEqual([503, 503]);
    expect(state.agentName).toBe("Eliza");
    expect(buildCharacterFromConfig(loadElizaConfig()).name).toBe("Eliza");
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
