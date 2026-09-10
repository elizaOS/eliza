/**
 * Exercises renderer destination authority through real TCP servers and the
 * native first-run, status, and config composers. Server records represent the
 * two external hosts; client selection, RPC routing, and HTTP serialization are
 * real. Native binding changes must never redirect a remote write locally.
 */
// @vitest-environment jsdom

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
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

const servers: Server[] = [];
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
  };
  const server = createServer(async (req, res) => {
    state.paths.push(`${req.method} ${req.url}`);
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
  setPendingFirstRunTextReleaseHandler(null);
  delete desktopWindow.__ELIZA_DESKTOP_LOCAL_API_BASE__;
  delete desktopWindow.__ELIZA_ELECTROBUN_RPC__;
  client.setToken(null);
  localStorage.clear();
  sessionStorage.clear();
  rpcCalls.length = 0;
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
