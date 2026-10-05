import type http from "node:http";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  handlePermissionsExtraRoutes,
  type PermissionsExtraRouteContext,
} from "./permissions-routes-extra.ts";

function tradeModePut(
  config: ElizaConfig,
  mode: string,
  saveError: Error,
): PermissionsExtraRouteContext {
  return {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "PUT",
    pathname: "/api/permissions/trade-mode",
    state: { config },
    json: vi.fn(),
    error: vi.fn(),
    readJsonBody: vi.fn(async () => ({ mode })) as never,
    saveElizaConfig: vi.fn(() => {
      throw saveError;
    }),
    resolveTradePermissionMode: vi.fn(),
    canUseLocalTradeExecution: vi.fn(() => false),
    parseAgentAutomationMode: vi.fn(),
    persistAgentAutomationMode: vi.fn(),
  };
}

describe("PUT /api/permissions/trade-mode", () => {
  it("rolls the mode back and answers 500 when the config write fails", async () => {
    const config = {
      features: { tradePermissionMode: "agent-auto", other: true },
    } as unknown as ElizaConfig;
    const ctx = tradeModePut(config, "user-sign-only", new Error("EACCES"));

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to save trade permission mode: EACCES",
      500,
    );
    expect(ctx.json).not.toHaveBeenCalled();
    expect(ctx.state.config.features).toEqual({
      tradePermissionMode: "agent-auto",
      other: true,
    });
  });

  it("leaves features unset when the first trade-mode write fails", async () => {
    const ctx = tradeModePut(
      {} as ElizaConfig,
      "agent-auto",
      new Error("ENOSPC"),
    );

    await expect(handlePermissionsExtraRoutes(ctx)).resolves.toBe(true);

    expect(ctx.error).toHaveBeenCalledWith(
      ctx.res,
      "Failed to save trade permission mode: ENOSPC",
      500,
    );
    expect(ctx.state.config.features).toBeUndefined();
  });
});
