/**
 * Tests real Linear service/action behavior over the in-memory runtime with a
 * deterministic injected transport; no part of the system under test is mocked.
 */

import {
  type ActionParameters,
  AgentRuntime,
  createCharacter,
  InMemoryDatabaseAdapter,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linearAction } from "./action.js";
import { LinearClient } from "./client.js";
import { LinearError } from "./errors.js";
import { linearPlugin } from "./plugin.js";
import { LINEAR_SERVICE_TYPE, LinearService } from "./service.js";

const AGENT_ID = "11111111-1111-4111-a111-111111111111" as UUID;
const OWNER_ID = "22222222-2222-4222-a222-222222222222" as UUID;
const ROOM_ID = "44444444-4444-4444-a444-444444444444" as UUID;

const issue = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix sign-in redirect",
  url: "https://linear.app/acme/issue/ENG-1",
  priority: 2,
  updatedAt: "2026-08-01T00:00:00.000Z",
  state: { name: "In Progress", type: "started" as const },
  team: { id: "team-1", key: "ENG", name: "Engineering" },
  assignee: { id: "user-1", name: "Ada" },
};

interface CapturedRequest {
  headers: Headers;
  body: {
    operationName?: string;
    variables?: Record<string, unknown>;
  };
}

function clientWith(
  respond: (request: CapturedRequest) => Response,
  credential: { type: "apiKey" | "oauth"; value: string } = {
    type: "apiKey",
    value: "lin_api_test_key",
  },
  captured?: CapturedRequest[],
): LinearClient {
  return new LinearClient({
    credential,
    testTransport: {
      fetchImpl: vi.fn(async (input, init) => {
        const request: CapturedRequest = {
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body ?? "{}")),
        };
        captured?.push(request);
        void input;
        return respond(request);
      }),
    },
  });
}

function issuesResponse(
  nodes: (typeof issue)[],
  endCursor: string | null = null,
): Response {
  return Response.json({
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage: endCursor !== null, endCursor },
      },
    },
  });
}

function message(): Memory {
  return {
    id: "55555555-5555-4555-a555-555555555555" as UUID,
    agentId: AGENT_ID,
    entityId: OWNER_ID,
    roomId: ROOM_ID,
    content: { text: "linear" },
  };
}

function runtimeWith(service: LinearService): AgentRuntime {
  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character: createCharacter({ name: "Linear Test" }),
    adapter: new InMemoryDatabaseAdapter(),
    disableBasicCapabilities: true,
    logLevel: "fatal",
  });
  vi.spyOn(runtime, "getService").mockImplementation((serviceType) =>
    serviceType === LINEAR_SERVICE_TYPE ? service : null,
  );
  return runtime;
}

async function invoke(runtime: AgentRuntime, parameters: ActionParameters) {
  const actionResult = await linearAction.handler(
    runtime,
    message(),
    undefined,
    { parameters },
  );
  if (!actionResult) throw new Error("LINEAR handler returned no result");
  return actionResult;
}

describe("linearPlugin registration", () => {
  it("registers the umbrella and every promoted subaction as read-only", () => {
    expect(linearPlugin.actions?.map((action) => action.name)).toEqual([
      "LINEAR",
      "LINEAR_MY_ISSUES",
      "LINEAR_SEARCH",
      "LINEAR_ISSUE",
      "LINEAR_TEAMS",
    ]);
    for (const action of linearPlugin.actions ?? []) {
      expect(action.tags).toContain("domain:work");
      expect(action.tags).toContain("capability:read");
      expect(action.tags).not.toContain("capability:write");
    }
  });
});

describe("LinearService credential resolution", () => {
  it("fails with a typed not-configured error when no credential exists", async () => {
    const runtime = new AgentRuntime({
      agentId: AGENT_ID,
      character: createCharacter({ name: "Linear Unconfigured" }),
      adapter: new InMemoryDatabaseAdapter(),
      disableBasicCapabilities: true,
      logLevel: "fatal",
    });
    const service = new LinearService(runtime);
    await expect(service.getViewer()).rejects.toMatchObject({
      code: "LINEAR_NOT_CONFIGURED",
    });
    expect(service.isConfigured()).toBe(false);
  });

  it("sends a personal API key as a raw Authorization value", async () => {
    const captured: CapturedRequest[] = [];
    const client = clientWith(
      () => issuesResponse([issue]),
      { type: "apiKey", value: "lin_api_test_key" },
      captured,
    );
    await client.searchIssues({ query: "sign-in" });
    expect(captured[0]?.headers.get("authorization")).toBe("lin_api_test_key");
  });

  it("sends an OAuth token as a Bearer Authorization value", async () => {
    const captured: CapturedRequest[] = [];
    const client = clientWith(
      () => issuesResponse([issue]),
      { type: "oauth", value: "oauth_token_value" },
      captured,
    );
    await client.searchIssues({ query: "sign-in" });
    expect(captured[0]?.headers.get("authorization")).toBe(
      "Bearer oauth_token_value",
    );
  });

  it("rejects non-HTTPS and credential-bearing endpoints", () => {
    for (const endpoint of [
      "http://api.linear.app/graphql",
      "https://user:pass@api.linear.app/graphql",
      "https://api.linear.app/graphql?key=x",
    ]) {
      expect(
        () =>
          new LinearClient({
            credential: { type: "apiKey", value: "k" },
            endpoint,
          }),
      ).toThrowError(LinearError);
    }
  });
});

