/**
 * Route-level e2e for plugin-discord-local (issue #8802).
 *
 * Boots the plugin's declared `Route[]` (from `discordLocalPlugin.routes`) through
 * the real production dispatcher (`tryHandleRuntimePluginRoute`) over a loopback
 * `http.createServer` — exercising the real auth gate, JSON body parsing, query
 * parsing, and handler dispatch — with a faked `DiscordLocalService` standing in
 * for the local Discord desktop bridge. The bridge is never contacted: the
 * service is mocked, so no Discord IPC socket, OAuth flow, or osascript runs.
 * Every assertion is on a real HTTP response, not mocked `json`/`error` functions.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import discordLocalPlugin, { DISCORD_LOCAL_SERVICE_NAME, DiscordLocalService } from "../index.ts";

const routes = discordLocalPlugin.routes;

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        })
    )
  );
  servers.length = 0;
});

type DiscordStatus = {
  available: boolean;
  connected: boolean;
  authenticated: boolean;
  currentUser: unknown;
  subscribedChannelIds: string[];
  configuredChannelIds: string[];
  scopes: string[];
  lastError: string | null;
  ipcPath: string | null;
};

interface FakeServiceState {
  status: DiscordStatus;
  authorizeResult: DiscordStatus | null;
  authorizeError: Error | null;
  guilds: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name?: string | null }>;
  channelsError: Error | null;
  subscribed: string[];
  calls: string[];
}

function baseStatus(overrides: Partial<DiscordStatus> = {}): DiscordStatus {
  return {
    available: true,
    connected: true,
    authenticated: false,
    currentUser: null,
    subscribedChannelIds: [],
    configuredChannelIds: [],
    scopes: ["rpc", "identify", "rpc.notifications.read"],
    lastError: null,
    ipcPath: "/tmp/discord-ipc-0",
    ...overrides,
  };
}

function defaultState(): FakeServiceState {
  return {
    status: baseStatus(),
    authorizeResult: baseStatus({ authenticated: true, currentUser: { id: "u1" } }),
    authorizeError: null,
    guilds: [{ id: "g1", name: "Guild One" }],
    channels: [{ id: "c1", name: "general" }],
    channelsError: null,
    subscribed: [],
    calls: [],
  };
}

/**
 * The faked DiscordLocalService. It must be `instanceof DiscordLocalService`
 * for `resolveDiscordLocalService` to accept it — but constructing the real
 * class would try to read config / touch the filesystem. Instead we build a
 * plain object and patch its prototype to the real class so the `instanceof`
 * guard passes without running any bridge code.
 */
function makeFakeService(state: FakeServiceState): object {
  const service = {
    getStatus() {
      state.calls.push("getStatus");
      return state.status;
    },
    async authorize() {
      state.calls.push("authorize");
      if (state.authorizeError) {
        throw state.authorizeError;
      }
      return state.authorizeResult;
    },
    async disconnectSession() {
      state.calls.push("disconnectSession");
    },
    async listGuilds() {
      state.calls.push("listGuilds");
      return state.guilds;
    },
    async listChannels(guildId: string) {
      state.calls.push(`listChannels:${guildId}`);
      if (state.channelsError) {
        throw state.channelsError;
      }
      return state.channels;
    },
    async subscribeChannelMessages(channelIds: string[]) {
      state.calls.push(`subscribe:${channelIds.join(",")}`);
      state.subscribed = channelIds;
      return channelIds;
    },
  };
  Object.setPrototypeOf(service, DiscordLocalService.prototype);
  return service;
}

function makeRuntime(
  options: { withService?: boolean; state?: FakeServiceState } = {}
): AgentRuntime {
  const { withService = true, state } = options;
  const service = state ? makeFakeService(state) : makeFakeService(defaultState());
  return {
    routes,
    getService: (key: string) =>
      withService && key === DISCORD_LOCAL_SERVICE_NAME ? service : null,
  } as unknown as AgentRuntime;
}

