/**
 * Persistence contract for POST /api/capability-router/connect: absent stored
 * values merge as empty, while a present-but-unreadable stored value refuses
 * the save instead of being rewritten as empty.
 */
import type http from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleRemoteCapabilityRoutes,
  type RemoteCapabilityRouteContext,
} from "./remote-capability-routes.ts";

const PERSISTED_KEYS = [
  "ELIZA_CAPABILITY_ROUTER_ENABLED",
  "ELIZA_CAPABILITY_ROUTER_URLS",
  "ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES",
  "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
  "ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT",
] as const;

const EXISTING_ENDPOINT = {
  id: "existing",
  baseUrl: "https://existing.example.com",
};
const EXISTING_AUDIT_RECORD = {
  recordedAt: "2026-01-01T00:00:00.000Z",
  mode: "endpoint",
  provider: "direct",
  endpoint: { id: "existing", baseUrl: EXISTING_ENDPOINT.baseUrl },
  allowedModuleIds: [],
  registered: [],
  skipped: [],
  unloaded: [],
  trustDecisions: [],
};

type Harness = {
  ctx: RemoteCapabilityRouteContext;
  vars: Record<string, string>;
  saveConfig: ReturnType<typeof vi.fn>;
  persistConfigEnv: ReturnType<typeof vi.fn>;
  connectEndpointProvider: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function createHarness(vars: Record<string, string>): Harness {
  const config = { env: { vars: { ...vars } } };
  const saveConfig = vi.fn();
  const persistConfigEnv = vi.fn(async () => undefined);
  const connectEndpointProvider = vi.fn(async () => ({
    providerId: "direct",
    endpoint: { id: "fresh", baseUrl: "https://fresh.example.com" },
    sync: { registered: [], unloaded: [], skipped: [], trustDecisions: [] },
  }));
  const json = vi.fn();
  const error = vi.fn();
  const ctx = {
    req: { headers: {} } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/capability-router/connect",
    runtime: {} as IAgentRuntime,
    config,
    saveConfig,
    persistConfigEnv,
    connectEndpointProvider,
    readJsonBody: vi.fn(async () => ({
      endpoint: { id: "fresh", baseUrl: "https://fresh.example.com" },
    })),
    json,
    error,
  } as unknown as RemoteCapabilityRouteContext;
  return {
    ctx,
    vars: config.env.vars,
    saveConfig,
    persistConfigEnv,
    connectEndpointProvider,
    json,
    error,
  };
}

describe("capability-router connect persistence", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PERSISTED_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PERSISTED_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("treats absent persisted values as empty and saves the new endpoint", async () => {
    const harness = createHarness({});

    await handleRemoteCapabilityRoutes(harness.ctx);

    expect(harness.error).not.toHaveBeenCalled();
    expect(harness.saveConfig).toHaveBeenCalledTimes(1);
    const saved = harness.saveConfig.mock.calls[0][0] as {
      env: { vars: Record<string, string> };
    };
    expect(JSON.parse(saved.env.vars.ELIZA_CAPABILITY_ROUTER_URLS)).toEqual([
      { id: "fresh", baseUrl: "https://fresh.example.com" },
    ]);
  });

  it("merges readable persisted endpoints and audit records", async () => {
    const harness = createHarness({
      ELIZA_CAPABILITY_ROUTER_URLS: JSON.stringify([EXISTING_ENDPOINT]),
      ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT: JSON.stringify([
        EXISTING_AUDIT_RECORD,
      ]),
    });

    await handleRemoteCapabilityRoutes(harness.ctx);

    expect(harness.error).not.toHaveBeenCalled();
    const saved = harness.saveConfig.mock.calls[0][0] as {
      env: { vars: Record<string, string> };
    };
    expect(
      JSON.parse(saved.env.vars.ELIZA_CAPABILITY_ROUTER_URLS).map(
        (endpoint: { id: string }) => endpoint.id,
      ),
    ).toEqual(["existing", "fresh"]);
    expect(
      JSON.parse(saved.env.vars.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT),
    ).toHaveLength(2);
  });

  it.each([
    ["ELIZA_CAPABILITY_ROUTER_URLS", "[not json"],
    ["ELIZA_CAPABILITY_ROUTER_URLS", '{"id":"existing"}'],
    ["ELIZA_CAPABILITY_ROUTER_URLS", '[{"id":"no-base-url"}]'],
    ["ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES", "{broken"],
    ["ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES", '{"existing":"mod"}'],
    ["ELIZA_CAPABILITY_ROUTER_TRUST_POLICY", "{broken"],
    [
      "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
      '{"existing":{"requireSignedProvenance":"yes"}}',
    ],
    ["ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT", "[broken"],
    ["ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT", '[{"mode":"endpoint"}]'],
  ])("refuses to overwrite corrupt persisted %s (%s)", async (key, value) => {
    const harness = createHarness({
      ELIZA_CAPABILITY_ROUTER_URLS: JSON.stringify([EXISTING_ENDPOINT]),
      [key]: value,
    });
    const before = { ...harness.vars };

    await handleRemoteCapabilityRoutes(harness.ctx);

    expect(harness.error).toHaveBeenCalledTimes(1);
    const [, message, status] = harness.error.mock.calls[0];
    expect(status).toBe(500);
    expect(message).toContain(key);
    expect(harness.connectEndpointProvider).not.toHaveBeenCalled();
    expect(harness.persistConfigEnv).not.toHaveBeenCalled();
    expect(harness.saveConfig).not.toHaveBeenCalled();
    expect(harness.json).not.toHaveBeenCalled();
    expect(harness.vars).toEqual(before);
  });

  it("refuses to overwrite a corrupt value supplied through process.env", async () => {
    process.env.ELIZA_CAPABILITY_ROUTER_URLS = "[not json";
    const harness = createHarness({});

    await handleRemoteCapabilityRoutes(harness.ctx);

    expect(harness.error.mock.calls[0]?.[2]).toBe(500);
    expect(harness.persistConfigEnv).not.toHaveBeenCalled();
    expect(harness.saveConfig).not.toHaveBeenCalled();
  });
});
