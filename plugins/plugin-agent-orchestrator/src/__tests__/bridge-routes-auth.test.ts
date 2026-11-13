/**
 * Sub-agent bridge authentication through the registered route table.
 *
 * A real Node HTTP server dispatches every request through
 * `codingAgentRoutePlugin.routes` behind a stand-in for the server's central
 * auth gate under ELIZA_REQUIRE_LOCAL_AUTH=1: loopback is not trusted, no
 * owner token is sent, so only routes declared `public` get past it. The bridge
 * routes must therefore be public and authenticate in the handler with
 * loopback plus the per-session token.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { assertPublicRouteIntent, type Route } from "@elizaos/host/protocol";
import { SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE } from "@elizaos/plugin-assistant";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BridgeCredentialAdapter } from "../api/bridge-routes.js";
import {
  CREDENTIAL_BRIDGE_TOKEN_HASH_METADATA,
  createCredentialBridgeToken,
} from "../services/credential-bridge-auth.js";
import type { SessionInfo } from "../services/types.js";
import { codingAgentRoutePlugin } from "../setup-routes.js";

const SESSION_ID = "session-a";
const ORIGIN_ROOM = "11111111-1111-4111-8111-111111111111";
const TASK_ROOM = "22222222-2222-4222-8222-222222222222";
const PROJECT_WORLD = "33333333-3333-4333-8333-333333333333";
const { token: SESSION_TOKEN, hash: SESSION_TOKEN_HASH } =
  createCredentialBridgeToken();

function makeSession(
  id: string,
  taskId: string,
  hash = SESSION_TOKEN_HASH,
): SessionInfo {
  return {
    id,
    name: id,
    agentType: "codex",
    workdir: `/work/${id}`,
    status: "running",
    approvalPreset: "standard",
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {
      taskId,
      roomId: TASK_ROOM,
      originRoomId: ORIGIN_ROOM,
      source: "telegram",
      [CREDENTIAL_BRIDGE_TOKEN_HASH_METADATA]: hash,
    },
  } as SessionInfo;
}

const sessions = [
  makeSession(SESSION_ID, "task-a"),
  makeSession("session-sibling", "task-a", createCredentialBridgeToken().hash),
  makeSession("session-other", "task-b", createCredentialBridgeToken().hash),
];
const tasks: Record<string, { projectId?: string; worldId?: string }> = {
  "task-a": { projectId: "project-a", worldId: PROJECT_WORLD },
  "task-b": { projectId: "project-b" },
};

let retrieveCalls = 0;
let retrieveOutcome: Awaited<
  ReturnType<BridgeCredentialAdapter["tryRetrieveCredential"]>
> = { status: "pending" };
const searchCalls: Array<Record<string, unknown>> = [];
const settings: Record<string, string> = {};

const adapter: BridgeCredentialAdapter = {
  async requestCredentials() {
    return {
      credentialScopeId: "scope-1",
      scopedToken: "scoped-token",
      expiresAt: Date.now() + 60_000,
      sensitiveRequestIds: [],
    };
  },
  async tryRetrieveCredential() {
    retrieveCalls += 1;
    return retrieveOutcome;
  },
};

const services: Record<string, unknown> = {
  ACP_SERVICE: {
    getSession: async (id: string) => sessions.find((s) => s.id === id),
    listSessions: () => sessions,
  },
  ORCHESTRATOR_TASK_SERVICE: {
    getTask: async (taskId: string) =>
      tasks[taskId] ? { goal: `goal ${taskId}`, ...tasks[taskId] } : null,
  },
  AGENT_SKILLS_SERVICE: {
    getEligibleSkills: async () => [
      { slug: "lint", name: "Lint", description: "Run lint", content: "body" },
    ],
    isSkillEnabled: () => true,
  },
  [SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE]: adapter,
};

const runtime = {
  agentId: "44444444-4444-4444-8444-444444444444",
  character: { name: "Parent", bio: [] },
  getService: (name: string) => services[name] ?? null,
  hasService: () => false,
  getSetting: (key: string) => settings[key] ?? null,
  getRoom: async () => null,
  useModel: async () => [0.1, 0.2],
  searchMemories: async (params: Record<string, unknown>) => {
    searchCalls.push(params);
    return [];
  },
} as unknown as IAgentRuntime;

function matches(pattern: string, pathname: string): boolean {
  const p = pattern.split("/").filter(Boolean);
  const c = pathname.split("/").filter(Boolean);
  return (
    p.length === c.length &&
    p.every((seg, i) => seg.startsWith(":") || seg === c[i])
  );
}

/** Stand-in for the central gate: no owner token is ever sent, so only a
 * public route passes. Remote callers are simulated with a test header. */
