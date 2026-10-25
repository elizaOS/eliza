/** Resolves interactive owners or source-app buyer credentials without treating infrastructure keys as subscriber authority. */

import {
  requireApiKeyCredential,
  requireSessionUserWithOrg,
} from "@elizaos/cloud-shared/auth";
import type { AppBillingPrincipal } from "@elizaos/cloud-shared/db/repositories/app-billing-accounts";
import {
  ApiError,
  failureResponse,
} from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { getPresentedMobileApiKeySecret } from "@elizaos/cloud-shared/lib/auth/mobile-api-key";
import type { AppContext } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { z } from "zod";
export const appBillingEnvironment = z.enum(["test", "live"]);
export const appBillingId = z.string().uuid();
export async function appBillingPrincipal(
  c: AppContext,
  appId: string,
  owner: boolean,
): Promise<AppBillingPrincipal> {
  const key = getPresentedMobileApiKeySecret(c.req.raw);
  if (!owner && key !== null) {
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
