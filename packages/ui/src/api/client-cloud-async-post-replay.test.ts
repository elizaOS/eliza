/**
 * Regression coverage for Cloud control-plane POSTs and their declared async
 * poll routes. The HTTP transport is deterministic; no live Cloud calls.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-cloud";
import type { CloudCompatAgent } from "./client-types-cloud";

const DIRECT_BASE = "https://api.elizacloud.ai";
const PROXY_BASE = "https://local-agent.example.test";

function acceptedResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

function stubAcceptedPost(body: unknown) {
  const request = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      acceptedResponse(body),
  );
  vi.stubGlobal("fetch", request);
  return request;
}

function expectOnePost(
  request: ReturnType<typeof stubAcceptedPost>,
  suffix: string,
): void {
  expect(request).toHaveBeenCalledOnce();
  expect(String(request.mock.calls[0]?.[0]).endsWith(suffix)).toBe(true);
  expect(request.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
}

function proxyAgent(status: string, agentId = "agent-1"): CloudCompatAgent {
  return {
    agent_id: agentId,
    agent_name: "Eliza",
    node_id: null,
    container_id: null,
    headscale_ip: null,
    bridge_url: null,
    web_ui_url: `https://${agentId}.elizacloud.ai`,
    status,
    agent_config: {},
    created_at: "2026-08-11T00:00:00.000Z",
    updated_at: "2026-08-11T00:00:00.000Z",
    containerUrl: `https://${agentId}.elizacloud.ai`,
    webUiUrl: `https://${agentId}.elizacloud.ai`,
    database_status: "ok",
    error_message: null,
    last_heartbeat_at: null,
    execution_tier: "dedicated-always",
  };
}

describe("Cloud async control-plane POSTs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the first force-create job without minting a second cookie-auth agent", async () => {
    const request = stubAcceptedPost({
      success: true,
      created: true,
      source: "cold_provision",
      data: {
        agentId: "agent-created",
        agentName: "Eliza",
        jobId: "job-create-original",
        status: "queued",
      },
    });
    const client = new ElizaClient(DIRECT_BASE);

    const result = await client.createCloudCompatAgent({
      agentName: "Eliza",
      forceCreate: true,
    });

    expectOnePost(request, "/api/v1/eliza/agents");
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      forceCreate: true,
    });
    expect(result.data.jobId).toBe("job-create-original");
  });

  it("preserves the first compat create job", async () => {
    const request = stubAcceptedPost({
      success: true,
      created: true,
      source: "cold_provision",
      data: {
        agentId: "agent-compat",
        agentName: "Eliza",
        jobId: "job-create-compat-original",
        status: "queued",
        nodeId: null,
        message: "Agent create queued",
      },
    });
    const client = new ElizaClient(PROXY_BASE);

    const result = await client.createCloudCompatAgent({ agentName: "Eliza" });

    expectOnePost(request, "/api/cloud/compat/agents");
    expect(result.data.jobId).toBe("job-create-compat-original");
  });

  it("composes proxy compat create through the synthetic agent job namespace", async () => {
    const agentId = "agent-created";
    const returnedJobId = "job-create-compat-distinct";
    const request = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/api/cloud/compat/agents" && init?.method === "POST") {
          return acceptedResponse({
            success: true,
            created: true,
            source: "cold_provision",
            data: {
              agentId,
              agentName: "Eliza",
              jobId: returnedJobId,
              status: "queued",
              nodeId: null,
              message: "Agent create queued",
            },
          });
        }
        if (path === `/api/cloud/compat/jobs/${agentId}`) {
          return Response.json({
            success: true,
            data: {
              id: agentId,
              jobId: agentId,
              status: "completed",
              type: "agent_provision",
            },
          });
        }
        if (path === `/api/cloud/compat/agents/${agentId}`) {
          return Response.json({
            success: true,
            data: proxyAgent("running", agentId),
          });
        }
        return Response.json({ error: `unexpected ${path}` }, { status: 404 });
      },
    );
    vi.stubGlobal("fetch", request);
    const client = new ElizaClient(PROXY_BASE);

    const result = await client.selectOrProvisionCloudAgent({
      cloudApiBase: DIRECT_BASE,
      authToken: "test-token",
      knownAgents: [],
      name: "Eliza",
      wakePollIntervalMs: 1,
      wakeTimeoutMs: 50,
    });

    expect(result).toMatchObject({
      agentId,
      created: true,
      jobId: agentId,
      source: "cold_provision",
    });
    const calls = request.mock.calls.map(([input, init]) => ({
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
    }));
    expect(calls).toEqual([
      { method: "POST", path: "/api/cloud/compat/agents" },
      { method: "GET", path: `/api/cloud/compat/jobs/${agentId}` },
      { method: "GET", path: `/api/cloud/compat/agents/${agentId}` },
    ]);
    expect(
      calls.some(
        ({ path }) => path === `/api/cloud/compat/jobs/${returnedJobId}`,
      ),
    ).toBe(false);
    expect(
      calls.some(({ path }) => path.startsWith("/api/cloud/v1/jobs/")),
    ).toBe(false);
  });

  for (const branch of [
    {
      base: DIRECT_BASE,
      name: "cookie-auth direct",
      suffix: "/api/v1/eliza/agents/agent-1/provision",
    },
    {
      base: PROXY_BASE,
      name: "compat proxy",
      suffix: "/api/cloud/v1/eliza/agents/agent-1/provision",
    },
  ]) {
    it(`preserves the first ${branch.name} provision job`, async () => {
      const request = stubAcceptedPost({
        success: true,
        data: {
          agentId: "agent-1",
          jobId: `job-provision-${branch.name}`,
          status: "queued",
        },
      });
      const client = new ElizaClient(branch.base);

      const result = await client.provisionCloudCompatAgent("agent-1");

      expectOnePost(request, branch.suffix);
      expect(result.data?.jobId).toBe(`job-provision-${branch.name}`);
    });
  }

  for (const action of ["resume", "wake"] as const) {
    for (const branch of [
      {
        base: DIRECT_BASE,
        name: "cookie-auth direct",
        suffix: `/api/v1/eliza/agents/agent-1/${action}`,
      },
      {
        base: PROXY_BASE,
        name: "compat proxy",
        suffix:
          action === "wake"
            ? "/api/cloud/v1/eliza/agents/agent-1/wake"
            : "/api/cloud/compat/agents/agent-1/resume",
      },
    ]) {
      it(`preserves the first ${branch.name} ${action} job`, async () => {
        const jobId = `job-${action}-${branch.name}`;
        const request = stubAcceptedPost({
          success: true,
          data: {
            jobId,
            status: "queued",
            message: `${action} queued`,
          },
        });
        const client = new ElizaClient(branch.base);

        const result =
          action === "wake"
            ? await client.wakeCloudCompatAgent("agent-1")
            : await client.resumeCloudCompatAgent("agent-1");

        expectOnePost(request, branch.suffix);
        expect(result.data.jobId).toBe(jobId);
      });
    }
  }

  for (const branch of [
    {
      jobKind: "v1",
      mutationPath: "/api/cloud/v1/eliza/agents/agent-1/wake",
      name: "sleeping wake",
      status: "sleeping",
      trigger: "wake",
    },
    {
      jobKind: "v1",
      mutationPath: "/api/cloud/v1/eliza/agents/agent-1/provision",
      name: "disconnected reprovision",
      status: "disconnected",
      trigger: "provision",
    },
    {
      jobKind: "compat",
      mutationPath: "/api/cloud/compat/agents/agent-1/resume",
      name: "stopped resume",
      status: "stopped",
      trigger: "resume",
    },
  ] as const) {
    it(`composes proxy ${branch.name} through its declared ${branch.jobKind} job namespace`, async () => {
      const jobId =
        branch.jobKind === "v1" ? `job-${branch.trigger}-proxy` : "agent-1";
      const jobPath =
        branch.jobKind === "v1"
          ? `/api/cloud/v1/jobs/${jobId}`
          : `/api/cloud/compat/jobs/${jobId}`;
      const request = vi.fn(
        async (input: RequestInfo | URL, _init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (path === branch.mutationPath) {
            return acceptedResponse({
              success: true,
              alreadyInProgress: branch.trigger === "provision",
              data: {
                agentId: "agent-1",
                jobId,
                status: "queued",
                message: `${branch.trigger} queued`,
              },
            });
          }
          if (path === jobPath) {
            return Response.json({
              success: true,
              data: {
                id: jobId,
                jobId,
                status: "completed",
                type: `agent_${branch.trigger}`,
              },
            });
          }
          if (path === "/api/cloud/compat/agents/agent-1") {
            return Response.json({
              success: true,
              data: proxyAgent("running"),
            });
          }
          return Response.json(
            { error: `unexpected ${path}` },
            { status: 404 },
          );
        },
      );
      vi.stubGlobal("fetch", request);
      const client = new ElizaClient(PROXY_BASE);

      const result = await client.selectOrProvisionCloudAgent({
        cloudApiBase: DIRECT_BASE,
        authToken: "test-token",
        knownAgents: [proxyAgent(branch.status)],
        name: "Eliza",
        wakePollIntervalMs: 1,
        wakeTimeoutMs: 50,
      });

      expect(result).toMatchObject({
        agentId: "agent-1",
        created: false,
        jobId,
        source:
          branch.trigger === "wake"
            ? "existing_wake"
            : branch.trigger === "resume"
              ? "existing_resume"
              : "existing_provision",
      });
      const calls = request.mock.calls.map(([input, init]) => ({
        method: init?.method ?? "GET",
        path: new URL(String(input)).pathname,
      }));
      expect(calls).toEqual([
        { method: "POST", path: branch.mutationPath },
        { method: "GET", path: jobPath },
        { method: "GET", path: "/api/cloud/compat/agents/agent-1" },
      ]);
      const wrongJobPrefix =
        branch.jobKind === "v1"
          ? "/api/cloud/compat/jobs/"
          : "/api/cloud/v1/jobs/";
      expect(calls.some(({ path }) => path.startsWith(wrongJobPrefix))).toBe(
        false,
      );
    });
  }
});
