import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  handleWalletRoutes,
  loadElizaConfig,
  saveElizaConfig,
  resolveWalletExportRejection,
} = vi.hoisted(() => ({
  handleWalletRoutes: vi.fn(async () => true),
  loadElizaConfig: vi.fn(() => ({ features: {} })),
  saveElizaConfig: vi.fn(),
  resolveWalletExportRejection: vi.fn(() => null),
}));

vi.mock("../api/wallet-routes", () => ({
  DEFAULT_WALLET_ROUTE_DEPENDENCIES: {},
  handleWalletRoutes,
}));

vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig,
  saveElizaConfig,
}));

vi.mock("@elizaos/app-core/api/compat-route-shared", () => ({
  readCompatJsonBody: vi.fn(),
}));

vi.mock("@elizaos/app-core/api/response", () => ({
  sendJson: vi.fn(),
  sendJsonError: vi.fn(),
}));

vi.mock("./server-wallet-trade", () => ({
  resolveWalletExportRejection,
}));

import { handleWalletCoreRoutes } from "./wallet-core-routes";

describe("handleWalletCoreRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handleWalletRoutes.mockResolvedValue(true);
  });

  it("forwards runtime and restart hooks to the steward wallet routes", async () => {
    const req = {
      method: "GET",
      url: "/api/wallet/config",
      headers: { host: "localhost" },
    } as http.IncomingMessage;
    const res = {} as http.ServerResponse;
    const runtime = {
      plugins: [{ name: "evm" }],
    } as unknown as AgentRuntime;
    const restartRuntime = vi.fn(async () => true);
    const scheduleRuntimeRestart = vi.fn();

    await handleWalletCoreRoutes(req, res, {
      runtime,
      restartRuntime,
      scheduleRuntimeRestart,
    });

    expect(loadElizaConfig).toHaveBeenCalledTimes(1);
    expect(handleWalletRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        res,
        method: "GET",
        pathname: "/api/wallet/config",
        config: { features: {} },
        runtime,
        restartRuntime,
        scheduleRuntimeRestart,
      }),
    );
  });

  it("ignores non-wallet routes", async () => {
    const req = {
      method: "GET",
      url: "/api/health",
      headers: { host: "localhost" },
    } as http.IncomingMessage;
    const res = {} as http.ServerResponse;

    await expect(handleWalletCoreRoutes(req, res, {})).resolves.toBe(false);
    expect(handleWalletRoutes).not.toHaveBeenCalled();
  });
});
