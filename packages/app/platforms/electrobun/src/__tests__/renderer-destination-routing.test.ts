/**
 * Exercises renderer destination authority through real TCP servers and the
 * native first-run, status, and config composers. Server records represent the
 * two external hosts; client selection, RPC routing, and HTTP serialization are
 * real. Native binding changes must never redirect a remote write locally.
 */
// @vitest-environment jsdom

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { WebSocket as TcpWebSocket, WebSocketServer } from "ws";
import { authMe } from "../../../../../ui/src/api/auth-client";
import { ElizaClient } from "../../../../../ui/src/api/client-base";
import { client } from "../../../../../ui/src/api/index";
import { completeRemoteAgentFirstRun } from "../../../../../ui/src/first-run/adopt-remote-first-run";
import { setPendingFirstRunTextReleaseHandler } from "../../../../../ui/src/first-run/first-run-pending-text";
import { applyLaunchConnection } from "../../../../../ui/src/platform/browser-launch";
import {
  composeAgentStatusSnapshot,
  readAgentStatusViaHttp,
} from "../agent-status-rpc";
import { applyElectrobunApiBaseUpdate } from "../bridge/electrobun-boot-config";
import {
  composeAuthMeSnapshot,
  readAuthMeViaHttp,
} from "../config-and-auth-rpc";
import {
  composeConversationsListSnapshot,
  readConversationsListViaHttp,
} from "../conversations-and-character-rpc";
import {
  composeFirstRunStatusSnapshot,
  readFirstRunStatusViaHttp,
} from "../first-run-rpc";
import { isRecord } from "../rpc-parse-utils";
import {
  composeConfigUpdate,
  updateConfigViaHttp,
} from "../settings-mutations-rpc";

// Use the real TCP WebSocket client without Node EventTarget/jsdom realm mixing.
beforeAll(() => vi.stubGlobal("WebSocket", TcpWebSocket));
afterAll(() => vi.unstubAllGlobals());

const servers: Server[] = [];
const webSockets: WebSocketServer[] = [];
const rpcCalls: string[] = [];
const desktopWindow = window as typeof window & {
  __ELIZA_DESKTOP_LOCAL_API_BASE__?: string;
  __ELIZA_ELECTROBUN_RPC__?: {
    request: Record<
      string,
      (params?: Record<string, unknown>) => Promise<unknown>
    >;
    onMessage(): void;
    offMessage(): void;
  };
};

