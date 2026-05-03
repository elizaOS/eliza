#!/usr/bin/env -S npx tsx
import * as http from "node:http";

/**
 * Standalone Provisioning Worker
 *
 * A long-lived daemon that polls for pending `agent_provision` jobs and
 * executes them outside the Next.js serverless sandbox.
 *
 * Replaces the flaky /api/v1/cron/process-provisioning-jobs route which
 * crashes due to memory/time limits on SSH-heavy provisioning flows.
 *
 * Usage:
 *   npx tsx packages/scripts/provisioning-worker.ts
 *
 * Environment:
 *   DATABASE_URL          - Neon Postgres connection string (shared DB)
 *   NEON_API_KEY           - Neon Management API key (for per-agent DB provisioning)
 *   AGENT_SSH_KEY_PATH    - Path to SSH private key for Docker nodes
 *   AGENT_DOCKER_IMAGE    - Docker image to deploy (default: agent/agent:cloud-full-ui)
 *   WORKER_POLL_INTERVAL   - Poll interval in ms (default: 30000)
 *   WORKER_BATCH_SIZE      - Max jobs per cycle (default: 3)
 *   WORKER_HEALTH_TIMEOUT  - Health check timeout in ms (default: 180000)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { Client as SSHClient } from "ssh2";
import { ObjectNamespaces } from "../lib/storage/object-namespace";
import { hydrateJsonField, offloadJsonField, offloadTextField } from "../lib/storage/object-store";

// ---------------------------------------------------------------------------
// Load .env.local (dotenv-style, no dependency)
// ---------------------------------------------------------------------------

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1);
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Load from project root
const projectRoot = path.resolve(import.meta.dirname ?? __dirname, "../..");
loadEnvFile(path.join(projectRoot, ".env.local"));
loadEnvFile(path.join(projectRoot, ".env"));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[worker] FATAL: DATABASE_URL is not set");
  process.exit(1);
}

const NEON_API_KEY = process.env.NEON_API_KEY;
if (!NEON_API_KEY) {
  console.error("[worker] FATAL: NEON_API_KEY is not set");
  process.exit(1);
}

const SSH_KEY_PATH =
  process.env.AGENT_SSH_KEY_PATH || path.join(os.homedir(), ".ssh", "clawdnet_nodes");

const DOCKER_IMAGE = process.env.AGENT_DOCKER_IMAGE || "agent/agent:cloud-full-ui";

const AGENT_BASE_DOMAIN = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN || "waifu.fun";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL) || 30_000;
const BATCH_SIZE = Number(process.env.WORKER_BATCH_SIZE) || 3;
const HEALTH_CHECK_TIMEOUT_MS = Number(process.env.WORKER_HEALTH_TIMEOUT) || 180_000;
const HEALTH_CHECK_POLL_INTERVAL_MS = 3_000;
const HEALTH_CHECK_REQUEST_TIMEOUT_MS = 8_000;
const SSH_PULL_TIMEOUT_MS = 300_000; // 5 min
const SSH_CMD_TIMEOUT_MS = 60_000;
const STALE_JOB_THRESHOLD_MS = 5 * 60 * 1000; // 5 min

// Port ranges (must match docker-sandbox-utils.ts)
const BRIDGE_PORT_MIN = 18790;
const BRIDGE_PORT_MAX = 19790;
const WEBUI_PORT_MIN = 20000;
const WEBUI_PORT_MAX = 25000;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (data) {
    console[level](`${prefix} ${msg}`, JSON.stringify(data));
  } else {
    console[level](`${prefix} ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Database Pool
// ---------------------------------------------------------------------------

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  log("error", "Unexpected pool error", { error: err.message });
});

// ---------------------------------------------------------------------------
// SSH Helpers
// ---------------------------------------------------------------------------

let _sshKey: Buffer | null = null;
function getSSHKey(): Buffer {
  if (_sshKey) return _sshKey;

  // Check env var first (base64-encoded, serverless-friendly)
  const sshKeyEnv = process.env.AGENT_SSH_KEY;
  if (sshKeyEnv) {
    _sshKey = Buffer.from(sshKeyEnv, "base64");
    log("info", "SSH key loaded from AGENT_SSH_KEY env var");
    return _sshKey;
  }

  // Fall back to filesystem
  _sshKey = fs.readFileSync(SSH_KEY_PATH);
  log("info", `SSH key loaded from ${SSH_KEY_PATH}`);
  return _sshKey;
}

function sshExec(
  hostname: string,
  port: number,
  user: string,
  command: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let output = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.end();
        reject(new Error(`SSH command timed out after ${timeoutMs}ms on ${hostname}`));
      }
    }, timeoutMs);

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          settled = true;
          conn.end();
          reject(new Error(`SSH exec error on ${hostname}: ${err.message}`));
          return;
        }

        stream.on("data", (data: Buffer) => {
          output += data.toString();
        });

        stream.stderr.on("data", (data: Buffer) => {
          output += data.toString();
        });

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          conn.end();

          if (code !== 0) {
            reject(
              new Error(
                `SSH command exited with code ${code} on ${hostname}: ${output.trim().slice(0, 500)}`,
              ),
            );
          } else {
            resolve(output);
          }
        });

        stream.on("error", (streamErr: Error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            conn.end();
            reject(new Error(`SSH stream error on ${hostname}: ${streamErr.message}`));
          }
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error(`SSH connection error for ${hostname}: ${err.message}`));
      }
    });

    conn.connect({
      host: hostname,
      port,
      username: user,
      privateKey: getSSHKey(),
      readyTimeout: 10_000,
    });
  });
}

// ---------------------------------------------------------------------------
// Shell Quoting (match docker-sandbox-utils.ts)
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// Port Allocation
// ---------------------------------------------------------------------------

function allocatePort(min: number, max: number, excluded: Set<number>): number {
  const range = max - min;
  if (excluded.size >= range) {
    throw new Error(`No available ports in range [${min}, ${max})`);
  }
  let port: number;
  let attempts = 0;
  do {
    port = min + Math.floor(Math.random() * range);
    attempts++;
    if (attempts > range * 2) {
      throw new Error(`Failed to find available port in [${min}, ${max})`);
    }
  } while (excluded.has(port));
  return port;
}

// ---------------------------------------------------------------------------
// Neon API Client (minimal, standalone)
// ---------------------------------------------------------------------------

interface NeonProjectResult {
  projectId: string;
  branchId: string;
  connectionUri: string;
}

async function neonCreateProject(name: string): Promise<NeonProjectResult> {
  const res = await fetch("https://console.neon.tech/api/v2/projects", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NEON_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      project: {
        name,
        region_id: "aws-us-east-1",
        pg_version: 16,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Neon API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const connectionUri = data.connection_uris?.[0]?.connection_uri;
  if (!connectionUri) {
    throw new Error("No connection URI in Neon response");
  }

  return {
    projectId: data.project.id,
    branchId: data.branch.id,
    connectionUri,
  };
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

async function waitForHealth(
  hostname: string,
  webUiPort: number,
  timeoutMs: number,
): Promise<boolean> {
  const url = `http://${hostname}:${webUiPort}/health`;
  const deadline = Date.now() + timeoutMs;

  log("info", `Polling health at ${url} (timeout: ${timeoutMs / 1000}s)`);

  while (Date.now() < deadline) {
    try {
      // Use http.request instead of fetch because Node.js fetch (undici)
      // ignores the Host header override. Vite's DNS rebinding protection
      // rejects requests where Host !== localhost.
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.request(
          {
            hostname,
            port: webUiPort,
            path: "/health",
            method: "GET",
            headers: { Host: "localhost" },
            timeout: HEALTH_CHECK_REQUEST_TIMEOUT_MS,
          },
          (res) =>
            resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400),
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });

      if (ok) {
        log("info", `Health check passed: ${url}`);
        return true;
      }
    } catch {
      // Connection refused, timeout — expected while container boots
    }

    const remaining = deadline - Date.now();
    if (remaining > HEALTH_CHECK_POLL_INTERVAL_MS) {
      await sleep(HEALTH_CHECK_POLL_INTERVAL_MS);
    } else if (remaining > 0) {
      await sleep(Math.min(remaining, 1000));
    } else {
      break;
    }
  }

  log("warn", `Health check timed out after ${timeoutMs / 1000}s: ${url}`);
  return false;
}

// ---------------------------------------------------------------------------
// Database Queries
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  type: string;
  status: string;
  data: {
    agentId: string;
    organizationId: string;
    userId: string;
    agentName: string;
  };
  data_storage: string;
  data_key: string | null;
  attempts: number;
  max_attempts: number;
  webhook_url: string | null;
  created_at: Date;
}

async function hydrateJobRow(row: JobRow): Promise<JobRow> {
  const data = await hydrateJsonField<JobRow["data"]>({
    storage: row.data_storage,
    key: row.data_key,
    inlineValue: row.data,
  });
  if (!data?.agentId || !data.organizationId || !data.userId || !data.agentName) {
    throw new Error(`Job ${row.id} is missing required provisioning data`);
  }
  return { ...row, data };
}

interface SandboxRow {
  id: string;
  organization_id: string;
  agent_name: string | null;
  status: string;
  database_status: string;
  database_uri: string | null;
  neon_project_id: string | null;
  neon_branch_id: string | null;
  environment_vars: Record<string, string>;
  error_count: number;
  docker_image: string | null;
  sandbox_id: string | null;
  bridge_url: string | null;
  health_url: string | null;
}

interface DockerNodeRow {
  node_id: string;
  hostname: string;
  ssh_port: number;
  ssh_user: string;
  capacity: number;
  allocated_count: number;
  host_key_fingerprint: string | null;
}

/**
 * Claim pending provisioning jobs using FOR UPDATE SKIP LOCKED.
 * Atomically transitions them to 'in_progress'.
 */
