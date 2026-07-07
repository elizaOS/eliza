// @vitest-environment jsdom

/**
 * Mock-cloud connect e2e (#8621 / #8387): the REAL client connect path —
 * selectOrProvisionCloudAgent → cold-boot wait → base resolution → chat REST
 * round-trip — driven against a REAL HTTP server that implements the cloud
 * control plane + dedicated-agent-proxy semantics (202/Retry-After) + the
 * shared-runtime REST adapter. Nothing on the client side is stubbed except
 * @capacitor/core platform detection (this lane is the non-native web path;
 * CapacitorHttp is never used on it).
 *
 * Covered:
 *  - G1: a reused DEDICATED agent that is not `running` triggers a resume kick
 *    and a control-plane poll (progress streamed via onProgress) before the
 *    dedicated base is bound; the post-wake record's fresh URL wins.
 *  - error path: a terminal `error` status fails fast with the agent's
 *    error_message; timeout path: a never-booting agent fails with an
 *    actionable message instead of hanging.
 *  - composition with the 202 honor in client-base: the dedicated proxy
 *    answering 202 + Retry-After on the first authed call after wake is
 *    retried transparently.
 *  - G2 (#8387): a SHARED agent with no URLs in the list DTO derives the
 *    REST-adapter base and completes a real conversation round-trip
 *    (health → create → send → list messages) with the cloud bearer token.
 */

