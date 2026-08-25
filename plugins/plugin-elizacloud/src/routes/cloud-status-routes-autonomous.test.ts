import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCanonicalCloudApiBaseUrl: vi.fn(
    (raw?: string) => raw ?? "https://api.eliza.app/api/v1",
  ),
  resolveCloudApiKey: vi.fn(() => "test-api-key"),
  validateCloudBaseUrl: vi.fn(async () => null),
  isCloudInferenceSelectedInConfig: vi.fn(() => true),
  isElizaCloudServiceSelectedInConfig: vi.fn(() => true),
  migrateLegacyRuntimeConfig: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  isCloudInferenceSelectedInConfig: mocks.isCloudInferenceSelectedInConfig,
  isElizaCloudServiceSelectedInConfig: mocks.isElizaCloudServiceSelectedInConfig,
  migrateLegacyRuntimeConfig: mocks.migrateLegacyRuntimeConfig,
}));
vi.mock("../cloud/base-url.js", () => ({
  resolveCloudApiBaseUrl: mocks.resolveCanonicalCloudApiBaseUrl,
}));
vi.mock("../cloud/cloud-api-key.js", () => ({
  resolveCloudApiKey: mocks.resolveCloudApiKey,
}));
vi.mock("../cloud/validate-url.js", () => ({
  validateCloudBaseUrl: mocks.validateCloudBaseUrl,
}));

import { handleCloudStatusRoutes } from "./cloud-status-routes-autonomous";
import type { CloudStatusRouteContext } from "./cloud-status-routes-autonomous";

function makeCtx(overrides: Partial<CloudStatusRouteContext> = {}): CloudStatusRouteContext {
  const json = vi.fn();
  const ctx: CloudStatusRouteContext = {
    res: {},
    method: "GET",
    pathname: "/api/cloud/credits",
    config: { cloud: { apiKey: "k", baseUrl: "https://api.eliza.app" } },
    runtime: null,
    json,
    ...overrides,
  };
  return ctx;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(async () => body),
  };
}

describe("handleCloudStatusRoutes /api/cloud/credits (API-key path)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveCloudApiKey.mockReturnValue("test-api-key");
    mocks.validateCloudBaseUrl.mockResolvedValue(null);
  });

  it("surfaces a numeric fixed-precision string balance with low/critical thresholds", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ balance: "1.5" }));
    const ctx = makeCtx();
    await expect(handleCloudStatusRoutes(ctx)).resolves.toBe(true);
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, {
      connected: true,
      balance: 1.5,
      low: true,
      critical: false,
      topUpUrl: "https://cloud.eliza.app/cloud/billing",
    });
  });

  it("marks a balance below 0.5 as critical", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ balance: "0.4" }));
    const ctx = makeCtx();
    await handleCloudStatusRoutes(ctx);
    const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload).toMatchObject({ balance: 0.4, low: true, critical: true });
  });

  it("treats a high balance as neither low nor critical", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ balance: 5 }));
    const ctx = makeCtx();
    await handleCloudStatusRoutes(ctx);
    const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload).toMatchObject({ balance: 5, low: false, critical: false });
  });

  it("fails closed on a malformed balance string with a numeric prefix", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ balance: "12abc" }));
    const ctx = makeCtx();
    await expect(handleCloudStatusRoutes(ctx)).rejects.toThrow(
      "unexpected response",
    );
  });

  it("fails closed on a hex-prefixed balance string", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ balance: "0x10" }));
    const ctx = makeCtx();
    await expect(handleCloudStatusRoutes(ctx)).rejects.toThrow(
      "unexpected response",
    );
  });

  it("fails closed on an exponent-notation balance string", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ balance: "1e3" }));
    const ctx = makeCtx();
    await expect(handleCloudStatusRoutes(ctx)).rejects.toThrow(
      "unexpected response",
    );
  });

  it("rejects a redirect instead of following it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 302));
    const ctx = makeCtx();
    await expect(handleCloudStatusRoutes(ctx)).rejects.toThrow(
      "redirects are not allowed",
    );
  });

  it("surfaces the upstream error message on a non-OK response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "over quota" }, 429));
    const ctx = makeCtx();
    await expect(handleCloudStatusRoutes(ctx)).rejects.toThrow("over quota");
  });

  it("returns disconnected when no API key and no auth service are present", async () => {
    mocks.resolveCloudApiKey.mockReturnValue(null);
    const ctx = makeCtx({ runtime: null });
    await expect(handleCloudStatusRoutes(ctx)).resolves.toBe(true);
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, {
      balance: null,
      connected: false,
    });
  });

  it("surfaces a base-URL validation rejection without calling fetch", async () => {
    mocks.validateCloudBaseUrl.mockResolvedValue("blocked local hostname");
    const ctx = makeCtx();
    await expect(handleCloudStatusRoutes(ctx)).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledWith(ctx.res, {
      balance: null,
      connected: true,
      error: "blocked local hostname",
    });
  });
});

describe("handleCloudStatusRoutes /api/cloud/status", () => {
  beforeEach(() => {
    mocks.resolveCloudApiKey.mockReturnValue("test-api-key");
  });

  it("reports connected with an api key before the runtime is started", async () => {
    const ctx = makeCtx({ pathname: "/api/cloud/status", runtime: null });
    await expect(handleCloudStatusRoutes(ctx)).resolves.toBe(true);
    const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload).toMatchObject({
      connected: true,
      hasApiKey: true,
      reason: "api_key_present_runtime_not_started",
    });
  });

  it("reports not authenticated when the runtime has neither auth nor key", async () => {
    mocks.resolveCloudApiKey.mockReturnValue(null);
    const ctx = makeCtx({
      pathname: "/api/cloud/status",
      runtime: { getService: () => null } as unknown as CloudStatusRouteContext["runtime"],
    });
    await expect(handleCloudStatusRoutes(ctx)).resolves.toBe(true);
    const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload).toMatchObject({
      connected: false,
      hasApiKey: false,
      reason: "not_authenticated",
    });
  });

  it("reports connected when the cloud auth service is authenticated", async () => {
    const authService = {
      isAuthenticated: () => true,
      getUserId: () => "user-1",
      getOrganizationId: () => "org-1",
    };
    const ctx = makeCtx({
      pathname: "/api/cloud/status",
      runtime: {
        getService: () => authService,
      } as unknown as CloudStatusRouteContext["runtime"],
    });
    await expect(handleCloudStatusRoutes(ctx)).resolves.toBe(true);
    const payload = (ctx.json as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload).toMatchObject({
      connected: true,
      userId: "user-1",
      organizationId: "org-1",
    });
  });

  it("returns false for an unknown route", async () => {
    const ctx = makeCtx({ pathname: "/api/other" });
    await expect(handleCloudStatusRoutes(ctx)).resolves.toBe(false);
    expect(ctx.json).not.toHaveBeenCalled();
  });
});
