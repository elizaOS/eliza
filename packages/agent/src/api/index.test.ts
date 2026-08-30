/**
 * Guards the runtime export contract of the public agent API barrel and drives
 * its compatibility handlers through their real plugin implementations.
 */
import { describe, expect, it } from "vitest";
import * as api from "./index.ts";

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