async function claimPendingJobs(limit: number): Promise<JobRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<JobRow>(
      `UPDATE jobs
       SET status = 'in_progress',
           started_at = NOW(),
           attempts = attempts + 1,
           updated_at = NOW()
       WHERE id IN (
         SELECT id FROM jobs
         WHERE type = 'agent_provision'
           AND status = 'pending'
           AND scheduled_for <= NOW()
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, type, status, data, data_storage, data_key, attempts, max_attempts, webhook_url, created_at`,
      [limit],
    );

    await client.query("COMMIT");
    return await Promise.all(rows.map(hydrateJobRow));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get the agent sandbox record.
 */
async function getSandbox(agentId: string): Promise<SandboxRow | null> {
  const { rows } = await pool.query<SandboxRow>(
    `SELECT id, organization_id, agent_name, status, database_status,
            database_uri, neon_project_id, neon_branch_id,
            environment_vars, error_count, docker_image,
            sandbox_id, bridge_url, health_url
     FROM agent_sandboxes
     WHERE id = $1`,
    [agentId],
  );
  return rows[0] ?? null;
}

/**
 * Try to set the sandbox status to 'provisioning' atomically.
 * Returns true if the transition succeeded.
 */
async function trySetProvisioning(agentId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE agent_sandboxes
     SET status = 'provisioning', updated_at = NOW()
     WHERE id = $1
       AND status IN ('pending', 'error', 'stopped', 'disconnected')`,
    [agentId],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Update sandbox with Neon DB info.
 */
async function updateSandboxNeon(
  agentId: string,
  projectId: string,
  branchId: string,
  connectionUri: string,
): Promise<void> {
  await pool.query(
    `UPDATE agent_sandboxes
     SET neon_project_id = $2,
         neon_branch_id = $3,
         database_uri = $4,
         database_status = 'ready',
         database_error = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [agentId, projectId, branchId, connectionUri],
  );
}

