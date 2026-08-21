/**
 * Verifies a stale connectBot() login failure can't overwrite the status of
 * a connection that disconnectBot() (or a newer connectBot()) already took
 * ownership of while login() was in flight.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as discordActual from "discord.js";

const createdClients: FakeDiscordClient[] = [];
let pendingLogin: (() => Promise<unknown>) | null = null;

class FakeDiscordClient extends EventEmitter {
  login = mock(() => (pendingLogin ? pendingLogin() : Promise.resolve()));
  destroy = mock(() => undefined);
  guilds = { cache: { size: 0 } };
  user = undefined;

  constructor() {
    super();
    createdClients.push(this);
  }
}

// `mock.module` is process-global: spread the real discord.js module so this
// file's partial mock (only `Client`) does not drop the other exports (e.g.
// `Events`, `Partials`, `GatewayIntentBits`) for later test files in the same
// run. No other test file in this package constructs a real `Client`.
mock.module("discord.js", () => ({
  ...discordActual,
  Client: mock(() => new FakeDiscordClient()),
}));

const { GatewayManager } = await import("../src/gateway-manager");

function statusPosts(fetchMock: ReturnType<typeof mock>) {
  return fetchMock.mock.calls
    .filter(([url]: [string]) => url.includes("/gateway/status"))
    .map(([, init]: [string, RequestInit]) => JSON.parse(String(init.body)));
}

function makeManager() {
  const manager = new GatewayManager({
    podName: "test-pod",
    elizaCloudUrl: "https://eliza.test",
    gatewayBootstrapSecret: "secret",
    project: "test",
  });
  // Bypass acquireToken(): stub the private auth fields directly.
  (manager as unknown as { accessToken: string }).accessToken = "test-token";
  (manager as unknown as { tokenExpiresAt: Date }).tokenExpiresAt = new Date(
    Date.now() + 60_000,
  );
  return manager;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const ASSIGNMENT = {
  connectionId: "conn-1",
  organizationId: "org-1",
  applicationId: "app-1",
  botToken: "fake-token",
  intents: 0,
  characterId: null,
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  createdClients.length = 0;
  pendingLogin = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

describe("connectBot / disconnectBot ownership race", () => {
  test("revokes ownership before an awaited disconnect session save", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const manager = makeManager();
    const gm = manager as unknown as {
      connectBot: (a: typeof ASSIGNMENT) => Promise<void>;
      disconnectBot: (id: string) => Promise<void>;
    };

    const save = deferred();
    (manager as unknown as { redis: unknown }).redis = {
      setex: mock(() => save.promise),
    };

    let rejectLogin: ((err: Error) => void) | undefined;
    pendingLogin = () =>
      new Promise((_resolve, reject) => {
        rejectLogin = reject;
      });

    const connectPromise = gm.connectBot(ASSIGNMENT);

    // The session save is deliberately stalled. Ownership must already be
    // revoked even though disconnectBot() has not reached client.destroy().
    const disconnectPromise = gm.disconnectBot(ASSIGNMENT.connectionId);

    // The old login fails while teardown is still awaiting the session save.
    rejectLogin?.(new Error("destroyed mid-login"));
    await connectPromise;
    save.resolve();
    await disconnectPromise;

    const posts = statusPosts(fetchMock);
    expect(posts.map((p: { status: string }) => p.status)).not.toContain(
      "error",
    );
    expect(posts.at(-1)).toMatchObject({ status: "disconnected" });
  });

  test("destroys a replaced client and ignores its queued error callback", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const manager = makeManager();
    const gm = manager as unknown as {
      connectBot: (a: typeof ASSIGNMENT) => Promise<void>;
    };

    const teardownOrder: string[] = [];
    const setex = mock(async (...args: unknown[]) => {
      teardownOrder.push(`setex:${String(args[0])}`);
      return "OK";
    });
    (manager as unknown as { redis: unknown }).redis = { setex };

    const firstLogin = deferred();
    pendingLogin = () => firstLogin.promise;
    const firstConnect = gm.connectBot(ASSIGNMENT);
    const firstClient = createdClients[0];
    firstClient.destroy = mock(() => {
      teardownOrder.push("destroy");
      return undefined;
    });
    // Counters the superseded connection accumulated before it was replaced.
    const firstConn = (
      manager as unknown as {
        connections: Map<string, { guildCount: number; eventsRouted: number }>;
      }
    ).connections.get(ASSIGNMENT.connectionId);
    if (!firstConn) throw new Error("first connection was never registered");
    firstConn.guildCount = 3;
    firstConn.eventsRouted = 7;

    const queuedError = firstClient.listeners(
      discordActual.Events.Error,
    )[0] as (error: Error) => Promise<void>;

    pendingLogin = () => Promise.resolve();
    await gm.connectBot(ASSIGNMENT);

    expect(firstClient.destroy).toHaveBeenCalledTimes(1);
    // The superseded connection's session state is persisted before its client
    // is destroyed, exactly as disconnectBot and shutdown do.
    expect(teardownOrder).toEqual([
      `setex:discord:session:${ASSIGNMENT.connectionId}`,
      "destroy",
    ]);
    const savedState = JSON.parse(String(setex.mock.calls[0]?.[2]));
    expect(savedState).toMatchObject({
      connectionId: ASSIGNMENT.connectionId,
      guildCount: 3,
      eventsRouted: 7,
    });
    await queuedError(new Error("stale socket error"));
    firstLogin.reject(new Error("replaced login"));
    await firstConnect;

    expect(statusPosts(fetchMock)).toEqual([]);
  });

  test("shutdown revokes ownership before destroying an in-flight login", async () => {
    const shutdownResponse = deferred<Response>();
    const fetchMock = mock(async (url: string) => {
      if (url.includes("/gateway/shutdown")) return shutdownResponse.promise;
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const manager = makeManager();
    const gm = manager as unknown as {
      connectBot: (a: typeof ASSIGNMENT) => Promise<void>;
    };

    const login = deferred();
    const save = deferred();
    (manager as unknown as { redis: unknown }).redis = {
      setex: mock(() => save.promise),
      del: mock(() => Promise.resolve()),
      srem: mock(() => Promise.resolve()),
    };
    pendingLogin = () => login.promise;
    const connectPromise = gm.connectBot(ASSIGNMENT);
    const shutdownPromise = manager.shutdown();

    await Promise.resolve();
    login.reject(new Error("shutdown destroyed login"));
    await connectPromise;
    expect(statusPosts(fetchMock)).toEqual([]);

    save.resolve();
    shutdownResponse.resolve(new Response(null, { status: 200 }));
    await shutdownPromise;
  });

  test("still reports error status when login fails with no concurrent disconnect", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const manager = makeManager();
    const gm = manager as unknown as {
      connectBot: (a: typeof ASSIGNMENT) => Promise<void>;
    };

    let rejectLogin: ((err: Error) => void) | undefined;
    pendingLogin = () =>
      new Promise((_resolve, reject) => {
        rejectLogin = reject;
      });

    const connectPromise = gm.connectBot(ASSIGNMENT);
    rejectLogin?.(new Error("bad token"));
    await connectPromise;

    const posts = statusPosts(fetchMock);
    expect(posts.at(-1)).toMatchObject({ status: "error" });
  });
});
