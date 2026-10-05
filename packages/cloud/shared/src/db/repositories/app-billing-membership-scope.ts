/** Keeps backend-created membership grants inside their registered billing environment while preserving existing account owners. */
import { eq, isNull, or } from "drizzle-orm";
import { appBillingMembers } from "../schemas/app-billing";

export function appBillingMembershipEnvironment(livemode?: boolean) {
  return livemode === undefined
    ? isNull(appBillingMembers.livemode)
    : or(isNull(appBillingMembers.livemode), eq(appBillingMembers.livemode, livemode));
}