import { createServer, type Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { DEFAULT_BOOT_CONFIG, setBootConfig } from "../config/boot-config";
import { ElizaClient } from "./client-base";
// Side-effect imports: patch the cloud + chat domains onto the prototype.
import "./client-cloud";
import "./client-chat";
import { waitForCloudAgentRunning } from "./client-cloud";

const AUTH_TOKEN = "test-cloud-session-token";

// Leg-4 port range (36400-36499) per the workspace convention.
const PORT_RANGE_START = 36400;
const PORT_RANGE_END = 36499;

type MockAgent = {
  id: string;
  agentName: string;
  status: string;
  webUiUrl: string | null;
  bridgeUrl: string | null;
  errorMessage?: string | null;
  /** When set, this webUiUrl is reported ONLY once the agent is running —
   *  models the record re-read picking up fresh post-wake URLs. */
  runningWebUiUrl?: string | null;
  /** Number of detail polls (after a resume) before the agent flips to
   *  `running`; Infinity = never boots. */
  bootAfterPolls: number;
  /** When set: number of post-resume polls before the boot FAILS terminally. */
  errorAfterPolls?: number;
  /** Detail GETs that answer 500 before the route recovers (transient blips). */
  detailFailuresRemaining?: number;
  resumeRequested: boolean;
  pollsSinceResume: number;
  /** After running: how many dedicated-proxy calls still answer 202. */
  proxy202sRemaining: number;
};

type MockMessage = { id: string; role: string; text: string };

interface MockCloudState {
  agents: Map<string, MockAgent>;
  conversations: Map<
    string,
    { id: string; title: string; messages: MockMessage[] }
  >;
  requests: Array<{ method: string; path: string; auth: string | null }>;
  resumeCalls: string[];
}

function agentDto(agent: MockAgent) {
  const running = agent.status === "running";
  return {
    id: agent.id,
    agentName: agent.agentName,
    status: agent.status,
    webUiUrl:
      running && agent.runningWebUiUrl !== undefined
        ? agent.runningWebUiUrl
        : agent.webUiUrl,
    bridgeUrl: agent.bridgeUrl,
    errorMessage: agent.errorMessage ?? null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function json(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One HTTP server plays all three cloud roles:
 *  - control plane: /api/v1/eliza/agents(/:id)(/resume)
 *  - dedicated-agent proxy: /dedicated/:id/api/*  (202 + Retry-After while the
 *    container is not running — the #8628 unified-proxy semantics)
 *  - shared REST adapter (#8387): /api/v1/eliza/agents/:id/api/*
 */
function createMockCloud(state: MockCloudState): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const auth = req.headers.authorization ?? null;
    state.requests.push({ method, path, auth });

    const chatSurface = async (agent: MockAgent): Promise<void> => {
      if (agent.status !== "running") {
        json(res, 202, { status: "starting" }, { "Retry-After": "0" });
        return;
      }
      if (agent.proxy202sRemaining > 0) {
        agent.proxy202sRemaining -= 1;
        json(res, 202, { status: "starting" }, { "Retry-After": "0" });
        return;
      }
      const rest = path.replace(
        /^\/(?:dedicated|api\/v1\/eliza\/agents)\/[^/]+/,
        "",
      );
      if (method === "GET" && rest === "/api/health") {
        json(res, 200, { status: "ok", agentId: agent.id });
        return;
      }
      if (method === "POST" && rest === "/api/conversations") {
        const conversation = {
          id: `conv-${state.conversations.size + 1}`,
          title: "Mock conversation",
          messages: [] as MockMessage[],
        };
        state.conversations.set(conversation.id, conversation);
        json(res, 200, {
          conversation: {
            id: conversation.id,
            title: conversation.title,
            createdAt: "2026-07-01T00:00:00.000Z",
            updatedAt: "2026-07-01T00:00:00.000Z",
          },
        });
        return;
      }
      const messagesMatch = /^\/api\/conversations\/([^/]+)\/messages$/.exec(
        rest,
      );
      if (messagesMatch) {
        const conversation = state.conversations.get(messagesMatch[1]);
        if (!conversation) {
          json(res, 404, { error: "conversation not found" });
          return;
        }
        if (method === "POST") {
          const body = JSON.parse(await readBody(req)) as { text?: string };
          const userText = body.text ?? "";
          const replyText = `echo from ${agent.id}: ${userText}`;
          conversation.messages.push(
            {
              id: `m-${conversation.messages.length + 1}`,
              role: "user",
              text: userText,
            },
            {
              id: `m-${conversation.messages.length + 2}`,
              role: "assistant",
              text: replyText,
            },
          );
          json(res, 200, { text: replyText, agentName: agent.agentName });
          return;
        }
        json(res, 200, { messages: conversation.messages });
        return;
      }
      json(res, 404, { error: `no mock route for ${method} ${rest}` });
    };

    // ── dedicated-agent proxy (#8628 semantics) ────────────────────────────
    const dedicated = /^\/dedicated\/([^/]+)\//.exec(path);
    if (dedicated) {
      const agent = state.agents.get(dedicated[1]);
      if (!agent) {
        json(res, 404, { error: "unknown dedicated agent" });
        return;
      }
      // The unified proxy only forwards for authenticated org members.
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      await chatSurface(agent);
      return;
    }

    // ── control plane ──────────────────────────────────────────────────────
    if (path.startsWith("/api/v1/eliza/agents")) {
      if (auth !== `Bearer ${AUTH_TOKEN}`) {
        json(res, 401, { error: "unauthorized", success: false });
        return;
      }
      if (path === "/api/v1/eliza/agents" && method === "GET") {
        json(res, 200, {
          success: true,
          data: [...state.agents.values()].map(agentDto),
        });
        return;
      }
      const resume = /^\/api\/v1\/eliza\/agents\/([^/]+)\/resume$/.exec(path);
      if (resume && method === "POST") {
        const agent = state.agents.get(resume[1]);
        if (!agent) {
          json(res, 404, { error: "unknown agent", success: false });
          return;
        }
        state.resumeCalls.push(agent.id);
        agent.resumeRequested = true;
        agent.pollsSinceResume = 0;
        if (agent.status !== "running" && agent.status !== "error") {
          agent.status = "starting";
        }
        json(res, 200, {
          success: true,
          data: {
            jobId: `job-${agent.id}`,
            status: "queued",
            message: "Agent resume enqueued",
          },
        });
        return;
      }
      const sharedApi = /^\/api\/v1\/eliza\/agents\/([^/]+)\/api\//.exec(path);
      if (sharedApi) {
        const agent = state.agents.get(sharedApi[1]);
        if (!agent) {
          json(res, 404, { error: "unknown shared agent" });
          return;
        }
        await chatSurface(agent);
        return;
      }
      const detail = /^\/api\/v1\/eliza\/agents\/([^/]+)$/.exec(path);
      if (detail && method === "GET") {
        const agent = state.agents.get(detail[1]);
        if (!agent) {
          json(res, 404, { error: "unknown agent", success: false });
          return;
        }
        if ((agent.detailFailuresRemaining ?? 0) > 0) {
          agent.detailFailuresRemaining =
            (agent.detailFailuresRemaining ?? 0) - 1;
          json(res, 500, {
            error: "transient control-plane blip",
            success: false,
          });
          return;
        }
        if (agent.resumeRequested && agent.status === "starting") {
          agent.pollsSinceResume += 1;
          if (
            agent.errorAfterPolls !== undefined &&
            agent.pollsSinceResume >= agent.errorAfterPolls
          ) {
            agent.status = "error";
            agent.errorMessage =
              agent.errorMessage ?? "container image pull failed";
          } else if (agent.pollsSinceResume >= agent.bootAfterPolls) {
            agent.status = "running";
          }
        }
        json(res, 200, { success: true, data: agentDto(agent) });
        return;
      }
    }

    json(res, 404, { error: `no mock route for ${method} ${path}` });
  });
}

async function listenInLegRange(server: Server): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    const bound = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolve(true);
      });
    });
    if (bound) return port;
  }
  throw new Error("no free port in the leg-4 range 36400-36499");
}

