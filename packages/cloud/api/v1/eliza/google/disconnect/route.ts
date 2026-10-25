/**
 * POST /api/v1/eliza/google/disconnect
 *
 * Removes the managed Google connection for the caller's side (preferring
 * the active connection when `connectionId` is omitted or null).
 */

import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentGoogleConnectorError,
  disconnectManagedGoogleConnection,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const app = new Hono<AppEnv>();

const requestSchema = z
  .object({
    side: z.enum(["owner", "agent"]).optional(),
    connectionId: z.string().uuid().nullable().optional(),
  })
  .strict();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawBody = await c.req.text();
    let bodyValue: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        bodyValue = JSON.parse(rawBody);
      } catch {
        // error-policy:J3 malformed client JSON is an explicit invalid request.
        return c.json(
          { error: "Invalid disconnect request: body is not valid JSON." },
          400,
        );
      }
    }
    const parsed = requestSchema.safeParse(bodyValue);
    if (!parsed.success) {
      return c.json(
        { error: "Invalid disconnect request.", details: parsed.error.issues },
        400,
      );
    }

    if (parsed.data.side !== "agent") await requirePrivateOwnerAccess(c, user);
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
