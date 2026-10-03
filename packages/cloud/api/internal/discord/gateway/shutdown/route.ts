/** Handles the internal Discord gateway shutdown endpoint with service-to-service auth. */
import { Hono } from "hono";
import { z } from "zod";
import { discordConnectionsRepository } from "@/db/repositories/discord-connections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const shutdownSchema = z.object({
  pod_name: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9-]+$/)
    .optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    // An empty or absent body means "release the caller's pod". A NON-empty
    // body that is not valid JSON is a client error and must never fall back
    // to those defaults — that turned a truncated request into a pod release.
    const rawBody = await c.req.text();
    let bodyValue: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        bodyValue = JSON.parse(rawBody);
      } catch {
        // error-policy:J3 untrusted-input sanitizing: malformed JSON on this
        // mutating route is an explicit invalid result, never a default pod.
        return c.json(
          {
            success: false,
            error: "Invalid shutdown request: body is not valid JSON.",
          },
          400,
        );
      }
    }

    const body = shutdownSchema.parse(bodyValue);
    const podName = body.pod_name ?? auth.podName;
    const released =
      await discordConnectionsRepository.clearPodAssignments(podName);
    return c.json({ success: true, released });
  } catch (err) {
    logger.error("[internal/discord/gateway/shutdown]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
