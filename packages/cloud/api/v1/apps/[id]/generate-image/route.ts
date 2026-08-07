/** Delegates app-scoped image generation to the canonical cache-only pipeline. */

import { Hono } from "hono";
import { handleGenerateImagePOST } from "@/api/v1/generate-image/route";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  const appId = c.req.param("id");
  if (!appId) return jsonError(c, 400, "Missing app id", "validation_error");

  try {
    return await handleGenerateImagePOST(c, { requiredAppId: appId });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.all("*", (c) =>
  c.json({ success: false, error: "Method not allowed" }, 405),
);

export default app;
