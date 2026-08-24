/**
 * Guards the runtime export contract of the public agent API barrel and drives
 * its compatibility handlers through their real plugin implementations.
 */
import { handleAppsRoutes as pluginHandleAppsRoutes } from "@elizaos/plugin-app-manager";
import { describe, expect, it } from "vitest";
import { dispatchRoute } from "./dispatch-route.ts";
import * as api from "./index.ts";
import {
  matchPluginRoutePath,
  tryHandleRuntimePluginRoute,
} from "./runtime-plugin-routes.ts";
import { hasPersistedFirstRunState } from "./server-helpers.ts";

const STAR_EXPORT_MODULES = [
  "./accounts-routes.ts",
  "./agent-admin-routes.ts",
  "./agent-lifecycle-routes.ts",
  "./agent-model.ts",
  "./agent-transfer-routes.ts",
  "./approval-routes.ts",
  "./auth-routes.ts",
  "./backup-v2-stream-response.ts",
  "./bug-report-routes.ts",
  "./character-routes.ts",
  "./compat-utils.ts",
  "./connector-health.ts",
  "./conversation-restore.ts",
  "./credit-detection.ts",
  "./database.ts",
  "./diagnostics-routes.ts",
  "./documents-service-loader.ts",
  "./early-logs.ts",
  "./memory-bounds.ts",
  "./memory-routes.ts",
  "./model-catalog.ts",
  "./model-config-routes.ts",
  "./models-routes.ts",
  "./parse-action-block.ts",
  "./permissions-routes.ts",
  "./plugin-validation.ts",
  "./project-routes.ts",
  "./provider-switch-config.ts",
  "./rate-limiter.ts",
  "./registry-routes.ts",
  "./registry-service.ts",
  "./subscription-routes.ts",
  "./terminal-run-limits.ts",
  "./tx-service.ts",
  "./wallet.ts",
  "./wallet-evm-balance.ts",
  "./wallet-rpc.ts",
  "./wallet-trading-profile.ts",
  "./workbench-vfs-routes.ts",
  "./zip-utils.ts",
] as const;

function createWalletRouteContext(method: string, pathname: string) {
  const response: { body?: unknown; statusCode?: number } = {};
  const context = {
    req: { headers: {} },
    res: response,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    config: {},
    saveConfig() {},
    ensureWalletKeysInEnvAndConfig: () => true,
    resolveWalletExportRejection: () => null,
    deps: {},
    readJsonBody: async () => null,
    json(target: typeof response, body: unknown, statusCode = 200) {
      target.statusCode = statusCode;
      target.body = body;
    },
    error(target: typeof response, message: string, statusCode = 400) {
      target.statusCode = statusCode;
      target.body = { error: message };
    },
  } as unknown as Parameters<typeof api.handleWalletRoutes>[0];

  return { context, response };
}

describe("agent API barrel", () => {
  it("re-exports every runtime symbol from each star-exported API module", async () => {
    const publicApi = api as Record<string, unknown>;

    for (const specifier of STAR_EXPORT_MODULES) {
      const source = await import(specifier);
      for (const [name, value] of Object.entries(source)) {
        if (name === "default") continue;
        expect(publicApi, `${specifier} export ${name}`).toHaveProperty(name);
        expect(publicApi[name], `${specifier} export ${name}`).toBe(value);
      }
    }
  });

  it("preserves the explicitly named compatibility and dispatcher exports", () => {
    expect(api.handleAppsRoutes).toBe(pluginHandleAppsRoutes);
    expect(api.dispatchRoute).toBe(dispatchRoute);
    expect(api.matchPluginRoutePath).toBe(matchPluginRoutePath);
    expect(api.tryHandleRuntimePluginRoute).toBe(tryHandleRuntimePluginRoute);
    expect(api.hasPersistedFirstRunState).toBe(hasPersistedFirstRunState);
  });

  it("delegates wallet routes lazily to the real plugin handler", async () => {
    const unhandled = createWalletRouteContext(
      "GET",
      "/api/not-a-wallet-route",
    );
    await expect(api.handleWalletRoutes(unhandled.context)).resolves.toBe(
      false,
    );
    expect(unhandled.response).toEqual({});

    const removedExport = createWalletRouteContext(
      "POST",
      "/api/wallet/export",
    );
    await expect(api.handleWalletRoutes(removedExport.context)).resolves.toBe(
      true,
    );
    expect(removedExport.response).toEqual({
      statusCode: 410,
      body: {
        error:
          "Private key export has been removed. Use Steward or OS-backed custody flows.",
      },
    });
  });
});
