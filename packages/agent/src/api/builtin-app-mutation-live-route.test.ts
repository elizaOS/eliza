/**
 * Proves My Apps semantic twins against a real AgentRuntime and TCP API host:
 * APP stop moves a real AppManager run out of inventory, and VIEWS show
 * resolves the hidden Cloud Apps shell page from the server view registry.
 * No action, route, runtime, or service is mocked.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Action,
  type ActionResult,
  AgentRuntime,
  type Memory,
  type UUID,
} from "@elizaos/core";
import {
  appControlPlugin,
  createAppControlClient,
} from "@elizaos/plugin-app-control";
import { afterEach, describe, expect, it } from "vitest";
import { startApiServer } from "./server.ts";

const TEST_APP = "ratchet-proof";
const TEST_PLUGIN = "@test/ratchet-proof";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const originalEnv = new Map<string, string | undefined>();
const touchedEnv = [
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_STATE_DIR",
  "ELIZA_WORKSPACE_ROOT",
] as const;

function snapshotEnvironment(): void {
  originalEnv.clear();
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
}

function restoreEnvironment(): void {
  for (const key of touchedEnv) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  originalEnv.clear();
}

function requireAction(runtime: AgentRuntime, name: string): Action {
  const action = runtime.actions.find((candidate) => candidate.name === name);
  if (!action) throw new Error(`Expected runtime action ${name}`);
  return action;
}

async function invokeAppStop(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<ActionResult> {
  const message = {
    id: randomUUID(),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId,
    content: { text: "stop the ratchet proof app" },
  } as Memory;
  const result = await requireAction(runtime, "APP").handler(
    runtime,
    message,
    undefined,
    { parameters: { action: "stop", app: TEST_APP } },
    undefined,
  );
  if (!result) throw new Error("APP returned no action result");
  return result;
}

async function invokeCloudAppsShow(
  runtime: AgentRuntime,
  roomId: UUID,
): Promise<ActionResult> {
  const message = {
    id: randomUUID(),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId,
    content: { text: "Open the requested deployment studio." },
  } as Memory;
  const result = await requireAction(runtime, "VIEWS").handler(
    runtime,
    message,
    undefined,
    { parameters: { action: "show", view: "cloud-apps" } },
    undefined,
  );
  if (!result) throw new Error("VIEWS returned no action result");
  return result;
}

async function seedInstalledApp(root: string): Promise<void> {
  const stateDir = path.join(root, "state");
  const cacheDir = path.join(stateDir, "cache");
  await mkdir(cacheDir, { recursive: true });

  const configPath = path.join(stateDir, "eliza.json");
  await writeFile(
    configPath,
    JSON.stringify({
      logging: { level: "error" },
      plugins: {
        installs: {
          [TEST_PLUGIN]: {
            source: "npm",
            spec: `${TEST_PLUGIN}@1.0.0`,
            version: "1.0.0",
            installedAt: "2026-07-23T00:00:00.000Z",
          },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(cacheDir, "registry.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      plugins: [
        [
          TEST_APP,
          {
            name: TEST_APP,
            gitRepo: "test/ratchet-proof",
            gitUrl: "https://example.test/ratchet-proof.git",
            directory: null,
            description: "Real APP stop route fixture.",
            homepage: "https://example.test/ratchet-proof",
            topics: ["app", "test"],
            stars: 0,
            language: "TypeScript",
            npm: {
              package: TEST_PLUGIN,
              v0Version: null,
              v1Version: null,
              v2Version: "1.0.0",
            },
            git: {
              v0Branch: null,
              v1Branch: null,
              v2Branch: "main",
            },
            supports: { v0: false, v1: false, v2: true },
            kind: "app",
            appMeta: {
              displayName: "Ratchet Proof",
              category: "tool",
              launchType: "connect",
              launchUrl: "https://example.test/ratchet-proof",
              icon: null,
              heroImage: null,
              capabilities: [],
              minPlayers: null,
              maxPlayers: null,
            },
          },
        ],
      ],
    }),
    "utf8",
  );

  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = "ratchet-live-route-token";
  process.env.ELIZA_WORKSPACE_ROOT = path.resolve(
    import.meta.dirname,
    "../../../..",
  );
  delete process.env.ELIZA_API_AUTH_TOKEN;
}

afterEach(restoreEnvironment);

describe("My Apps semantic route parity (#16944)", () => {
  it("stops a real app run and resolves Cloud Apps through VIEWS.show", async () => {
    snapshotEnvironment();
    const root = await mkdtemp(path.join(tmpdir(), "eliza-app-stop-ratchet-"));
    let runtime: AgentRuntime | null = null;
    let api: ApiServer | null = null;
    try {
      await seedInstalledApp(root);
      runtime = new AgentRuntime({
        logLevel: "fatal",
        plugins: [appControlPlugin],
      });
      await runtime.initialize({
        allowNoDatabase: true,
        skipMigrations: true,
      });
      await runtime.getServiceLoadPromise("app-registry");
      await runtime.getServiceLoadPromise("app-worker-host");

      api = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      process.env.ELIZA_PORT = String(api.port);
      process.env.ELIZA_API_PORT = String(api.port);

      const client = createAppControlClient();
      const shown = await invokeCloudAppsShow(runtime, randomUUID() as UUID);
      expect(shown).toEqual(
        expect.objectContaining({
          success: true,
          values: expect.objectContaining({
            mode: "show",
            viewId: "cloud-apps",
            label: "Cloud Apps",
          }),
          data: expect.objectContaining({
            view: expect.objectContaining({
              id: "cloud-apps",
              path: "/cloud-apps",
              visibleInManager: false,
            }),
          }),
        }),
      );
      const currentViewResponse = await fetch(
        `http://127.0.0.1:${api.port}/api/views/current`,
        {
          headers: {
            Authorization: "Bearer ratchet-live-route-token",
          },
        },
      );
      expect(currentViewResponse.ok).toBe(true);
      await expect(currentViewResponse.json()).resolves.toEqual(
        expect.objectContaining({
          currentView: expect.objectContaining({
            viewId: "cloud-apps",
            viewPath: "/cloud-apps",
          }),
        }),
      );

      const launched = await client.launchApp(TEST_APP);
      expect(launched.run).toEqual(
        expect.objectContaining({
          appName: TEST_APP,
          status: "running",
        }),
      );
      await expect(client.listAppRuns()).resolves.toEqual([
        expect.objectContaining({
          appName: TEST_APP,
          status: "running",
        }),
      ]);

      const stopped = await invokeAppStop(runtime, randomUUID() as UUID);
      expect(stopped).toEqual(
        expect.objectContaining({
          success: true,
          values: expect.objectContaining({
            mode: "stop",
            appName: TEST_APP,
            stopScope: "viewer-session",
          }),
        }),
      );
      await expect(client.listAppRuns()).resolves.toEqual([]);

      const alreadyStopped = await invokeAppStop(runtime, randomUUID() as UUID);
      expect(alreadyStopped).toEqual(
        expect.objectContaining({
          success: false,
          values: expect.objectContaining({
            mode: "stop",
            appName: TEST_APP,
            stopScope: "nothing-stopped",
          }),
        }),
      );
      await expect(client.listAppRuns()).resolves.toEqual([]);
    } finally {
      if (api) await api.close();
      if (runtime) {
        await runtime.stop({ fast: true });
        await runtime.close();
      }
      // The stopped runtime can still be flushing state files; retry the
      // teardown instead of failing the suite on a transient ENOTEMPTY.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 120_000);
});
