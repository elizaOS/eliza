#!/usr/bin/env bun

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { dbWrite } from "../db/helpers";
import { organizations } from "../db/schemas/organizations";
import { users } from "../db/schemas/users";
import { apiKeysService } from "../lib/services/api-keys";

type JsonObject = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://api-staging.elizacloud.ai";
const baseUrl = (process.env.CLOUD_SMOKE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
const timeoutMs = Number.parseInt(process.env.CLOUD_SMOKE_TIMEOUT_MS ?? "240000", 10);
const pollIntervalMs = Number.parseInt(process.env.CLOUD_SMOKE_POLL_INTERVAL_MS ?? "5000", 10);
const runId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

let apiKey: string | undefined;
let orgId: string | undefined;
let agentId: string | undefined;
let cleanupDbOrg = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeBody(body: unknown): string {
  if (!body || typeof body !== "object") return String(body);

  const record = body as JsonObject;
  const parts: JsonObject = {};
  for (const key of ["success", "code", "error", "message", "status"] as const) {
    if (key in record) parts[key] = record[key];
  }
  if ("data" in record && record.data && typeof record.data === "object") {
    parts.dataKeys = Object.keys(record.data as JsonObject);
  }
  return JSON.stringify(parts);
}

async function requestJson(
  path: string,
  init: RequestInit = {},
  expectedStatuses: number[] = [200],
): Promise<{ status: number; body: JsonObject }> {
  if (!apiKey) throw new Error("API key not initialized");

  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("accept", "application/json");
  headers.set("user-agent", "eliza-cloud-live-smoke/1.0");
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

  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `${init.method ?? "GET"} ${path} returned ${response.status}: ${describeBody(body)}`,
    );
  }

  return { status: response.status, body };
}

async function jsonRpc(method: string, params: JsonObject = {}): Promise<JsonObject> {
  if (!agentId) throw new Error("Agent not initialized");
  const { body } = await requestJson(`/api/v1/eliza/agents/${agentId}/bridge`, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params,
    }),
  });
  if (body.error) {
    throw new Error(`Bridge ${method} failed: ${describeBody(body.error)}`);
  }
  const result = body.result;
  if (!result || typeof result !== "object") {
    throw new Error(`Bridge ${method} returned no result`);
  }
  return result as JsonObject;
}

async function createSmokeIdentity(): Promise<void> {
  if (process.env.CLOUD_SMOKE_AUTH === "siwe") {
    await createSmokeIdentityViaSiwe();
    return;
  }

  const slug = `cloud-smoke-${runId}`;
  const [org] = await dbWrite
    .insert(organizations)
    .values({
      name: `Cloud Smoke ${runId}`,
      slug,
      credit_balance: "50.000000",
      settings: { smoke: true, runId },
    })
    .returning({ id: organizations.id });

  if (!org?.id) throw new Error("Failed to create smoke organization");
  orgId = org.id;

  const [user] = await dbWrite
    .insert(users)
    .values({
      email: `${slug}@example.invalid`,
      email_verified: true,
      organization_id: orgId,
      role: "owner",
      name: "Cloud Smoke",
      is_active: true,
    })
    .returning({ id: users.id });

  if (!user?.id) throw new Error("Failed to create smoke user");

  const generated = await apiKeysService.create({
    user_id: user.id,
    organization_id: orgId,
    name: `cloud-smoke-${runId}`,
    description: "Temporary cloud provisioning live smoke key",
    permissions: ["*"],
    rate_limit: 1000,
    is_active: true,
  });

  apiKey = generated.plainKey;
  cleanupDbOrg = true;
}

function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    "",
    params.statement,
    "",
    `URI: ${params.uri}`,
    `Version: ${params.version}`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}

