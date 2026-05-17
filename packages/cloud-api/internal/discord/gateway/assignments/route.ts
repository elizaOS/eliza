import { Hono } from "hono";
import { z } from "zod";
import { discordConnectionsRepository } from "@/db/repositories/discord-connections";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../../_auth";

const podNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9-]+$/);

const querySchema = z.object({
  pod: podNameSchema,
  current: z.coerce.number().int().min(0).default(0),
  max: z.coerce.number().int().min(1).max(500).default(50),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    const query = querySchema.parse({
      pod: c.req.query("pod"),
      current: c.req.query("current") ?? undefined,
      max: c.req.query("max") ?? undefined,
    });
    const assignments = await discordConnectionsRepository.getAssignmentsForPod(
      query.pod,
      query.current < query.max,
    );
    return c.json({ assignments });
  } catch (err) {
    logger.error("[internal/discord/gateway/assignments]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
