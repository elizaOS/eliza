/**
 * GET /api/v1/gallery/stats
 *
 * Returns total image count, total video count, and total file size for
 * the authenticated user's completed generations.
 *
 * Mirrors `_legacy_actions/gallery.ts → getUserMediaStats`.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { generationsService } from "@elizaos/cloud-shared/lib/services/generations";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const generations = await generationsService.listByOrganizationAndStatus(
      user.organization_id,
      "completed",
      { userId: user.id },
    );

    const userGenerations = generations.filter((gen) => gen.storage_url);

    const totalImages = userGenerations.filter(
      (gen) => gen.type === "image",
    ).length;
    const totalVideos = userGenerations.filter(
      (gen) => gen.type === "video",
    ).length;
    const totalSize = userGenerations.reduce(
      (acc, gen) => acc + Number(gen.file_size || 0),
      0,
    );

    return c.json({ totalImages, totalVideos, totalSize });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
