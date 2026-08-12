/**
 * Regression coverage for Cloud control-plane POSTs returning canonical 202
 * job envelopes. The HTTP transport is deterministic; no live Cloud calls.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-cloud";

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
});