async function host(name: string, prefix = "") {
  const state = {
    complete: false,
    writes: 0,
    rejectAuth: false,
    paths: [] as string[],
    bearers: [] as (string | undefined)[],
    upgrades: [] as string[],
  };
  const server = createServer(async (req, res) => {
    state.paths.push(`${req.method} ${req.url}`);
    state.bearers.push(req.headers.authorization);
    const route = req.url?.slice(prefix.length);
    if (route === "/api/auth/me" && state.rejectAuth) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          reason: "remote_auth_required",
          access: {
            mode: "remote",
            passwordConfigured: true,
            ownerConfigured: true,
          },
        }),
      );
      return;
    }
    let body: Record<string, unknown>;
    if (route === "/api/first-run/status") body = { complete: state.complete };
    else if (route === "/api/status")
      body = {
        state: "running",
        agentName: name,
        model: "synthetic/model",
        canRespond: true,
      };
    else if (route === "/api/conversations")
      body = {
        conversations: [
          {
            id: name,
            title: name,
            roomId: name,
            createdAt: "2026-09-10T00:00:00.000Z",
            updatedAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      };
    else if (route === "/api/auth/me")
      body = {
        identity: { id: name, displayName: name, kind: "machine" },
        session: { id: name, kind: "machine", expiresAt: null },
        access: {
          mode: "bearer",
          passwordConfigured: true,
          ownerConfigured: true,
        },
      };
    else if (route === "/api/config" && req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const patch = JSON.parse(Buffer.concat(chunks).toString());
      state.complete = patch.meta.firstRunComplete;
      state.writes++;
      body = { meta: { firstRunComplete: state.complete } };
    } else {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  const wsServer = new WebSocketServer({ noServer: true });
  webSockets.push(wsServer);
  server.on("upgrade", (req, socket, head) => {
    state.upgrades.push(req.url ?? "");
    wsServer.handleUpgrade(req, socket, head, () => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener");
  return {
    state,
    port: address.port,
    base: `http://127.0.0.1:${address.port}${prefix}`,
  };
}

function bindLocal(port: number, base: string) {
  desktopWindow.__ELIZA_DESKTOP_LOCAL_API_BASE__ = base;
  desktopWindow.__ELIZA_ELECTROBUN_RPC__ = {
    request: {
      listConversations: async () => {
        rpcCalls.push("conversations");
        return composeConversationsListSnapshot(
          port,
          readConversationsListViaHttp,
        );
      },
      getAuthMe: async () => {
        rpcCalls.push("auth");
        return composeAuthMeSnapshot(port, readAuthMeViaHttp);
      },
      getFirstRunStatus: async () => {
        rpcCalls.push("firstRun");
        return composeFirstRunStatusSnapshot(port, readFirstRunStatusViaHttp);
      },
      getAgentStatus: async () => {
        rpcCalls.push("status");
        return composeAgentStatusSnapshot(port, readAgentStatusViaHttp);
      },
      updateConfig: async (patch) => {
        rpcCalls.push("config");
        if (!isRecord(patch)) throw new Error("Missing config patch");
        return composeConfigUpdate(port, patch, updateConfigViaHttp);
      },
    },
    onMessage() {},
    offMessage() {},
  };
}

afterEach(async () => {
  client.disconnectWs();
  setPendingFirstRunTextReleaseHandler(null);
  delete desktopWindow.__ELIZA_DESKTOP_LOCAL_API_BASE__;
  delete desktopWindow.__ELIZA_ELECTROBUN_RPC__;
  client.setToken(null);
  localStorage.clear();
  sessionStorage.clear();
  rpcCalls.length = 0;
  for (const wsServer of webSockets.splice(0)) {
    for (const socket of wsServer.clients) socket.terminate();
    wsServer.close();
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("adopts the selected prefixed remote, preserves local config, and restores explicit local RPC", async () => {
  const local = await host("local");
  const remote = await host("remote", "/deployment");
  bindLocal(local.port, local.base);
  const effects: string[] = [];
  setPendingFirstRunTextReleaseHandler(() => effects.push("release"));
  applyLaunchConnection({ apiBase: remote.base, token: "synthetic-owner" });
  expect((await client.getStatus()).agentName).toBe("remote");
  await completeRemoteAgentFirstRun(client, { apiBase: remote.base }, () =>
    effects.push("complete"),
  );
  expect(effects).toEqual(["complete", "release"]);
  const identity = await authMe();
  expect(identity.ok && identity.identity.id).toBe("remote");
  expect((await client.listConversations()).conversations[0]?.id).toBe(
    "remote",
  );
  expect(remote.state.complete).toBe(true);
  expect(remote.state.writes).toBe(1);
  expect(local.state.writes).toBe(0);
  expect(local.state.paths).toEqual([]);
  expect(rpcCalls).toEqual([]);
  const explicitLocal = new ElizaClient(local.base);
  expect((await explicitLocal.getStatus()).agentName).toBe("local");
  await explicitLocal.updateConfig({ meta: { firstRunComplete: true } });
  expect(await explicitLocal.getFirstRunStatus()).toEqual({ complete: true });
  expect(rpcCalls).toEqual(["status", "config", "firstRun"]);
  expect(local.state.writes).toBe(1);
  expect(remote.state.writes).toBe(1);
  applyLaunchConnection({ apiBase: local.base });
  const localIdentity = await authMe();
  expect(localIdentity.ok && localIdentity.identity.id).toBe("local");
  expect((await client.listConversations()).conversations[0]?.id).toBe("local");
  expect(rpcCalls).toEqual([
    "status",
    "config",
    "firstRun",
    "auth",
    "conversations",
  ]);
});

it("does not use local RPC for an explicit different target or missing binding", async () => {
  const local = await host("local");
  const remote = await host("remote");
  bindLocal(local.port, local.base);
  const explicit = new ElizaClient(remote.base);
  expect((await explicit.getStatus()).agentName).toBe("remote");
  await explicit.updateConfig({ meta: { firstRunComplete: true } });
  expect(local.state.paths).toEqual([]);
  delete desktopWindow.__ELIZA_DESKTOP_LOCAL_API_BASE__;
  const unbound = new ElizaClient(local.base);
  await unbound.updateConfig({ meta: { firstRunComplete: true } });
  expect(rpcCalls).toEqual([]);
  expect(local.state.writes).toBe(1);
});

it("keeps a different prefix on the same origin outside local RPC authority", async () => {
  const local = await host("prefixed", "/deployment");
  bindLocal(local.port, `http://127.0.0.1:${local.port}`);
  const explicit = new ElizaClient(local.base);
  expect((await explicit.getStatus()).agentName).toBe("prefixed");
  await explicit.updateConfig({ meta: { firstRunComplete: true } });
  expect(rpcCalls).toEqual([]);
  expect(local.state.paths).toContain("PUT /deployment/api/config");
});

it("preserves remote unauthorized state instead of accepting the local session, including missing binding", async () => {
  const local = await host("local");
  const remote = await host("remote");
  remote.state.rejectAuth = true;
  bindLocal(local.port, local.base);
  applyLaunchConnection({
    apiBase: remote.base,
    token: "synthetic-invalid-owner",
  });
  expect(await authMe()).toMatchObject({
    ok: false,
    status: 401,
    reason: "remote_auth_required",
  });
  delete desktopWindow.__ELIZA_DESKTOP_LOCAL_API_BASE__;
  expect(await authMe()).toMatchObject({
    ok: false,
    status: 401,
    reason: "remote_auth_required",
  });
  expect(rpcCalls).toEqual([]);
  expect(local.state.paths).toEqual([]);
});

it("retains selected remote auth and writes when the native host publishes a port update", async () => {
  const local = await host("local");
  const remote = await host("remote", "/deployment");
  bindLocal(local.port, local.base);
  applyLaunchConnection({ apiBase: remote.base, token: "synthetic-remote" });
  expect(await authMe()).toMatchObject({
    ok: true,
    identity: { id: "remote" },
  });
  applyElectrobunApiBaseUpdate(window, {
    base: local.base,
    token: "synthetic-local",
    localApiBase: local.base,
  });
  expect(await authMe()).toMatchObject({
    ok: true,
    identity: { id: "remote" },
  });
  await client.updateConfig({ meta: { firstRunComplete: true } });
  expect(local.state.paths).toEqual([]);
  expect(remote.state.writes).toBe(1);
});

it("rotates explicit local selection and its bearer after returning from a remote host", async () => {
  const oldLocal = await host("old-local");
  const remote = await host("remote");
  const nextLocal = await host("next-local");
  bindLocal(oldLocal.port, oldLocal.base);
  applyLaunchConnection({ apiBase: remote.base, token: "synthetic-remote" });
  client.setBaseUrl(oldLocal.base);
  client.setToken("synthetic-old-local");
  applyElectrobunApiBaseUpdate(window, {
    base: nextLocal.base,
    token: "synthetic-next-local",
    localApiBase: nextLocal.base,
  });
  // Remove RPC only to observe the real client's serialized HTTP destination and bearer.
  delete desktopWindow.__ELIZA_ELECTROBUN_RPC__;
  expect((await client.getStatus()).agentName).toBe("next-local");
  expect(await authMe()).toMatchObject({
    ok: true,
    identity: { id: "next-local" },
  });
  expect(
    nextLocal.state.bearers.every(
      (value) => value === "Bearer synthetic-next-local",
    ),
  ).toBe(true);
  expect(oldLocal.state.paths).toEqual([]);
  expect(remote.state.paths).toEqual([]);
  let authorityChanges = 0;
  const unsubscribe = client.onAuthorityChange(() => {
    authorityChanges += 1;
  });
  applyElectrobunApiBaseUpdate(window, {
    base: nextLocal.base,
    token: "synthetic-next-local",
    localApiBase: nextLocal.base,
  });
  expect(authorityChanges).toBe(0);
  unsubscribe();
});

it("rotates an unselected local boot and preserves a selected different prefix", async () => {
  const local = await host("local");
  const nextLocal = await host("next-local");
  bindLocal(local.port, local.base);
  client.setBaseUrl(local.base);
  client.setToken(null);
  client.setBaseUrl(null, { persist: false });
  client.connectWs();
  await expect.poll(() => local.state.upgrades.length).toBe(1);
  await expect.poll(() => client.getConnectionState().state).toBe("connected");
  let changes = 0;
  const stopObserving = client.onAuthorityChange(() => {
    changes += 1;
  });
  applyElectrobunApiBaseUpdate(window, {
    base: nextLocal.base,
    token: "synthetic-next",
    localApiBase: nextLocal.base,
  });
  delete desktopWindow.__ELIZA_ELECTROBUN_RPC__;
  expect((await client.getStatus()).agentName).toBe("next-local");
  expect(nextLocal.state.bearers.at(-1)).toBe("Bearer synthetic-next");
  await expect.poll(() => nextLocal.state.upgrades.length).toBe(1);
  await expect.poll(() => client.getConnectionState().state).toBe("connected");
  expect(changes).toBe(1);
  stopObserving();
  client.disconnectWs();
  const prefixed = await host("prefixed", "/deployment");
  bindLocal(prefixed.port, `http://127.0.0.1:${prefixed.port}`);
  applyLaunchConnection({ apiBase: prefixed.base, token: "synthetic-prefix" });
  applyElectrobunApiBaseUpdate(window, {
    base: local.base,
    token: "synthetic-local",
    localApiBase: local.base,
  });
  expect(await authMe()).toMatchObject({
    ok: true,
    identity: { id: "prefixed" },
  });
  expect((await client.getStatus()).agentName).toBe("prefixed");
  expect(
    prefixed.state.bearers.every(
      (value) => value === "Bearer synthetic-prefix",
    ),
  ).toBe(true);
});
