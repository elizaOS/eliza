/**
 * A character edit that clears the topics list must still be cleared after a
 * restart. PUT /api/character saves `topics: []` to the config, and boot
 * rebuilds the character from that config; an empty list must not be read as
 * "no topics saved" and refilled from the bundled preset, the way the cleared
 * bio, adjectives and examples already stay cleared. Real PGlite runtime and
 * the real agent HTTP server, restarted on the same database and config.
 * The config carries the avatar the character editor saves with every edit,
 * which resolves a bundled preset at boot.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import { loadElizaConfig } from "../src/config/config.ts";
import { buildCharacterFromConfig } from "../src/runtime/build-character-config.ts";

type CharacterView = { topics?: string[]; adjectives?: string[] };

it("keeps a cleared topics list cleared after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-cleared-topics-"));
  const configPath = join(directory, "config.json");
  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  });
  await writeFile(
    configPath,
    JSON.stringify({
      // The character editor saves the picked avatar beside the character.
      ui: { avatarIndex: 1 },
      agents: { list: [{ id: "main", default: true, name: "Nova" }] },
    }),
  );
  const boot = async () => {
    const fixture = await createTestRuntime({
      characterName: "Nova",
      settings: { BASIC_CAPABILITIES_DEFLLMOFF: true },
      pgliteDir: join(directory, "pglite"),
      // Boot builds the character from the saved config, as startEliza does.
      configureRuntime: (runtime) => {
        Object.assign(
          runtime.character,
          buildCharacterFromConfig(loadElizaConfig()),
        );
      },
    });
    const server = await startApiServer({
      port: 0,
      runtime: fixture.runtime,
      skipDeferredStartupWork: true,
    });
    const call = async (method: string, body?: unknown) => {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/character`,
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return {
        status: response.status,
        body: (await response.json()) as { character: CharacterView },
      };
    };
    return { fixture, server, call };
  };

  let live: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    live = await boot();
    // The fresh agent starts with the default preset's topics.
    const initial = (await live.call("GET")).body.character;
    expect(initial.topics?.length).toBeGreaterThan(0);

    // The owner clears the topics (and the adjectives) and saves.
    const saved = await live.call("PUT", {
      name: "Nova",
      topics: [],
      adjectives: [],
    });
    expect(saved.status).toBe(200);
    const edited = (await live.call("GET")).body.character;
    expect(edited.topics).toEqual([]);
    expect(edited.adjectives).toEqual([]);

    await live.server.close();
    await live.fixture.cleanup();
    live = undefined;

    // Restart on the same database and config.
    live = await boot();
    const restarted = (await live.call("GET")).body.character;
    expect(restarted.adjectives).toEqual([]);
    expect(restarted.topics).toEqual([]);
  } finally {
    await live?.server.close();
    await live?.fixture.cleanup();
    process.env = previousEnv;
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
