/**
 * POST /api/v1/eliza/google/gmail/message-send
 *
 * Sends a new Gmail message via the managed Google connector.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  AgentGoogleConnectorError,
  sendManagedGoogleMessage,
} from "@/lib/services/agent-google-connector";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  side: z.enum(["owner", "agent"]).optional(),
  grantId: z.string().trim().min(1).optional(),
  to: z.array(z.string().email()).min(1),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().trim().min(1),
  bodyText: z.string().min(1),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid Gmail message send request.",
          details: parsed.error.issues,
        },
        400,
      );
    }

    await sendManagedGoogleMessage({
      organizationId: user.organization_id,
      userId: user.id,
      side: parsed.data.side ?? "owner",
      grantId: parsed.data.grantId,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      subject: parsed.data.subject,
      bodyText: parsed.data.bodyText,
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
