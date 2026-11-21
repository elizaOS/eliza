/**
 * Real HTTP boundary for the relationships paging check: GET /api/relationships/graph
 * and GET /api/relationships/people read `limit` and `offset`, but only the
 * sibling `/activity` route checked them. An invalid `limit` was dropped before
 * the query was built, and the graph service reads a missing limit as no limit,
 * so a caller that asked for zero rows received every person in the graph.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type IAgentRuntime, Service } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { registerTokenRoleResolver } from "../src/api/boundary-role-resolver.ts";
import { startApiServer } from "../src/api/server.ts";

const PEOPLE = [
  { primaryEntityId: "person-1", displayName: "Ada", memberEntityIds: [] },
  { primaryEntityId: "person-2", displayName: "Grace", memberEntityIds: [] },
  {
    primaryEntityId: "person-3",
    displayName: "Katherine",
    memberEntityIds: [],
  },
];

interface GraphQuery {
  limit?: number;
  offset?: number;
}

/** Applies the paging rule the real relationships graph service applies. */
class GraphStub extends Service {
  static serviceType = "relationships";
  capabilityDescription = "probe stub";
  readonly queries: GraphQuery[] = [];

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new GraphStub();
    (service as unknown as { runtime: IAgentRuntime }).runtime = runtime;
    return service;
  }

  async stop(): Promise<void> {}

  async getGraphSnapshot(query: GraphQuery = {}) {
    this.queries.push(query);
    const offset = Math.max(0, query.offset ?? 0);
    const limit =
      typeof query.limit === "number" && query.limit > 0
        ? query.limit
        : PEOPLE.length;
    return {
      people: PEOPLE.slice(offset, offset + limit),
      relationships: [],
      stats: {
        totalPeople: PEOPLE.length,
        totalRelationships: 0,
        totalIdentities: 0,
      },
    };
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

let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let graph: GraphStub;
let unregisterResolver: (() => void) | undefined;
let stateDir: string;

beforeAll(async () => {
  stateDir = await mkdtemp(
    path.join(tmpdir(), "eliza-relationships-paging-http-"),
  );
  await writeFile(path.join(stateDir, "eliza.json"), "{}");
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(stateDir, "eliza.json"));
  vi.stubEnv("ELIZA_CLOUD_PROVISIONED", undefined);
  fixture = await createTestRuntime({
    characterName: "RelationshipsPagingHttp",
  });
  unregisterResolver = registerTokenRoleResolver({
    id: "relationships-paging-http-test",
    resolve: (req) => {
      if (req.headers["x-test-role"] !== "owner") return null;
      return {
        providerId: "relationships-paging-http-test",
        worldRole: "OWNER",
        principal: "relationships-paging-owner",
        isAdmin: true,
        isRouteInScope: () => true,
        claims: {},
      };
    },
  });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
  graph = (await GraphStub.start(fixture.runtime)) as GraphStub;
  (
    fixture.runtime as unknown as { services: Map<string, Service[]> }
  ).services.set("relationships", [graph]);
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  unregisterResolver?.();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
}, 120_000);

async function get(target: string) {
  return await fetch(`http://127.0.0.1:${server.port}${target}`, {
    method: "GET",
    headers: { "x-test-role": "owner" },
  });
}

afterEach(() => {
  graph.queries.length = 0;
});

it("answers 400 for a limit that is not a positive integer on the graph route", async () => {
  const response = await get("/api/relationships/graph?limit=0");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "Invalid relationships pagination.",
  });
  expect(graph.queries).toEqual([]);
});

it("answers 400 for a limit that is not a number on the graph route", async () => {
  const response = await get("/api/relationships/graph?limit=abc");
  expect(response.status).toBe(400);
  expect(graph.queries).toEqual([]);
});

it("answers 400 for a limit that is not a positive integer on the people route", async () => {
  const response = await get("/api/relationships/people?limit=0");
  expect(response.status).toBe(400);
  expect(graph.queries).toEqual([]);
});

it("answers 400 for an offset that is not a non-negative integer on the graph route", async () => {
  const response = await get("/api/relationships/graph?offset=-1");
  expect(response.status).toBe(400);
  expect(graph.queries).toEqual([]);
});

it("keeps a valid limit and offset on the graph route", async () => {
  const response = await get("/api/relationships/graph?limit=1&offset=1");
  expect(response.status).toBe(200);
  expect(graph.queries).toHaveLength(1);
  expect(graph.queries[0]).toMatchObject({ limit: 1, offset: 1 });
  const body = (await response.json()) as { data: { people: unknown[] } };
  expect(body.data.people).toHaveLength(1);
});

it("keeps the unpaged graph request working when no paging is asked for", async () => {
  const response = await get("/api/relationships/graph");
  expect(response.status).toBe(200);
  expect(graph.queries).toHaveLength(1);
  expect(graph.queries[0]?.limit).toBeUndefined();
  expect(graph.queries[0]?.offset).toBeUndefined();
  const body = (await response.json()) as { data: { people: unknown[] } };
  expect(body.data.people).toHaveLength(PEOPLE.length);
});