/**
 * Mark sandbox as running with all container metadata.
 */
async function markSandboxRunning(
  agentId: string,
  sandboxId: string,
  bridgeUrl: string,
  healthUrl: string,
  nodeId: string,
  containerName: string,
  bridgePort: number,
  webUiPort: number,
  dockerImage: string,
): Promise<void> {
  await pool.query(
    `UPDATE agent_sandboxes
     SET status = 'running',
         sandbox_id = $2,
         bridge_url = $3,
         health_url = $4,
         node_id = $5,
         container_name = $6,
         bridge_port = $7,
         web_ui_port = $8,
         docker_image = $9,
         last_heartbeat_at = NOW(),
         error_message = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [
      agentId,
      sandboxId,
      bridgeUrl,
      healthUrl,
      nodeId,
      containerName,
      bridgePort,
      webUiPort,
      dockerImage,
    ],
  );
}

/**
 * Mark sandbox as error.
 */
async function markSandboxError(agentId: string, errorMsg: string): Promise<void> {
  await pool.query(
    `UPDATE agent_sandboxes
     SET status = 'error',
         error_message = $2,
         error_count = error_count + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [agentId, errorMsg],
  );
}

/**
 * Find the least-loaded available Docker node.
 */
async function findAvailableNode(): Promise<DockerNodeRow | null> {
  const { rows } = await pool.query<DockerNodeRow>(
    `SELECT node_id, hostname, ssh_port, ssh_user, capacity,
            allocated_count, host_key_fingerprint
     FROM docker_nodes
     WHERE enabled = true
       AND status = 'healthy'
       AND allocated_count < capacity
     ORDER BY (capacity - allocated_count) DESC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Increment allocated_count for a node.
 */
async function incrementNodeAllocated(nodeId: string): Promise<void> {
  await pool.query(
    `UPDATE docker_nodes
     SET allocated_count = allocated_count + 1,
         updated_at = NOW()
     WHERE node_id = $1`,
    [nodeId],
  );
}

/**
 * Decrement allocated_count for a node.
 */
async function decrementNodeAllocated(nodeId: string): Promise<void> {
  await pool.query(
    `UPDATE docker_nodes
     SET allocated_count = GREATEST(allocated_count - 1, 0),
         updated_at = NOW()
     WHERE node_id = $1`,
    [nodeId],
  );
}

/**
 * Get used ports on a node.
 */
async function getUsedPorts(nodeId: string): Promise<Set<number>> {
  const { rows } = await pool.query<{ bridge_port: number | null; web_ui_port: number | null }>(
    `SELECT bridge_port, web_ui_port
     FROM agent_sandboxes
     WHERE node_id = $1
       AND status NOT IN ('stopped', 'error')`,
    [nodeId],
  );
  const used = new Set<number>();
  for (const r of rows) {
    if (r.bridge_port) used.add(r.bridge_port);
    if (r.web_ui_port) used.add(r.web_ui_port);
  }
  return used;
}

/**
 * Mark a job as completed.
 */
async function markJobCompleted(job: JobRow, result: Record<string, unknown>): Promise<void> {
  const payload = await offloadJsonField<Record<string, unknown>>({
    namespace: ObjectNamespaces.JobPayloads,
    organizationId: job.data.organizationId,
    objectId: job.id,
    field: "result",
    createdAt: job.created_at,
    value: result,
    inlineValueWhenOffloaded: null,
  });

  await pool.query(
    `UPDATE jobs
     SET status = 'completed',
         result = $2,
         result_storage = $3,
         result_key = $4,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [job.id, payload.value ? JSON.stringify(payload.value) : null, payload.storage, payload.key],
  );
}

