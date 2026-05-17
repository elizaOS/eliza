import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  buildCodingPromotionResponse,
  PromoteVfsToCloudContainerRequestSchema,
  type PromoteVfsToCloudContainerResponse,
} from "@/lib/services/coding-containers";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = PromoteVfsToCloudContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid promotion request",
        },
        400,
      );
    }

    const response: PromoteVfsToCloudContainerResponse = {
      success: true,
      data: buildCodingPromotionResponse(parsed.data),
      message:
        "VFS promotion accepted. Include promotionId or source when requesting a coding container.",
    };
    return c.json(response, 202);
  } catch (error) {
    logger.error("[CodingContainers API] promotion error:", error);
    return failureResponse(c, error);
  }
});

export default app;
