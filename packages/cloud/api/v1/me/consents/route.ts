/**
 * GET/POST /api/v1/me/consents
 *
 * Server-recorded consent ledger for the signed-in user. GET returns the
 * latest decision per purpose, the policy the server enforces for every
 * purpose (`effective`, which distinguishes a recorded choice from the
 * deployment default), and a read-only `capture` block describing the
 * deployment's model-call recording policy (not a user choice); POST appends
 * a new decision and writes the
 * matching `consent.granted` / `consent.revoked` audit record in the same
 * database transaction (a failed audit write records nothing).
 */

import { requireUserWithOrg } from "@elizaos/cloud-shared/auth";
import { dbWrite } from "@elizaos/cloud-shared/db/client";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { checkElizaMutatingRequestOrigin } from "@elizaos/cloud-shared/lib/auth/browser-origin-policy";
import { describeModelCallRecording } from "@elizaos/cloud-shared/lib/config/llm-trajectory-policy";
import {
  getRequestIp,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  listLatestUserConsents,
  recordUserConsent,
  resolveEffectiveConsents,
  USER_CONSENT_PURPOSES,
  type UserConsentDto,
} from "@elizaos/cloud-shared/lib/services/user-consents";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";
import { createTransactionalAudit } from "@/api-app/services/audit-transactional";

const consentSchema = z.object({
  purpose: z.enum(USER_CONSENT_PURPOSES),
  granted: z.boolean(),
  policyVersion: z.string().trim().min(1).max(64),
});

const app = new Hono<AppEnv>();
app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  c.header("Cache-Control", "no-store, private");
  try {
    const user = await requireUserWithOrg(c);
    const consents = await listLatestUserConsents(
      user.id,
      user.organization_id,
    );
    return c.json({
      consents,
      effective: resolveEffectiveConsents(consents),
      capture: { modelCallRecording: describeModelCallRecording() },
    });
  } catch (error) {
    // error-policy:J1 The HTTP boundary translates service failures into a structured response.
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  c.header("Cache-Control", "no-store, private");
  const origin = checkElizaMutatingRequestOrigin(
    c.req,
    c.env.NODE_ENV === "production",
  );
  if (!origin.ok) {
    return c.json(
      { error: "Forbidden", code: "forbidden_origin" as const },
      403,
    );
  }
  try {
    const user = await requireUserWithOrg(c);
    const decoded = await decodeRequestJson(c.req);
    if (!decoded.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const input = consentSchema.parse(decoded.value);
    const audit = createTransactionalAudit();
    const consent = await dbWrite.transaction(
      async (tx): Promise<UserConsentDto> => {
        const recorded = await recordUserConsent(
          {
            userId: user.id,
            organizationId: user.organization_id,
            purpose: input.purpose,
            granted: input.granted,
            policyVersion: input.policyVersion,
            source: "api",
          },
          tx,
        );
        await audit.write(tx, {
          actor: { type: "user", id: user.id },
          action: input.granted ? "consent.granted" : "consent.revoked",
          result: "success",
          resource: { type: "consent", id: input.purpose },
          org_id: user.organization_id,
          ip: getRequestIp(c),
          user_agent: c.req.header("user-agent") ?? undefined,
          request_id: c.get("requestId"),
          metadata: {
            purpose: input.purpose,
            policy_version: input.policyVersion,
            source: recorded.source,
            granted: input.granted,
          },
        });
        return recorded;
      },
    );
    await audit.publish();
    return c.json({ consent }, 201);
  } catch (error) {
    // error-policy:J1 The HTTP boundary translates service failures into a structured response.
    return failureResponse(c, error);
  }
});

export default app;
