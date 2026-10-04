/**
 * Browser Solana message signing must separate client errors from signer
 * outages.
 *
 * POST /api/wallet/browser-solana-sign-message replied 503 (signer
 * unavailable, retry later) when the dApp sent neither `message` nor
 * `messageBase64` — the same wrong-status class already fixed for the
 * transaction route's cluster/transactionBase64 validation. Missing or
 * blank payloads are a client error answered with the exact 400 contract;
 * a missing signer key keeps the 503 unavailable status. Exercises the
 * real route handler; signing runs through node:crypto with a stubbed
 * local key so no network is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleWalletRoutes,
  type WalletRouteContext,
} from "./wallet-routes.ts";

const SOLANA_KEY = `[${Array(32).fill(1).join(",")}]`;
const MESSAGE_BASE64 = Buffer.from("hello").toString("base64");

function buildCtx(pathname: string, body: unknown) {
  const res: { statusCode?: number; body?: unknown } = {};
  const ctx = {
    req: { headers: {} },
    res,
    method: "POST",
    pathname,
    config: {},
    saveConfig: vi.fn(),
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
      deriveSolanaAddress: () => "TestSolanaAddress",
    },
  } as unknown as WalletRouteContext;
  return { ctx, res };
}

async function postSignMessage(
  body: Record<string, unknown>,
  envKey: string | null = SOLANA_KEY,
) {
  const { ctx, res } = buildCtx(
    "/api/wallet/browser-solana-sign-message",
    body,
  );
  if (envKey === null) {
    delete process.env.SOLANA_PRIVATE_KEY;
  } else {
    process.env.SOLANA_PRIVATE_KEY = envKey;
  }
  try {
    await expect(handleWalletRoutes(ctx)).resolves.toBe(true);
  } finally {
    delete process.env.SOLANA_PRIVATE_KEY;
  }
  return res;
}

beforeEach(() => {
  vi.stubEnv("SOLANA_PRIVATE_KEY", SOLANA_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/wallet/browser-solana-sign-message status contract", () => {
  it("signs a message payload", async () => {
    const res = await postSignMessage({ message: "hello" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ mode: "local-key" });
    expect(
      typeof (res.body as { signatureBase64: string }).signatureBase64,
    ).toBe("string");
  });

  it("signs a messageBase64 payload", async () => {
    const res = await postSignMessage({ messageBase64: MESSAGE_BASE64 });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ mode: "local-key" });
  });

  it("rejects a missing or blank payload as a client error, not 503", async () => {
    for (const body of [{}, { message: "   " }, { messageBase64: "" }]) {
      const res = await postSignMessage(body);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        error: "message or messageBase64 is required.",
      });
    }
  });

  it("keeps a missing signer key on the 503 unavailable contract", async () => {
    const res = await postSignMessage({ message: "hello" }, null);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      error: "No browser Solana signer is available.",
    });
  });
});
