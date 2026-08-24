/**
 * Real TCP coverage for canonical first-run authorization, CSRF, durable
 * completion, and rerun denial. The host bridge is deterministic, while every
 * request crosses the production Host/CORS/auth/route/persistence pipeline.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { startApiServer } from "./server.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const touchedEnv = [
  "AGENT_SERVER_SHARED_SECRET",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
] as const;

const originalEnv = new Map<string, string | undefined>();
let stateDir: string | null = null;
let api: ApiServer | null = null;

beforeEach(async () => {
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-first-run-real-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = process.env.ELIZA_CONFIG_PATH;
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = "configured-owner-token";
  process.env.AGENT_SERVER_SHARED_SECRET = "s".repeat(32);
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.EVM_PRIVATE_KEY;
  delete process.env.SOLANA_PRIVATE_KEY;

  setAgentHostBridge({
    ...defaultAgentHostBridge,
    resolveHttpRequestAuthorization: async (req, _runtime, options) => {
      const authorization =
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : "";
      if (options.allowBearerAuth && authorization === "Bearer host-owner") {
        return { ok: true, role: "OWNER", identityId: "owner" };
      }
      if (options.allowBearerAuth && authorization === "Bearer host-user") {
        return { ok: true, role: "USER", identityId: "machine" };
      }
      if (!options.allowCookieAuth) return { ok: false, role: "NONE" };
      const cookie =
        typeof req.headers.cookie === "string" ? req.headers.cookie : "";
      if (!cookie.includes("eliza_session=owner-session")) {
        return { ok: false, role: "NONE" };
      }
      if (
        req.method === "POST" &&
        req.headers["x-eliza-csrf"] !== "valid-csrf"
      ) {
        return { ok: false, role: "NONE" };
      }
      return { ok: true, role: "OWNER", identityId: "owner" };
    },
  });

  api = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
  });
}, 30_000);

afterEach(async () => {
  await api?.close();
  api = null;
  _resetAgentHostBridge();
  if (stateDir) await rm(stateDir, { recursive: true, force: true });
  stateDir = null;
  for (const key of touchedEnv) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
}, 30_000);

function endpoint(pathname: string): string {
  if (!api) throw new Error("test server is not running");
  return `http://127.0.0.1:${api.port}${pathname}`;
}

async function post(
  headers: Record<string, string>,
  body = '{"name":"Ada"}',
): Promise<Response> {
  return fetch(endpoint("/api/first-run"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("canonical first-run server boundary", () => {
  it("denies remote/USER/failed credentials, enforces cookie CSRF, commits once, and rejects rerun", async () => {
    const remoteAnonymous = await fetch(endpoint("/api/first-run/status"), {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(remoteAnonymous.status).toBe(401);

    const provisionalLoopback = await fetch(endpoint("/api/first-run/status"));
    expect(provisionalLoopback.status).toBe(200);
    await expect(provisionalLoopback.json()).resolves.toEqual({
      complete: false,
    });

    const hostUser = await fetch(endpoint("/api/first-run/options"), {
      headers: { authorization: "Bearer host-user" },
    });
    expect(hostUser.status).toBe(403);

    const serviceUser = await fetch(endpoint("/api/first-run/options"), {
      headers: { "x-server-token": "s".repeat(32) },
    });
    expect(serviceUser.status).toBe(403);

    const invalidHeaders: Array<Record<string, string>> = [
      { authorization: "Bearer wrong" },
      { "x-api-token": "wrong" },
      { "x-eliza-token": "wrong" },
      { cookie: "eliza_session=" },
    ];
    for (const headers of invalidHeaders) {
      const denied = await fetch(endpoint("/api/first-run/options"), {
        headers,
      });
      expect(denied.status).toBe(401);
    }

    const hostOwner = await fetch(endpoint("/api/first-run/options"), {
      headers: { authorization: "Bearer host-owner" },
    });
    expect(hostOwner.status).toBe(200);

    const configuredOwner = await fetch(endpoint("/api/first-run/options"), {
      headers: { authorization: "Bearer configured-owner-token" },
    });
    expect(configuredOwner.status).toBe(200);

    let resolveHeldStatus: ((status: number) => void) | undefined;
    const heldStatus = new Promise<number>((resolve) => {
      resolveHeldStatus = resolve;
    });
    const held = http.request(
      endpoint("/api/first-run"),
      {
        method: "POST",
        headers: {
          authorization: "Bearer configured-owner-token",
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolveHeldStatus?.(response.statusCode ?? 0),
        );
      },
    );
    held.write('{"name":');
    let concurrentStatus = 0;
    for (let attempt = 0; attempt < 10 && concurrentStatus !== 409; attempt++) {
      const concurrent = await post(
        { authorization: "Bearer configured-owner-token" },
        "{}",
      );
      concurrentStatus = concurrent.status;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(concurrentStatus).toBe(409);
    held.end("{}}");
    await expect(heldStatus).resolves.toBe(400);

    const missingCsrf = await post({ cookie: "eliza_session=owner-session" });
    expect(missingCsrf.status).toBe(401);

    const wrongCsrf = await post({
      cookie: "eliza_session=owner-session",
      "x-eliza-csrf": "wrong",
    });
    expect(wrongCsrf.status).toBe(401);

    const committed = await post({
      cookie: "eliza_session=owner-session",
      "x-eliza-csrf": "valid-csrf",
    });
    expect(committed.status).toBe(200);
    await expect(committed.json()).resolves.toEqual({ ok: true });

    const persisted = await readFile(
      process.env.ELIZA_CONFIG_PATH as string,
      "utf8",
    );
    expect(persisted).toContain('"firstRunComplete": true');
    expect(persisted).toContain("EVM_PRIVATE_KEY");
    expect(persisted).toContain("SOLANA_PRIVATE_KEY");

    const rerun = await post({
      authorization: "Bearer configured-owner-token",
    });
    expect(rerun.status).toBe(409);
    await expect(rerun.json()).resolves.toEqual({
      error: "First-run setup is already complete",
    });
  });
});
