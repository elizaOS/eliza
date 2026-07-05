/**
 * Real-server e2e for the runtime-mode gate on the BARE agent server — the
 * exact `startApiServer` root `bun run start` binds, with no app-core wrapper
 * in front. Spawns the fixture child under `bun --conditions=eliza-source`
 * (the same source-mode resolution the dev/live stack uses) against a temp
 * `ELIZA_STATE_DIR`, rewrites `eliza.json` between phases (the mode resolver
 * re-reads config per request), and drives real HTTP requests plus a real
 * loopback "remote target" server so a forward is observable end to end. No
 * mocks anywhere.
 *
 * Before the gate moved into `src/api/runtime-mode/` the bare server was
 * ungated: in remote mode `GET /api/local-inference/hub` served the
 * local-model catalog (200) and `POST /api/cloud/login` executed LOCALLY
 * (returning a live elizacloud session URL) instead of forwarding to the
 * configured target — every phase below failed. The app-core compat pipeline
 * now calls the same pre-dispatch hook instead of being the only gated host.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  HERE,
  "..",
  "fixtures",
  "runtime-mode-gate-server.ts",
);

interface TargetHit {
  method: string;
  url: string;
  authorization: string | undefined;
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-mode-gate-"));

let child: ChildProcess | null = null;
let childLog = "";
let apiBase = "";
let target: http.Server | null = null;
let targetBase = "";
const targetHits: TargetHit[] = [];
const API_TOKEN = "gate-api-token";

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(stateDir, "eliza.json"),
    JSON.stringify({ ...config, logging: { level: "error" } }, null, 2),
  );
}

function remoteConfig(): Record<string, unknown> {
  return {
    deploymentTarget: {
      runtime: "remote",
      remoteApiBase: targetBase,
      remoteAccessToken: "gate-test-token",
    },
  };
}

async function request(
  method: string,
  pathname: string,
  options: { authorized?: boolean } = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(apiBase + pathname, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.authorized ? { authorization: `Bearer ${API_TOKEN}` } : {}),
    },
    body: method === "GET" || method === "OPTIONS" ? undefined : "{}",
  });
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  // Real loopback stand-in for the controlled remote Eliza instance.
  target = http.createServer((req, res) => {
    targetHits.push({
      method: req.method ?? "",
      url: req.url ?? "",
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ forwardedToTarget: true }));
  });
  await new Promise<void>((resolve) => {
    target?.listen(0, "127.0.0.1", resolve);
  });
  targetBase = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

  writeConfig({});
  const port = await new Promise<number>((resolve, reject) => {
    child = spawn("bun", ["--conditions=eliza-source", FIXTURE], {
      env: {
        ...process.env,
        ELIZA_STATE_DIR: stateDir,
        ELIZA_CONFIG_PATH: "",
        ELIZA_API_PORT: "",
        ELIZA_REQUIRE_LOCAL_AUTH: "1",
        ELIZA_API_TOKEN: API_TOKEN,
        LOG_LEVEL: "error",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer): void => {
      childLog += chunk.toString();
      const match = childLog.match(/GATE_E2E_PORT=(\d+)/);
      if (match) resolve(Number(match[1]));
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      reject(
        new Error(`gate server exited early (code ${code}):\n${childLog}`),
      );
    });
  });
  apiBase = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  child?.removeAllListeners("exit");
  child?.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (!target) return resolve();
    target.close(() => resolve());
  });
  fs.rmSync(stateDir, { recursive: true, force: true });
}, 30_000);

describe("bare agent server enforces the runtime-mode contract", () => {
  it("remote mode hides /api/local-inference/* (404, not the local catalog)", async () => {
    writeConfig(remoteConfig());
    const res = await request("GET", "/api/local-inference/hub");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("catalog");
  });

  it("remote mode rejects unauthenticated cloud mutations before forwarding", async () => {
    writeConfig(remoteConfig());
    targetHits.length = 0;
    const res = await request("POST", "/api/cloud/login");
    expect(res.status).toBe(401);
    expect(targetHits).toHaveLength(0);
  });

  it("remote mode forwards authorized POST /api/cloud/login to the target with its access token", async () => {
    writeConfig(remoteConfig());
    targetHits.length = 0;
    const res = await request("POST", "/api/cloud/login", {
      authorized: true,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ forwardedToTarget: true });
    expect(targetHits).toHaveLength(1);
    expect(targetHits[0]).toMatchObject({
      method: "POST",
      url: "/api/cloud/login",
      authorization: "Bearer gate-test-token",
    });
  });

  it("remote mode keeps cloud READS local (no forward) and answers OPTIONS preflight", async () => {
    writeConfig(remoteConfig());
    targetHits.length = 0;
    const status = await request("GET", "/api/cloud/status");
    expect(status.status).not.toBe(404);
    const preflight = await request("OPTIONS", "/api/local-inference/hub");
    expect(preflight.status).toBe(204);
    expect(targetHits).toHaveLength(0);
  });

  it("remote mode without a valid target rejects cloud mutations instead of running them locally", async () => {
    writeConfig({ deploymentTarget: { runtime: "remote" } });
    const res = await request("POST", "/api/cloud/login", {
      authorized: true,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Remote target not configured",
    });
  });

  // local-only (`cloud.enabled === false`) has no e2e phase: `loadElizaConfig`
  // runs `migrateLegacyRuntimeConfig`, which prunes `cloud.enabled` before the
  // disk-backed mode resolver reads it, so NO host (bare agent or app-core)
  // can currently reach local-only from persisted config — a pre-existing
  // resolver hole tracked separately from the gate move. The local-only
  // decision itself stays covered by the pure-resolver unit tests in
  // `src/api/runtime-mode/`.
  it("cloud mode hides /api/local-inference/* but keeps /api/cloud/* reachable", async () => {
    writeConfig({ deploymentTarget: { runtime: "cloud" } });
    const hub = await request("GET", "/api/local-inference/hub");
    expect(hub.status).toBe(404);
    const status = await request("GET", "/api/cloud/status");
    expect(status.status).not.toBe(404);
  });

  it("default local mode leaves cloud + unlisted routes reachable", async () => {
    writeConfig({});
    const health = await request("GET", "/api/health");
    expect(health.status).toBe(200);
    const status = await request("GET", "/api/cloud/status");
    expect(status.status).not.toBe(404);
  });
});
