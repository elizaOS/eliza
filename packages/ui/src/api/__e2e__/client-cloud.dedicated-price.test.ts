/**
 * The Dedicated price header reaches the Cloud API only when the caller holds
 * the owner's acceptance, on both the create and the resume request.
 */
import {
  DEDICATED_COMPUTE_PRICE_HEADER,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ElizaClient } from "../client-base";
import "../client-cloud";

const originalFetch = globalThis.fetch;
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function captureCloudRequests(body: unknown) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

function directCloudClient(): ElizaClient {
  return new ElizaClient(
    "https://api.eliza.app/api/v1/eliza/agents/personal:11111111-1111-5111-8111-111111111111",
    "cloud-session-token",
  );
}

function priceHeader(init: RequestInit): string | null {
  return new Headers(init.headers).get(DEDICATED_COMPUTE_PRICE_HEADER);
}

describe("Dedicated price acceptance header", () => {
  it("sends the accepted price on resume and keeps the bearer", async () => {
    const requests = captureCloudRequests({
      success: true,
      data: { jobId: "job-1", status: "queued", message: "Resuming" },
    });
    const acceptance = getDedicatedComputePriceAcceptance();

    await directCloudClient().resumeCloudCompatAgent(AGENT_ID, {
      dedicatedPriceAcceptance: acceptance,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      `https://api.eliza.app/api/v1/eliza/agents/${AGENT_ID}/resume`,
    );
    expect(requests[0].init.method).toBe("POST");
    expect(priceHeader(requests[0].init)).toBe(acceptance);
    expect(new Headers(requests[0].init.headers).get("Authorization")).toBe(
      "Bearer cloud-session-token",
    );
  });

  it("sends no price header on resume without an acceptance", async () => {
    const requests = captureCloudRequests({
      success: true,
      data: { jobId: "job-1", status: "queued", message: "Resuming" },
    });

    await directCloudClient().resumeCloudCompatAgent(AGENT_ID);
    await directCloudClient().resumeCloudCompatAgent(AGENT_ID, {});

    expect(requests).toHaveLength(2);
    expect(priceHeader(requests[0].init)).toBeNull();
    expect(priceHeader(requests[1].init)).toBeNull();
  });

  it("never sends the price header on suspend", async () => {
    const requests = captureCloudRequests({
      success: true,
      data: { jobId: "job-2", status: "queued", message: "Suspending" },
    });

    await directCloudClient().suspendCloudCompatAgent(AGENT_ID);

    expect(requests).toHaveLength(1);
    expect(priceHeader(requests[0].init)).toBeNull();
  });

  it("sends the accepted price as a header on create, not in the body", async () => {
    const requests = captureCloudRequests({
      success: true,
      created: true,
      data: { id: AGENT_ID, agentName: "Fresh Agent", status: "pending" },
    });
    const acceptance = getDedicatedComputePriceAcceptance();

    await directCloudClient().createCloudCompatAgent({
      agentName: "Fresh Agent",
      forceCreate: true,
      dedicatedPriceAcceptance: acceptance,
    });

    const create = requests.find(
      (request) =>
        request.url === "https://api.eliza.app/api/v1/eliza/agents" &&
        request.init.method === "POST",
    );
    expect(create).toBeDefined();
    if (!create) return;
    expect(priceHeader(create.init)).toBe(acceptance);
    const body = JSON.parse(String(create.init.body)) as Record<
      string,
      unknown
    >;
    expect(body.alwaysOn).toBe(true);
    expect(body).not.toHaveProperty("dedicatedPriceAcceptance");
  });

  it("sends no price header on create without an acceptance", async () => {
    const requests = captureCloudRequests({
      success: true,
      created: true,
      data: { id: AGENT_ID, agentName: "Fresh Agent", status: "pending" },
    });

    await directCloudClient().createCloudCompatAgent({
      agentName: "Fresh Agent",
      forceCreate: true,
    });

    const create = requests.find(
      (request) =>
        request.url === "https://api.eliza.app/api/v1/eliza/agents" &&
        request.init.method === "POST",
    );
    expect(create).toBeDefined();
    if (!create) return;
    expect(priceHeader(create.init)).toBeNull();
  });
});
