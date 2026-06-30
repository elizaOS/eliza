/**
 * POST /api/v1/user/wallets/provision — provision a server-side wallet for the user's org.
 * Idempotent on the authenticated organization's client_address + chain_type.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { isAddress } from "viem";
import { z } from "zod";
import { dbWrite } from "@/db/helpers";
import { agentServerWallets } from "@/db/schemas/agent-server-wallets";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { provisionServerWallet } from "@/lib/services/server-wallets";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

// `clientAddress` is always the agent's local EVM key — the same address is
// registered for both evm and solana wallets and is what signs RPC + the
// provision control-proof, so it is EVM-validated regardless of chainType.
const provisionWalletSchema = z.object({
  chainType: z.enum(["evm", "solana"]),
  clientAddress: z.string().refine((value) => isAddress(value), {
    message: "Invalid EVM address",
  }),
  characterId: z.string().uuid().optional().nullable(),
  // Proof the caller controls the clientAddress key (signed challenge); see
  // buildWalletProvisionChallenge. Required — without it any org could squat an
  // arbitrary address (#10279).
  controlProof: z.object({
    signature: z
      .string()
      .regex(/^0x[0-9a-fA-F]+$/, "signature must be 0x-prefixed hex"),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(1),
  }),
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
    const clientAddress = validated.clientAddress.toLowerCase();

    if (!user.organization?.id) {
      return c.json(
        { success: false, error: "User does not belong to an organization" },
        403,
      );
    }

    const walletRecord = await provisionServerWallet({
      organizationId: user.organization.id,
      userId: user.id,
      characterId: validated.characterId || null,
      clientAddress,
      chainType: validated.chainType,
      controlProof: {
        signature: validated.controlProof.signature as `0x${string}`,
        timestamp: validated.controlProof.timestamp,
        nonce: validated.controlProof.nonce,
      },
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
      return c.json(
        { success: false, error: "Validation error", details: error.issues },
        400,
      );
    }

    if (error instanceof Error && error.name === "ProvisionProofExpiredError") {
      return c.json({ success: false, error: error.message }, 400);
    }

    if (error instanceof Error && error.name === "ProvisionProofInvalidError") {
      return c.json({ success: false, error: error.message }, 401);
    }

    if (error instanceof Error && error.name === "ProvisionProofReplayError") {
      return c.json({ success: false, error: error.message }, 409);
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
            eq(
              agentServerWallets.client_address,
              validated.clientAddress.toLowerCase(),
            ),
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
