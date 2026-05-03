/**
 * POST /api/v1/user/wallets/provision — provision a server-side wallet for the user's org.
 * Idempotent on (organization_id, client_address, chain_type).
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { isAddress } from "viem";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { provisionServerWallet } from "@/lib/services/server-wallets";
import { logger } from "@/lib/utils/logger";
import { dbWrite } from "@/packages/db/helpers";
import { agentServerWallets } from "@/packages/db/schemas/agent-server-wallets";
import type { AppEnv } from "@/types/cloud-worker-env";

const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const provisionWalletSchema = z
  .object({
    chainType: z.enum(["evm", "solana"]),
    clientAddress: z.string().min(10),
    characterId: z.string().uuid().optional().nullable(),
  })
  .superRefine((data, ctx) => {
    if (data.chainType === "evm" && !isAddress(data.clientAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid EVM address",
        path: ["clientAddress"],
      });
    }
    if (data.chainType === "solana" && !SOLANA_BASE58.test(data.clientAddress)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid Solana address (base58, 32–44 chars)",
        path: ["clientAddress"],
      });
    }
  });

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  let user: Awaited<ReturnType<typeof requireUserOrApiKey>> | undefined;
  let validated: z.infer<typeof provisionWalletSchema> | undefined;

  try {
    user = await requireUserOrApiKey(c);
    const body = await c.req.json();
    validated = provisionWalletSchema.parse(body);

    if (!user.organization?.id) {
      return c.json({ success: false, error: "User does not belong to an organization" }, 403);
    }

    const walletRecord = await provisionServerWallet({
      organizationId: user.organization.id,
      userId: user.id,
      characterId: validated.characterId || null,
      clientAddress: validated.clientAddress,
      chainType: validated.chainType,
    });

    return c.json({
      success: true,
      data: {
        id: walletRecord.id,
        address: walletRecord.address,
        chainType: walletRecord.chain_type,
        clientAddress: walletRecord.client_address,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, error: "Validation error", details: error.issues }, 400);
    }

    if (
      error instanceof Error &&
      error.name === "WalletAlreadyExistsError" &&
      user?.organization?.id &&
      validated
    ) {
      const [existing] = await dbWrite
        .select({
          id: agentServerWallets.id,
          address: agentServerWallets.address,
          chain_type: agentServerWallets.chain_type,
          client_address: agentServerWallets.client_address,
        })
        .from(agentServerWallets)
        .where(
          and(
            eq(agentServerWallets.organization_id, user.organization.id),
            eq(agentServerWallets.client_address, validated.clientAddress),
            eq(agentServerWallets.chain_type, validated.chainType),
          ),
        )
        .limit(1);

      if (existing) {
        return c.json({
          success: true,
          data: {
            id: existing.id,
            address: existing.address,
            chainType: existing.chain_type,
            clientAddress: existing.client_address,
          },
        });
      }
    }

    logger.error("Error provisioning server wallet:", error);
    return failureResponse(c, error);
  }
});

export default app;
