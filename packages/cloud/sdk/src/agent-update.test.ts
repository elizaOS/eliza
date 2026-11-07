import { expect, test } from "bun:test";
import { ElizaCloudClient } from "./client.js";

interface Captured {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

function clientCapturing(
  captured: Captured[],
  body: unknown,
  status = 200,
): ElizaCloudClient {
  return new ElizaCloudClient({
    baseUrl: "http://cloud.test",
    apiKey: "api-key",
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return Response.json(body, { status });
    }) as unknown as typeof fetch,
  });
}

test("updateAgent sends the name and config the route accepts", async () => {
  const captured: Captured[] = [];
  const client = clientCapturing(captured, {
    success: true,
    data: {
      id: "agent-1",
      agentName: "Ops",
      executionTier: "shared",
      updatedAt: "2026-10-13T13:00:00.000Z",
    },
  });

  await client.updateAgent("agent-1", {
    agentName: "Ops",
    agentConfig: { tone: "brief" },
  });

  expect(captured).toEqual([
    {
      method: "PATCH",
      path: "/api/v1/eliza/agents/agent-1",
      body: { agentName: "Ops", agentConfig: { tone: "brief" } },
    },
  ]);
});

test("updateAgentEnvironment sends the variables to the environment route", async () => {
  const captured: Captured[] = [];
  const client = clientCapturing(captured, {
    success: true,
    data: {
      agentId: "agent-1",
      updatedKeys: ["OPENAI_API_KEY"],
      removedKeys: [],
      status: "running",
      executionTier: "dedicated",
      needsRestart: true,
    },
  });

  const response = await client.updateAgentEnvironment("agent-1", {
    environmentVars: { OPENAI_API_KEY: "sk-test" },
  });

  expect(captured).toEqual([
    {
      method: "PATCH",
      path: "/api/v1/eliza/agents/agent-1/environment",
      body: { environmentVars: { OPENAI_API_KEY: "sk-test" } },
    },
  ]);
  expect(response.data?.updatedKeys).toEqual(["OPENAI_API_KEY"]);
  expect(response.data?.needsRestart).toBe(true);
});

test("updateAgentEnvironment sends null to remove a variable and reports it removed", async () => {
  const captured: Captured[] = [];
  const client = clientCapturing(captured, {
    success: true,
    data: {
      agentId: "agent-1",
      updatedKeys: [],
      removedKeys: ["OPENAI_API_KEY"],
      status: "stopped",
      executionTier: "shared",
      needsRestart: false,
    },
  });

  const response = await client.updateAgentEnvironment("agent-1", {
    environmentVars: { OPENAI_API_KEY: null },
  });

  expect(captured[0]?.body).toEqual({
    environmentVars: { OPENAI_API_KEY: null },
  });
  expect(response.data?.removedKeys).toEqual(["OPENAI_API_KEY"]);
  expect(response.data?.updatedKeys).toEqual([]);
});

test("updateAgent throws the route's error body instead of returning it", async () => {
  const captured: Captured[] = [];
  const client = clientCapturing(
    captured,
    { success: false, error: "Provide agentName and/or agentConfig" },
    400,
  );

  await expect(client.updateAgent("agent-1", {})).rejects.toThrow(
    "Provide agentName and/or agentConfig",
  );
  expect(captured).toHaveLength(1);
});
