#!/usr/bin/env bun
/**
 * Proves the local cloud path through SIWE, workerd, PostgreSQL, the real
 * control plane, an OrbStack Docker agent, deterministic inference, and deletion.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { loginAsSeededUser } from "../../../e2e/src/helpers/wallet-login";
import { profiles } from "./local-parity.mjs";

type Profile = keyof typeof profiles;

interface JsonObject {
  [key: string]: unknown;
}

const profileArgIndex = process.argv.indexOf("--profile");
const profile = (
  profileArgIndex >= 0 ? process.argv[profileArgIndex + 1] : "staging"
) as Profile;
const config = profiles[profile];
if (!config)
  throw new Error(
    `Profile must be staging or production, received ${JSON.stringify(profile)}`,
  );

const apiUrl = `http://127.0.0.1:${config.apiPort}`;
const controlPlaneUrl = `http://127.0.0.1:${config.controlPlanePort}`;
const databaseUrl = process.env.DATABASE_URL;
const controlPlaneToken = process.env.CONTAINER_CONTROL_PLANE_TOKEN;
if (!databaseUrl || !controlPlaneToken) {
  throw new Error(
    "Smoke requires DATABASE_URL and CONTAINER_CONTROL_PLANE_TOKEN from the orchestrator",
  );
}

const report: JsonObject = {
  schema: "elizaos.local-parity-smoke/v1",
  profile,
  startedAt: new Date().toISOString(),
  apiUrl,
  controlPlaneUrl,
  checks: [],
};
const checks = report.checks as JsonObject[];

function record(name: string, evidence: JsonObject = {}): void {
  checks.push({ name, at: new Date().toISOString(), ...evidence });
  console.log(`[local-parity-smoke] ${name}`);
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey };
}

async function jsonRequest(
  url: string,
  init: RequestInit,
  accepted: number[],
): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body: JsonObject;
  try {
    body = text ? (JSON.parse(text) as JsonObject) : {};
  } catch {
    // error-policy:J3 preserve invalid response text for a precise boundary failure.
    body = { raw: text };
  }
  if (!accepted.includes(response.status)) {
    throw new Error(
      `${init.method ?? "GET"} ${url} returned ${response.status}: ${text}`,
    );
  }
  return { status: response.status, body };
}

async function tick(): Promise<JsonObject> {
  const result = await jsonRequest(
    `${controlPlaneUrl}/api/v1/cron/process-provisioning-jobs`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer test-cron-secret",
        "content-type": "application/json",
        "x-container-control-plane-token": controlPlaneToken,
        "x-eliza-cloud-database-url": databaseUrl,
      },
    },
    [200],
  );
  return result.body;
}

function agentState(body: JsonObject): string | undefined {
  if (typeof body.status === "string") return body.status;
  const data = body.data;
  if (
    data &&
    typeof data === "object" &&
    "status" in data &&
    typeof data.status === "string"
  ) {
    return data.status;
  }
  return undefined;
}

async function pollAgent(
  apiKey: string,
  agentId: string,
  expected: string,
): Promise<JsonObject> {
  const deadline = Date.now() + 180_000;
  let last: JsonObject = {};
  while (Date.now() < deadline) {
    await tick();
    const response = await jsonRequest(
      `${apiUrl}/api/v1/eliza/agents/${agentId}`,
      { headers: authHeaders(apiKey) },
      [200, 404],
    );
    last = response.body;
    if (expected === "deleted" && response.status === 404) return last;
    if (agentState(last) === expected) return last;
    await Bun.sleep(750);
  }
  throw new Error(
    `Agent ${agentId} did not reach ${expected}; last=${JSON.stringify(last)}`,
  );
}

async function bridge(
  apiKey: string,
  agentId: string,
  method: string,
  params?: JsonObject,
  accept: (body: JsonObject) => boolean = (body) => !("error" in body),
): Promise<JsonObject> {
  const deadline = Date.now() + 120_000;
  let last: JsonObject = {};
  while (Date.now() < deadline) {
    const response = await jsonRequest(
      `${apiUrl}/api/v1/eliza/agents/${agentId}/bridge`,
      {
        method: "POST",
        headers: { ...authHeaders(apiKey), "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: method,
          method,
          ...(params ? { params } : {}),
        }),
      },
      [200, 503],
    );
    last = response.body;
    if (response.status === 200 && accept(last)) return last;
    await Bun.sleep(750);
  }
  throw new Error(`Bridge ${method} did not succeed: ${JSON.stringify(last)}`);
}

function dockerEvidence(agentId: string): JsonObject {
  const result = spawnSync(
    "docker",
    [
      "ps",
      "--filter",
      `label=ai.elizaos.agent-id=${agentId}`,
      "--filter",
      `label=ai.elizaos.local-parity-profile=${profile}`,
      "--format",
      "{{json .}}",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `No running profile-labeled Docker container found for ${agentId}: ${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout.trim().split("\n")[0]) as JsonObject;
}

async function main(): Promise<void> {
  const user = await loginAsSeededUser(apiUrl);
  record("siwe-login", {
    userId: user.userId,
    organizationId: user.organizationId,
  });

  const created = await jsonRequest(
    `${apiUrl}/api/v1/eliza/agents`,
    {
      method: "POST",
      headers: {
        ...authHeaders(user.apiKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentName: `local-${profile}-${Date.now().toString(36)}`,
        alwaysOn: true,
        autoProvision: false,
        agentConfig: {
          character: {
            name: "Local Parity Agent",
            system: "Reply helpfully and retain the conversation context.",
            model: "openai/local-parity-model",
          },
        },
      }),
    },
    [200, 201, 202],
  );
  const data = created.body.data as JsonObject | undefined;
  const agentId = [
    created.body.sandboxId,
    created.body.agentId,
    created.body.id,
    data?.sandboxId,
    data?.agentId,
    data?.id,
  ].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (!agentId)
    throw new Error(
      `Create response did not contain an agent id: ${JSON.stringify(created.body)}`,
    );
  report.agentId = agentId;
  report.organizationId = user.organizationId;
  record("agent-created", { agentId });

  await jsonRequest(
    `${apiUrl}/api/v1/eliza/agents/${agentId}/provision`,
    { method: "POST", headers: authHeaders(user.apiKey) },
    [200, 202, 409],
  );
  const running = await pollAgent(user.apiKey, agentId, "running");
  record("agent-running", { state: running });

  const { agentSandboxesRepository } = await import(
    "@elizaos/cloud-shared/db/repositories/agent-sandboxes"
  );
  const row = await agentSandboxesRepository.findByIdAndOrg(
    agentId,
    user.organizationId,
  );
  if (
    row?.status !== "running" ||
    !row.execution_tier.startsWith("dedicated")
  ) {
    throw new Error(`Unexpected persisted sandbox row: ${JSON.stringify(row)}`);
  }
  record("postgres-persistence", {
    status: row.status,
    executionTier: row.execution_tier,
    bridgeUrl: row.bridge_url,
  });

  const container = dockerEvidence(agentId);
  record("docker-container", container);

  const heartbeat = await bridge(
    user.apiKey,
    agentId,
    "heartbeat",
    undefined,
    (body) =>
      !("error" in body) &&
      typeof body.result === "object" &&
      body.result !== null &&
      (body.result as JsonObject).ready === true,
  );
  record("bridge-heartbeat", { response: heartbeat });

  const mockHealthBefore = await jsonRequest(
    `http://127.0.0.1:${config.openAiPort}/health`,
    {},
    [200],
  );
  const requestsBefore = mockHealthBefore.body.requests;
  if (typeof requestsBefore !== "number") {
    throw new Error(
      `OpenAI mock did not report its request count: ${JSON.stringify(mockHealthBefore.body)}`,
    );
  }

  const firstText = "My local parity word is amber. Remember it.";
  const first = await bridge(user.apiKey, agentId, "message.send", {
    text: firstText,
  });
  const second = await bridge(user.apiKey, agentId, "message.send", {
    text: "What local parity word did I give you?",
  });
  const mockHealth = await jsonRequest(
    `http://127.0.0.1:${config.openAiPort}/health`,
    {},
    [200],
  );
  if (
    typeof mockHealth.body.requests !== "number" ||
    mockHealth.body.requests - requestsBefore < 2
  ) {
    throw new Error(
      `Expected at least two new deterministic inference calls: before=${requestsBefore} after=${JSON.stringify(mockHealth.body)}`,
    );
  }
  const status = await bridge(user.apiKey, agentId, "status.get");
  record("chat-and-memory", {
    first,
    second,
    mockRequestsBefore: requestsBefore,
    mockRequestsAfter: mockHealth.body.requests,
    status,
  });

  await jsonRequest(
    `${apiUrl}/api/v1/eliza/agents/${agentId}`,
    { method: "DELETE", headers: authHeaders(user.apiKey) },
    [200, 202, 204],
  );
  await pollAgent(user.apiKey, agentId, "deleted");
  const remaining = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `label=ai.elizaos.agent-id=${agentId}`],
    { encoding: "utf8" },
  );
  if (remaining.status !== 0 || remaining.stdout.trim()) {
    throw new Error(
      `Agent container still exists after deprovision: ${remaining.stdout || remaining.stderr}`,
    );
  }
  record("agent-deprovisioned", { agentId });
  report.completedAt = new Date().toISOString();
  report.result = "passed";
}

const outputDir = path.join(process.cwd(), ".eliza", "local-parity", profile);
mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(
  outputDir,
  `smoke-${new Date().toISOString().replaceAll(":", "-")}.json`,
);

try {
  await main();
} catch (error) {
  // error-policy:J1 the CLI boundary records a structured failure artifact and exits non-zero.
  report.completedAt = new Date().toISOString();
  report.result = "failed";
  report.error =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : String(error);
  throw error;
} finally {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`[local-parity-smoke] report=${outputPath}`);
}
