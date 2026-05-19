import type http from "node:http";
import type {
  IAgentRuntime,
  Plugin,
  RouteHelpers,
  RouteRequestMeta,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemotePluginSyncResult } from "../services/remote-plugin-adapter";
import { handleRemoteCapabilityRoutes } from "./remote-capability-routes";

const originalEnabled = process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
const originalUrls = process.env.ELIZA_CAPABILITY_ROUTER_URLS;

afterEach(() => {
  if (originalEnabled === undefined) {
    delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
  } else {
    process.env.ELIZA_CAPABILITY_ROUTER_ENABLED = originalEnabled;
  }
  if (originalUrls === undefined) {
    delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
  } else {
    process.env.ELIZA_CAPABILITY_ROUTER_URLS = originalUrls;
  }
});

function makeRuntime(): IAgentRuntime {
  return {
    services: new Map(),
  } as unknown as IAgentRuntime;
}

function makeCtx(
  body: Record<string, unknown>,
  overrides: Partial<Parameters<typeof handleRemoteCapabilityRoutes>[0]> = {},
): {
  ctx: Parameters<typeof handleRemoteCapabilityRoutes>[0];
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const ctx = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/capability-router/connect",
    runtime: makeRuntime(),
    config: {},
    saveConfig: vi.fn(),
    persistConfigEnv: vi.fn(async (key: string, value: string) => {
      process.env[key] = value;
    }),
    readJsonBody: vi.fn().mockResolvedValue(body),
    json,
    error,
    ...overrides,
  } satisfies RouteRequestMeta &
    Pick<RouteHelpers, "json" | "error"> &
    Parameters<typeof handleRemoteCapabilityRoutes>[0];
  return { ctx, json, error };
}

const syncResult: RemotePluginSyncResult = {
  registered: [{ name: "remote-plugin" } as Plugin],
  unloaded: ["old-remote-plugin"],
  skipped: ["local-plugin"],
};

