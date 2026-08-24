/**
 * Real HTTP-boundary coverage for owner-only diagnostics. The production
 * server runs on an ephemeral loopback listener with a deterministic host
 * authorization bridge so cookie role/CSRF, service/configured/host tokens,
 * failed credential attempts, redaction, export, and clear cross real TCP.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { startApiServer } from "./server.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const API_TOKEN = "diagnostics-owner-api-token";
const SERVER_TOKEN = "diagnostics-service-gateway-token";
const HOST_OWNER_BEARER = "diagnostics-host-owner-token";
const HOST_USER_BEARER = "diagnostics-host-user-token";
const HOST_OWNER_API_TOKEN = "diagnostics-host-owner-api-token";
const SOURCE = "diagnostics-redaction-boundary";
const FILTER_SOURCE = SOURCE.toUpperCase();
const PRIVATE_KEY_SECRET = "private-key-secret-abcdefghijklmnopqrstuvwxyz";
const AUTHORIZATION_SECRET = "authorization-secret-abcdefghijklmnopqrstuvwxyz";
const REMOTE_HEADERS = { "x-forwarded-for": "203.0.113.61" } as const;
const touchedEnv = [
  "AGENT_SERVER_SHARED_SECRET",
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
] as const;

const originalEnv = new Map<string, string | undefined>();
let api: ApiServer | null = null;
let stateDir: string | null = null;

const resolveAuthorization = vi.fn<
  NonNullable<typeof defaultAgentHostBridge.resolveHttpRequestAuthorization>
>(async (req, _runtime, options) => {
  if (
    options.allowBearerAuth !== false &&
    req.headers["x-api-token"] === HOST_OWNER_API_TOKEN
  ) {
    return { ok: true, role: "OWNER", identityId: "api-token-owner" };
  }
  const authorization =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";
  if (
    options.allowBearerAuth !== false &&
    authorization === `Bearer ${HOST_OWNER_BEARER}`
  ) {
    return { ok: true, role: "OWNER", identityId: "bearer-owner" };
  }
  if (
    options.allowBearerAuth !== false &&
    authorization === `Bearer ${HOST_USER_BEARER}`
  ) {
    return { ok: true, role: "USER", identityId: "bearer-user" };
  }
  if (!options.allowCookieAuth) return { ok: false, role: "NONE" };
  const cookie =
    typeof req.headers.cookie === "string" ? req.headers.cookie : "";
  const method = (req.method ?? "GET").toUpperCase();
  const mutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (cookie.includes("eliza_session=machine")) {
    if (mutation && req.headers["x-eliza-csrf"] !== "valid-csrf") {
      return { ok: false, role: "NONE" };
    }
    return { ok: true, role: "USER", identityId: "machine" };
  }
  if (!cookie.includes("eliza_session=owner")) {
    return { ok: false, role: "NONE" };
  }
  if (mutation && req.headers["x-eliza-csrf"] !== "valid-csrf") {
    return { ok: false, role: "NONE" };
  }
  return { ok: true, role: "OWNER", identityId: "owner" };
});

function restoreEnvironment(): void {
  for (const key of touchedEnv) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
}

beforeEach(async () => {
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-diagnostics-boundary-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  process.env.AGENT_SERVER_SHARED_SECRET = SERVER_TOKEN;
  process.env.ELIZA_ALLOW_WS_QUERY_TOKEN = "1";
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  resolveAuthorization.mockClear();
  setAgentHostBridge({
    ...defaultAgentHostBridge,
    resolveHttpRequestAuthorization: resolveAuthorization,
  });
  api = await startApiServer({ port: 0, skipDeferredStartupWork: true });
}, 30_000);

afterEach(async () => {
  await api?.close();
  api = null;
  _resetAgentHostBridge();
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
  }
  stateDir = null;
  restoreEnvironment();
}, 30_000);

function endpoint(pathname: string): string {
  if (!api) throw new Error("test server is not running");
  return `http://127.0.0.1:${api.port}${pathname}`;
}

function ownerHeaders(
  csrf?: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Cookie: "eliza_session=owner",
    ...(csrf ? { "X-Eliza-CSRF": csrf } : {}),
    ...extra,
  };
}

function seedSensitiveLog(): void {
  logger.info(
    {
      src: SOURCE,
      tags: [SOURCE],
      privateKey: PRIVATE_KEY_SECRET,
      Authorization: `Bearer ${AUTHORIZATION_SECRET}`,
    },
    `diagnostics marker Authorization: Bearer ${AUTHORIZATION_SECRET}`,
  );
}

describe("diagnostics authority and mutation boundary", () => {
  it("denies anonymous, USER, service, invalid-cookie, and invalid-CSRF callers without changing buffer bytes", async () => {
    seedSensitiveLog();
    const filteredPath = `/api/logs?source=${encodeURIComponent(FILTER_SOURCE)}`;
    const beforeResponse = await fetch(endpoint(filteredPath), {
      headers: ownerHeaders(),
    });
    expect(beforeResponse.status).toBe(200);
    const beforeBytes = await beforeResponse.text();

    const anonymous = await fetch(endpoint(filteredPath), {
      headers: REMOTE_HEADERS,
    });
    expect(anonymous.status).toBe(401);

    const deniedMutations: Array<{
      label: string;
      headers: Record<string, string>;
      status: number;
    }> = [
      {
        label: "host machine USER",
        headers: ownerHeaders("valid-csrf", {
          Cookie: "eliza_session=machine",
        }),
        status: 403,
      },
      {
        label: "service gateway",
        headers: { ...REMOTE_HEADERS, "X-Server-Token": SERVER_TOKEN },
        status: 403,
      },
      {
        label: "invalid ambient cookie on trusted loopback",
        headers: { Cookie: "eliza_session=invalid" },
        status: 401,
      },
      {
        label: "owner cookie without CSRF",
        headers: ownerHeaders(),
        status: 401,
      },
      {
        label: "owner cookie with wrong CSRF",
        headers: ownerHeaders("wrong-csrf"),
        status: 401,
      },
    ];

    for (const denied of deniedMutations) {
      const response = await fetch(endpoint("/api/logs"), {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...denied.headers,
        },
        body: JSON.stringify({ confirm: true }),
      });
      expect(response.status, denied.label).toBe(denied.status);
    }

    const afterResponse = await fetch(endpoint(filteredPath), {
      headers: ownerHeaders(),
    });
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.text()).toBe(beforeBytes);
    expect(resolveAuthorization.mock.calls).toContainEqual([
      expect.anything(),
      null,
      expect.objectContaining({
        allowTrustedLocalBypass: false,
        allowBearerAuth: true,
      }),
    ]);
  });

  it("preserves host bearer roles and rejects an invalid bearer before loopback fallback", async () => {
    const owner = await fetch(endpoint("/api/logs"), {
      headers: {
        ...REMOTE_HEADERS,
        Authorization: `Bearer ${HOST_OWNER_BEARER}`,
      },
    });
    expect(owner.status).toBe(200);

    const user = await fetch(endpoint("/api/logs"), {
      headers: {
        ...REMOTE_HEADERS,
        Authorization: `Bearer ${HOST_USER_BEARER}`,
      },
    });
    expect(user.status).toBe(403);

    const invalidLoopback = await fetch(endpoint("/api/logs"), {
      headers: { Authorization: "Bearer invalid-host-token" },
    });
    expect(invalidLoopback.status).toBe(401);

    const apiTokenOwner = await fetch(endpoint("/api/logs"), {
      headers: {
        ...REMOTE_HEADERS,
        "X-API-Token": HOST_OWNER_API_TOKEN,
      },
    });
    expect(apiTokenOwner.status).toBe(200);
  });

  it("rejects failed supported credential channels before loopback fallback", async () => {
    const attempts: Array<{
      label: string;
      pathname: string;
      headers: Record<string, string>;
    }> = [
      {
        label: "wrong host API token",
        pathname: "/api/logs",
        headers: { "X-API-Token": "wrong-host-token" },
      },
      {
        label: "wrong service token",
        pathname: "/api/logs",
        headers: { "X-Server-Token": "wrong-service-token" },
      },
      {
        label: "wrong configured-token alias",
        pathname: "/api/logs",
        headers: { "X-ElizaOS-Token": "wrong-configured-token" },
      },
      {
        label: "wrong supported SSE query token",
        pathname: "/api/logs?api_key=wrong-query-token",
        headers: { Accept: "text/event-stream" },
      },
      {
        label: "empty session cookie",
        pathname: "/api/logs",
        headers: { Cookie: "eliza_session=" },
      },
    ];

    for (const attempt of attempts) {
      const response = await fetch(endpoint(attempt.pathname), {
        headers: attempt.headers,
      });
      expect(response.status, attempt.label).toBe(401);
    }
  });

  it("accepts owner cookie plus CSRF plus confirmation for clear", async () => {
    seedSensitiveLog();
    const response = await fetch(endpoint("/api/logs"), {
      method: "DELETE",
      headers: ownerHeaders("valid-csrf", {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ confirm: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cleared: expect.any(Number),
    });
    const filtered = await fetch(
      endpoint(`/api/logs?source=${encodeURIComponent(FILTER_SOURCE)}`),
      { headers: ownerHeaders() },
    );
    await expect(filtered.json()).resolves.toMatchObject({ entries: [] });
  });
});

describe("logger to diagnostics export redaction", () => {
  it("redacts credential context and text in GET, JSON, and CSV exports for configured API owners", async () => {
    seedSensitiveLog();
    const read = await fetch(
      endpoint(`/api/logs?source=${encodeURIComponent(FILTER_SOURCE)}`),
      { headers: ownerHeaders() },
    );
    const readText = await read.text();
    expect(read.status).toBe(200);
    expect(readText).not.toContain(PRIVATE_KEY_SECRET);
    expect(readText).not.toContain(AUTHORIZATION_SECRET);
    expect(readText).toContain("[REDACTED]");

    for (const format of ["json", "csv"] as const) {
      const response = await fetch(endpoint("/api/logs/export"), {
        method: "POST",
        headers: {
          ...REMOTE_HEADERS,
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          confirm: true,
          format,
          source: FILTER_SOURCE,
        }),
      });
      const attachment = await response.text();
      expect(response.status, format).toBe(200);
      expect(response.headers.get("content-disposition"), format).toContain(
        `.${format}`,
      );
      expect(attachment, format).not.toContain(PRIVATE_KEY_SECRET);
      expect(attachment, format).not.toContain(AUTHORIZATION_SECRET);
      expect(attachment, format).toContain("[REDACTED]");
    }
  });
});