async function createSmokeIdentityViaSiwe(): Promise<void> {
  const privateKey = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const account = privateKeyToAccount(privateKey);

  const nonceResponse = await fetch(`${baseUrl}/api/auth/siwe/nonce?chainId=1`, {
    headers: {
      accept: "application/json",
      "user-agent": "eliza-cloud-live-smoke/1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const nonceBody = (await nonceResponse.json().catch(() => ({}))) as JsonObject;
  if (!nonceResponse.ok) {
    throw new Error(`SIWE nonce returned ${nonceResponse.status}: ${describeBody(nonceBody)}`);
  }

  const nonce = typeof nonceBody.nonce === "string" ? nonceBody.nonce : null;
  const domain = typeof nonceBody.domain === "string" ? nonceBody.domain : null;
  const uri = typeof nonceBody.uri === "string" ? nonceBody.uri : null;
  const statement =
    typeof nonceBody.statement === "string" ? nonceBody.statement : "Sign in to Eliza Cloud";
  const version = typeof nonceBody.version === "string" ? nonceBody.version : "1";
  const chainId = typeof nonceBody.chainId === "number" ? nonceBody.chainId : 1;
  if (!nonce || !domain || !uri) {
    throw new Error(`SIWE nonce response missing required fields: ${describeBody(nonceBody)}`);
  }

  const message = buildSiweMessage({
    domain,
    address: account.address,
    statement,
    uri,
    version,
    chainId,
    nonce,
  });
  const signature = await account.signMessage({ message });

  const verifyResponse = await fetch(`${baseUrl}/api/auth/siwe/verify`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "eliza-cloud-live-smoke/1.0",
    },
    body: JSON.stringify({ message, signature }),
    signal: AbortSignal.timeout(60_000),
  });
  const verifyBody = (await verifyResponse.json().catch(() => ({}))) as JsonObject;
  if (!verifyResponse.ok) {
    throw new Error(`SIWE verify returned ${verifyResponse.status}: ${describeBody(verifyBody)}`);
  }

  const plainKey = typeof verifyBody.apiKey === "string" ? verifyBody.apiKey : null;
  const user = verifyBody.user as JsonObject | undefined;
  const organization = verifyBody.organization as JsonObject | undefined;
  if (!plainKey) {
    throw new Error(`SIWE verify response missing apiKey: ${describeBody(verifyBody)}`);
  }

  apiKey = plainKey;
  orgId =
    (typeof organization?.id === "string" ? organization.id : undefined) ??
    (typeof user?.organization_id === "string" ? user.organization_id : undefined);
}

async function createAgent(): Promise<void> {
  const { status, body } = await requestJson(
    "/api/v1/eliza/agents",
    {
      method: "POST",
      body: JSON.stringify({
        agentName: `cloud-smoke-${runId}`,
        agentConfig: {
          name: `Cloud Smoke ${runId}`,
          username: `cloud-smoke-${runId}`,
          system: "You are a concise test assistant for cloud provisioning smoke checks.",
          bio: ["Cloud provisioning smoke test agent."],
          topics: ["cloud provisioning smoke"],
          adjectives: ["concise"],
          plugins: ["@elizaos/plugin-sql", "@elizaos/plugin-openai", "@elizaos/plugin-bootstrap"],
          settings: { secrets: {} },
        },
        environmentVars: {
          ELIZA_SMOKE_RUN_ID: runId,
        },
      }),
    },
    [201],
  );
  const data = body.data as JsonObject | undefined;
  if (!data || typeof data.id !== "string") {
    throw new Error(`Create agent returned ${status} without an agent id`);
  }
  agentId = data.id;
}

async function provisionAgent(): Promise<string> {
  if (!agentId) throw new Error("Agent not initialized");
  const { status, body } = await requestJson(
    `/api/v1/eliza/agents/${agentId}/provision`,
    { method: "POST" },
    [202],
  );
  const data = body.data as JsonObject | undefined;
  if (status !== 202 || !data || typeof data.jobId !== "string") {
    throw new Error(`Provision did not return an async job: ${describeBody(body)}`);
  }
  return data.jobId;
}

async function waitForJob(jobId: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "";

  while (Date.now() < deadline) {
    const { body } = await requestJson(`/api/v1/jobs/${jobId}`);
    const data = body.data as JsonObject | undefined;
    const status = typeof data?.status === "string" ? data.status : "unknown";
    if (status !== lastStatus) {
      console.log(`[smoke] job ${jobId} -> ${status}`);
      lastStatus = status;
    }

    if (status === "completed") {
      const result = data?.result as JsonObject | undefined;
      if (result?.status !== "running") {
        throw new Error(`Completed job did not produce a running agent: ${describeBody(data)}`);
      }
      return;
    }

    if (status === "failed" || status === "cancelled" || status === "canceled") {
      throw new Error(`Provisioning job ended in ${status}: ${describeBody(data)}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting ${timeoutMs}ms for provisioning job ${jobId}`);
}

async function assertAgentRunning(): Promise<void> {
  if (!agentId) throw new Error("Agent not initialized");
  const { body } = await requestJson(`/api/v1/eliza/agents/${agentId}`);
  const data = body.data as JsonObject | undefined;
  if (data?.status !== "running" || data.databaseStatus !== "ready") {
    throw new Error(`Agent is not running with a ready database: ${describeBody(body)}`);
  }
}

async function assertBridge(): Promise<void> {
  const status = await jsonRpc("status.get");
  if (status.ready !== true) {
    throw new Error(`Bridge status is not ready: ${describeBody(status)}`);
  }

  const heartbeat = await jsonRpc("heartbeat");
  if (heartbeat.ready !== true && heartbeat.ok !== true) {
    throw new Error(`Bridge heartbeat failed: ${describeBody(heartbeat)}`);
  }

  const message = await jsonRpc("message.send", {
    text: `cloud smoke ping ${runId}`,
    roomId: `cloud-smoke-room-${runId}`,
    userId: `cloud-smoke-user-${runId}`,
  });
  if (message.accepted !== true && typeof message.text !== "string") {
    throw new Error(`Bridge message send failed: ${describeBody(message)}`);
  }
}

async function assertPairingToken(): Promise<void> {
  if (!agentId) throw new Error("Agent not initialized");
  const { body } = await requestJson(`/api/v1/eliza/agents/${agentId}/pairing-token`, {
    method: "POST",
  });
  const data = body.data as JsonObject | undefined;
  const redirectUrl = typeof data?.redirectUrl === "string" ? data.redirectUrl : null;
  if (!data || typeof data.token !== "string" || !redirectUrl) {
    throw new Error(`Pairing token response missing token or redirect URL: ${describeBody(body)}`);
  }

  const response = await fetch(redirectUrl, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status >= 500) {
    throw new Error(`Pairing redirect URL returned HTTP ${response.status}`);
  }
}

async function deleteAgent(): Promise<void> {
  if (!agentId) return;
  const deletedAgentId = agentId;
  await requestJson(`/api/v1/eliza/agents/${deletedAgentId}`, { method: "DELETE" }, [200, 404]);
  await requestJson(`/api/v1/eliza/agents/${deletedAgentId}`, {}, [404]);
  agentId = undefined;
}

async function cleanup(): Promise<void> {
  try {
    await deleteAgent();
  } catch (error) {
    console.warn(
      `[smoke] agent cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (cleanupDbOrg && orgId) {
    await dbWrite.delete(organizations).where(eq(organizations.id, orgId));
    orgId = undefined;
  }
}

async function main(): Promise<void> {
  console.log(`[smoke] base ${baseUrl}`);
  await createSmokeIdentity();
  console.log("[smoke] disposable auth ready");

  await createAgent();
  console.log(`[smoke] agent created ${agentId}`);

  const jobId = await provisionAgent();
  console.log(`[smoke] provision enqueued ${jobId}`);

  await waitForJob(jobId);
  await assertAgentRunning();
  console.log("[smoke] agent running");

  await assertBridge();
  console.log("[smoke] bridge ok");

  await assertPairingToken();
  console.log("[smoke] pairing ok");

  await deleteAgent();
  console.log("[smoke] delete ok");
}

try {
  await main();
  console.log("[smoke] complete");
} finally {
  await cleanup();
}
