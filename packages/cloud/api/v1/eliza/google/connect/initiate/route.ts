/**
 * POST /api/v1/eliza/google/connect/initiate
 *
 * Returns the OAuth URL the client should redirect to in order to start a
 * managed Google connection (with optional capability scopes).
 */

import {
  requirePrivateOwnerAccess,
  requireUserOrApiKeyWithOrg,
} from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { getCloudAwareEnv } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import {
  AgentGoogleConnectorError,
  initiateManagedGoogleConnection,
} from "@elizaos/cloud-shared/lib/services/agent-google-connector";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { resolveAppOAuthReturn } from "../../../../oauth/app-oauth-return";

const app = new Hono<AppEnv>();

const requestSchema = z.object({
  side: z.enum(["owner", "agent"]).optional(),
  purpose: z.literal("personal_google_context_v1").optional(),
  redirectUrl: z.string().trim().min(1).optional(),
  capabilities: z
    .array(
      z.enum([
        "google.basic_identity",
        "google.calendar.read",
        "google.calendar.write",
        "google.gmail.triage",
        "google.gmail.send",
        "google.gmail.manage",
        "google.gmail.drafts",
        "google.gmail.mailbox",
      ]),
    )
    .optional(),
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    // An empty or absent body means "initiate with defaults". A NON-empty
    // body that is not valid JSON is a client error and must never fall back
    // to those defaults — that turned a truncated request into an initiated
    // connection flow.
    const rawBody = await c.req.text();
    let bodyValue: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        bodyValue = JSON.parse(rawBody);
      } catch {
        // error-policy:J3 malformed JSON is invalid request input.
        return c.json(
          {
            error: "Invalid Google connector request: body is not valid JSON.",
          },
          400,
        );
      }
    }
    const parsed = requestSchema.safeParse(bodyValue);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid Google connector request.",
          details: parsed.error.issues,
        },
        400,
      );
    }
    if (parsed.data.side !== "agent" || parsed.data.purpose)
      await requirePrivateOwnerAccess(c, user);
    const result = await initiateManagedGoogleConnection({
      organizationId: user.organization_id,
      userId: user.id,
      side: parsed.data.side ?? "owner",
      redirectUrl: parsed.data.redirectUrl,
      capabilities: parsed.data.capabilities,
      ...(parsed.data.purpose
        ? { personalContextPurpose: parsed.data.purpose }
        : {}),
    });
    const alphaReturn = resolveAppOAuthReturn(
      {
        providerId: "google",
        organizationId: user.organization_id,
        userId: user.id,
        createdAt: Date.now(),
        redirectUrl: parsed.data.redirectUrl,
      },
      "google",
      getCloudAwareEnv().ALPHA_OAUTH_RETURN_URLS,
    );
    return c.json(alphaReturn ? { ...result, alphaReturn: 2 } : result);
  } catch (error) {
    if (error instanceof AgentGoogleConnectorError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