describe("mock-cloud connect e2e — dedicated cold boot + shared chat bridge", () => {
  const state: MockCloudState = {
    agents: new Map(),
    conversations: new Map(),
    requests: [],
    resumeCalls: [],
  };
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createMockCloud(state);
    const port = await listenInLegRange(server);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setBootConfig(DEFAULT_BOOT_CONFIG);
  });

  beforeEach(() => {
    state.agents.clear();
    state.conversations.clear();
    state.requests.length = 0;
    state.resumeCalls.length = 0;
    // Make the mock origin the recognized direct-cloud base for both
    // isDirectCloudBase() (client-base origin match) and the native fallback.
    setBootConfig({ ...DEFAULT_BOOT_CONFIG, cloudApiBase: base });
  });

  function makeClient(): ElizaClient {
    const client = new ElizaClient(base);
    return client;
  }

  function seedDedicated(overrides: Partial<MockAgent> = {}): MockAgent {
    const agent: MockAgent = {
      id: "agent-ded",
      agentName: "Dedicated Eliza",
      status: "stopped",
      // Stale pre-wake URL vs the fresh post-wake URL: the connect flow must
      // bind the record it re-reads AFTER the agent reports running.
      webUiUrl: `${base}/dedicated/agent-ded-stale`,
      runningWebUiUrl: `${base}/dedicated/agent-ded`,
      bridgeUrl: null,
      bootAfterPolls: 3,
      resumeRequested: false,
      pollsSinceResume: 0,
      proxy202sRemaining: 0,
      ...overrides,
    };
    state.agents.set(agent.id, agent);
    return agent;
  }

  it("waits out a dedicated cold boot: resume kick, starting progress, fresh post-wake base, then a real chat round-trip through the proxy (202 honored)", async () => {
    const agent = seedDedicated({ proxy202sRemaining: 1 });
    const progress: Array<[string, string | undefined]> = [];
    const client = makeClient();

    const result = await client.selectOrProvisionCloudAgent({
      cloudApiBase: base,
      authToken: AUTH_TOKEN,
      name: "Eliza",
      onProgress: (status, detail) => progress.push([status, detail]),
      wakePollIntervalMs: 20,
      wakeTimeoutMs: 5_000,
    });

    // Resume was kicked exactly once and the agent booted through the poll.
    expect(state.resumeCalls).toEqual(["agent-ded"]);
    expect(agent.status).toBe("running");
    expect(result.created).toBe(false);
    expect(result.agentId).toBe("agent-ded");
    // Fresh post-wake URL, not the stale list-DTO URL.
    expect(result.apiBase).toBe(`${base}/dedicated/agent-ded`);

    // Progress streamed through the connect flow's existing plumbing. The
    // reuse lookup reports "listing" (not "creating") so downstream consumers
    // — the first-run silent cloud entry (#15133) — can tell bookkeeping from
    // a real provisioning phase.
    const statuses = progress.map(([status]) => status);
    expect(statuses[0]).toBe("listing"); // "Finding your agents..."
    expect(statuses).toContain("starting");
    expect(statuses[statuses.length - 1]).toBe("ready");
    const startingDetails = progress
      .filter(([status]) => status === "starting")
      .map(([, detail]) => detail ?? "");
    expect(
      startingDetails.some((d) => /cold boot|Starting your agent/i.test(d)),
    ).toBe(true);

    // Now the real chat round-trip through the dedicated proxy base, with the
    // cloud bearer token — the first call eats one 202 + Retry-After
    // (client-base resume honor) before succeeding.
    client.setBaseUrl(result.apiBase, { persist: false });
    client.setToken(AUTH_TOKEN);
    const created = await client.createConversation("hello");
    expect(created.conversation.id).toBe("conv-1");
    expect(agent.proxy202sRemaining).toBe(0);

    const reply = await client.sendConversationMessage(
      created.conversation.id,
      "ping over the unified proxy",
    );
    expect(reply.text).toBe("echo from agent-ded: ping over the unified proxy");

    const { messages } = await client.getConversationMessages(
      created.conversation.id,
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].text).toContain("ping over the unified proxy");

    // The proxy saw authenticated calls only.
    const proxyCalls = state.requests.filter((r) =>
      r.path.startsWith("/dedicated/"),
    );
    expect(proxyCalls.length).toBeGreaterThan(0);
    expect(proxyCalls.every((r) => r.auth === `Bearer ${AUTH_TOKEN}`)).toBe(
      true,
    );
  });

  it("skips the wait entirely for an already-running dedicated agent (no resume, no starting progress)", async () => {
    seedDedicated({
      status: "running",
      webUiUrl: `${base}/dedicated/agent-ded`,
    });
    const progress: string[] = [];
    const client = makeClient();

    const result = await client.selectOrProvisionCloudAgent({
      cloudApiBase: base,
      authToken: AUTH_TOKEN,
      name: "Eliza",
      onProgress: (status) => progress.push(status),
      wakePollIntervalMs: 20,
      wakeTimeoutMs: 1_000,
    });

    expect(result.apiBase).toBe(`${base}/dedicated/agent-ded`);
    expect(state.resumeCalls).toEqual([]);
    expect(progress).not.toContain("starting");
  });

  it("fails fast with the agent's error message on a terminal error status", async () => {
    seedDedicated({
      bootAfterPolls: Number.POSITIVE_INFINITY,
      errorAfterPolls: 2,
      errorMessage: "container image pull failed",
    });
    const client = makeClient();
    await expect(
      client.selectOrProvisionCloudAgent({
        cloudApiBase: base,
        authToken: AUTH_TOKEN,
        name: "Eliza",
        wakePollIntervalMs: 20,
        wakeTimeoutMs: 5_000,
      }),
    ).rejects.toThrow(/failed to start.*container image pull failed/i);
  });

  it("times out with an actionable message when the container never reports running", async () => {
    seedDedicated({ bootAfterPolls: Number.POSITIVE_INFINITY });
    const client = makeClient();
    await expect(
      client.selectOrProvisionCloudAgent({
        cloudApiBase: base,
        authToken: AUTH_TOKEN,
        name: "Eliza",
        wakePollIntervalMs: 20,
        wakeTimeoutMs: 200,
      }),
    ).rejects.toThrow(/still "starting" after \d+s/i);
  });

  it("tolerates transient control-plane poll failures while waiting", async () => {
    // First two detail polls 500 (transient); the wait must keep going.
    const agent = seedDedicated({
      bootAfterPolls: 2,
      detailFailuresRemaining: 2,
    });
    const client = makeClient();
    client.setToken(AUTH_TOKEN);
    const record = await waitForCloudAgentRunning(client, {
      agentId: "agent-ded",
      pollIntervalMs: 20,
      timeoutMs: 5_000,
    });
    expect(record.status).toBe("running");
    expect(agent.status).toBe("running");
    // The 500s were real: the control plane logged them before recovering.
    expect(agent.detailFailuresRemaining).toBe(0);
  });

  it("derives the shared REST-adapter base for a URL-less shared agent and completes the #8387 chat bridge round-trip", async () => {
    const shared: MockAgent = {
      id: "agent-shared",
      agentName: "Shared Eliza",
      status: "running",
      webUiUrl: null,
      bridgeUrl: null,
      bootAfterPolls: 0,
      resumeRequested: false,
      pollsSinceResume: 0,
      proxy202sRemaining: 0,
    };
    state.agents.set(shared.id, shared);

    const client = makeClient();
    const result = await client.selectOrProvisionCloudAgent({
      cloudApiBase: base,
      authToken: AUTH_TOKEN,
      name: "Eliza",
    });

    // No URLs in the list DTO → the shared-runtime REST adapter base (#8387).
    expect(result.apiBase).toBe(`${base}/api/v1/eliza/agents/agent-shared`);
    expect(state.resumeCalls).toEqual([]);

    client.setBaseUrl(result.apiBase, { persist: false });
    client.setToken(AUTH_TOKEN);

    const health = await client.fetch<{ status: string; agentId: string }>(
      "/api/health",
    );
    expect(health).toEqual({ status: "ok", agentId: "agent-shared" });

    const created = await client.createConversation("shared hello");
    const reply = await client.sendConversationMessage(
      created.conversation.id,
      "hello shared runtime",
    );
    expect(reply.text).toBe("echo from agent-shared: hello shared runtime");
    const { messages } = await client.getConversationMessages(
      created.conversation.id,
    );
    expect(messages).toHaveLength(2);

    // Every adapter call carried the cloud bearer token.
    const adapterCalls = state.requests.filter((r) =>
      r.path.startsWith("/api/v1/eliza/agents/agent-shared/api/"),
    );
    expect(adapterCalls.length).toBeGreaterThanOrEqual(4);
    expect(adapterCalls.every((r) => r.auth === `Bearer ${AUTH_TOKEN}`)).toBe(
      true,
    );
  });

  it("rejects (never provisions a duplicate) when the control plane refuses the list", async () => {
    seedDedicated();
    const client = makeClient();
    await expect(
      client.selectOrProvisionCloudAgent({
        cloudApiBase: base,
        authToken: "wrong-token",
        name: "Eliza",
      }),
    ).rejects.toThrow(/unauthorized|find your agents/i);
    // No create POST reached the control plane.
    expect(
      state.requests.filter(
        (r) => r.method === "POST" && r.path === "/api/v1/eliza/agents",
      ),
    ).toEqual([]);
  });
});