async function startServer(
  runtime: AgentRuntime,
  isAuthorized: () => boolean = () => true
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime,
      isAuthorized,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function postJson(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("plugin-discord-local routes (real dispatch)", () => {
  it("declares the documented six routes", () => {
    expect(Array.isArray(routes)).toBe(true);
    const declared = (routes ?? []).map((r) => `${r.type} ${r.path}`).sort();
    expect(declared).toEqual(
      [
        "GET /api/setup/discord/status",
        "POST /api/setup/discord/start",
        "POST /api/setup/discord/cancel",
        "GET /api/discord/guilds",
        "GET /api/discord/channels",
        "POST /api/discord/subscriptions",
      ].sort()
    );
  });

  it("serves setup status (200) with the service mocked", async () => {
    const state = defaultState();
    state.status = baseStatus({ authenticated: true, currentUser: { id: "u1" } });
    const base = await startServer(makeRuntime({ state }));
    const res = await fetch(`${base}/api/setup/discord/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connector: string;
      state: string;
      detail: DiscordStatus;
    };
    expect(body.connector).toBe("discord");
    expect(body.state).toBe("paired");
    expect(body.detail.authenticated).toBe(true);
    expect(state.calls).toContain("getStatus");
  });

  it("reports idle setup status (200) when the service is not registered", async () => {
    const base = await startServer(makeRuntime({ withService: false }));
    const res = await fetch(`${base}/api/setup/discord/status`);
    // status handler is resilient: no service still yields a 200 idle envelope.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; detail: DiscordStatus };
    expect(body.state).toBe("idle");
    expect(body.detail.available).toBe(false);
  });

  it("starts the OAuth flow (200) and reports paired on success", async () => {
    const state = defaultState();
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/setup/discord/start", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; detail: DiscordStatus };
    expect(body.state).toBe("paired");
    expect(body.detail.authenticated).toBe(true);
    expect(state.calls).toContain("authorize");
  });

  it("returns 503 from start when the discord-local service is unavailable", async () => {
    const base = await startServer(makeRuntime({ withService: false }));
    const res = await postJson(base, "/api/setup/discord/start", {});
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("service_unavailable");
  });

  it("returns 500 from start when authorize throws", async () => {
    const state = defaultState();
    state.authorizeError = new Error("Discord IPC socket not found");
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/setup/discord/start", {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.message).toContain("Discord IPC socket not found");
  });

  it("lists guilds (200) with the service mocked", async () => {
    const state = defaultState();
    const base = await startServer(makeRuntime({ state }));
    const res = await fetch(`${base}/api/discord/guilds`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      guilds: Array<{ id: string }>;
      count: number;
    };
    expect(body.count).toBe(1);
    expect(body.guilds[0]?.id).toBe("g1");
    expect(state.calls).toContain("listGuilds");
  });

  it("requires guildId on the channels route (400) and serves it when present", async () => {
    const state = defaultState();
    const base = await startServer(makeRuntime({ state }));

    const missing = await fetch(`${base}/api/discord/channels`);
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as {
      error: { code: string; message: string };
    };
    expect(missingBody.error.code).toBe("bad_request");
    expect(missingBody.error.message).toContain("guildId");

    const ok = await fetch(`${base}/api/discord/channels?guildId=g1`);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as {
      channels: Array<{ id: string }>;
      count: number;
    };
    expect(okBody.count).toBe(1);
    expect(okBody.channels[0]?.id).toBe("c1");
    expect(state.calls).toContain("listChannels:g1");
  });

  it("updates subscriptions (200) from the parsed JSON body", async () => {
    const state = defaultState();
    const base = await startServer(makeRuntime({ state }));
    const res = await postJson(base, "/api/discord/subscriptions", {
      channelIds: ["c1", "c2", "c1", "  ", "c3"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { subscribedChannelIds: string[] };
    // handler dedupes + trims before calling the service.
    expect(body.subscribedChannelIds).toEqual(["c1", "c2", "c3"]);
    expect(state.subscribed).toEqual(["c1", "c2", "c3"]);
  });

  it("returns 503 from subscriptions when the service is unavailable", async () => {
    const base = await startServer(makeRuntime({ withService: false }));
    const res = await postJson(base, "/api/discord/subscriptions", {
      channelIds: ["c1"],
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("service_unavailable");
  });

  it("enforces the auth gate on every non-public route (401)", async () => {
    const base = await startServer(makeRuntime(), () => false);

    const status = await fetch(`${base}/api/setup/discord/status`);
    expect(status.status).toBe(401);

    const start = await postJson(base, "/api/setup/discord/start", {});
    expect(start.status).toBe(401);

    const cancel = await postJson(base, "/api/setup/discord/cancel", {});
    expect(cancel.status).toBe(401);

    const guilds = await fetch(`${base}/api/discord/guilds`);
    expect(guilds.status).toBe(401);

    const channels = await fetch(`${base}/api/discord/channels?guildId=g1`);
    expect(channels.status).toBe(401);

    const subs = await postJson(base, "/api/discord/subscriptions", {
      channelIds: ["c1"],
    });
    expect(subs.status).toBe(401);
  });
});
