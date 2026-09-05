/**
 * POST /api/v1/extract
 * Extract content from a hosted browser page (HTML/links/markdown/screenshot).
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
  extractHostedPage,
  logHostedBrowserFailure,
} from "@/lib/services/browser-tools";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppEnv } from "@/types/cloud-worker-env";

const extractRequestSchema = z.object({
  formats: z
    .array(z.enum(["html", "links", "markdown", "screenshot"]))
    .max(4)
    .optional(),
  onlyMainContent: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  url: z.string().trim().url().max(2_000),
  waitFor: z.number().int().min(0).max(120_000).optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const decodedBody = await decodeRequestJson(c.req);
    let pendingResponse: Response | undefined;
    let body: z.infer<typeof extractRequestSchema> | undefined;
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      pendingResponse = c.json(
        { success: false, error: "Invalid JSON body" },
        400,
      );
    } else {
      const bodyResult = extractRequestSchema.safeParse(decodedBody.value);
      if (bodyResult.success) body = bodyResult.data;
      else {
        pendingResponse = c.json(
          {
            error: "Invalid extract request",
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
    if (!body) throw new Error("Validated extract request was not retained");
    const { user } = caller;

    const result = await extractHostedPage(body, {
      apiKeyId: caller.apiKeyId,
      organizationId: user.organization_id,
      requestSource: "api",
      userId: user.id,
      operationContext: getGenerativeOperationContext(c, caller, {
        credentialForAdmission: () => credentialGuard.credentialForAdmission(),
      }),
    });

    return c.json(result);
  } catch (error) {
    logHostedBrowserFailure("extract_page", error);
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});

export default app;
