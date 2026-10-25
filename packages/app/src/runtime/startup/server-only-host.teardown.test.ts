import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  closeRuntimeAdapter,
  ensureTrajectoriesTable,
  reopenRuntimeAdapter,
  shutdownRuntime,
} from "@elizaos/agent";
import { AgentRuntime, Service } from "@elizaos/core";
import { installHttpPluginLifecycle } from "@elizaos/host/protocol";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { afterEach, expect, it, vi } from "vitest";
import { hashPassword } from "../../api/auth/passwords.js";
import {
  createBrowserSession,
  deriveCsrfToken,
} from "../../api/auth/sessions.js";
import { authStoreForRuntime } from "../../services/auth-store.js";
import { installAgentHostBridge } from "../install-agent-host-bridge.js";
import type { ServerOnlyHost } from "../server-only-process.js";
import { startServerOnlyHost } from "./server-only-host.js";

/** Holds runtime teardown open so a signal can arrive while it runs. */
class SlowStopService extends Service {
  static serviceType = "server_only_teardown_slow_stop";
  capabilityDescription = "Stops after a delay";
  static async start(runtime: AgentRuntime) {
    return new SlowStopService(runtime);
  }
  async stop() {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function startHost(options?: {
  holdReplacementBoot?: Promise<void>;
  failReplacementBootOnce?: boolean;
}) {
  const dir = await mkdtemp(path.join(tmpdir(), "server-only-teardown-"));
  dirs.push(dir);
  const configPath = path.join(dir, "eliza.json");
  await writeFile(
    configPath,
    JSON.stringify({ agents: { list: [{ id: "main", name: "Eliza" }] } }),
  );
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  // A provider key skips the fresh-install boot deferral.
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-used");
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  vi.stubEnv("ELIZA_API_PORT", String(port));
  const runtimes: AgentRuntime[] = [];
  const adapterCloses: number[] = [];
  let replacementBootEntered: () => void = () => {};
  const replacementBootStarted = new Promise<void>((resolve) => {
    replacementBootEntered = resolve;
  });
  let replacementFailureUsed = false;
  let host: ServerOnlyHost | undefined;
  await startServerOnlyHost({
    options: {
      onServerOnlyHostReady: (ready) => {
        host = ready;
      },
    },
    bootRuntime: async () => {
      const index = runtimes.length;
      if (index > 0) {
        replacementBootEntered();
        await options?.holdReplacementBoot;
        if (options?.failReplacementBootOnce && !replacementFailureUsed) {
          replacementFailureUsed = true;
          throw new Error("forced replacement boot failure");
        }
      }
      const runtime = new AgentRuntime({
        character: { name: "Eliza", bio: ["test"] },
        plugins: [],
        logLevel: "fatal",
      });
      runtime.setSetting("PGLITE_DATA_DIR", path.join(dir, "pg"));
      runtime.setSetting("POSTGRES_URL", "");
      installHttpPluginLifecycle(runtime);
      await runtime.registerPlugin(sqlPlugin);
      await runtime.registerPlugin({
        name: "server-only-teardown-slow-stop",
        description: "Holds teardown open",
        services: [SlowStopService as never],
      });
      await runtime.initialize();
      await ensureTrajectoriesTable(runtime);
      const adapter = runtime.adapter as { close: () => Promise<void> };
      const close = adapter.close.bind(adapter);
      adapterCloses[index] = 0;
      adapter.close = async () => {
        adapterCloses[index] += 1;
        await close();
      };
      runtimes.push(runtime);
      return runtime;
    },
    stopRuntime: (runtime, reason, options) =>
      shutdownRuntime(runtime, reason, options),
    closeRuntimeAdapter,
    reopenRuntimeAdapter,
    stopWithoutRuntime: () => {},
  });
  if (!host) throw new Error("server-only host did not start");
  const post = (action: "restart" | "stop") =>
    fetch(`http://127.0.0.1:${port}/api/agent/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => undefined);
  return {
    host,
    port,
    post,
    runtimes,
    adapterCloses,
    replacementBootStarted,
  };
}

it.each(["stop", "restart"] as const)(
  "closes the original adapter once when a signal arrives during an API %s",
  async (action) => {
    const { host, post, runtimes, adapterCloses } = await startHost();
    const request = post(action);
    // The teardown is now inside the slow service stop.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await host.close();
    // The signal path returned only after the original adapter closed.
    expect(adapterCloses[0]).toBe(1);
    await request;
    for (const runtime of runtimes.slice(1)) {
      await shutdownRuntime(runtime, "server-only teardown test cleanup", {
        fast: true,
      });
    }
    expect(adapterCloses[0]).toBe(1);
  },
  60_000,
);

it("waits for a replacement boot that is still running when the signal arrives", async () => {
  let releaseBoot: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseBoot = resolve;
  });
  const { host, post, runtimes, adapterCloses, replacementBootStarted } =
    await startHost({ holdReplacementBoot: hold });
  const request = post("restart");
  // The old runtime is torn down and the replacement boot is held open.
  await replacementBootStarted;
  expect(adapterCloses[0]).toBe(1);
  let closed = false;
  const closing = host.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(closed).toBe(false);
  releaseBoot();
  await closing;
  // close() returned only after the replacement booted and was stopped.
  expect(runtimes).toHaveLength(2);
  expect(adapterCloses).toEqual([1, 1]);
  await request;
}, 60_000);

it("keeps stopped owner sessions isolated between hosts and can start the agent again", async () => {
  // Treat the loopback client as a remote browser: no trusted-local bypass.
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  vi.stubEnv("ELIZA_API_TOKEN", "server-only-teardown-static-credential");
  // startEliza installs the session-aware authorization before the host.
  installAgentHostBridge();
  const { host, port, runtimes, adapterCloses } = await startHost();
  const store = authStoreForRuntime(runtimes[0]);
  if (!store) throw new Error("runtime has no auth store");
  const owner = await store.createIdentity({
    id: randomUUID(),
    kind: "owner",
    displayName: "Owner",
    createdAt: Date.now(),
    passwordHash: await hashPassword("owner-password-1234"),
  });
  const { session } = await createBrowserSession(store, {
    identityId: owner.id,
    ip: null,
    userAgent: null,
    rememberDevice: false,
  });
  const csrf = deriveCsrfToken(session);
  const call = (
    method: "GET" | "POST",
    route: string,
    targetPort = port,
    sessionId = session.id,
    csrfToken = csrf,
  ) =>
    fetch(`http://127.0.0.1:${targetPort}${route}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        origin: `http://127.0.0.1:${targetPort}`,
        cookie: `eliza_session=${encodeURIComponent(sessionId)}; eliza_csrf=${csrfToken}`,
        "x-eliza-csrf": csrfToken,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
  try {
    expect((await call("POST", "/api/agent/stop")).status).toBe(200);
    const other = await startHost();
    try {
      const otherStore = authStoreForRuntime(other.runtimes[0]);
      if (!otherStore) throw new Error("second runtime has no auth store");
      const otherOwner = await otherStore.createIdentity({
        id: randomUUID(),
        kind: "owner",
        displayName: "Other owner",
        createdAt: Date.now(),
        passwordHash: await hashPassword("other-owner-password-1234"),
      });
      const { session: otherSession } = await createBrowserSession(otherStore, {
        identityId: otherOwner.id,
        ip: null,
        userAgent: null,
        rememberDevice: false,
      });
      const otherCsrf = deriveCsrfToken(otherSession);
      expect(
        (
          await call(
            "POST",
            "/api/agent/stop",
            other.port,
            otherSession.id,
            otherCsrf,
          )
        ).status,
      ).toBe(200);
      expect((await call("GET", "/api/auth/me")).status).toBe(200);
      expect(
        (
          await call(
            "GET",
            "/api/auth/me",
            other.port,
            otherSession.id,
            otherCsrf,
          )
        ).status,
      ).toBe(200);
      expect(
        (await call("GET", "/api/auth/me", port, otherSession.id, otherCsrf))
          .status,
      ).toBe(401);
      expect((await call("GET", "/api/auth/me", other.port)).status).toBe(401);
      expect(authStoreForRuntime(null)).toBeNull();
    } finally {
      await other.host.close();
    }
    expect((await call("GET", "/api/auth/me")).status).toBe(200);
    const status = await call("GET", "/api/status");
    expect(status.status).toBe(200);
    expect(((await status.json()) as { state: string }).state).toBe("stopped");
    expect((await call("POST", "/api/agent/start")).status).toBe(200);
    // Start closed the stopped database once, before the replacement opened.
    expect(runtimes).toHaveLength(2);
    expect(adapterCloses[0]).toBe(1);
  } finally {
    await host.close();
  }
  expect(adapterCloses).toEqual([1, 1]);
  // Two independent database boots plus the original host restart.
}, 120_000);

it("restores the stopped session store when replacement boot fails", async () => {
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  vi.stubEnv("ELIZA_API_TOKEN", "server-only-teardown-static-credential");
  installAgentHostBridge();
  const { host, port, runtimes } = await startHost({
    failReplacementBootOnce: true,
  });
  const store = authStoreForRuntime(runtimes[0]);
  if (!store) throw new Error("runtime has no auth store");
  const owner = await store.createIdentity({
    id: randomUUID(),
    kind: "owner",
    displayName: "Owner",
    createdAt: Date.now(),
    passwordHash: await hashPassword("owner-password-1234"),
  });
  const { session } = await createBrowserSession(store, {
    identityId: owner.id,
    ip: null,
    userAgent: null,
    rememberDevice: false,
  });
  const csrf = deriveCsrfToken(session);
  const call = (method: "GET" | "POST", route: string) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        origin: `http://127.0.0.1:${port}`,
        cookie: `eliza_session=${encodeURIComponent(session.id)}; eliza_csrf=${csrf}`,
        "x-eliza-csrf": csrf,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
  try {
    expect((await call("POST", "/api/agent/stop")).status).toBe(200);
    expect((await call("POST", "/api/agent/start")).status).toBe(500);
    expect((await call("GET", "/api/auth/me")).status).toBe(200);

    expect((await call("POST", "/api/agent/start")).status).toBe(200);
    expect(runtimes).toHaveLength(2);
    expect((await call("GET", "/api/auth/me")).status).toBe(200);
  } finally {
    await host.close();
  }
}, 60_000);
