/** Lets current app-owner organization administrators register and revoke confidential app clients. */
import type { Hono } from "hono";
import { z } from "zod";
import {
  appDelegationsRepository,
  registerAppClientSchema,
} from "@/db/repositories/app-delegations";
import { checkCookieMutationGuard } from "@/lib/auth/cookie-mutation-guard";
import { requireCurrentBillingManagerSession } from "@/lib/auth/workers-hono-auth";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";
import { appDelegationErrorResponse } from "../../../app-auth/delegations/_handlers";

export function appClientManagementBoundary(app: Hono<AppEnv>) {
  app.onError(appDelegationErrorResponse);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
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
}
export const listAppDelegationClients = async (c: AppContext) => {
  const user = await requireCurrentBillingManagerSession(c);
  const appId = z.string().uuid().parse(c.req.param("id"));
  return c.json({
    success: true,
    data: await appDelegationsRepository.list(appId, user.organization_id),
  });
};
export const registerAppDelegationClient = async (c: AppContext) => {
  const user = await requireCurrentBillingManagerSession(c);
  const appId = z.string().uuid().parse(c.req.param("id"));
  const input = registerAppClientSchema.parse(await c.req.json());
  return c.json(
    {
      success: true,
      data: await appDelegationsRepository.register(
        appId,
        user.organization_id,
        input,
      ),
    },
    201,
  );
};
export const rotateAppDelegationClient = async (c: AppContext) => {
  const user = await requireCurrentBillingManagerSession(c);
  const appId = z.string().uuid().parse(c.req.param("id"));
  const clientId = z.string().uuid().parse(c.req.param("clientId"));
  return c.json({
    success: true,
    data: await appDelegationsRepository.rotate(
      appId,
      clientId,
      user.organization_id,
      false,
    ),
  });
};
export const revokeAppDelegationClient = async (c: AppContext) => {
  const user = await requireCurrentBillingManagerSession(c);
  const appId = z.string().uuid().parse(c.req.param("id"));
  const clientId = z.string().uuid().parse(c.req.param("clientId"));
  await appDelegationsRepository.rotate(
    appId,
    clientId,
    user.organization_id,
    true,
  );
  return c.json({ success: true });
};
