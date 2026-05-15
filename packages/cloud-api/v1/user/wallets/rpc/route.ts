/**
 * POST /api/v1/user/wallets/rpc — execute a server-wallet RPC call.
 * Wallet-signature auth via X-Wallet-Address / X-Timestamp / X-Wallet-Signature.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { verifyWalletSignature } from "@/lib/auth/wallet-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { executeServerWalletRpc } from "@/lib/services/server-wallets";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const rpcPayloadSchema = z.object({
  clientAddress: z.string().min(10),
  payload: z.object({
    method: z.string(),
    params: z.array(z.any()),
  }),
  signature: z.string().startsWith("0x"),
  timestamp: z.number().int().positive(),
  nonce: z.string().min(1),
});

/** Bridge Hono context to a Fetch `Request` for `verifyWalletSignature`. */
function honoToWalletAuthRequest(c: import("hono").Context, url: URL): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(c.req.header())) {
    if (typeof v === "string") headers.set(k, v);
  }
  return new Request(url.href, { method: c.req.method, headers });
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const validated = rpcPayloadSchema.parse(body);

    const url = new URL(c.req.url);
    const authenticatedUser = await verifyWalletSignature(honoToWalletAuthRequest(c, url));
    if (!authenticatedUser) {
      return c.json({ success: false, error: "Wallet authentication required" }, 401);
    }

    const authenticatedWallet = authenticatedUser.wallet_address?.toLowerCase();
    if (!authenticatedWallet || authenticatedWallet !== validated.clientAddress.toLowerCase()) {
      return c.json(
        {
          success: false,
          error: "Unauthorized: clientAddress does not belong to the authenticated wallet",
        },
        403,
      );
    }

    const result = await executeServerWalletRpc({
      clientAddress: validated.clientAddress,
      payload: {
        ...validated.payload,
        timestamp: validated.timestamp,
        nonce: validated.nonce,
      },
      signature: validated.signature as `0x${string}`,
    });

    return c.json({ success: true, data: result });
  } catch (error) {
    logger.error("Error executing server wallet RPC:", error);

    if (error instanceof z.ZodError) {
      return c.json({ success: false, error: "Validation error", details: error.issues }, 400);
    }

    if (
      error instanceof Error &&
      (error.message.includes("Invalid wallet signature") ||
        error.message.includes("Wallet authentication failed") ||
        error.message.includes("Signature has already been used") ||
        error.message.includes("Signature timestamp expired") ||
        error.message.includes("Service temporarily unavailable"))
    ) {
      return c.json({ success: false, error: error.message }, 401);
    }

    if (error instanceof Error && error.name === "RpcRequestExpiredError") {
      return c.json({ success: false, error: error.message }, 400);
    }

    if (error instanceof Error && error.name === "RpcReplayError") {
      return c.json({ success: false, error: error.message }, 409);
    }

    if (error instanceof Error && error.name === "InvalidRpcSignatureError") {
      return c.json({ success: false, error: error.message }, 401);
    }

    if (error instanceof Error && error.name === "ServerWalletNotFoundError") {
      return c.json({ success: false, error: error.message }, 404);
    }

    return failureResponse(c, error);
  }
});

export default app;
