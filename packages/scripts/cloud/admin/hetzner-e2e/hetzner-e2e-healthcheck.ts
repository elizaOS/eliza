#!/usr/bin/env bun
/**
 * One JSON-RPC `status.get` ping against the deployed agent's bridge.
 * Exit 0 = healthy, nonzero = failure.
 */

import { readState } from "./state-file";

const DEFAULT_BASE_URL = "https://api-staging.elizacloud.ai";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[hetzner-e2e-healthcheck] missing env: ${name}`);
    process.exit(1);
  }
  return value;
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

  const response = await fetch(
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
}

await main();
