#!/usr/bin/env bun
/**
 * Deploy a trivial test agent via the Eliza Cloud staging API and wait
 * for it to reach `running` / `databaseStatus=ready`. Mirrors the
 * pattern in `live-cloud-provision-smoke.ts` but trimmed to the minimum
 * needed for the E2E heartbeat check.
 */

import { randomBytes } from "node:crypto";
import { appendStateAtomic } from "./state-file";

const DEFAULT_BASE_URL = "https://api-staging.elizacloud.ai";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[hetzner-e2e-deploy-agent] missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type JsonObject = Record<string, unknown>;

const baseUrl = (process.env.CLOUD_SMOKE_BASE_URL ?? DEFAULT_BASE_URL).replace(
  /\/+$/,
  "",
);
const apiKey = requireEnv("CLOUD_E2E_API_KEY");
const runId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const timeoutMs = 240_000;
const pollIntervalMs = 5_000;

async function requestJson(
  path: string,
  init: RequestInit = {},
  expected: number[] = [200],
): Promise<{ status: number; body: JsonObject }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("accept", "application/json");
  headers.set("user-agent", "hetzner-e2e/1.0");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(130_000),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as JsonObject) : {};
  if (!expected.includes(response.status)) {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${response.status}: ${text.slice(0, 300)}`,
    );
  }
  return { status: response.status, body };
}

async function createAgent(): Promise<string> {
  const { body } = await requestJson(
    "/api/v1/eliza/agents",
    {
      method: "POST",
      body: JSON.stringify({
        agentName: `hetzner-e2e-${runId}`,
        agentConfig: {
          name: `Hetzner E2E ${runId}`,
          username: `hetzner-e2e-${runId}`,
          system: "Minimal agent for hetzner E2E heartbeat.",
          bio: ["Hetzner E2E agent."],
          topics: ["e2e"],
          adjectives: ["concise"],
          plugins: ["@elizaos/plugin-sql", "@elizaos/plugin-elizacloud"],
          settings: { secrets: {} },
        },
        environmentVars: { HETZNER_E2E_RUN_ID: runId },
      }),
    },
    [201],
  );
  const data = body.data as JsonObject | undefined;
  if (!data || typeof data.id !== "string") {
    throw new Error("Create agent response missing data.id");
  }
  return data.id;
}

async function provisionAgent(agentId: string): Promise<string> {
  const { body } = await requestJson(
    `/api/v1/eliza/agents/${agentId}/provision`,
    { method: "POST" },
    [202],
  );
  const data = body.data as JsonObject | undefined;
  if (!data || typeof data.jobId !== "string") {
    throw new Error("Provision response missing jobId");
  }
  return data.jobId;
}

async function waitForJob(jobId: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const { body } = await requestJson(`/api/v1/jobs/${jobId}`);
    const data = body.data as JsonObject | undefined;
    const status = typeof data?.status === "string" ? data.status : "unknown";
    if (status !== last) {
      console.log(`[hetzner-e2e-deploy-agent] job ${jobId} -> ${status}`);
      last = status;
    }
    if (status === "completed") return;
    if (
      status === "failed" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      throw new Error(`Job ${jobId} ended in ${status}`);
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function main(): Promise<void> {
  const agentId = await createAgent();
  appendStateAtomic({ agent_id: agentId });
  console.log(`[hetzner-e2e-deploy-agent] agent created ${agentId}`);

  const jobId = await provisionAgent(agentId);
  await waitForJob(jobId);
  console.log(`[hetzner-e2e-deploy-agent] agent running ${agentId}`);
}

await main();