function gate(req: IncomingMessage, res: ServerResponse): void {
  const routes = codingAgentRoutePlugin.routes as Route[];
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";
  const route = routes.find(
    (r) => r.type === method && matches(r.path, pathname),
  );
  if (!route?.handler) {
    res.writeHead(404).end();
    return;
  }
  for (const r of routes) assertPublicRouteIntent(r, "test");
  if (route.public !== true) {
    res.writeHead(401).end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  // Keep-alive reuses sockets, so clear any earlier override first.
  delete (req.socket as { remoteAddress?: string }).remoteAddress;
  const remote = req.headers["x-test-remote-address"];
  if (typeof remote === "string") {
    Object.defineProperty(req.socket, "remoteAddress", {
      value: remote,
      configurable: true,
    });
  }
  void route.handler(req as never, res as never, runtime as never);
}

const BRIDGE_REQUESTS: Array<{ method: string; path: string }> = [
  { method: "GET", path: `/api/coding-agents/${SESSION_ID}/parent-context` },
  { method: "GET", path: `/api/coding-agents/${SESSION_ID}/memory?q=deploy` },
  { method: "GET", path: `/api/coding-agents/${SESSION_ID}/active-workspaces` },
  { method: "GET", path: `/api/coding-agents/${SESSION_ID}/skills` },
  { method: "GET", path: `/api/coding-agents/${SESSION_ID}/skills/lint` },
  {
    method: "POST",
    path: `/api/coding-agents/${SESSION_ID}/credentials/request`,
  },
  {
    method: "GET",
    path: `/api/coding-agents/${SESSION_ID}/credentials/OPENAI_API_KEY?token=scoped-token`,
  },
];

describe("sub-agent bridge auth through the registered routes", () => {
  let server: Server;
  let baseUrl: string;
  const previousRequireLocalAuth = process.env.ELIZA_REQUIRE_LOCAL_AUTH;

  beforeAll(async () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    server = createServer(gate);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (previousRequireLocalAuth === undefined)
      delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    else process.env.ELIZA_REQUIRE_LOCAL_AUTH = previousRequireLocalAuth;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    retrieveCalls = 0;
    retrieveOutcome = { status: "ready", value: "sk-test" };
    searchCalls.length = 0;
    delete settings.ELIZA_SUBAGENT_GLOBAL_MEMORY_SEARCH;
  });

  function send(
    request: { method: string; path: string },
    headers: Record<string, string>,
  ): Promise<Response> {
    return fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: { "content-type": "application/json", ...headers },
      body:
        request.method === "POST"
          ? JSON.stringify({ credentialKeys: ["OPENAI_API_KEY"] })
          : undefined,
    });
  }

  for (const request of BRIDGE_REQUESTS) {
    const label = `${request.method} ${request.path.split("?")[0]}`;

    it(`${label} rejects a non-loopback caller`, async () => {
      const response = await send(request, {
        "x-eliza-session-token": SESSION_TOKEN,
        "x-test-remote-address": "10.0.0.5",
      });
      expect(response.status).toBe(403);
    });

    it(`${label} rejects a missing token`, async () => {
      const response = await send(request, {});
      expect(response.status).toBe(401);
      expect(retrieveCalls).toBe(0);
    });

    it(`${label} rejects another session's token`, async () => {
      const response = await send(request, {
        "x-eliza-session-token": createCredentialBridgeToken().token,
      });
      expect(response.status).toBe(401);
      expect(retrieveCalls).toBe(0);
    });

    it(`${label} accepts loopback with the session token`, async () => {
      const response = await send(request, {
        "x-eliza-session-token": SESSION_TOKEN,
      });
      expect(response.status).toBe(200);
    });
  }

  it("keeps non-bridge routes behind the central gate", async () => {
    const response = await fetch(`${baseUrl}/api/coding-agents/settings`, {
      headers: { "x-eliza-session-token": SESSION_TOKEN },
    });
    expect(response.status).toBe(401);
  });

  it("scopes memory search to the task's project world by default", async () => {
    const response = await send(BRIDGE_REQUESTS[1], {
      "x-eliza-session-token": SESSION_TOKEN,
    });
    expect(await response.json()).toMatchObject({ scope: "world" });
    expect(searchCalls.length).toBeGreaterThan(0);
    for (const call of searchCalls) {
      expect(call.worldId).toBe(PROJECT_WORLD);
    }
  });

  it("searches globally only when the host opts in", async () => {
    settings.ELIZA_SUBAGENT_GLOBAL_MEMORY_SEARCH = "1";
    const response = await send(BRIDGE_REQUESTS[1], {
      "x-eliza-session-token": SESSION_TOKEN,
    });
    expect(await response.json()).toMatchObject({ scope: "global" });
    for (const call of searchCalls) {
      expect(call.worldId).toBeUndefined();
      expect(call.roomId).toBeUndefined();
    }
  });

  it("lists only sessions of the same task", async () => {
    const response = await send(BRIDGE_REQUESTS[2], {
      "x-eliza-session-token": SESSION_TOKEN,
    });
    const body = (await response.json()) as {
      activeSessions: Array<{ id: string }>;
    };
    expect(body.activeSessions.map((s) => s.id).sort()).toEqual([
      SESSION_ID,
      "session-sibling",
    ]);
  });

  it("stops redeeming once the child disconnects mid long-poll", async () => {
    retrieveOutcome = { status: "pending" };
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}${BRIDGE_REQUESTS[6].path}`, {
      headers: { "x-eliza-session-token": SESSION_TOKEN },
      signal: controller.signal,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(retrieveCalls).toBeGreaterThan(0);
    controller.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterAbort = retrieveCalls;
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(retrieveCalls).toBe(afterAbort);
  });
});
