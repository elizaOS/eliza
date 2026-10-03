/** Authorizes registered app backends to mirror accepted members without borrowing an owner's delegation. */
import { z } from "zod";
import { readAppClientBasicAuthorization } from "@/lib/auth/app-delegation-auth";
import { AppDelegationError } from "@/lib/services/app-delegation";
import { appDelegationService } from "@/lib/services/app-delegation-adapter";
import {
  genericBillingMembershipService,
  synchronizeAppBillingMemberInput,
} from "@/lib/services/generic-billing-membership";
import { configuredAppBillingEnvironment } from "@/lib/services/generic-billing-runtime-config";
import type { AppContext } from "@/types/cloud-worker-env";

async function membershipBackend(c: AppContext) {
  const appId = z.string().uuid().parse(c.req.param("id"));
  const billingAccountId = z.string().uuid().parse(c.req.param("accountId"));
  const credentials = readAppClientBasicAuthorization(
    c.req.header("Authorization"),
  );
  const registration = await appDelegationService.requireClient(
    credentials.clientId,
    credentials.secret,
  );
  if (
    registration.appId !== appId ||
    !registration.allowedScopes.includes("billing:write")
  )
    throw new AppDelegationError(
      403,
      "APP_SCOPE_DENIED",
      "The backend client cannot synchronize this application's billing membership",
    );
  if (
    registration.billingEnvironment === "live" &&
    configuredAppBillingEnvironment() !== "live"
  )
    throw new AppDelegationError(
      403,
      "APP_ENVIRONMENT_DENIED",
      "This deployment does not accept live billing membership changes",
    );
  return { registration, billingAccountId };
}
export async function getBillingMembers(c: AppContext) {
  const { registration, billingAccountId } = await membershipBackend(c);
  return c.json({
    success: true,
    data: await genericBillingMembershipService.snapshot(
      registration,
      billingAccountId,
    ),
  });
}
export async function synchronizeBillingMember(c: AppContext) {
  const { registration, billingAccountId } = await membershipBackend(c);
  const input = synchronizeAppBillingMemberInput.parse(await c.req.json());
  return c.json({
    success: true,
    data: await genericBillingMembershipService.synchronize(
      registration,
      billingAccountId,
      input,
    ),
  });
}
