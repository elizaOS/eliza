/**
 * POST /api/eliza-app/identity-link/confirm — channel-side confirmation of a
 * link code (#17344). Gateway-internal auth only: the gateway attests "this
 * message came from <platform> handle X", the code proves the sender also owns
 * the minting eliza.app session, and the two together authorize the bind.
 * Every non-linked outcome is a distinct typed status so the gateway can reply
 * with the right user-facing message and never fabricate success.
 */
import { Hono } from "hono";
import { z } from "zod";
import { providerForPlatform } from "@/db/repositories/users";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { confirmIdentityLink } from "@/lib/services/eliza-app/identity-link";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../internal/_auth";

const confirmSchema = z.object({
  code: z.string().trim().min(4).max(32),
  // Transport platform as the gateway names it (telegram/twilio/...).
  platform: z.enum(["telegram", "discord", "phone"]),
  platformId: z.string().trim().min(1).max(256),
  platformName: z.string().trim().max(255).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const parsed = confirmSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return jsonError(c, 400, "Invalid confirm payload", "validation_error");
    }

    const provider = providerForPlatform(parsed.data.platform);
    if (!provider || provider === "steward") {
      return jsonError(c, 400, "Unsupported link platform", "validation_error");
    }

    const result = await confirmIdentityLink({
      code: parsed.data.code,
      platform: provider,
      platformId: parsed.data.platformId,
      platformName: parsed.data.platformName,
    });

    if (result.status === "linked") {
      return c.json({
        success: true,
        data: {
          status: result.status,
          userId: result.userId,
          organizationId: result.organizationId,
          platform: result.platform,
        },
      });
    }
    return c.json({ success: false, data: { status: result.status } }, 409);
  } catch (error) {
    logger.error("[IdentityLink Confirm] Error", { error });
    return failureResponse(c, error);
  }
});

export default app;
