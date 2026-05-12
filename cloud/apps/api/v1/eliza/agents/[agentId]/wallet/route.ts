import { Hono } from "hono";

import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * GET /api/v1/eliza/agents/[agentId]/wallet
 *
 * Returns wallet information for an agent (address, provider, balance, chain).
 * All Docker-node agents use Steward for wallet management.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { agentServerWallets } from "@/db/schemas/agent-server-wallets";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { getStewardWalletInfo } from "@/lib/services/steward-client";
import { logger } from "@/lib/utils/logger";

const CORS_METHODS = "GET, OPTIONS";

async function __hono_GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const agent = await elizaSandboxService.getAgent(agentId, user.organization_id);
    if (!agent) {
      return applyCorsHeaders(
        Response.json({ success: false, error: "Agent not found" }, { status: 404 }),
        CORS_METHODS,
      );
    }

    const isDockerAgent = !!agent.node_id;
    if (isDockerAgent) {
      const stewardInfo = await getStewardWalletInfo(agentId, {
        organizationId: user.organization_id,
      });

      if (stewardInfo) {
        return applyCorsHeaders(
          Response.json({
            success: true,
            data: {
              agentId,
              walletAddress: stewardInfo.walletAddress,
              walletProvider: "steward",
              walletStatus: stewardInfo.walletStatus,
              balance: stewardInfo.balance,
              chain: stewardInfo.chain ?? "base",
            },
          }),
          CORS_METHODS,
        );
      }

      logger.warn(`[wallet-api] Steward unreachable for agent ${agentId}, falling back to DB`);
    }

    // DB fallback (legacy wallet rows linked by character_id, kept until
    if (agent.character_id) {
      const walletRecord = await db.query.agentServerWallets.findFirst({
        where: eq(agentServerWallets.character_id, agent.character_id),
      });
      if (walletRecord) {
        return applyCorsHeaders(
          Response.json({
            success: true,
            data: {
              agentId,
              walletAddress: walletRecord.address,
              walletProvider: "steward",
              walletStatus: "active",
              balance: null,
              chain: walletRecord.chain_type === "evm" ? "base" : walletRecord.chain_type,
            },
          }),
          CORS_METHODS,
        );
      }
    }

    return applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          agentId,
          walletAddress: null,
          walletProvider: null,
          walletStatus: "none",
          balance: null,
          chain: null,
        },
      }),
      CORS_METHODS,
    );
  } catch (error) {
    logger.error("[wallet-api] GET /agents/[agentId]/wallet error", { error });
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, { params: Promise.resolve({ agentId: c.req.param("agentId")! }) }),
);
export default __hono_app;
