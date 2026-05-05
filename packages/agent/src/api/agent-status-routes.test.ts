import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.js";
import {
  type AgentStatusRouteContext,
  handleAgentStatusRoutes,
} from "./agent-status-routes.js";

function baseContext(
  plugins: Array<{ name: string }>,
): AgentStatusRouteContext & { jsonPayload?: unknown } {
  const ctx = {
    req: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "GET",
    pathname: "/api/agent/self-status",
    url: new URL("http://127.0.0.1/api/agent/self-status"),
    state: {
      config: {} as ElizaConfig,
      runtime: {
        plugins,
        character: { name: "Test Agent" },
      },
      agentState: "running",
      agentName: "Test Agent",
      shellEnabled: true,
    },
    json: vi.fn((_res: http.ServerResponse, data: unknown) => {
      ctx.jsonPayload = data;
    }),
    error: vi.fn(),
    readJsonBody: vi.fn(),
    deps: {
      getWalletAddresses: () => ({
        evmAddress: null,
        solanaAddress: null,
      }),
      resolveWalletCapabilityStatus: () => ({
        walletSource: "none",
        hasWallet: false,
        hasEvm: false,
        evmAddress: null,
        localSignerAvailable: false,
        rpcReady: false,
        pluginEvmLoaded: false,
        pluginEvmRequired: false,
        executionReady: false,
        executionBlockedReason: null,
        automationMode: "disabled",
      }),
      resolveWalletRpcReadiness: () => ({
        managedBscRpcReady: false,
      }),
      resolveTradePermissionMode: () => "disabled",
      canUseLocalTradeExecution: () => false,
      detectRuntimeModel: () => undefined,
      resolveProviderFromModel: () => null,
      getGlobalAwarenessRegistry: () => null,
      RegistryService: {
        defaultCapabilitiesHash: () => "hash",
      },
    },
  } satisfies AgentStatusRouteContext & { jsonPayload?: unknown };
  return ctx;
}

describe("handleAgentStatusRoutes", () => {
  it("recognizes full computer-use plugin package names", async () => {
    const ctx = baseContext([{ name: "@elizaos/plugin-computeruse" }]);

    await expect(handleAgentStatusRoutes(ctx)).resolves.toBe(true);

    expect(ctx.jsonPayload).toMatchObject({
      capabilities: {
        canUseComputer: true,
      },
    });
  });
});
