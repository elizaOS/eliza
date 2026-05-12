/**
 * POST /api/v1/eliza/google/disconnect
 *
 * Removes a managed Google connection (or all connections on the given side
 * when `connectionId` is null).
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  disconnectManagedGoogleConnection,
} from "@/lib/services/agent-google-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  side: z.enum(["owner", "agent"]).optional(),
  connectionId: z.string().uuid().nullable().optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: "Invalid disconnect request.", details: parsed.error.issues }, 400);
    }

    await disconnectManagedGoogleConnection({
      organizationId: user.organization_id,
      userId: user.id,
      side: parsed.data.side ?? "owner",
      connectionId: parsed.data.connectionId ?? null,
    });
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
