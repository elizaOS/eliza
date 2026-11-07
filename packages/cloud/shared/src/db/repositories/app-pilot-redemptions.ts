/** Atomically records sponsored-pilot admission, access and monthly usage allowance. */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { sqlRows } from "../execute-helpers";
import { writeTransaction } from "../helpers";
import type { AppPilotRedemption } from "../schemas/app-pilot-redemptions";
import { publishAppPilotAccess } from "./app-pilot-access";
import {
  appBillingConflict,
  lockAppBillingScope,
  planForScope,
  requireAppBillingAdministrator,
} from "./app-subscription-authority";
import { ensureBillingIdentitySubject } from "./billing-identities";

/** Operators provision random, unguessable codes and store only their SHA-256 digest. */
export function appPilotCodeDigest(code: string): string {
  // Accept the case-sensitive base64url format; entropy is the provisioning authority’s duty.
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(code)) appBillingConflict("Pilot code is unavailable");
  return createHash("sha256").update(code).digest("hex");
}

export class AppPilotRedemptionsRepository {
  /** Internal only: the caller must bind app/environment/scope from authenticated app billing. */
  async redeem(input: {
    appId: string;
    livemode: boolean;
    scopeId: string;
    actorUserId: string;
    code: string;
  }): Promise<{ redemption: AppPilotRedemption; replayed: boolean }> {
    const codeDigest = appPilotCodeDigest(input.code);
    return writeTransaction(async (tx) => {
      // Same organization/scope/account/principal lock order as paid billing admission.
      const scope = await lockAppBillingScope(tx, input.scopeId, true);
      if (scope.appId !== input.appId || scope.livemode !== input.livemode)
        appBillingConflict("Pilot scope does not match the authenticated app environment");
      const administrator = await requireAppBillingAdministrator(tx, scope, input.actorUserId);
      const [campaign] = await sqlRows<{
        id: string;
        plan_revision_id: string;
        maximum_redemptions: number;
      }>(
        tx,
        sql`SELECT id, plan_revision_id, maximum_redemptions
        FROM app_pilot_campaigns WHERE app_id = ${scope.appId} AND livemode = ${scope.livemode}
          AND code_digest = ${codeDigest} FOR UPDATE`,
      );
      if (!campaign) appBillingConflict("Pilot code is unavailable");
      const [existing] = await sqlRows<AppPilotRedemption>(
        tx,
        sql`
        SELECT * FROM app_pilot_redemptions WHERE app_id = ${scope.appId}
          AND livemode = ${scope.livemode} AND eligibility_principal_id = ${scope.eligibilityPrincipalId}`,
      );
      if (existing) {
        if (existing.billing_scope_id !== scope.scopeId || existing.campaign_id !== campaign.id)
          appBillingConflict("Pilot eligibility has already been used");
        // Preserve the original result even after expiry/revocation. This is not an access decision.
        return { redemption: existing, replayed: true };
      }
      if (scope.salesFenced || !administrator.newWorkAllowed)
        appBillingConflict("New pilot admission is unavailable for this account");
      const plan = await planForScope(tx, scope, campaign.plan_revision_id);
      if (plan.interval !== "month" || plan.interval_count !== 1 || plan.minimum_quantity !== 1)
        appBillingConflict("Pilot requires a published monthly plan with one supported seat");
      const [invitation] = await sqlRows<{ campaign_id: string }>(
        tx,
        sql`
        SELECT campaign_id FROM app_pilot_invitations WHERE campaign_id = ${campaign.id}
          AND eligibility_principal_id = ${scope.eligibilityPrincipalId}
          AND revoked_at IS NULL FOR UPDATE`,
      );
      if (!invitation) appBillingConflict("Pilot invitation is unavailable for this account");
      const [obligation] = await sqlRows<{ present: number }>(
        tx,
        sql`
        SELECT 1 AS present WHERE EXISTS (
          SELECT 1 FROM billing_subscriptions WHERE billing_scope_id = ${scope.scopeId}
            AND status NOT IN ('canceled', 'incomplete_expired')
        ) OR EXISTS (
          SELECT 1 FROM billing_subscription_commands WHERE billing_scope_id = ${scope.scopeId}
            AND kind = 'checkout' AND status IN ('PREPARED', 'OUTCOME_UNKNOWN', 'SUCCEEDED')
        )`,
      );
      if (obligation)
        appBillingConflict("Existing billing must be resolved before pilot admission");
      await ensureBillingIdentitySubject(tx, input.actorUserId);
      // Re-read primary time after all blocking locks. PostgreSQL UTC month arithmetic clamps month-end.
      const [redemption] = await sqlRows<AppPilotRedemption>(
        tx,
        sql`
        WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
        INSERT INTO app_pilot_redemptions
          (campaign_id, app_id, livemode, eligibility_principal_id, billing_scope_id,
           plan_revision_id, redeemed_by_user_id, starts_at, ends_at)
        SELECT c.id, c.app_id, c.livemode, ${scope.eligibilityPrincipalId}, ${scope.scopeId},
          c.plan_revision_id, ${input.actorUserId}, clock.now,
          ((clock.now AT TIME ZONE 'UTC') + interval '6 months') AT TIME ZONE 'UTC'
        FROM app_pilot_campaigns c CROSS JOIN clock
        WHERE c.id = ${campaign.id} AND c.revoked_at IS NULL
          AND c.opens_at <= clock.now AND clock.now < c.closes_at
          AND (SELECT count(*) FROM app_pilot_redemptions r WHERE r.campaign_id = c.id) < c.maximum_redemptions
        RETURNING *`,
      );
      if (!redemption) appBillingConflict("Pilot campaign is expired, revoked or full");
      await publishAppPilotAccess(tx, scope, redemption.id);
      return { redemption, replayed: false };
    });
  }
}

export const appPilotRedemptionsRepository = new AppPilotRedemptionsRepository();
