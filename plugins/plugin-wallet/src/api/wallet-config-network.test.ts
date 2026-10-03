/**
 * Rejects untrusted wallet network values at the config-update boundary.
 * Exercises PUT /api/wallet/config through the real route handler with a
 * hand-built context mock — no live server or wallet backend involved.
 */
import { describe, expect, it, vi } from "vitest";
import { handleWalletRoutes, type WalletRouteContext } from "./wallet-routes";

function buildPutCtx(body: unknown) {
  const res: { statusCode?: number; body?: unknown } = {};
  const applyWalletRpcConfigUpdate = vi.fn();
  const saveConfig = vi.fn();
  const ctx = {
    req: { headers: {} },
    res,
    method: "PUT",
    pathname: "/api/wallet/config",
    config: {},
    saveConfig,
    readJsonBody: vi.fn(async () => body),
    json(target: typeof res, data: unknown, status = 200) {
      target.statusCode = status;
      target.body = data;
    },
    error(target: typeof res, message: string, status = 400) {
      target.statusCode = status;
      target.body = { error: message };
    },
    deps: {
      getStoredWalletRpcSelections: () => ({
        evm: "eliza-cloud",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      }),
      applyWalletRpcConfigUpdate,
    },
  } as unknown as WalletRouteContext;
  return { ctx, res, applyWalletRpcConfigUpdate, saveConfig };
}

const selections = {
  evm: "alchemy",
  bsc: "eliza-cloud",
  solana: "eliza-cloud",
};

describe("PUT /api/wallet/config network validation", () => {
  it("accepts a valid network and preserves absent or blank as no-change", async () => {
    for (const walletNetwork of ["mainnet", undefined, "   ", null]) {
      const body =
        walletNetwork === undefined
          ? { selections }
          : { selections, walletNetwork };
      const { ctx, res, applyWalletRpcConfigUpdate } = buildPutCtx(body);
      await expect(handleWalletRoutes(ctx)).resolves.toBe(true);
      expect(res.statusCode).toBe(200);
      expect(applyWalletRpcConfigUpdate).toHaveBeenCalledOnce();
      const update = applyWalletRpcConfigUpdate.mock.calls[0][1] as {
        walletNetwork?: string;
      };
      if (walletNetwork === "mainnet") {
        expect(update.walletNetwork).toBe("mainnet");
      } else {
        expect(update.walletNetwork).toBeUndefined();
      }
    }
  });

  it("normalizes case-insensitive testnet instead of ignoring it", async () => {
    const { ctx, res, applyWalletRpcConfigUpdate } = buildPutCtx({
      selections,
      walletNetwork: " TestNet ",
    });
    await expect(handleWalletRoutes(ctx)).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
    const update = applyWalletRpcConfigUpdate.mock.calls[0][1] as {
      walletNetwork?: string;
    };
    expect(update.walletNetwork).toBe("testnet");
  });

  it("rejects non-blank invalid networks instead of silently ignoring them", async () => {
    for (const walletNetwork of [
      "devnet",
      "mainent",
      123,
      { net: "mainnet" },
    ]) {
      const { ctx, res, applyWalletRpcConfigUpdate } = buildPutCtx({
        selections,
        walletNetwork,
      });
      await expect(handleWalletRoutes(ctx)).resolves.toBe(true);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "Invalid wallet config update" });
      expect(applyWalletRpcConfigUpdate).not.toHaveBeenCalled();
    }
  });

  it("rejects invalid networks on the compat credential path", async () => {
    const { ctx, res, applyWalletRpcConfigUpdate } = buildPutCtx({
      ALCHEMY_API_KEY: "fixture-key",
      walletNetwork: "devnet",
    });
    await expect(handleWalletRoutes(ctx)).resolves.toBe(true);
    expect(res.statusCode).toBe(400);
    expect(applyWalletRpcConfigUpdate).not.toHaveBeenCalled();
  });
});
