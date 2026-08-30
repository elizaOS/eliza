import type http from "node:http";
import {
  type DevCloudEnvAuthority,
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CloudRouteState,
  handleCloudRoute,
} from "./cloud-routes.js";

const AUTHORITY_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_ORGANIZATION_ID",
  "ELIZA_CLOUD_SERVICE_KEY",
  "ELIZA_CLOUD_USER_ID",
] as const;

const originalEnv = Object.fromEntries(
  AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof AUTHORITY_ENV_KEYS)[number], string | undefined>;

const BLOCK_REASON =
  "Cloud login cannot persist credentials owned by the immutable local development launch target";

const GUARDED_ROUTES = [
  {
    label: "login",
    method: "POST",
    pathname: "/api/cloud/login",
    url: "/api/cloud/login",
  },
  {
    label: "login status",
    method: "GET",
    pathname: "/api/cloud/login/status",
    url: "/api/cloud/login/status?sessionId=immutable-session",
  },
  {
    label: "login persist",
    method: "POST",
    pathname: "/api/cloud/login/persist",
    url: "/api/cloud/login/persist",
  },
  {
    label: "disconnect",
    method: "POST",
    pathname: "/api/cloud/disconnect",
    url: "/api/cloud/disconnect",
  },
] as const;

function restoreAuthorityEnv(): void {
  for (const key of AUTHORITY_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function installAuthority(authority: DevCloudEnvAuthority): void {
  resetDevCloudEnvAuthorityForTests();
  process.env.ELIZA_DEV_SOURCE = "1";
  process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
  process.env.ELIZA_DEV_CLOUD_TARGET = authority;
  process.env.ELIZAOS_CLOUD_API_KEY = `launch-${authority}-key`;
  process.env.ELIZAOS_CLOUD_BASE_URL =
    authority === "production"
      ? "https://api.eliza.app/api/v1"
      : authority === "self-hosted"
        ? "http://127.0.0.1:8787/api/v1"
        : "https://api-staging.eliza.app/api/v1";
  process.env.ELIZAOS_CLOUD_ENABLED = "true";
  process.env.ELIZA_CLOUD_ORGANIZATION_ID = `launch-${authority}-org`;
  process.env.ELIZA_CLOUD_SERVICE_KEY = `launch-${authority}-service-key`;
  process.env.ELIZA_CLOUD_USER_ID = `launch-${authority}-user`;
  expect(resolveDevCloudEnvAuthority()).toBe(authority);
}

function requestTrap(method: string, url: string): http.IncomingMessage {
  return {
    get body(): never {
      throw new Error("guarded Cloud route read its request body");
    },
    headers: { host: "127.0.0.1:3000" },
    method,
    url,
    [Symbol.asyncIterator](): never {
      throw new Error("guarded Cloud route consumed its request stream");
    },
  } as unknown as http.IncomingMessage;
}

function responseSink(): http.ServerResponse & { jsonBody: () => unknown } {
  let body = "";
  const sink = {
    headersSent: false,
    statusCode: 200,
    setHeader: () => {},
    end: (chunk?: unknown) => {
      body = typeof chunk === "string" ? chunk : String(chunk ?? "");
      sink.headersSent = true;
      return sink;
    },
    jsonBody: () => (body ? JSON.parse(body) : undefined),
  };
  return sink as unknown as http.ServerResponse & {
    jsonBody: () => unknown;
  };
}

function createRouteState() {
  const settings = {
    ELIZAOS_CLOUD_API_KEY: "runtime-production-key",
    ELIZA_CLOUD_USER_ID: "runtime-production-user",
  };
  const runtime = {
    agentId: "11111111-2222-4333-8444-555555555555",
    character: {
      secrets: {
        ELIZAOS_CLOUD_API_KEY: "runtime-production-key",
        ELIZA_CLOUD_ORGANIZATION_ID: "runtime-production-org",
      },
      settings: { ...settings },
    },
    getService: vi.fn(() => null),
    getSetting: vi.fn((key: string) => settings[key as keyof typeof settings]),
    setSetting: vi.fn(),
    updateAgent: vi.fn(async () => undefined),
  };
  const cloudManager = {
    connect: vi.fn(),
    disconnect: vi.fn(async () => undefined),
    getActiveAgentId: vi.fn(() => null),
    getClient: vi.fn(() => null),
    getStatus: vi.fn(() => ({ connected: true })),
    init: vi.fn(async () => undefined),
    replaceApiKey: vi.fn(async () => undefined),
  };
  const sideEffects = {
    applyCanonicalSetupConfig: vi.fn(),
    handleAutonomousCloudRoute: vi.fn(async () => false),
    normalizeCloudSiteUrl: vi.fn((value?: string) => value ?? ""),
    saveElizaConfig: vi.fn(),
    validateCloudBaseUrl: vi.fn(async () => null),
  };
  const state: CloudRouteState = {
    config: {
      cloud: {
        apiKey: "durable-production-key",
        baseUrl: "https://durable.example/api/v1",
        enabled: true,
      },
      linkedAccounts: {
        elizacloud: { source: "api-key", status: "linked" },
      },
    },
    cloudManager:
      cloudManager as unknown as CloudRouteState["cloudManager"],
    runtime: runtime as unknown as CloudRouteState["runtime"],
    services: sideEffects,
  };
  return { cloudManager, runtime, sideEffects, state };
}

function cloudEnvBytes(): string {
  return JSON.stringify(
    Object.entries(process.env)
      .filter(
        ([key]) =>
          key === "ELIZA_DEV_SOURCE" ||
          key.includes("CLOUD") ||
          key.startsWith("ELIZACLOUD_"),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function runtimeBytes(runtime: ReturnType<typeof createRouteState>["runtime"]): string {
  return JSON.stringify({
    agentId: runtime.agentId,
    character: runtime.character,
  });
}

function expectNoRouteSideEffects(
  fixture: ReturnType<typeof createRouteState>,
): void {
  expect(fixture.cloudManager.connect).not.toHaveBeenCalled();
  expect(fixture.cloudManager.disconnect).not.toHaveBeenCalled();
  expect(fixture.cloudManager.getActiveAgentId).not.toHaveBeenCalled();
  expect(fixture.cloudManager.getClient).not.toHaveBeenCalled();
  expect(fixture.cloudManager.getStatus).not.toHaveBeenCalled();
  expect(fixture.cloudManager.init).not.toHaveBeenCalled();
  expect(fixture.cloudManager.replaceApiKey).not.toHaveBeenCalled();
  expect(fixture.runtime.getService).not.toHaveBeenCalled();
  expect(fixture.runtime.getSetting).not.toHaveBeenCalled();
  expect(fixture.runtime.setSetting).not.toHaveBeenCalled();
  expect(fixture.runtime.updateAgent).not.toHaveBeenCalled();
  expect(fixture.sideEffects.applyCanonicalSetupConfig).not.toHaveBeenCalled();
  expect(fixture.sideEffects.handleAutonomousCloudRoute).not.toHaveBeenCalled();
  expect(fixture.sideEffects.normalizeCloudSiteUrl).not.toHaveBeenCalled();
  expect(fixture.sideEffects.saveElizaConfig).not.toHaveBeenCalled();
  expect(fixture.sideEffects.validateCloudBaseUrl).not.toHaveBeenCalled();
}

beforeEach(() => {
  restoreAuthorityEnv();
  resetDevCloudEnvAuthorityForTests();
});

afterEach(() => {
  restoreAuthorityEnv();
  resetDevCloudEnvAuthorityForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("immutable development Cloud route authority", () => {
  it.each(["staging-default", "offline"] as const)(
    "%s rejects login and disconnect routes without fetch or disconnect",
    async (authority) => {
      installAuthority(authority);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("guarded route attempted fetch"));
      const fixture = createRouteState();

      for (const route of GUARDED_ROUTES) {
        const response = responseSink();
        const handled = await handleCloudRoute(
          requestTrap(route.method, route.url),
          response,
          route.pathname,
          route.method,
          fixture.state,
        );

        expect(handled, route.label).toBe(true);
        expect(response.statusCode, route.label).toBe(409);
        expect(response.jsonBody(), route.label).toEqual({
          ok: false,
          error: BLOCK_REASON,
        });
      }

      expect(fetchMock).not.toHaveBeenCalled();
      expectNoRouteSideEffects(fixture);
    },
  );

  it.each(["staging-explicit", "production", "self-hosted"] as const)(
    "%s preserves config, runtime, and env byte-for-byte",
    async (authority) => {
      installAuthority(authority);
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("guarded route attempted fetch"));
      const fixture = createRouteState();
      const configBefore = JSON.stringify(fixture.state.config);
      const runtimeBefore = runtimeBytes(fixture.runtime);
      const envBefore = cloudEnvBytes();

      for (const route of GUARDED_ROUTES) {
        const response = responseSink();
        const handled = await handleCloudRoute(
          requestTrap(route.method, route.url),
          response,
          route.pathname,
          route.method,
          fixture.state,
        );

        expect(handled, route.label).toBe(true);
        expect(response.statusCode, route.label).toBe(409);
        expect(response.jsonBody(), route.label).toEqual({
          ok: false,
          error: BLOCK_REASON,
        });
        expect(JSON.stringify(fixture.state.config), route.label).toBe(
          configBefore,
        );
        expect(runtimeBytes(fixture.runtime), route.label).toBe(runtimeBefore);
        expect(cloudEnvBytes(), route.label).toBe(envBefore);
      }

      expect(fetchMock).not.toHaveBeenCalled();
      expectNoRouteSideEffects(fixture);
    },
  );

  it("preserves the ordinary no-authority login delegation", async () => {
    delete process.env.ELIZA_DEV_SOURCE;
    delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
    resetDevCloudEnvAuthorityForTests();
    const fixture = createRouteState();
    fixture.sideEffects.handleAutonomousCloudRoute.mockResolvedValue(true);
    const response = responseSink();

    const handled = await handleCloudRoute(
      requestTrap("POST", "/api/cloud/login"),
      response,
      "/api/cloud/login",
      "POST",
      fixture.state,
    );

    expect(handled).toBe(true);
    expect(fixture.sideEffects.handleAutonomousCloudRoute).toHaveBeenCalledOnce();
  });

  it("preserves the ordinary no-authority disconnect behavior", async () => {
    delete process.env.ELIZA_DEV_SOURCE;
    delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
    resetDevCloudEnvAuthorityForTests();
    const fixture = createRouteState();
    const response = responseSink();

    const handled = await handleCloudRoute(
      requestTrap("POST", "/api/cloud/disconnect"),
      response,
      "/api/cloud/disconnect",
      "POST",
      fixture.state,
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.jsonBody()).toEqual({ ok: true, status: "disconnected" });
    expect(fixture.cloudManager.disconnect).toHaveBeenCalledOnce();
    expect(fixture.sideEffects.saveElizaConfig).toHaveBeenCalledOnce();
  });
});