/**
 * Mark a job as failed, with exponential backoff retry.
 */
async function markJobFailed(job: JobRow, errorMsg: string): Promise<"retrying" | "failed"> {
  const errorPayload = await offloadTextField({
    namespace: ObjectNamespaces.JobPayloads,
    organizationId: job.data.organizationId,
    objectId: job.id,
    field: "error",
    createdAt: job.created_at,
    value: errorMsg,
  });

  const attempts = job.attempts;
  const maxAttempts = job.max_attempts;
  if (attempts >= maxAttempts) {
    // Permanently failed
    await pool.query(
      `UPDATE jobs
       SET status = 'failed',
           error = $2,
           error_storage = $3,
           error_key = $4,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [job.id, errorPayload.value, errorPayload.storage, errorPayload.key],
    );
    return "failed";
  }

  // Schedule retry with exponential backoff
  const backoffMs = Math.min(1000 * 2 ** attempts, 60_000);
  await pool.query(
    `UPDATE jobs
     SET status = 'pending',
         error = $2,
         error_storage = $3,
         error_key = $4,
         scheduled_for = NOW() + interval '${backoffMs} milliseconds',
         updated_at = NOW()
     WHERE id = $1`,
    [job.id, errorPayload.value, errorPayload.storage, errorPayload.key],
  );
  return "retrying";
}

/**
 * Recover stale jobs stuck in 'in_progress' for too long.
 */
async function recoverStaleJobs(): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE jobs
     SET status = 'pending',
         error = 'Recovered from stale in_progress state',
         updated_at = NOW()
     WHERE type = 'agent_provision'
       AND status = 'in_progress'
       AND started_at < NOW() - interval '${STALE_JOB_THRESHOLD_MS} milliseconds'
       AND attempts < max_attempts`,
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeProjectName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20) || "agent"
  );
}

