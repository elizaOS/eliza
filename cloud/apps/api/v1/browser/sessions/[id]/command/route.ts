import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { getErrorStatusCode, getSafeErrorMessage } from "@/lib/api/errors";
import { nextStyleParams } from "@/lib/api/hono-next-style-params";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { executeHostedBrowserCommand, logHostedBrowserFailure } from "@/lib/services/browser-tools";
import type { AppEnv } from "@/types/cloud-worker-env";

type RouteContext = {
  params: Promise<{ id: string }>;
};

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

async function handlePOST(request: Request, context: RouteContext) {
  try {
    const authResult = await requireAuthOrApiKeyWithOrg(request);
    const { id } = await context.params;
    const bodyResult = commandSchema.safeParse(await request.json());
    if (!bodyResult.success) {
      return Response.json(
        {
          error: "Invalid browser command",
          details: bodyResult.error.flatten(),
        },
        { status: 400 },
      );
    }

    const result = await executeHostedBrowserCommand(id, bodyResult.data, {
      apiKeyId: authResult.apiKey?.id ?? null,
      organizationId: authResult.user.organization_id,
      requestSource: "api",
      userId: authResult.user.id,
    });

    return Response.json(result);
  } catch (error) {
    logHostedBrowserFailure("browser_command", error);
    return Response.json(
      { error: getSafeErrorMessage(error) },
      { status: getErrorStatusCode(error) },
    );
  }
}

const ROUTE_PARAM_SPEC = [{ name: "id", splat: false }] as const;
const honoRouter = new Hono<AppEnv>();
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handlePOST(c.req.raw, nextStyleParams(c, ROUTE_PARAM_SPEC));
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
