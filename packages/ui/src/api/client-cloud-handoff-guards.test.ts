/**
 * Cloud handoff readiness must never switch the app onto a shared runtime.
 * Each case runs the real `ElizaClient.startCloudAgentHandoff` against a
 * loopback HTTP server that answers every route a completed switch needs
 * (agent detail, runtime health, shared conversation, import), so the guard
 * under test is the only thing between the target and a switch. No module or
 * function doubles; rejections are counted from real, handled polls.
 */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-cloud";

type AgentDetail = {
  id: string;
  status: string;
  webUiUrl: string;
  executionTier?: "shared" | "dedicated";
};

type CloudStandIn = {
  base: string;
  detailReads: (agentId: string) => number;
  runtimeContacts: () => number;
};

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  server.close();
  await once(server, "close");
  server = null;
});

async function startCloud(
  detailFor: (base: string, agentId: string) => AgentDetail | null,
): Promise<CloudStandIn> {
  const reads = new Map<string, number>();
  let runtimeContacts = 0;
  let base = "";
  server = createServer((request, response) => {
    const path = request.url ?? "";
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const detail = /^\/api\/v1\/eliza\/agents\/([^/]+)$/.exec(path);
    if (detail && request.method === "GET") {
      const agentId = decodeURIComponent(detail[1] ?? "");
      reads.set(agentId, (reads.get(agentId) ?? 0) + 1);
      const data = detailFor(base, agentId);
      reply(data ? 200 : 404, { success: Boolean(data), data });
      return;
    }
    if (path.endsWith("/api/health") || path.endsWith("/import")) {
      runtimeContacts += 1;
      reply(200, { ok: true, inserted: 0 });
      return;
    }
    if (path.endsWith("/messages")) {
      reply(200, { messages: [] });
      return;
    }
    reply(404, { error: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    detailReads: (agentId) => reads.get(agentId) ?? 0,
    runtimeContacts: () => runtimeContacts,
  };
}

async function runHandoff(
  cloud: CloudStandIn,
  options: { agentId: string; dedicatedAgentId?: string },
) {
  const switchedTo: string[] = [];
  const result = await new ElizaClient(cloud.base).startCloudAgentHandoff({
    agentId: options.agentId,
    dedicatedAgentId: options.dedicatedAgentId,
    sharedApiBase: `${cloud.base}/api/v1/eliza/agents/${options.agentId}`,
    conversationId: options.agentId,
    cloudApiBase: cloud.base,
    authToken: "session-token",
    onSwitch: (target) => {
      switchedTo.push(target);
    },
    intervalMs: 5,
    timeoutMs: 400,
  });
  return { result, switchedTo };
}

describe("startCloudAgentHandoff never switches onto a shared runtime", () => {
  it("switches to a ready dedicated target through the same HTTP fixture", async () => {
    const cloud = await startCloud((base, agentId) => ({
      id: agentId,
      status: "running",
      webUiUrl: `${base}/runtime/${agentId}`,
      executionTier: "dedicated",
    }));

    const { result, switchedTo } = await runHandoff(cloud, {
      agentId: "shared-1",
      dedicatedAgentId: "dedicated-1",
    });

    expect(result.status).toBe("switched-empty");
    expect(switchedTo).toEqual([`${cloud.base}/runtime/dedicated-1`]);
    expect(cloud.detailReads("dedicated-1")).toBeGreaterThan(0);
    expect(cloud.runtimeContacts()).toBeGreaterThan(0);
  });

  it("refuses a shared source with no dedicated target, even when the control plane omits executionTier", async () => {
    const cloud = await startCloud((base, agentId) => ({
      id: agentId,
      status: "running",
      webUiUrl: `${base}/runtime/${agentId}`,
    }));

    const { result, switchedTo } = await runHandoff(cloud, {
      agentId: "shared-1",
    });

    expect(result.status).toBe("timed-out");
    expect(switchedTo).toEqual([]);
    // The refusal precedes any read, so the whole budget passes untouched.
    expect(cloud.detailReads("shared-1")).toBe(0);
    expect(cloud.runtimeContacts()).toBe(0);
  });

  it("refuses a running target whose control-plane row is shared-tier", async () => {
    const cloud = await startCloud((base, agentId) => ({
      id: agentId,
      status: "running",
      webUiUrl: `${base}/runtime/${agentId}`,
      executionTier: "shared",
    }));

    const { result, switchedTo } = await runHandoff(cloud, {
      agentId: "shared-1",
      dedicatedAgentId: "dedicated-1",
    });

    expect(result.status).toBe("timed-out");
    expect(switchedTo).toEqual([]);
    // Polls are sequential, so a third read proves two handled refusals.
    expect(cloud.detailReads("dedicated-1")).toBeGreaterThanOrEqual(3);
    expect(cloud.runtimeContacts()).toBe(0);
  });

  it("refuses a target that advertises the shared REST adapter as its runtime", async () => {
    const cloud = await startCloud((base, agentId) => ({
      id: agentId,
      status: "running",
      webUiUrl: `${base}/api/v1/eliza/agents/${agentId}`,
      executionTier: "dedicated",
    }));

    const { result, switchedTo } = await runHandoff(cloud, {
      agentId: "shared-1",
      dedicatedAgentId: "dedicated-1",
    });

    expect(result.status).toBe("timed-out");
    expect(switchedTo).toEqual([]);
    expect(cloud.detailReads("dedicated-1")).toBeGreaterThanOrEqual(3);
    expect(cloud.runtimeContacts()).toBe(0);
  });
});
