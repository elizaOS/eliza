/**
 * GET /api/v1/eliza/google/gmail/read
 *
 * Reads a single Gmail message by id via the managed Google connector.
 */

import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  AgentGoogleConnectorError,
  readManagedGoogleGmailAttachment,
  readManagedGoogleGmailMessage,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const rawSide = c.req.query("side") ?? null;
    if (rawSide !== "agent") await requirePrivateOwnerAccess(c, user);
    const grantId = c.req.query("grantId")?.trim();
    const messageId = c.req.query("messageId") ?? null;

    if (rawSide !== null && rawSide !== "owner" && rawSide !== "agent") {
      return c.json({ error: "side must be owner or agent." }, 400);
    }
    if (!messageId || messageId.trim().length === 0) {
      return c.json({ error: "messageId is required." }, 400);
    }

    const partId = c.req.query("partId");
    if (partId !== undefined) {
      const rawMax = c.req.query("maxBytes");
      if (!grantId || (rawMax !== undefined && !/^[1-9][0-9]*$/.test(rawMax)))
        return c.json(
          { error: "A grant and valid byte limit are required." },
          400,
        );
      const result = await readManagedGoogleGmailAttachment({
        organizationId: user.organization_id,
        userId: user.id,
        side: rawSide === "agent" ? "agent" : "owner",
        grantId,
        messageId: messageId.trim(),
        partId,
        maxBytes: rawMax === undefined ? undefined : Number(rawMax),
      });
      return c.json(result);
    }
    const message = await readManagedGoogleGmailMessage({
      organizationId: user.organization_id,
      userId: user.id,
      side: rawSide === "agent" ? "agent" : "owner",
      grantId: grantId && grantId.length > 0 ? grantId : undefined,
      messageId: messageId.trim(),
    });
    return c.json(message);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
