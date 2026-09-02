/** Executes validated commands in an authenticated hosted-browser session. */

import { Hono } from "hono";
import { z } from "zod";
import {
  asGenerativeCacheApiError,
  getGenerativeOperationContext,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import {
  nextStyleParams,
  type RouteContext,
} from "@/lib/api/hono-next-style-params";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  executeHostedBrowserCommand,
  logHostedBrowserFailure,
} from "@/lib/services/browser-tools";
import { deferredCredentialAdmissionGuard } from "@/lib/services/deferred-credential-admission-guard";
import { decodeRequestJson } from "@/lib/utils/json-parsing";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const commandSchema = z.object({
  id: z.string().trim().optional(),
  key: z.string().trim().optional(),
  pixels: z.number().int().min(-5000).max(5000).optional(),
  script: z.string().optional(),
  selector: z.string().trim().optional(),
  subaction: z.enum([
    "back",
    "click",
    "eval",
    "forward",
    "get",
    "navigate",
    "press",
    "reload",
    "scroll",
    "state",
    "type",
    "wait",
  ]),
  text: z.string().optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
  url: z.string().trim().url().optional(),
});

async function handlePOST(
  c: AppContext,
  context: RouteContext<{ id: string }>,
) {
  try {
    const { id } = await context.params;
    const decodedRawBody = await decodeRequestJson(c.req);
    let pendingResponse: Response | undefined;
    let body: z.infer<typeof commandSchema> | undefined;
    if (!decodedRawBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      pendingResponse = Response.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    } else {
      const bodyResult = commandSchema.safeParse(decodedRawBody.value);
      if (bodyResult.success) {
        body = bodyResult.data;
      } else {
        pendingResponse = Response.json(
          {
            error: "Invalid browser command",
            details: bodyResult.error.flatten(),
          },
          { status: 400 },
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

    const result = await executeHostedBrowserCommand(id, body!, {
      apiKeyId: caller.apiKeyId,
      organizationId: caller.user.organization_id,
      requestSource: "api",
      userId: caller.user.id,
      operationContext: getGenerativeOperationContext(c, caller, {
        credentialForAdmission: () => credentialGuard.credentialForAdmission(),
      }),
    });

    return Response.json(result);
  } catch (error) {
    logHostedBrowserFailure("browser_command", error);
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handlePOST(c, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, asGenerativeCacheApiError(error) ?? error);
  }
});
export default honoRouter;
