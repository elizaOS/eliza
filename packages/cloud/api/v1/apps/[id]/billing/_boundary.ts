/** Resolves interactive owners or source-app buyer credentials without treating infrastructure keys as subscriber authority. */
import { z } from "zod";
import type { AppBillingPrincipal } from "@/db/repositories/app-billing-accounts";
import { ApiError, failureResponse } from "@/lib/api/cloud-worker-errors";
import { isMobileApiKeySecret } from "@/lib/auth/mobile-api-key";
import {
  requireApiKeyCredential,
  requireSessionUserWithOrg,
} from "@/lib/auth/workers-hono-auth";
import type { AppContext } from "@/types/cloud-worker-env";
export const appBillingEnvironment = z.enum(["test", "live"]);
export const appBillingId = z.string().uuid();
export async function appBillingPrincipal(
  c: AppContext,
  appId: string,
  owner: boolean,
): Promise<AppBillingPrincipal> {
  const key =
    c.req.header("X-API-Key") ??
    c.req.header("Authorization")?.replace(/^Bearer /, "");
  if (!owner && key?.startsWith("eliza_")) {
    if (!isMobileApiKeySecret(key))
      throw new ApiError(
        403,
        "access_denied",
        "A source-app buyer credential is required",
      );
    const credential = await requireApiKeyCredential(c);
    if (credential.source_app_id !== appId)
      throw new ApiError(
        403,
        "access_denied",
        "Credential does not belong to this app",
      );
    return { userId: credential.user_id, credentialId: credential.id };
  }
  const user = await requireSessionUserWithOrg(c);
  return { userId: user.id, credentialId: null };
}
export function appBillingFailure(c: AppContext, error: unknown): Response {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "APP_BILLING_ACCESS_DENIED"
  ) {
    return c.json(
      {
        success: false,
        code: "access_denied",
        error: "App billing access denied",
      },
      403,
    );
  }
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "APP_BILLING_ACCOUNT_UNAVAILABLE"
  ) {
    return c.json(
      {
        success: false,
        code: "service_unavailable",
        error: "App billing account unavailable",
      },
      503,
    );
  }
  return failureResponse(c, error);
}
