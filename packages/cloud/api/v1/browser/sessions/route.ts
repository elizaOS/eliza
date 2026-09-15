/**
 * GET/POST /api/v1/browser/sessions
 * List/create hosted browser sessions for the authenticated org.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  asGenerativeCacheApiError,
  getGenerativeOperationContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  createHostedBrowserSession,
  listHostedBrowserSessions,
  logHostedBrowserFailure,
} from "@/lib/services/browser-tools";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";

const createSessionSchema = z.object({
  activityTtl: z.number().int().min(10).max(3600).optional(),
  show: z.boolean().optional(),
  title: z.string().trim().min(1).max(255).optional(),
  ttl: z.number().int().min(30).max(3600).optional(),
  url: z.string().trim().url().max(2_000).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const caller = await requireGenerativeRouteCaller(c);
    const { user } = caller;
    const sessions = await listHostedBrowserSessions({
      apiKeyId: null,
      organizationId: user.organization_id,
      requestSource: "api",
      userId: user.id,
      operationContext: getGenerativeOperationContext(c, caller),
    });
    return c.json({ sessions });
  } catch (error) {
    logHostedBrowserFailure("browser_list", error);
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});

app.post("/", async (c) => {
  try {
    const decodedBody = await decodeRequestJson(c.req);
    let pendingResponse: Response | undefined;
    let body: z.infer<typeof createSessionSchema> | undefined;
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      pendingResponse = c.json({ error: "Invalid JSON body" }, 400);
    } else {
      const bodyResult = createSessionSchema.safeParse(decodedBody.value);
      if (bodyResult.success) {
        body = bodyResult.data;
      } else {
        pendingResponse = c.json(
          {
            error: "Invalid browser session request",
            details: bodyResult.error.flatten(),
          },
          400,
        );
      }
    }

    const caller = await requireGenerativeRouteCaller(c, {
      deferStrongCredentialCheck: pendingResponse === undefined,
    });
    await using credentialGuard = deferredCredentialAdmissionGuard({
      organizationId: () => caller.user.organization_id,
      credential: () => caller.credential,
    });
    if (pendingResponse) return pendingResponse;
    const { user } = caller;

    const session = await createHostedBrowserSession(body!, {
      apiKeyId: caller.apiKeyId,
      organizationId: user.organization_id,
      requestSource: "api",
      userId: user.id,
      operationContext: getGenerativeOperationContext(c, caller, {
        credentialForAdmission: () => credentialGuard.credentialForAdmission(),
      }),
    });
    return c.json({ session });
  } catch (error) {
    logHostedBrowserFailure("browser_create", error);
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});

export default app;
