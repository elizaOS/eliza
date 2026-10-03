/** Resolves operator-configured native product billing for a free signed-in purchaser before account creation. */
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { z } from "zod";
import { readAppBillingApplicationProduct } from "@/db/repositories/app-billing-application-slots";
import { requireUser } from "@/lib/auth/workers-hono-auth";
import { AppDelegationError } from "@/lib/services/app-delegation";
import { configuredAppBillingEnvironment } from "@/lib/services/generic-billing-runtime-config";
import type { AppEnv } from "@/types/cloud-worker-env";
import { appBillingErrorResponse } from "../../../apps/[id]/billing/_handlers";

const route = new Hono<AppEnv>();
route.onError((error, c) => {
  // error-policy:J1 Configuration absence is explicit and cannot become prepaid billing selection.
  if (
    error instanceof ElizaError &&
    error.code === "APP_BILLING_APPLICATION_SLOT_UNAVAILABLE"
  )
    return c.json(
      { success: false, error: error.message, code: error.code },
      503,
    );
  return appBillingErrorResponse(error, c);
});
route.get("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const user = await requireUser(c);
  if (c.get("authMethod") !== "session" || user.is_anonymous)
    throw new AppDelegationError(
      401,
      "APP_SESSION_REQUIRED",
      "Sign in to manage application product billing",
    );
  const slotKey = z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,99}$/)
    .parse(c.req.param("slotKey"));
  return c.json({
    success: true,
    data: await readAppBillingApplicationProduct({
      slotKey,
      livemode: configuredAppBillingEnvironment() === "live",
    }),
  });
});
export default route;
