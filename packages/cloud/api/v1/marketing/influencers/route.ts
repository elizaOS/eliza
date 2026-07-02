/**
 * Influencer marketplace — profiles (#10687).
 *
 * GET  /api/v1/marketing/influencers?niche=<niche>  — browse active profiles
 * POST /api/v1/marketing/influencers                — publish a profile
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { influencerMarketplaceService } from "@/lib/services/influencer-marketplace";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const PlatformSchema = z.object({
  platform: z.string().min(1).max(40),
  handle: z.string().min(1).max(120),
  followers: z.number().int().nonnegative(),
});
const CreateProfileSchema = z.object({
  displayName: z.string().min(1).max(120),
  niche: z.string().max(80).optional(),
  bio: z.string().max(2000).optional(),
  platforms: z.array(PlatformSchema).max(20).optional(),
  rateCard: z.record(z.string(), z.unknown()).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const niche = c.req.query("niche")?.trim() || undefined;
    const profiles = await influencerMarketplaceService.listProfiles({ niche });
    return c.json({ success: true, profiles });
  } catch (error) {
    logger.error("[Influencer API] browse failed:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = CreateProfileSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request",
          details: parsed.error.flatten(),
        },
        400,
      );
    }
    const profile = await influencerMarketplaceService.createProfile({
      userId: user.id,
      organizationId: user.organization_id,
      displayName: parsed.data.displayName,
      niche: parsed.data.niche,
      bio: parsed.data.bio,
      platforms: parsed.data.platforms,
      rateCard: parsed.data.rateCard,
    });
    return c.json({ success: true, profile }, 201);
  } catch (error) {
    logger.error("[Influencer API] create profile failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
