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
  test("does not overwrite a legitimate disconnect with an error status", async () => {
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    const manager = makeManager();
    const gm = manager as unknown as {
      connectBot: (a: typeof ASSIGNMENT) => Promise<void>;
      disconnectBot: (id: string) => Promise<void>;
    };

    let rejectLogin: ((err: Error) => void) | undefined;
    pendingLogin = () =>
      new Promise((_resolve, reject) => {
        rejectLogin = reject;
      });

    const connectPromise = gm.connectBot(ASSIGNMENT);

    // Disconnect while login() is still in flight -- this is the legitimate,
    // caller-initiated teardown.
    await gm.disconnectBot(ASSIGNMENT.connectionId);
    expect(statusPosts(fetchMock).at(-1)).toMatchObject({
      status: "disconnected",
    });

    // Now the destroyed client's login() rejects (as it would in reality
    // once the underlying connection is torn down mid-handshake).
    rejectLogin?.(new Error("destroyed mid-login"));
    await connectPromise;

    const posts = statusPosts(fetchMock);
    expect(posts.map((p: { status: string }) => p.status)).not.toContain(
      "error",
    );
    expect(posts.at(-1)).toMatchObject({ status: "disconnected" });
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