describe("handleRemoteCapabilityRoutes", () => {
  it("installs a direct endpoint, syncs plugins, and redacts tokens", async () => {
    const installEndpoint = vi.fn();
    const syncPlugins = vi.fn().mockResolvedValue(syncResult);
    const { ctx, json, error } = makeCtx(
      {
        endpoint: {
          id: "tools",
          baseUrl: "https://capability.example.test/",
          token: "secret-token",
        },
        requestTimeoutMs: 15_000,
      },
      { installEndpoint, syncPlugins },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(installEndpoint).toHaveBeenCalledWith(ctx.runtime, {
      enabled: true,
      endpoints: [
        {
          id: "tools",
          baseUrl: "https://capability.example.test",
          token: "secret-token",
        },
      ],
      environment: "server",
      requestTimeoutMs: 15_000,
    });
    expect(syncPlugins).toHaveBeenCalledWith(ctx.runtime, {
      unloadMissing: true,
    });
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, {
      success: true,
      mode: "endpoint",
      endpoint: {
        id: "tools",
        baseUrl: "https://capability.example.test",
        hasToken: true,
      },
      persisted: true,
      sync: {
        registered: ["remote-plugin"],
        unloaded: ["old-remote-plugin"],
        skipped: ["local-plugin"],
      },
    });
    expect(JSON.stringify(json.mock.calls[0]?.[1])).not.toContain(
      "secret-token",
    );
    expect(ctx.saveConfig).toHaveBeenCalledOnce();
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_ENABLED).toBe("true");
    expect(
      JSON.parse(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS ?? "[]"),
    ).toEqual([
      {
        id: "tools",
        baseUrl: "https://capability.example.test",
      },
    ]);
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_ENABLED",
      "true",
    );
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_URLS",
      JSON.stringify([
        {
          id: "tools",
          baseUrl: "https://capability.example.test",
          token: "secret-token",
        },
      ]),
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS).not.toContain(
      "secret-token",
    );
  });

  it("provisions cloud sandbox and returns redacted endpoint metadata", async () => {
    const connectCloudSandbox = vi.fn().mockResolvedValue({
      agentId: "agent-1",
      jobId: "job-1",
      endpoint: {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
        token: "cloud-secret",
      },
      sync: syncResult,
    });
    const { ctx, json, error } = makeCtx(
      {
        cloud: {
          cloudApiBase: "https://cloud.example.test/",
          authToken: "cloud-auth",
          name: "Remote Tools",
          bio: ["runs dynamic capabilities"],
          endpointId: "cloud",
          token: "endpoint-token",
          timeoutMs: 5_000,
          pollIntervalMs: 100,
        },
        unloadMissing: false,
      },
      { connectCloudSandbox },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(connectCloudSandbox).toHaveBeenCalledWith(ctx.runtime, {
      cloudApiBase: "https://cloud.example.test",
      authToken: "cloud-auth",
      name: "Remote Tools",
      bio: ["runs dynamic capabilities"],
      endpointId: "cloud",
      token: "endpoint-token",
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      unloadMissing: false,
      requestTimeoutMs: 60_000,
    });
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, {
      success: true,
      mode: "cloud",
      agentId: "agent-1",
      jobId: "job-1",
      endpoint: {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
        hasToken: true,
      },
      persisted: true,
      sync: {
        registered: ["remote-plugin"],
        unloaded: ["old-remote-plugin"],
        skipped: ["local-plugin"],
      },
    });
    expect(JSON.stringify(json.mock.calls[0]?.[1])).not.toContain(
      "cloud-secret",
    );
    expect(ctx.saveConfig).toHaveBeenCalledOnce();
    expect(
      JSON.parse(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS ?? "[]"),
    ).toEqual([
      {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
      },
    ]);
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_URLS",
      JSON.stringify([
        {
          id: "cloud",
          baseUrl: "https://cloud-capability.example.test",
          token: "cloud-secret",
        },
      ]),
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS).not.toContain(
      "cloud-secret",
    );
  });

  it("can connect without persisting the endpoint", async () => {
    const installEndpoint = vi.fn();
    const syncPlugins = vi.fn().mockResolvedValue(syncResult);
    const { ctx, json } = makeCtx(
      {
        endpoint: {
          id: "ephemeral",
          baseUrl: "https://capability.example.test",
        },
        persist: false,
      },
      { installEndpoint, syncPlugins },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(ctx.saveConfig).not.toHaveBeenCalled();
    expect(ctx.persistConfigEnv).not.toHaveBeenCalled();
    expect(json.mock.calls[0]?.[1]).toMatchObject({
      success: true,
      persisted: false,
    });
  });

  it("merges persisted endpoints by id", async () => {
    const installEndpoint = vi.fn();
    const syncPlugins = vi.fn().mockResolvedValue(syncResult);
    const { ctx } = makeCtx(
      {
        endpoint: {
          id: "tools",
          baseUrl: "https://new.example.test",
          token: "new-token",
        },
      },
      {
        installEndpoint,
        syncPlugins,
        config: {
          env: {
            vars: {
              ELIZA_CAPABILITY_ROUTER_URLS: JSON.stringify([
                {
                  id: "tools",
                  baseUrl: "https://old.example.test",
                  token: "old-token",
                },
                { id: "other", baseUrl: "https://other.example.test" },
              ]),
            },
          },
        },
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(
      JSON.parse(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS ?? "[]"),
    ).toEqual([
      { id: "tools", baseUrl: "https://new.example.test" },
      { id: "other", baseUrl: "https://other.example.test" },
    ]);
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_URLS",
      JSON.stringify([
        {
          id: "tools",
          baseUrl: "https://new.example.test",
          token: "new-token",
        },
        { id: "other", baseUrl: "https://other.example.test" },
      ]),
    );
  });

  it("rejects requests without endpoint or cloud configuration", async () => {
    const { ctx, error, json } = makeCtx({});

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Request body must include either 'endpoint' or 'cloud'.",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects invalid endpoint URLs", async () => {
    const { ctx, error, json } = makeCtx({
      endpoint: { baseUrl: "file:///tmp/capability" },
    });

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "endpoint.baseUrl must use http or https.",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("returns unavailable when no runtime is active", async () => {
    const { ctx, error } = makeCtx(
      { endpoint: { baseUrl: "https://capability.example.test" } },
      { runtime: null },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Agent runtime unavailable",
      503,
    );
  });

  it("does not handle unrelated routes", async () => {
    const { ctx, json, error } = makeCtx(
      {},
      { pathname: "/api/registry/plugins" },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
