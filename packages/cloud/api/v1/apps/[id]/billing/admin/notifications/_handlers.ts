/** Translates app-owner notification configuration requests without exposing persisted signing secrets. */
import { ElizaError } from "@elizaos/core";
import type { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import { appBillingNotifications } from "@/lib/services/app-billing-notifications";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const identity = z.object({
  clientRegistrationId: z.string().uuid(),
  expectedRevision: z
    .string()
    .regex(/^[1-9]\d*$/)
    .nullable(),
});
export function notificationBoundary(app: Hono<AppEnv>) {
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const guard = checkCookieMutationGuard(
      c.req,
      c.env.ENVIRONMENT,
      c.env.NODE_ENV === "production",
    );
    if (!guard.ok)
      return c.json(
        { success: false, error: "Forbidden", code: guard.code },
        403,
      );
    return next();
  });
  app.onError((error, c) => {
    // error-policy:J1 Configuration failures become typed transport responses; no successful defaults.
    if (error instanceof z.ZodError)
      return c.json(
        {
          success: false,
          error: "Notification request is invalid",
          code: "APP_NOTIFICATION_INVALID",
        },
        400,
      );
    if (
      error instanceof ElizaError &&
      error.code.startsWith("APP_NOTIFICATION_")
    )
      return c.json(
        { success: false, error: error.message, code: error.code },
        error.code === "APP_NOTIFICATION_FORBIDDEN"
          ? 403
          : error.code === "APP_NOTIFICATION_CONFLICT"
            ? 409
            : error.code === "APP_NOTIFICATION_UNAVAILABLE"
              ? 503
              : 400,
      );
    return failureResponse(c, error);
  });
}
async function owner(c: AppContext, clientRegistrationId: string) {
  const user = await requireCurrentBillingManagerSession(c);
  return {
    appId: z.string().uuid().parse(c.req.param("id")),
    organizationId: user.organization_id,
    clientRegistrationId,
  };
}
export async function readNotifications(c: AppContext) {
  const registration = z
    .string()
    .uuid()
    .parse(c.req.query("clientRegistrationId"));
  return c.json({
    success: true,
    data: await appBillingNotifications.read(await owner(c, registration)),
  });
}
export async function configureNotifications(c: AppContext) {
  const input = identity
    .extend({ endpointUrl: z.string().url(), enabled: z.boolean() })
    .strict()
    .parse(await c.req.json());
  return c.json({
    success: true,
    data: await appBillingNotifications.configure({
      ...(await owner(c, input.clientRegistrationId)),
      ...input,
    }),
  });
}
export async function prepareNotificationKey(c: AppContext) {
  const input = identity.strict().parse(await c.req.json());
  return c.json({
    success: true,
    data: await appBillingNotifications.prepareKey({
      ...(await owner(c, input.clientRegistrationId)),
      ...input,
    }),
  });
}
export async function activateNotificationKey(c: AppContext) {
  const input = identity
    .extend({ pendingKeyId: z.string().uuid() })
    .strict()
    .parse(await c.req.json());
  return c.json({
    success: true,
    data: await appBillingNotifications.activateKey({
      ...(await owner(c, input.clientRegistrationId)),
      ...input,
    }),
  });
}
