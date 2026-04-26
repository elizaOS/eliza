import fs from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ElizaConfig } from "../config/config.js";
import {
  type ConfigRouteContext,
  handleConfigRoutes,
} from "./config-routes.js";

// Minimal stubs that satisfy ConfigRouteContext without dragging in the
// full server.ts surface. The reload path only consults `config`,
// `runtime`, `BLOCKED_ENV_KEYS`, `json`, and `error`.
function makeStubCtx(params: {
  method: string;
  pathname: string;
  config: ElizaConfig;
  runtime?: ConfigRouteContext["runtime"];
  body?: unknown;
}): {
  ctx: ConfigRouteContext;
  jsonCalls: Array<{ status: number; body: unknown }>;
  errorCalls: Array<{ status: number; message: string }>;
} {
  const jsonCalls: Array<{ status: number; body: unknown }> = [];
  const errorCalls: Array<{ status: number; message: string }> = [];

  const req = {
    method: params.method,
    headers: { host: "localhost" },
    url: params.pathname,
  } as unknown as http.IncomingMessage;
  const res = {
    statusCode: 200,
    setHeader: () => res,
    end: () => res,
    headersSent: false,
  } as unknown as http.ServerResponse;

  const ctx: ConfigRouteContext = {
    req,
    res,
    method: params.method,
    pathname: params.pathname,
    url: new URL(`http://localhost${params.pathname}`),
    config: params.config,
    runtime: params.runtime ?? null,
    json: (_res, data, status = 200) => jsonCalls.push({ status, body: data }),
    error: (_res, message, status = 500) =>
      errorCalls.push({ status, message }),
    readJsonBody: async () => (params.body ?? {}) as never,
    redactConfigSecrets: (cfg) => cfg,
    isBlockedObjectKey: (k) => k === "__proto__" || k === "constructor",
    stripRedactedPlaceholderValuesDeep: () => {},
    patchTouchesProviderSelection: () => false,
    BLOCKED_ENV_KEYS: new Set<string>(["NODE_OPTIONS", "PATH"]),
    CONFIG_WRITE_ALLOWED_TOP_KEYS: new Set<string>(["agents", "ui"]),
    resolveMcpServersRejection: async () => null,
    resolveMcpTerminalAuthorizationRejection: () => null,
  };

  return { ctx, jsonCalls, errorCalls };
}

describe("handleConfigRoutes — POST /api/config/reload", () => {
  let stateDir: string;
  let configPath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "milady-config-reload-"),
    );
    configPath = path.join(stateDir, "milady.json");
    process.env.MILADY_STATE_DIR = stateDir;
    process.env.MILADY_CONFIG_PATH = configPath;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it("returns 400 with a parse error when milady.json is malformed", async () => {
    await fs.writeFile(configPath, "{ this is not json", "utf8");
    const config = { ui: { assistant: { name: "Old" } } } as ElizaConfig;
    const { ctx, errorCalls, jsonCalls } = makeStubCtx({
      method: "POST",
      pathname: "/api/config/reload",
      config,
    });

    const handled = await handleConfigRoutes(ctx);
    expect(handled).toBe(true);
    expect(jsonCalls).toEqual([]);
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0].status).toBe(400);
    expect(errorCalls[0].message).toMatch(/Config reload failed/);
  });

  it("merges fresh top-level keys into state.config and reports them as applied", async () => {
    const onDisk = {
      ui: { assistant: { name: "FreshName" } },
      features: { foo: true },
    } as ElizaConfig;
    await fs.writeFile(configPath, JSON.stringify(onDisk), "utf8");

    const config = { ui: { assistant: { name: "Stale" } } } as ElizaConfig;
    const { ctx, jsonCalls, errorCalls } = makeStubCtx({
      method: "POST",
      pathname: "/api/config/reload",
      config,
    });

    const handled = await handleConfigRoutes(ctx);
    expect(handled).toBe(true);
    expect(errorCalls).toEqual([]);
    expect(jsonCalls).toHaveLength(1);
    const body = jsonCalls[0].body as {
      reloaded: boolean;
      applied: string[];
      requiresRestart: string[];
    };
    expect(body.reloaded).toBe(true);
    // ui + features must be in the applied diff. loadElizaConfig() may
    // add other defaulted top keys (logging etc.); we assert only the
    // ones we actually changed are surfaced.
    expect(body.applied).toEqual(expect.arrayContaining(["ui", "features"]));
    expect(body.requiresRestart).toEqual([]);

    // state.config should now reflect the on-disk values in place.
    const live = config as unknown as Record<string, unknown>;
    expect((live.ui as { assistant?: { name?: string } }).assistant?.name).toBe(
      "FreshName",
    );
    expect((live.features as Record<string, unknown>).foo).toBe(true);
  });

  it("reports plugin-list changes under requiresRestart, not applied", async () => {
    const onDisk = {
      ui: { assistant: { name: "X" } },
      plugins: { allow: ["@elizaos/plugin-twitter"] },
    } as ElizaConfig;
    await fs.writeFile(configPath, JSON.stringify(onDisk), "utf8");

    const config = {
      ui: { assistant: { name: "X" } },
      plugins: { allow: [] },
    } as ElizaConfig;
    const { ctx, jsonCalls } = makeStubCtx({
      method: "POST",
      pathname: "/api/config/reload",
      config,
    });

    await handleConfigRoutes(ctx);
    const body = jsonCalls[0].body as {
      applied: string[];
      requiresRestart: string[];
    };
    expect(body.requiresRestart).toContain("plugins");
    expect(body.applied).not.toContain("plugins");
  });

  it("syncs whitelisted provider env keys from config.env.vars into process.env", async () => {
    const onDisk = {
      env: {
        vars: {
          ANTHROPIC_API_KEY: "sk-fresh-anthropic",
          PATH: "/should/not/leak", // blocked
        },
      },
    } as unknown as ElizaConfig;
    await fs.writeFile(configPath, JSON.stringify(onDisk), "utf8");

    delete process.env.ANTHROPIC_API_KEY;
    const before = process.env.PATH;

    const { ctx } = makeStubCtx({
      method: "POST",
      pathname: "/api/config/reload",
      config: {} as ElizaConfig,
    });

    await handleConfigRoutes(ctx);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-fresh-anthropic");
    expect(process.env.PATH).toBe(before); // blocked key not overwritten
  });
});
