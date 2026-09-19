/** Exercises owner and non-owner app mutations through real TCP, PGlite sessions, and the installed host bridge. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startApiServer } from "@elizaos/agent/api/server";
import { _resetAgentHostBridge } from "@elizaos/agent/runtime/host-bridge";
import { AgentRuntime, type IDatabaseAdapter } from "@elizaos/core";
import { appControlPlugin } from "@elizaos/plugin-app-control";
import {
  createDatabaseAdapter,
  DatabaseMigrationService,
  type DrizzleDatabase as SqlDrizzleDatabase,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import {
  AppLaunchResultSchema,
  AppStopResultSchema,
} from "@elizaos/shared/contracts/apps";
import { describe, expect, it } from "vitest";
import {
  CSRF_HEADER_NAME,
  createBrowserSession,
  createMachineSession,
  SESSION_COOKIE_NAME,
} from "../api/auth/sessions";
import { AuthStore, type DrizzleDatabase } from "../services/auth-store";
import { installAgentHostBridge } from "./install-agent-host-bridge";

const TEST_APP = "guard-proof";
const TEST_PLUGIN = "@test/guard-proof";
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
            gitRepo: "test/guard-proof",
            gitUrl: "https://example.test/guard-proof.git",
            directory: null,
            description: "Real APP stop route fixture.",
            homepage: "https://example.test/guard-proof",
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
              displayName: "Guard Proof",
              category: "tool",
              launchType: "connect",
              launchUrl: "https://example.test/guard-proof",
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
  process.env.ELIZA_API_TOKEN = "guard-live-route-token";
  process.env.ELIZA_WORKSPACE_ROOT = path.resolve(
    import.meta.dirname,
    "../../../..",
  );
  delete process.env.ELIZA_API_AUTH_TOKEN;
}

describe("App mutations through authenticated host sessions", () => {
  it("preserves owner sessions while denying non-owner and missing sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "app-session-transport-"));
    const touched = [
      "ELIZA_STATE_DIR",
      "ELIZA_CONFIG_PATH",
      "ELIZA_PERSIST_CONFIG_PATH",
      "ELIZA_API_BIND_HOST",
      "ELIZA_API_TOKEN",
      "ELIZA_API_AUTH_TOKEN",
      "ELIZA_WORKSPACE_ROOT",
      "ELIZA_CLOUD_PROVISIONED",
      "ELIZA_REQUIRE_LOCAL_AUTH",
      "AGENT_SERVER_SHARED_SECRET",
      "ELIZA_ALLOWED_ORIGINS",
    ];
    const before = new Map(touched.map((key) => [key, process.env[key]]));
    let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
    let runtime: AgentRuntime | undefined;
    let adapter: IDatabaseAdapter | undefined;
    const observations: Record<string, unknown>[] = [];
    try {
      await seedInstalledApp(root);
      process.env.ELIZA_CLOUD_PROVISIONED = "1";
      process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
      delete process.env.AGENT_SERVER_SHARED_SECRET;
      delete process.env.ELIZA_ALLOWED_ORIGINS;
      const agentId = randomUUID();
      adapter = createDatabaseAdapter(
        { dataDir: path.join(root, "pglite") },
        agentId,
      );
      if (!adapter) throw new Error("missing database adapter");
      if (!("init" in adapter) || typeof adapter.init !== "function") {
        throw new Error("PGlite adapter has no initializer");
      }
      await adapter.init();
      const migrations = new DatabaseMigrationService();
      const db = adapter.db as SqlDrizzleDatabase;
      await migrations.initializeWithDatabase(db);
      migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
      await migrations.runAllPluginMigrations();
      const store = new AuthStore(db as DrizzleDatabase);
      await store.createIdentity({
        id: "owner",
        kind: "owner",
        displayName: "Owner",
        createdAt: Date.now(),
        passwordHash: null,
      });
      await store.createIdentity({
        id: "machine",
        kind: "machine",
        displayName: "Machine",
        createdAt: Date.now(),
        passwordHash: null,
      });
      const owner = await createBrowserSession(store, {
        identityId: "owner",
        ip: null,
        userAgent: null,
        rememberDevice: false,
      });
      const ownerMachine = await createMachineSession(store, {
        identityId: "owner",
        scopes: [],
      });
      const guest = await createMachineSession(store, {
        identityId: "machine",
        scopes: [],
      });
      runtime = new AgentRuntime({
        agentId,
        logLevel: "fatal",
        adapter,
        plugins: [appControlPlugin],
      });
      await runtime.initialize({ skipMigrations: true });
      expect(runtime.adapter).toBe(adapter);
      await runtime.getServiceLoadPromise("app-registry");
      await runtime.getServiceLoadPromise("app-worker-host");
      installAgentHostBridge();
      api = await startApiServer({
        port: 0,
        runtime,
        skipDeferredStartupWork: true,
      });
      const base = `http://127.0.0.1:${api.port}`;
      const staticHeaders = { authorization: "Bearer guard-live-route-token" };
      async function request(
        label: string,
        method: string,
        route: string,
        headers: Record<string, string>,
        body?: unknown,
      ) {
        const response = await fetch(base + route, {
          method,
          headers: { ...headers, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const payload: unknown = await response.json();
        observations.push({
          label,
          method,
          route,
          status: response.status,
          payload,
        });
        return { status: response.status, payload };
      }
      const launched = await request(
        "static-owner-launch-control",
        "POST",
        "/api/apps/launch",
        staticHeaders,
        { name: TEST_APP },
      );
      expect(launched.status).toBe(200);
      const launchedApp = AppLaunchResultSchema.parse(launched.payload);
      expect(launchedApp.run?.status).toBe("running");
      if (!launchedApp.run) throw new Error("App did not create a run");
      const runId = launchedApp.run.runId;
      const ownerHeaders = {
        cookie: `${SESSION_COOKIE_NAME}=${owner.session.id}`,
        [CSRF_HEADER_NAME]: owner.csrfToken,
      };
      const ownerBearer = {
        authorization: `Bearer ${ownerMachine.session.id}`,
      };
      const guestHeaders = { authorization: `Bearer ${guest.session.id}` };
      expect(
        (
          await request(
            "owner-cookie-read",
            "GET",
            "/api/apps/runs",
            ownerHeaders,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            "owner-bearer-read",
            "GET",
            "/api/apps/runs",
            ownerBearer,
          )
        ).status,
      ).toBe(200);
      expect(
        (await request("machine-read", "GET", "/api/apps/runs", guestHeaders))
          .status,
      ).toBe(200);
      const missing = await request(
        "missing-session-stop",
        "POST",
        "/api/apps/stop",
        {},
        { name: TEST_APP, runId },
      );
      const denied = await request(
        "machine-stop",
        "POST",
        "/api/apps/stop",
        guestHeaders,
        { name: TEST_APP, runId },
      );
      const claimedOwnerHeaders = {
        "x-actor-role": "OWNER",
        "x-eliza-role": "OWNER",
        "x-user-role": "ADMIN",
      };
      const forgedSession = await request(
        "forged-owner-cookie-stop",
        "POST",
        "/api/apps/stop",
        {
          ...claimedOwnerHeaders,
          cookie: `${SESSION_COOKIE_NAME}=owner; actorRole=OWNER`,
          [CSRF_HEADER_NAME]: owner.csrfToken,
        },
        { name: TEST_APP, runId, actorRole: "OWNER" },
      );
      const forgedMachineRole = await request(
        "machine-claimed-owner-stop",
        "POST",
        "/api/apps/stop",
        { ...guestHeaders, ...claimedOwnerHeaders, cookie: "actorRole=OWNER" },
        { name: TEST_APP, runId, actorRole: "OWNER" },
      );
      expect(forgedSession.status).toBe(401);
      expect(forgedMachineRole.status).toBe(403);
      const beforeOwner = await request(
        "inventory-after-denied-stops",
        "GET",
        "/api/apps/runs",
        staticHeaders,
      );
      expect(beforeOwner.payload).toEqual([
        expect.objectContaining({ runId, status: "running" }),
      ]);
      const ownerResult = await request(
        "owner-cookie-stop",
        "POST",
        "/api/apps/stop",
        ownerHeaders,
        { name: TEST_APP, runId },
      );
      const afterOwnerCookie = await request(
        "inventory-after-owner-cookie-stop",
        "GET",
        "/api/apps/runs",
        staticHeaders,
      );
      const relaunched = await request(
        "static-owner-relaunch-control",
        "POST",
        "/api/apps/launch",
        staticHeaders,
        { name: TEST_APP },
      );
      expect(relaunched.status).toBe(200);
      const relaunchedApp = AppLaunchResultSchema.parse(relaunched.payload);
      if (!relaunchedApp.run)
        throw new Error("App did not create a second run");
      const ownerBearerResult = await request(
        "owner-bearer-stop",
        "POST",
        "/api/apps/stop",
        ownerBearer,
        { name: TEST_APP, runId: relaunchedApp.run.runId },
      );
      const afterOwnerBearer = await request(
        "inventory-after-owner-bearer-stop",
        "GET",
        "/api/apps/runs",
        staticHeaders,
      );
      const evidencePath = process.env.ELIZA_APP_SESSION_EVIDENCE_PATH;
      if (evidencePath)
        await writeFile(
          evidencePath,
          JSON.stringify({ observations }, null, 2),
        );
      expect(missing.status).toBe(401);
      expect(denied.status).toBe(403);
      expect(AppStopResultSchema.parse(ownerResult.payload).success).toBe(true);
      expect(afterOwnerCookie.payload).toEqual([]);
      expect(AppStopResultSchema.parse(ownerBearerResult.payload).success).toBe(
        true,
      );
      expect(afterOwnerBearer.payload).toEqual([]);
      expect(ownerResult.status).toBe(200);
      expect(ownerBearerResult.status).toBe(200);
    } finally {
      await api?.close();
      _resetAgentHostBridge();
      await runtime?.stop();
      await adapter?.close();
      await rm(root, { recursive: true, force: true });
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 120_000);
});
