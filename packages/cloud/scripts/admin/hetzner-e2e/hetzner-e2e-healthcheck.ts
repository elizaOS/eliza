#!/usr/bin/env bun
/**
 * Poll the deployed agent's JSON-RPC bridge until it is healthy, retrying only
 * explicit warming responses from the Cloud API. Exit 0 = healthy, nonzero =
 * failure.
 */

import { readState } from "./state-file";

const DEFAULT_BASE_URL = "https://api-staging.elizacloud.ai";
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_RETRY_DELAY_MS = 2_000;

type FetchBridge = (input: string, init: RequestInit) => Promise<Response>;

interface HealthcheckOptions {
  apiKey: string;
  baseUrl: string;
  agentId: string;
  fetchBridge?: FetchBridge;
  sleep?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[hetzner-e2e-healthcheck] missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

function isRetryableWarmingResponse(text: string): boolean {
  try {
    const body = JSON.parse(text) as { retryable?: unknown };
    return body.retryable === true;
  } catch {
    // error-policy:J3 An invalid error body is not evidence that retry is safe.
    return false;
  }
}

export async function runHealthcheck({
  apiKey,
  baseUrl,
  agentId,
  fetchBridge = fetch,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
}: HealthcheckOptions): Promise<void> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`Healthcheck maxAttempts must be positive: ${maxAttempts}`);
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetchBridge(
      `${baseUrl}/api/v1/eliza/agents/${agentId}/bridge`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "hetzner-e2e/1.0",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `health-${Date.now()}`,
          method: "status.get",
          params: {},
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      const retryable =
        response.status === 503 && isRetryableWarmingResponse(text);
      if (retryable && attempt < maxAttempts) {
        console.log(
          `[hetzner-e2e-healthcheck] bridge warming; retrying ${attempt}/${maxAttempts}`,
        );
        await sleep(retryDelayMs);
        continue;
      }
      throw new Error(
        `Healthcheck HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    const body = JSON.parse(text) as {
      result?: { ready?: boolean };
      error?: unknown;
    };
    if (body.error) {
      throw new Error(
        `Healthcheck JSON-RPC error: ${JSON.stringify(body.error).slice(0, 300)}`,
      );
    }
    if (body.result?.ready !== true) {
      throw new Error(
        `Healthcheck not ready: ${JSON.stringify(body.result).slice(0, 300)}`,
      );
    }
    console.log(`[hetzner-e2e-healthcheck] agent ${agentId} ready`);
    return;
  }
}

async function main(): Promise<void> {
  const apiKey = requireEnv("CLOUD_E2E_API_KEY");
  const baseUrl = (
    process.env.CLOUD_SMOKE_BASE_URL ?? DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  const state = readState();
  const agentId = state.agent_id;
  if (!agentId) {
    throw new Error(
      "state file missing agent_id; deploy-agent step must run first",
    );
  }

  await runHealthcheck({ apiKey, baseUrl, agentId });
}

if (import.meta.main) {
  await main();
}
