/**
 * Behavioural coverage for `handleElizaCompatRoute` from `./server` — the
 * app-core compat dispatcher entrypoint — against the real COMPAT_ROUTE_CHAIN
 * and the real route-auth-policy gate: the `/api/agents` single-agent envelope
 * (stopped vs attached runtime, session-tier denial), the OWNER-gated
 * `POST /api/agent/reset` rejection that must not touch PGlite state, and the
 * authorized `GET /api/config` read with sensitive env keys stripped through
 * the live filter. Requests run through real `http.IncomingMessage` /
 * `http.ServerResponse` objects against an on-disk `ELIZA_STATE_DIR` fixture;
 * nothing in the module under test is mocked.
 */
import fs from "node:fs";
import http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CompatRuntimeState } from "./compat-route-shared";
import { handleElizaCompatRoute, SENSITIVE_ENV_RESPONSE_KEYS } from "./server";

const TOKEN = "test-suite-api-token-1";
const STUB_AGENT_ID = "123e4567-e89b-42d3-a456-426614174000";

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CONFIG_PATH",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_RUNTIME_MODE",
  "ELIZA_STATE_DIR",
  "PGLITE_DATA_DIR",
] as const;

let savedEnv: Record<string, string | undefined>;
let stateDir: string | null = null;
let dataDirParent: string | null = null;

function baseState(
  current: CompatRuntimeState["current"] = null,
): CompatRuntimeState {
  return { current, pendingAgentName: null, pendingRestartReasons: [] };
}

function writeStateDirConfig(config: Record<string, unknown>): void {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-server-cov-"));
  fs.writeFileSync(
    path.join(stateDir, "eliza.json"),
    JSON.stringify(config, null, 2),
  );
  process.env.ELIZA_STATE_DIR = stateDir;
}

function remoteReq(method: string, pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "example.test:2138" };
  if (method !== "GET") {
    req.push("{}");
    req.push(null);
  }
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "203.0.113.9",
    configurable: true,
  });
  return req;
}

function bearerReq(method: string, pathname: string): http.IncomingMessage {
  const req = remoteReq(method, pathname);
  req.headers.authorization = `Bearer ${TOKEN}`;
  return req;
}

function captureRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  const socket = new Socket();
  res.assignSocket(socket);
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    socket.destroy();
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    json: () => (body ? JSON.parse(body) : null),
  };
}

describe("app-core compat server dispatch", () => {
  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = null;
    }
    if (dataDirParent) {
      fs.rmSync(dataDirParent, { recursive: true, force: true });
      dataDirParent = null;
    }
  });

  it("serves a single stopped agent envelope to an authorized GET /api/agents with no runtime attached", async () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    writeStateDirConfig({ logging: { level: "error" } });

    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      bearerReq("GET", "/api/agents"),
      cap.res,
      baseState(),
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(200);
    const payload = cap.json() as {
      agents: Array<{ id: string; name: string; status: string }>;
    };
    expect(Array.isArray(payload.agents)).toBe(true);
    expect(payload.agents).toHaveLength(1);
    expect(typeof payload.agents[0].id).toBe("string");
    expect(typeof payload.agents[0].name).toBe("string");
    expect(payload.agents[0].status).toBe("stopped");
  });

  it("reports the attached runtime as running and prefers its agentId in the /api/agents envelope", async () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    writeStateDirConfig({ logging: { level: "error" } });

    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      bearerReq("GET", "/api/agents"),
      cap.res,
      baseState({ agentId: STUB_AGENT_ID } as CompatRuntimeState["current"]),
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(200);
    const payload = cap.json() as { agents: Array<Record<string, unknown>> };
    expect(payload.agents).toHaveLength(1);
    expect(payload.agents[0].id).toBe(STUB_AGENT_ID);
    expect(payload.agents[0].status).toBe("running");
  });

  it("denies an unauthenticated GET /api/agents before any envelope is built", async () => {
    writeStateDirConfig({ logging: { level: "error" } });

    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      remoteReq("GET", "/api/agents"),
      cap.res,
      baseState(),
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(401);
    expect(cap.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects an unauthenticated POST /api/agent/reset without deleting the PGlite data dir", async () => {
    dataDirParent = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-reset-guard-"),
    );
    const elizadb = path.join(dataDirParent, ".elizadb");
    fs.mkdirSync(elizadb, { recursive: true });
    const marker = path.join(elizadb, "marker");
    fs.writeFileSync(marker, "x");
    process.env.PGLITE_DATA_DIR = elizadb;

    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      remoteReq("POST", "/api/agent/reset"),
      cap.res,
      baseState(),
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(401);
    expect(cap.json()).toEqual({ error: "Unauthorized" });
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(elizadb)).toBe(true);
  });

  it("strips sensitive env keys and redacts sensitive-looking keys from an authorized GET /api/config", async () => {
    process.env.ELIZA_API_TOKEN = TOKEN;
    const [exactSensitiveKey] = [...SENSITIVE_ENV_RESPONSE_KEYS];
    writeStateDirConfig({
      logging: { level: "error" },
      env: {
        [exactSensitiveKey]: "must-not-leak",
        CUSTOM_API_KEY_MATERIAL: "must-be-redacted",
        CUSTOM_PLAIN_SETTING: "visible-value",
      },
    });

    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      bearerReq("GET", "/api/config"),
      cap.res,
      baseState(),
    );

    expect(handled).toBe(true);
    expect(cap.status()).toBe(200);
    const payload = cap.json() as { env: Record<string, unknown> };
    expect(payload.env[exactSensitiveKey]).toBeUndefined();
    expect(payload.env.CUSTOM_API_KEY_MATERIAL).toBe("[REDACTED]");
    expect(payload.env.CUSTOM_PLAIN_SETTING).toBe("visible-value");
  });
});
