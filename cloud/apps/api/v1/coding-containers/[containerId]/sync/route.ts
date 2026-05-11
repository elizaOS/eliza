import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  buildCodingSyncResponse,
  SyncCloudCodingContainerRequestSchema,
  type SyncCloudCodingContainerResponse,
} from "@/lib/services/coding-containers";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    await requireUserOrApiKeyWithOrg(c);
    const containerId = c.req.param("containerId");
    if (!containerId) {
      return c.json({ success: false, error: "Container id required" }, 400);
    }

    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = SyncCloudCodingContainerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: parsed.error.issues[0]?.message ?? "Invalid sync request",
        },
        400,
      );
    }

    const response: SyncCloudCodingContainerResponse = {
      success: true,
      data: buildCodingSyncResponse(decodeURIComponent(containerId), parsed.data),
      message: "Sync request accepted. External VFS persistence is handled by the caller contract.",
    };
    return c.json(response, 202);
  } catch (error) {
    logger.error("[CodingContainers API] sync error:", error);
    return failureResponse(c, error);
  }
});

export default app;
