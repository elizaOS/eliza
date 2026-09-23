/** Exercises actual plugin resolution with SQLite and rejects PostgreSQL preflight before effects. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, type Plugin, type UUID } from "@elizaos/core";
import { plugin as sqlitePlugin } from "@elizaos/plugin-sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  CORE_PLUGINS,
  MOBILE_VIEW_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.ts";
import { SQL_PLUGIN, SQLITE_PLUGIN } from "./database-selection.ts";
import { resolvePlugins } from "./plugin-resolver.ts";
import { STATIC_ELIZA_PLUGINS } from "./plugin-types.ts";

const seeded: string[] = [];
function register(name: string, plugin: Plugin) {
  STATIC_ELIZA_PLUGINS[name] = { default: plugin };
  seeded.push(name);
}
function config(allow: string[]): ElizaConfig {
  return {
    plugins: {
      allow,
      deny: [
        ...CORE_PLUGINS,
        ...MOBILE_VIEW_PLUGINS,
        ...OPTIONAL_CORE_PLUGINS,
        "@elizaos/plugin-workflow",
      ].filter((name) => !allow.includes(name)),
    },
  };
}
afterEach(() => {
  for (const name of seeded.splice(0)) delete STATIC_ELIZA_PLUGINS[name];
  vi.unstubAllEnvs();
});

it("replaces SQL bootstrap with an actual durable SQLite adapter without activating SQL", async () => {
  vi.stubEnv("ELIZA_DATABASE_PROVIDER", "sqlite");
  vi.stubEnv("ELIZA_PLUGIN_SET", "lean-chat");
  const directory = await mkdtemp(join(tmpdir(), "agent-sqlite-selection-"));
  register(SQLITE_PLUGIN, sqlitePlugin);
  let sqlActivated = false;
  register(SQL_PLUGIN, {
    name: SQL_PLUGIN,
    description: "activation sentinel",
    preflight: () => {
      sqlActivated = true;
      throw new Error("SQL must not activate");
    },
  });
  const resolved = await resolvePlugins(config([SQL_PLUGIN]), { quiet: true });
  expect(resolved.map((entry) => entry.name)).toContain(SQLITE_PLUGIN);
  expect(resolved.map((entry) => entry.name)).not.toContain(SQL_PLUGIN);
  expect(sqlActivated).toBe(false);
  const selected = resolved.find((entry) => entry.name === SQLITE_PLUGIN);
  if (!selected) throw new Error("SQLite bootstrap missing");
  const runtime = new AgentRuntime({
    character: {
      id: randomUUID() as UUID,
      name: "SQLite selection",
      bio: [],
      settings: { SQLITE_DATABASE_PATH: join(directory, "state.sqlite") },
    },
    plugins: [selected.plugin],
  });
  try {
    await runtime.initialize();
    await runtime.adapter.setCaches([{ key: "selected", value: true }]);
    expect(
      (await runtime.adapter.getCaches(["selected"])).get("selected"),
    ).toBe(true);
  } finally {
    await runtime.stop();
    await runtime.adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a PostgreSQL-dependent optional plugin before its preflight", async () => {
  vi.stubEnv("ELIZA_DATABASE_PROVIDER", "sqlite");

  const name = "@synthetic/plugin-postgres-dependent";
  let activated = false;
  register(name, {
    name,
    description: "explicit SQL dependency",
    actions: [],
    dependencies: [SQL_PLUGIN],
    preflight: () => {
      activated = true;
    },
  });
  await expect(
    resolvePlugins(config([name]), { quiet: true }),
  ).rejects.toMatchObject({ code: "SQLITE_PLUGIN_INCOMPATIBLE" });
  expect(activated).toBe(false);
});

it("rejects an explicit SQLite plugin without the host database selection", async () => {
  vi.stubEnv("ELIZA_DATABASE_PROVIDER", undefined);
  register(SQLITE_PLUGIN, sqlitePlugin);
  await expect(
    resolvePlugins(config([SQLITE_PLUGIN]), { quiet: true }),
  ).rejects.toMatchObject({ code: "SQLITE_SELECTION_REQUIRED" });
});

it("prepares explicitly ported plugins without passing PostgreSQL schema metadata to SQLite", async () => {
  vi.stubEnv("ELIZA_DATABASE_PROVIDER", "sqlite");
  const name = "@synthetic/plugin-ported-storage";
  const original: Plugin = {
    name,
    description: "Native storage port admission",
    actions: [],
    databaseBackends: ["postgres", "sqlite"],
    dependencies: [SQL_PLUGIN],
    schema: { syntheticPostgresTable: {} },
  };
  register(name, original);
  const resolved = await resolvePlugins(config([name]), { quiet: true });
  const selected = resolved.find((entry) => entry.name === name);
  expect(selected?.plugin.dependencies).toEqual([SQLITE_PLUGIN]);
  expect(selected?.plugin.schema).toBeUndefined();
  expect(original.dependencies).toEqual([SQL_PLUGIN]);
  expect(original.schema).toBeDefined();
});
