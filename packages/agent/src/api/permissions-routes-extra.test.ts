/**
 * Unit coverage for handlePermissionsExtraRoutes — automation-mode and
 * trade-mode GET/PUT endpoints, validation, persistence, and passthrough.
 * Context is fully injected, so no external module mocks are required.
 */
import { describe, expect, it, vi } from "vitest";
import { handlePermissionsExtraRoutes } from "./permissions-routes-extra.ts";
import type { PermissionsExtraRouteContext } from "./permissions-routes-extra.ts";

type MockResponse = {
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function makeCtx(
  overrides: Partial<PermissionsExtraRouteContext> = {},
): { ctx: PermissionsExtraRouteContext; res: MockResponse } {
  const json = vi.fn();
  const error = vi.fn();
  const res = { json, error } as unknown as MockResponse;
  const ctx = {
    req: {} as PermissionsExtraRouteContext["req"],
    res: {} as PermissionsExtraRouteContext["res"],
    method: "GET",
    pathname: "",
    state: {
      config: {},
      agentAutomationMode: undefined,
    },
    json: (r, data, status) => json(data, status),
    error: (r, message, status) => error(message, status),
    readJsonBody: vi.fn(),
    saveElizaConfig: vi.fn(),
    resolveTradePermissionMode: vi.fn(() => "user-sign-only"),
    canUseLocalTradeExecution: vi.fn(() => false),
    parseAgentAutomationMode: vi.fn(),
    persistAgentAutomationMode: vi.fn(),
    ...overrides,
  } as unknown as PermissionsExtraRouteContext;
  return { ctx, res };
}

describe("handlePermissionsExtraRoutes — automation-mode", () => {
  it("GET returns current or default mode with options", async () => {
    const { ctx, res } = makeCtx({
      method: "GET",
      pathname: "/api/permissions/automation-mode",
    });
    const handled = await handlePermissionsExtraRoutes(ctx);
    expect(handled).toBe(true);
    expect(res.json).toHaveBeenCalledWith(
      { mode: "full", options: ["connectors-only", "full"] },
      undefined,
    );
  });

  it("GET reflects a persisted mode", async () => {
    const { ctx, res } = makeCtx({
      method: "GET",
      pathname: "/api/permissions/automation-mode",
      state: { config: {}, agentAutomationMode: "connectors-only" },
    });
    await handlePermissionsExtraRoutes(ctx);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "connectors-only" }),
      undefined,
    );
  });

  it("PUT persists a valid mode and saves config", async () => {
    const saveElizaConfig = vi.fn();
    const persistAgentAutomationMode = vi.fn();
    const { ctx, res } = makeCtx({
      method: "PUT",
      pathname: "/api/permissions/automation-mode",
      readJsonBody: vi.fn(async () => ({ mode: "connectors-only" })),
      parseAgentAutomationMode: vi.fn((v) =>
        v === "connectors-only" || v === "full" ? v : null,
      ),
      persistAgentAutomationMode,
      saveElizaConfig,
    });
    const handled = await handlePermissionsExtraRoutes(ctx);
    expect(handled).toBe(true);
    expect(persistAgentAutomationMode).toHaveBeenCalled();
    expect(saveElizaConfig).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "connectors-only" }),
      undefined,
    );
  });

  it("PUT rejects an invalid mode with 400", async () => {
    const { ctx, res } = makeCtx({
      method: "PUT",
      pathname: "/api/permissions/automation-mode",
      readJsonBody: vi.fn(async () => ({ mode: "nonsense" })),
      parseAgentAutomationMode: vi.fn(() => null),
    });
    const handled = await handlePermissionsExtraRoutes(ctx);
    expect(handled).toBe(true);
    expect(res.error).toHaveBeenCalledWith(
      'Invalid mode. Expected "connectors-only" or "full".',
      400,
    );
  });
});

describe("handlePermissionsExtraRoutes — trade-mode", () => {
  it("GET returns resolved mode and execution flags", async () => {
    const resolveTradePermissionMode = vi.fn(() => "agent-auto");
    const canUseLocalTradeExecution = vi.fn(() => true);
    const { ctx, res } = makeCtx({
      method: "GET",
      pathname: "/api/permissions/trade-mode",
      resolveTradePermissionMode,
      canUseLocalTradeExecution,
    });
    const handled = await handlePermissionsExtraRoutes(ctx);
    expect(handled).toBe(true);
    expect(resolveTradePermissionMode).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        tradePermissionMode: "agent-auto",
        canUserLocalExecute: true,
        canAgentAutoTrade: true,
      }),
      undefined,
    );
  });

  it("PUT persists a valid trade mode into config.features", async () => {
    const saveElizaConfig = vi.fn();
    const config = { features: {} };
    const { ctx, res } = makeCtx({
      method: "PUT",
      pathname: "/api/permissions/trade-mode",
      state: { config, agentAutomationMode: undefined },
      readJsonBody: vi.fn(async () => ({ mode: "manual-local-key" })),
      saveElizaConfig,
      canUseLocalTradeExecution: vi.fn(() => false),
    });
    const handled = await handlePermissionsExtraRoutes(ctx);
    expect(handled).toBe(true);
    expect((config.features as Record<string, unknown>).tradePermissionMode).toBe(
      "manual-local-key",
    );
    expect(saveElizaConfig).toHaveBeenCalledWith(config);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, tradePermissionMode: "manual-local-key" }),
      undefined,
    );
  });

  it("PUT initializes features when missing", async () => {
    const config: Record<string, unknown> = {};
    const { ctx } = makeCtx({
      method: "PUT",
      pathname: "/api/permissions/trade-mode",
      state: { config: config as never, agentAutomationMode: undefined },
      readJsonBody: vi.fn(async () => ({ mode: "agent-auto" })),
    });
    await handlePermissionsExtraRoutes(ctx);
    expect((config.features as Record<string, unknown>).tradePermissionMode).toBe(
      "agent-auto",
    );
  });

  it("PUT rejects an invalid trade mode with 400", async () => {
    const { ctx, res } = makeCtx({
      method: "PUT",
      pathname: "/api/permissions/trade-mode",
      readJsonBody: vi.fn(async () => ({ mode: "instant-rich" })),
    });
    const handled = await handlePermissionsExtraRoutes(ctx);
    expect(handled).toBe(true);
    expect(res.error).toHaveBeenCalledWith(
      'mode must be "user-sign-only", "manual-local-key", or "agent-auto"',
      400,
    );
  });

  it("PUT tolerates config save failure (logs, still responds)", async () => {
    const { ctx, res } = makeCtx({
      method: "PUT",
      pathname: "/api/permissions/trade-mode",
      readJsonBody: vi.fn(async () => ({ mode: "user-sign-only" })),
      saveElizaConfig: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    const handled = await handlePermissionsExtraRoutes(ctx);
    expect(handled).toBe(true);
    expect(res.json).toHaveBeenCalled();
  });
});

describe("handlePermissionsExtraRoutes — routing", () => {
  it("returns false for unknown paths", async () => {
    const { ctx } = makeCtx({ method: "GET", pathname: "/api/other" });
    expect(await handlePermissionsExtraRoutes(ctx)).toBe(false);
  });

  it("returns true (consumed) when body read returns null", async () => {
    const { ctx } = makeCtx({
      method: "PUT",
      pathname: "/api/permissions/trade-mode",
      readJsonBody: vi.fn(async () => null),
    });
    expect(await handlePermissionsExtraRoutes(ctx)).toBe(true);
  });
});