describe("LINEAR action", () => {
  let captured: CapturedRequest[];
  let runtime: AgentRuntime;

  beforeEach(() => {
    captured = [];
    const client = clientWith(
      (request) => {
        if (request.body.operationName === "Issues")
          return issuesResponse([issue], "cursor-2");
        if (request.body.operationName === "Issue")
          return Response.json({ data: { issue: null } });
        if (request.body.operationName === "Teams")
          return Response.json({
            data: {
              teams: {
                nodes: [issue.team],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        return Response.json({ data: { viewer: { id: "u", name: "Ada" } } });
      },
      { type: "apiKey", value: "lin_api_test_key" },
      captured,
    );
    runtime = runtimeWith(new LinearService(undefined, client));
  });

  it("defaults to the caller's assigned issues with an isMe filter", async () => {
    const result = await invoke(runtime, {});
    expect(result.success).toBe(true);
    expect(result.userFacingText).toContain("ENG-1");
    expect(result.userFacingText).toContain("More issues are available.");
    expect(captured[0]?.body.variables?.filter).toEqual({
      assignee: { isMe: { eq: true } },
    });
  });

  it("requires at least one search filter", async () => {
    const result = await invoke(runtime, { action: "search" });
    expect(result.success).toBe(false);
    expect(result.data?.code).toBe("LINEAR_INVALID_INPUT");
    expect(captured).toHaveLength(0);
  });

  it("builds a deterministic typed filter from search parameters", async () => {
    const result = await invoke(runtime, {
      action: "search",
      query: "sign-in",
      teamKey: "ENG",
      state: "started",
      limit: 5,
    });
    expect(result.success).toBe(true);
    expect(captured[0]?.body.variables).toEqual({
      filter: {
        title: { containsIgnoreCase: "sign-in" },
        team: { key: { eq: "ENG" } },
        state: { type: { eq: "started" } },
      },
      first: 5,
      after: null,
    });
  });

  it("rejects an unknown state filter before any HTTP request", async () => {
    const result = await invoke(runtime, {
      action: "search",
      query: "x",
      state: "doing",
    });
    expect(result.success).toBe(false);
    expect(result.data?.code).toBe("LINEAR_INVALID_INPUT");
    expect(captured).toHaveLength(0);
  });

  it("rejects malformed limits before any HTTP request", async () => {
    for (const limit of ["1", 1.5, Number.NaN, 0, 101, true, null]) {
      const result = await invoke(runtime, {
        action: "search",
        query: "x",
        limit,
      } as ActionParameters);
      expect(result.success).toBe(false);
      expect(result.data?.code).toBe("LINEAR_INVALID_INPUT");
    }
    expect(captured).toHaveLength(0);
  });

  it("rejects malformed cursor, assignedToMe, and teamKey before any HTTP request", async () => {
    const malformed: ActionParameters[] = [
      { action: "search", query: "x", cursor: 7 },
      { action: "search", query: "x", cursor: "" },
      { action: "search", query: "x", assignedToMe: "yes" },
      { action: "search", query: "x", teamKey: 9 },
      { action: "my_issues", teamKey: false },
      { action: "issue", identifier: 42 },
    ] as ActionParameters[];
    for (const parameters of malformed) {
      const result = await invoke(runtime, parameters);
      expect(result.success).toBe(false);
      expect(result.data?.code).toBe("LINEAR_INVALID_INPUT");
    }
    expect(captured).toHaveLength(0);
  });

  it("reports a missing issue as an explicit not-found result", async () => {
    const result = await invoke(runtime, {
      action: "issue",
      identifier: "ENG-404",
    });
    expect(result.success).toBe(false);
    expect(result.data?.code).toBe("LINEAR_NOT_FOUND");
    expect(result.userFacingText).toContain("ENG-404");
  });

  it("lists teams", async () => {
    const result = await invoke(runtime, { action: "teams" });
    expect(result.success).toBe(true);
    expect(result.userFacingText).toContain("ENG · Engineering");
  });

  it("translates rate limiting into a retryable result with metadata", async () => {
    const limited = clientWith(() =>
      Response.json(
        { errors: [{ extensions: { code: "RATELIMITED" } }] },
        { status: 429, headers: { "retry-after": "3" } },
      ),
    );
    const limitedRuntime = runtimeWith(new LinearService(undefined, limited));
    const result = await invoke(limitedRuntime, {});
    expect(result.success).toBe(false);
    expect(result.data?.code).toBe("LINEAR_RATE_LIMITED");
    expect(result.data?.retryable).toBe(true);
    expect(result.data?.retryAfterMs).toBe(3_000);
  });

  it("keeps the credential out of results and error payloads", async () => {
    const failing = clientWith(() =>
      Response.json({ message: "boom" }, { status: 500 }),
    );
    const failingRuntime = runtimeWith(new LinearService(undefined, failing));
    const failure = await invoke(failingRuntime, {});
    const success = await invoke(runtime, {});
    for (const payload of [failure, success]) {
      expect(JSON.stringify(payload)).not.toContain("lin_api_test_key");
    }
  });

  it("reports an unregistered service as a typed unavailable result", async () => {
    const bare = new AgentRuntime({
      agentId: AGENT_ID,
      character: createCharacter({ name: "Linear Bare" }),
      adapter: new InMemoryDatabaseAdapter(),
      disableBasicCapabilities: true,
      logLevel: "fatal",
    });
    const result = await invoke(bare, {});
    expect(result.success).toBe(false);
    expect(result.data?.code).toBe("LINEAR_UNAVAILABLE");
  });
});
