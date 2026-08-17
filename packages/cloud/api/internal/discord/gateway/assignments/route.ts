// Handles internal cloud API internal discord gateway assignments route traffic with service-to-service auth.
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

const MAX_ASSIGNMENTS_CAP = 500;
const DEFAULT_ASSIGNMENTS_MAX = 50;

class DiscordAssignmentsMaxError extends Error {
  constructor(message = "Invalid max") {
    super(message);
    this.name = "DiscordAssignmentsMaxError";
  }
}

/**
 * GET /api/internal/discord/gateway/assignments `max` is pod-capacity
 * identity, leftover tax after cloud list `limit` leftover-tax. Stock
 * develop used z.coerce.number(), which treated `1e2` / `007` / `0x10`
 * as a capacity instead of a 400. current / pod stay untouched.
 * Missing / empty still means 50. Exact integers above 500 stay 400.
 */
function parseDiscordAssignmentsMaxQuery(
  searchParams: URLSearchParams,
): number {
  const requested = searchParams.getAll("max");
  if (requested.length > 1) {
    throw new DiscordAssignmentsMaxError();
  }
  const raw = requested[0];
  if (raw == null || raw === "") {
    return DEFAULT_ASSIGNMENTS_MAX;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new DiscordAssignmentsMaxError();
  }
  const parsed = Number(raw);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_ASSIGNMENTS_CAP
  ) {
    throw new DiscordAssignmentsMaxError();
  }
  return parsed;
}

const querySchema = z.object({
  pod: podNameSchema,
  current: z.coerce.number().int().min(0).default(0),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    let max: number;
    try {
      max = parseDiscordAssignmentsMaxQuery(
        new URL(c.req.url, "http://localhost").searchParams,
      );
    } catch (maxError) {
      if (maxError instanceof DiscordAssignmentsMaxError) {
        return c.json({ success: false, error: maxError.message }, 400);
      }
      throw maxError;
    }

    const query = querySchema.parse({
      pod: c.req.query("pod"),
      current: c.req.query("current") ?? undefined,
    });
    const assignments = await discordConnectionsRepository.getAssignmentsForPod(
      query.pod,
      query.current < max,
    );
    return c.json({ assignments });
  } catch (err) {
    logger.error("[internal/discord/gateway/assignments]", { error: err });
    return failureResponse(c, err);
  }
});

export default app;
