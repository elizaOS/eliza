/** Routes delegated app-customer chat through Cloud inference with independent developer funding authority. */
import { Hono } from "hono";
import { z } from "zod";
import { requireAppActor } from "@/lib/auth/app-delegation-auth";
import { AppDelegationError } from "@/lib/services/app-delegation";
import { appInferenceErrorResponse } from "@/lib/services/app-subscription-inference-admission";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { handleChatCompletionsPOST } from "../../../../../chat/completions/route";

const scopeHeaders = z.object({
  appId: z.uuid(),
  billingAccountId: z.uuid(),
  productFamilyKey: z.string().min(1).max(100),
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  developerAuthorization: z.string().regex(/^Bearer [^\s]+$/),
});

/** Dependency injection keeps HTTP transport tests independent of the external model provider. */
export function createAppInferenceRoute(
  handleChat: typeof handleChatCompletionsPOST = handleChatCompletionsPOST,
) {
  const app = new Hono<AppEnv>();
  app.post("/", async (c) => {
    try {
      const parsed = scopeHeaders.safeParse({
        appId: c.req.param("id"),
        billingAccountId: c.req.header("X-Eliza-Billing-Account-Id"),
        productFamilyKey: c.req.header("X-Eliza-Product-Family"),
        operationId: c.req.header("Idempotency-Key"),
        developerAuthorization: c.req.header("X-Eliza-Developer-Authorization"),
      });
      if (
        !parsed.success ||
        c.req.header("X-Eliza-Application-Slot") ||
        c.req.header("X-App-Id") ||
        c.req.header("X-Affiliate-Code")
      )
        return c.json(
          {
            error: {
              code: "APP_INFERENCE_REQUEST",
              message:
                "Provide app account, product family, stable operation ID, and independent developer authorization",
            },
          },
          400,
        );
      const input = parsed.data;
      const executionEnvironment = c.env.APP_INFERENCE_EXECUTION_ENVIRONMENT;
      if (executionEnvironment !== "test" && executionEnvironment !== "live")
        return c.json(
          {
            error: {
              code: "APP_INFERENCE_UNAVAILABLE",
              message: "App inference execution environment is not configured",
            },
          },
          503,
        );
      const actor = await requireAppActor(c, input.appId, "inference");
      if (!actor.clientId || actor.billingEnvironment !== executionEnvironment)
        return c.json(
          {
            error: {
              code: "APP_INFERENCE_ENVIRONMENT",
              message:
                "Registered app client is not authorized for this inference execution environment",
            },
          },
          403,
        );
      const headers = new Headers(c.req.raw.headers);
      headers.set("Authorization", input.developerAuthorization);
      for (const header of [
        "X-Eliza-Developer-Authorization",
        "X-App-Delegation",
        "X-API-Key",
        "Cookie",
      ])
        headers.delete(header);
      const developerRequest = new Request(c.req.raw, { headers });
      return await handleChat(developerRequest, {
        appFundingActor: {
          appId: input.appId,
          billingAccountId: input.billingAccountId,
          productFamilyKey: input.productFamilyKey,
          environment: executionEnvironment,
          actorUserId: actor.userId,
          revalidate: async () => {
            const current = await requireAppActor(c, input.appId, "inference");
            if (
              current.clientId !== actor.clientId ||
              current.userId !== actor.userId ||
              current.billingEnvironment !== executionEnvironment
            )
              throw new AppDelegationError(
                403,
                "APP_SCOPE_DENIED",
                "App delegation changed before inference dispatch",
              );
          },
        },
        traceId: c.get("requestId"),
        executionCtx: c.executionCtx,
      });
    } catch (error) {
      // error-policy:J1 Translate credential and funding failures; never expose infrastructure queries or secrets.
      if (error instanceof AppDelegationError)
        return c.json(
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      const funding = appInferenceErrorResponse(error);
      if (funding) return funding;
      logger.error("[AppInference] Request failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return c.json(
        {
          error: {
            code: "APP_INFERENCE_UNAVAILABLE",
            message: "App inference authority is unavailable",
          },
        },
        503,
      );
    }
  });
  return app;
}
export default createAppInferenceRoute();
