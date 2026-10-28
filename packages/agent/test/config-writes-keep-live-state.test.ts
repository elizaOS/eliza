/**
 * Routes that write eliza.json straight from disk (load → modify → save) must
 * also update the live server config. Other routes persist by saving the whole
 * in-memory `state.config`, so a disk-only write is erased by the next such
 * save. Drives the real custom-action and database-config handlers over HTTP
 * against a temp config file, then performs the full save those other routes do.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CustomActionDef } from "@elizaos/contracts";
import { readJsonBody, sendJson, sendJsonError } from "@elizaos/host";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settingsAction } from "../src/actions/settings-actions.ts";
import { setLiveElizaConfigSource } from "../src/api/config-state.ts";
import { handleDatabaseRoute } from "../src/api/database.ts";
import {
  handleMiscRoutes,
  type MiscRouteContext,
} from "../src/api/misc-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { ElizaCharacterPersistenceService } from "../src/services/character-persistence.ts";

let dir: string;
let server: http.Server;
let baseUrl: string;
let state: { config: ElizaConfig };

function storedAction(
  overrides: Partial<CustomActionDef> = {},
): CustomActionDef {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: "PING_STATUS",
    description: "Ping the status page",
    similes: [],
    parameters: [],
    handler: { type: "http", method: "GET", url: "https://example.com/" },
    enabled: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function startServer(seed: ElizaConfig): Promise<void> {
  saveElizaConfig(seed);
  state = { config: loadElizaConfig() };
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const route = url.pathname.startsWith("/api/database/")
      ? handleDatabaseRoute(req, res, null, url.pathname, state.config)
      : handleMiscRoutes({
          req,
          res,
          method,
          pathname: url.pathname,
          url,
          state: state as unknown as MiscRouteContext["state"],
          json: sendJson,
          error: sendJsonError,
          readJsonBody,
          // The caller here is an authorized terminal client.
          resolveTerminalRunRejection: () => null,
        } as unknown as MiscRouteContext);
    void route.then((handled) => {
      if (!handled) sendJsonError(res, "not found", 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function send(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** What PUT /api/permissions/automation-mode and similar routes do. */
function fullSaveOfLiveConfig(): void {
  saveElizaConfig(state.config);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "config-live-state-"));
  const configPath = path.join(dir, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
});

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it("keeps a created custom action on disk after a full save of the live config", async () => {
  await startServer({});
  const created = await send("POST", "/api/custom-actions", {
    name: "check weather",
    description: "Look up the weather",
    handler: { type: "http", method: "GET", url: "https://example.com/w" },
    enabled: false,
  });
  expect(created.status).toBe(200);
  const id = (created.body.action as CustomActionDef).id;

  fullSaveOfLiveConfig();

  expect(loadElizaConfig().customActions?.map((a) => a.id)).toEqual([id]);
  const listed = await send("GET", "/api/custom-actions");
  expect((listed.body.actions as CustomActionDef[]).map((a) => a.id)).toEqual([
    id,
  ]);
});

it("keeps a deleted shell custom action deleted after a full save of the live config", async () => {
  const shellAction = storedAction({
    name: "WIPE_CACHE",
    handler: { type: "shell", command: "rm -rf ./cache" },
  });
  const kept = storedAction();
  await startServer({ customActions: [shellAction, kept] });

  const deleted = await send("DELETE", `/api/custom-actions/${shellAction.id}`);
  expect(deleted.status).toBe(200);

  fullSaveOfLiveConfig();

  expect(loadElizaConfig().customActions?.map((a) => a.id)).toEqual([kept.id]);
});

it("keeps an edited custom action after a full save of the live config", async () => {
  const action = storedAction();
  await startServer({ customActions: [action] });

  const edited = await send("PUT", `/api/custom-actions/${action.id}`, {
    description: "Ping the new status page",
    handler: { type: "http", method: "GET", url: "https://example.org/" },
  });
  expect(edited.status).toBe(200);

  fullSaveOfLiveConfig();

  const onDisk = loadElizaConfig().customActions ?? [];
  expect(onDisk).toHaveLength(1);
  expect(onDisk[0]?.description).toBe("Ping the new status page");
  expect(onDisk[0]?.handler).toEqual({
    type: "http",
    method: "GET",
    url: "https://example.org/",
  });
});

it("keeps a saved database provider after a full save of the live config", async () => {
  await startServer({
    database: {
      provider: "postgres",
      postgres: { host: "127.0.0.1", port: 5432, database: "agent" },
    },
  });

  const saved = await send("PUT", "/api/database/config", {
    provider: "pglite",
  });
  expect(saved.status).toBe(200);
  expect(saved.body.saved).toBe(true);

  fullSaveOfLiveConfig();

  expect(loadElizaConfig().database?.provider).toBe("pglite");
  expect(state.config.database?.provider).toBe("pglite");
});

it("keeps chat setting changes and character edits after a full save of the live config", async () => {
  await startServer({
    agents: {
      list: [{ id: "main", default: true, name: "Ava", bio: ["old bio"] }],
    },
  } as ElizaConfig);
  // startApiServer registers its in-memory config the same way.
  const release = setLiveElizaConfigSource(() => state.config);
  try {
    const runtime = {
      agentId: randomUUID(),
      character: { name: "Ava", bio: ["new bio from chat"], settings: {} },
      updateAgent: async () => true,
      reportError: () => {},
    } as never;
    const run = (parameters: Record<string, unknown>) =>
      settingsAction.handler?.(
        runtime,
        { entityId: randomUUID() } as never,
        undefined,
        { parameters } as never,
        undefined,
      );
    await run({
      action: "toggle_capability",
      capability: "browser",
      enabled: false,
    });
    await run({ action: "set_owner_name", name: "Dana" });
    await run({
      action: "update_ai_provider",
      provider: "anthropic",
      modelConfigs: { large: "claude-test-large" },
    });
    const persistence = new (
      ElizaCharacterPersistenceService as unknown as new (
        runtime: unknown,
      ) => ElizaCharacterPersistenceService
    )(runtime);
    (persistence as unknown as { runtime: unknown }).runtime = runtime;
    await persistence.persistCharacter({ source: "agent" } as never);

    fullSaveOfLiveConfig();

    const saved = loadElizaConfig() as ElizaConfig & {
      ui?: { capabilities?: Record<string, boolean>; ownerName?: string };
    };
    expect(saved.ui?.capabilities?.browser).toBe(false);
    expect(saved.ui?.ownerName).toBe("Dana");
    expect(saved.models?.large).toBe("claude-test-large");
    expect(saved.agents?.list?.[0]?.bio).toEqual(["new bio from chat"]);
  } finally {
    release();
  }
});
