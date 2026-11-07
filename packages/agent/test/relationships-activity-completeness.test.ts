/**
 * GET /api/relationships/activity pages through every stored fact: the
 * timeline's `total` is the real count and the oldest fact is reachable by
 * offset paging. Harness as in memory-search-completeness-http.test.ts.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  type IAgentRuntime,
  type Memory,
  Service,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import {
  handleRelationshipsRoutes,
  type RelationshipsRouteContext,
} from "../src/api/relationships-routes.ts";

const AGENT_NAME = "Relationships activity completeness";
const FACT_COUNT = 250;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Minimal graph surface so the route reaches its own facts read; the case is
// about the facts paging, not the graph service.
class EmptyGraphService extends Service {
  static serviceType = "relationships";
  capabilityDescription = "probe stub";
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const s = new EmptyGraphService();
    (s as unknown as { runtime: IAgentRuntime }).runtime = runtime;
    return s;
  }
  async stop(): Promise<void> {}
  async getGraphSnapshot() {
    return { people: [], relationships: [], stats: {} };
  }
  async getPersonDetail() {
    return null;
  }
  async getCandidateMerges() {
    return [];
  }
  async acceptMerge() {
    return null;
  }
  async rejectMerge() {
    return null;
  }
}

async function createRuntime(): Promise<AgentRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), "rel-activity-probe-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: AGENT_NAME, bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      path.join(directory, "agent.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.init();
  cleanups.push(() => runtime.close());
  // runtime.init() does not settle initPromise, so the lazy service starter
  // never runs; place the stub instance directly where getService() reads.
  const stub = await EmptyGraphService.start(runtime);
  (runtime as unknown as { services: Map<string, Service[]> }).services.set(
    "relationships",
    [stub],
  );
  return runtime;
}

interface RouteReply {
  status: number;
  body: unknown;
}

async function get(runtime: AgentRuntime, target: string): Promise<RouteReply> {
  const url = new URL(target, "http://localhost");
  const reply: RouteReply = { status: 0, body: undefined };
  const handled = await handleRelationshipsRoutes({
    req: { url: target } as http.IncomingMessage,
    res: { setHeader() {} } as unknown as http.ServerResponse,
    method: "GET",
    pathname: url.pathname,
    url,
    runtime,
    agentName: AGENT_NAME,
    json: (_res: unknown, data: unknown, status = 200) => {
      reply.status = status;
      reply.body = data;
    },
    error: (_res: unknown, message: string, status = 500) => {
      reply.status = status;
      reply.body = { error: message };
    },
    readJsonBody: async () => null,
  } as unknown as RelationshipsRouteContext);
  expect(handled).toBe(true);
  return reply;
}

async function storeFacts(runtime: AgentRuntime, count: number): Promise<void> {
  const roomId = stringToUuid(`${AGENT_NAME}-room`) as UUID;
  const entityId = randomUUID() as UUID;
  for (let start = 0; start < count; start += 500) {
    const size = Math.min(500, count - start);
    await runtime.createMemories(
      Array.from({ length: size }, (_u, offset) => {
        const index = start + offset;
        return {
          tableName: "facts",
          memory: {
            id: randomUUID() as UUID,
            roomId,
            entityId,
            agentId: runtime.agentId,
            createdAt: 1_700_000_000_000 + index * 1000,
            content: {
              text:
                index === 0
                  ? "oldest fact: allergic to peanuts"
                  : `fact ${index}`,
            },
            metadata: { type: "custom", confidence: 0.9 },
          } as Memory,
        };
      }),
    );
  }
}

it("lists every stored fact in the activity timeline with an honest total", async () => {
  const runtime = await createRuntime();
  await storeFacts(runtime, FACT_COUNT);
  const first = await get(
    runtime,
    "/api/relationships/activity?limit=100&offset=0",
  );
  expect(first.status).toBe(200);
  const body = first.body as {
    total: number;
    count: number;
    hasMore: boolean;
    activity: Array<{ detail: string }>;
  };
  expect(body.total).toBe(FACT_COUNT);
  expect(body.count).toBe(100);
  expect(body.hasMore).toBe(true);
  const all: Array<{ detail: string }> = [];
  for (let offset = 0; offset < FACT_COUNT + 100; offset += 100) {
    const page = (
      await get(
        runtime,
        `/api/relationships/activity?limit=100&offset=${offset}`,
      )
    ).body as { activity: Array<{ detail: string }> };
    all.push(...page.activity);
    if (page.activity.length === 0) break;
  }
  expect(all).toHaveLength(FACT_COUNT);
  expect(all.at(-1)?.detail).toContain("oldest fact");
});

it("reads a facts table of exactly the scan budget in full", async () => {
  const runtime = await createRuntime();
  await storeFacts(runtime, 5000);
  const reply = await get(
    runtime,
    "/api/relationships/activity?limit=1&offset=4999",
  );
  expect(reply.status).toBe(200);
  const body = reply.body as {
    total: number;
    hasMore: boolean;
    activity: Array<{ detail: string }>;
  };
  expect(body.total).toBe(5000);
  expect(body.hasMore).toBe(false);
  expect(body.activity[0]?.detail).toContain("oldest fact");
}, 120_000);
