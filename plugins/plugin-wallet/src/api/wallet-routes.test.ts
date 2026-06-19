import { describe, expect, it, vi } from "vitest";
import { handleWalletRoutes, type WalletRouteContext } from "./wallet-routes";

function buildCtx(): {
  ctx: WalletRouteContext;
  res: { statusCode?: number; body?: unknown };
  readJsonBody: ReturnType<typeof vi.fn>;
  resolveWalletExportRejection: ReturnType<typeof vi.fn>;
} {
  const res: { statusCode?: number; body?: unknown } = {};
  const readJsonBody = vi.fn(async () => ({
    confirm: true,
    exportToken: "token",
  }));
  const resolveWalletExportRejection = vi.fn(() => null);
  const ctx = {
    req: { headers: {} },
    res,
    method: "POST",
    pathname: "/api/wallet/export",
    config: {},
    saveConfig: vi.fn(),
    ensureWalletKeysInEnvAndConfig: vi.fn(() => true),
    resolveWalletExportRejection,
    deps: {},
    readJsonBody,
    json(target: typeof res, data: unknown, status = 200) {
      target.statusCode = status;
      target.body = data;
    },
    error(target: typeof res, message: string, status = 400) {
      target.statusCode = status;
      target.body = { error: message };
    },
  } as unknown as WalletRouteContext;
  return { ctx, res, readJsonBody, resolveWalletExportRejection };
}

describe("wallet route contracts", () => {
  it("keeps plaintext private-key export removed from the agent API", async () => {
    const { ctx, res, readJsonBody, resolveWalletExportRejection } = buildCtx();

    await expect(handleWalletRoutes(ctx)).resolves.toBe(true);

    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({
      error:
        "Private key export has been removed. Use Steward or OS-backed custody flows.",
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /privateKey|secretKey|mnemonic|seed/i,
    );
    expect(readJsonBody).not.toHaveBeenCalled();
    expect(resolveWalletExportRejection).not.toHaveBeenCalled();
  });
});