// ---------------------------------------------------------------------------
// Core Provisioning Logic
// ---------------------------------------------------------------------------

async function provisionAgent(
  agentId: string,
  orgId: string,
): Promise<{ success: boolean; error?: string; bridgeUrl?: string; healthUrl?: string }> {
  // 1. Get sandbox record
  const sandbox = await getSandbox(agentId);
  if (!sandbox) {
    return { success: false, error: "Agent not found" };
  }

  // Already running? Short-circuit.
  if (sandbox.status === "running" && sandbox.bridge_url && sandbox.health_url) {
    return {
      success: true,
      bridgeUrl: sandbox.bridge_url,
      healthUrl: sandbox.health_url,
    };
  }

  // 2. Try to set provisioning status
  const locked = await trySetProvisioning(agentId);
  if (!locked) {
    // Might already be provisioning
    return { success: false, error: "Agent is already being provisioned or in unexpected state" };
  }

  // 3. Database provisioning (Neon)
  let dbUri = sandbox.database_uri;
  if (sandbox.database_status !== "ready" || !dbUri) {
    log("info", `Provisioning Neon DB for agent ${agentId}`);

    try {
      // Mark DB as provisioning
      await pool.query(
        `UPDATE agent_sandboxes SET database_status = 'provisioning', updated_at = NOW() WHERE id = $1`,
        [agentId],
      );

      const projectName = `agent-${sanitizeProjectName(sandbox.agent_name ?? "agent")}-${agentId.substring(0, 8)}`;
      const neonResult = await neonCreateProject(projectName);

      await updateSandboxNeon(
        agentId,
        neonResult.projectId,
        neonResult.branchId,
        neonResult.connectionUri,
      );

      dbUri = neonResult.connectionUri;
      log("info", `Neon DB provisioned for ${agentId}`, {
        projectId: neonResult.projectId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markSandboxError(agentId, `Database provisioning failed: ${msg}`);
      return { success: false, error: `Database provisioning failed: ${msg}` };
    }
  }

  // 4. Find available Docker node
  const node = await findAvailableNode();
  if (!node) {
    await markSandboxError(agentId, "No available Docker nodes");
    return { success: false, error: "No available Docker nodes" };
  }

  log("info", `Selected node ${node.node_id} (${node.hostname}) for agent ${agentId}`);

  // 5. Allocate ports
  const usedPorts = await getUsedPorts(node.node_id);
  const bridgePort = allocatePort(BRIDGE_PORT_MIN, BRIDGE_PORT_MAX, usedPorts);
  const webUiPort = allocatePort(WEBUI_PORT_MIN, WEBUI_PORT_MAX, usedPorts);
  const containerName = `agent-${agentId}`;
  const volumePath = `/data/agents/${agentId}`;
  const resolvedImage = sandbox.docker_image || DOCKER_IMAGE;

  // 6. Build environment variables
  const jwtSecret = crypto.randomUUID();
  const agentApiToken = crypto.randomUUID();
  const userEnvVars = (sandbox.environment_vars as Record<string, string>) ?? {};

  const allEnv: Record<string, string> = {
    ...userEnvVars,
    AGENT_NAME: sandbox.agent_name ?? "CloudAgent",
    PORT: "2139",
    ELIZA_PORT: "2138",
    BRIDGE_PORT: "31337",
    BRIDGE_COMPAT_PORT: "18790",
    AGENT_API_BIND: "0.0.0.0",
    JWT_SECRET: userEnvVars.JWT_SECRET || jwtSecret,
    ELIZA_API_TOKEN: userEnvVars.ELIZA_API_TOKEN || agentApiToken,
    ELIZA_ALLOWED_ORIGINS: `https://${agentId}.${AGENT_BASE_DOMAIN},https://${agentId}.shad0w.xyz`,
    DATABASE_URL: dbUri!,
  };

  // Validate env var keys
  for (const key of Object.keys(allEnv)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      await markSandboxError(agentId, `Invalid environment variable key: "${key}"`);
      return { success: false, error: `Invalid environment variable key: "${key}"` };
    }
  }

  const envFlags = Object.entries(allEnv)
    .map(([key, value]) => `-e ${shellQuote(`${key}=${value}`)}`)
    .join(" ");

  // 7. Build docker run command
  const dockerRunCmd = [
    "docker run -d",
    `--name ${shellQuote(containerName)}`,
    "--restart unless-stopped",
    `-v ${shellQuote(volumePath)}:/app/data`,
    `-p ${bridgePort}:31337`,
    `-p ${webUiPort}:2138`,
    envFlags,
    shellQuote(resolvedImage),
  ].join(" ");

  // 8. SSH to node, pull image, create container
  await incrementNodeAllocated(node.node_id);

  try {
    // Ensure volume directory
    await sshExec(
      node.hostname,
      node.ssh_port,
      node.ssh_user,
      `mkdir -p ${shellQuote(volumePath)}`,
      SSH_CMD_TIMEOUT_MS,
    );

    // Pull image
    log("info", `Pulling image ${resolvedImage} on ${node.node_id}`);
    try {
      await sshExec(
        node.hostname,
        node.ssh_port,
        node.ssh_user,
        `docker pull ${shellQuote(resolvedImage)}`,
        SSH_PULL_TIMEOUT_MS,
      );
      log("info", `Image pulled on ${node.node_id}`);
    } catch (pullErr) {
      log("warn", `Image pull failed on ${node.node_id} (using cached)`, {
        error: pullErr instanceof Error ? pullErr.message : String(pullErr),
      });
    }

    // Run container
    const output = await sshExec(
      node.hostname,
      node.ssh_port,
      node.ssh_user,
      dockerRunCmd,
      SSH_CMD_TIMEOUT_MS,
    );
    const containerId = output.trim().slice(0, 12);
    log("info", `Container created on ${node.node_id}: ${containerId} (${containerName})`);
  } catch (err) {
    await decrementNodeAllocated(node.node_id);
    const msg = err instanceof Error ? err.message : String(err);
    await markSandboxError(agentId, `Container creation failed: ${msg}`);
    return { success: false, error: `Container creation failed: ${msg}` };
  }

  // 9. Wait for health check
  const healthy = await waitForHealth(node.hostname, webUiPort, HEALTH_CHECK_TIMEOUT_MS);

  if (!healthy) {
    // Clean up the unhealthy container
    log("warn", `Health check failed for ${containerName}, cleaning up`);
    try {
      await sshExec(
        node.hostname,
        node.ssh_port,
        node.ssh_user,
        `docker rm -f ${shellQuote(containerName)}`,
        SSH_CMD_TIMEOUT_MS,
      );
    } catch {
      // best effort
    }
    await decrementNodeAllocated(node.node_id);
    await markSandboxError(agentId, "Health check timed out");
    return { success: false, error: "Health check timed out" };
  }

  // 10. Update sandbox record
  const bridgeUrl = `http://${node.hostname}:${bridgePort}`;
  const healthUrl = `http://${node.hostname}:${webUiPort}`;

  await markSandboxRunning(
    agentId,
    containerName,
    bridgeUrl,
    healthUrl,
    node.node_id,
    containerName,
    bridgePort,
    webUiPort,
    resolvedImage,
  );

  log("info", `Agent ${agentId} provisioned successfully`, {
    node: node.node_id,
    bridgePort,
    webUiPort,
    containerName,
  });

  return { success: true, bridgeUrl, healthUrl };
}

// ---------------------------------------------------------------------------
// Job Processor
// ---------------------------------------------------------------------------

async function processJob(job: JobRow): Promise<void> {
  const { agentId, organizationId } = job.data;

  // Cross-check org ID
  if (organizationId && job.data.organizationId) {
    // Both data and we're consistent
  }

  log("info", `Processing job ${job.id}`, {
    agentId,
    orgId: organizationId,
    attempt: job.attempts,
  });

  const result = await provisionAgent(agentId, organizationId);

  if (result.success) {
    await markJobCompleted(job, {
      cloudAgentId: agentId,
      status: "running",
      bridgeUrl: result.bridgeUrl,
      healthUrl: result.healthUrl,
    });
    log("info", `Job ${job.id} completed successfully`);
  } else {
    const outcome = await markJobFailed(job, result.error ?? "Unknown error");

    if (outcome === "failed") {
      // Permanently failed — mark sandbox as error too
      await markSandboxError(
        agentId,
        `Provisioning permanently failed after ${job.max_attempts} attempts: ${result.error}`,
      );
      log("error", `Job ${job.id} permanently failed`, { error: result.error });
    } else {
      log("warn", `Job ${job.id} failed, will retry`, {
        error: result.error,
        attempt: job.attempts,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main Loop
// ---------------------------------------------------------------------------

let running = true;

async function pollCycle(): Promise<void> {
  try {
    // 1. Recover stale jobs
    const recovered = await recoverStaleJobs();
    if (recovered > 0) {
      log("info", `Recovered ${recovered} stale job(s)`);
    }

    // 2. Claim and process pending jobs
    const jobs = await claimPendingJobs(BATCH_SIZE);

    if (jobs.length > 0) {
      log("info", `Claimed ${jobs.length} job(s)`);

      // Process sequentially to avoid overwhelming SSH connections
      for (const job of jobs) {
        try {
          await processJob(job);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log("error", `Unhandled error processing job ${job.id}`, { error: msg });

          // Mark job failed so it doesn't get stuck
          try {
            const outcome = await markJobFailed(job, msg);
            if (outcome === "failed") {
              const { agentId } = job.data;
              await markSandboxError(agentId, `Provisioning permanently failed: ${msg}`).catch(
                () => {},
              );
            }
          } catch (markErr) {
            log("error", `Failed to mark job ${job.id} as failed`, {
              error: markErr instanceof Error ? markErr.message : String(markErr),
            });
          }
        }
      }
    }
  } catch (err) {
    log("error", "Poll cycle error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  log("info", "=== Provisioning Worker Starting ===");
  log("info", `Poll interval: ${POLL_INTERVAL_MS}ms`);
  log("info", `Batch size: ${BATCH_SIZE}`);
  log("info", `Health check timeout: ${HEALTH_CHECK_TIMEOUT_MS}ms`);
  log("info", `Docker image: ${DOCKER_IMAGE}`);
  log("info", `Agent base domain: ${AGENT_BASE_DOMAIN}`);
  log("info", `SSH key: ${SSH_KEY_PATH}`);

  // Verify DB connectivity
  try {
    const { rows } = await pool.query("SELECT NOW() as now");
    log("info", `Database connected: ${rows[0].now}`);
  } catch (err) {
    log("error", "Failed to connect to database", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Verify SSH key exists
  try {
    getSSHKey();
  } catch (err) {
    log("error", "Failed to load SSH key", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  // Main poll loop
  while (running) {
    await pollCycle();
    await sleep(POLL_INTERVAL_MS);
  }

  log("info", "Worker shutting down...");
  await pool.end();
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  log("info", "Received SIGINT, shutting down...");
  running = false;
});

process.on("SIGTERM", () => {
  log("info", "Received SIGTERM, shutting down...");
  running = false;
});

process.on("unhandledRejection", (reason) => {
  log("error", "Unhandled rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

main().catch((err) => {
  log("error", "Worker crashed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
