/** Synchronizes app-owned membership under scoped backend credentials without granting purchase or administrator authority. */
import type {
  AppBillingMember,
  AppBillingMembershipChange,
  AppBillingMembershipSnapshot,
} from "@elizaos/cloud-sdk/app-billing-membership";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import { appBillingMembershipEnvironment } from "../../db/repositories/app-billing-membership-scope";
import { setAppBillingSeat } from "../../db/repositories/app-billing-seats";
import {
  appBillingConflict,
  lockAppBillingScope,
} from "../../db/repositories/app-subscription-authority";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import {
  appBillingAccounts,
  appBillingMembers,
  appBillingScopes,
  appBillingSeats,
} from "../../db/schemas/app-billing";
import {
  appBillingMembershipOperations,
  appBillingMembershipStates,
} from "../../db/schemas/app-billing-memberships";
import { appClientRegistrations } from "../../db/schemas/app-delegations";
import { apps } from "../../db/schemas/apps";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import type { AppClientRegistration } from "./app-delegation";
import { settlementDigest } from "./settlement-digest";

export const synchronizeAppBillingMemberInput = z
  .object({
    userId: z.string().uuid(),
    active: z.boolean(),
    expectedRevision: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
    seats: z
      .array(
        z
          .object({
            productFamilyKey: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
              .max(100),
            assigned: z.boolean(),
          })
          .strict(),
      )
      .refine(
        (rows) => new Set(rows.map((row) => row.productFamilyKey)).size === rows.length,
        "A product family can occur only once",
      ),
  })
  .strict()
  .refine(
    (value) => value.active || value.seats.every((seat) => !seat.assigned),
    "An inactive member cannot retain a seat",
  );

async function lockContext(
  tx: DbTransaction,
  registration: AppClientRegistration,
  billingAccountId: string,
) {
  const livemode = registration.billingEnvironment === "live";
  const [organization] = await tx
    .select({
      id: organizations.id,
      active: organizations.is_active,
      lifecycle: organizations.account_lifecycle_state,
      fencedAt: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, registration.appOwnerOrganizationId))
    .for("update");
  const [app] = await tx
    .select({
      id: apps.id,
      owner: apps.organization_id,
      active: apps.is_active,
      approved: apps.is_approved,
      reviewStatus: apps.review_status,
    })
    .from(apps)
    .where(eq(apps.id, registration.appId));
  const [client] = await tx
    .select()
    .from(appClientRegistrations)
    .where(eq(appClientRegistrations.id, registration.id))
    .for("update");
  if (
    !organization ||
    !app ||
    app.owner !== organization.id ||
    !client ||
    !client.is_active ||
    client.app_id !== app.id ||
    client.owner_organization_id !== organization.id ||
    client.billing_environment !== registration.billingEnvironment ||
    client.revision !== registration.revision ||
    !client.allowed_scopes.includes("billing:write")
  )
    appBillingConflict("Current registered app backend billing authority is required");
  const hints = await tx
    .select({ id: appBillingScopes.id })
    .from(appBillingScopes)
    .where(
      and(
        eq(appBillingScopes.app_id, app.id),
        eq(appBillingScopes.billing_account_id, billingAccountId),
        eq(appBillingScopes.livemode, livemode),
      ),
    )
    .orderBy(asc(appBillingScopes.id));
  const scopes = [];
  for (const hint of hints) scopes.push(await lockAppBillingScope(tx, hint.id, true));
  const [account] = await tx
    .select()
    .from(appBillingAccounts)
    .where(and(eq(appBillingAccounts.id, billingAccountId), eq(appBillingAccounts.app_id, app.id)))
    .for("update");
  if (!account || account.deleted_at) appBillingConflict("App billing account is unavailable");
  return {
    appId: app.id,
    billingAccountId,
    livemode,
    scopes,
    fenced:
      !organization.active ||
      organization.lifecycle !== "active" ||
      organization.fencedAt !== null ||
      !app.active ||
      !app.approved ||
      app.reviewStatus !== "approved",
  };
}

async function members(
  tx: DbTransaction,
  scope: { appId: string; billingAccountId: string; livemode: boolean },
): Promise<AppBillingMember[]> {
  const rows = await tx
    .select()
    .from(appBillingMembers)
    .where(
      and(
        eq(appBillingMembers.app_id, scope.appId),
        eq(appBillingMembers.billing_account_id, scope.billingAccountId),
        appBillingMembershipEnvironment(scope.livemode),
      ),
    )
    .orderBy(asc(appBillingMembers.user_id), asc(appBillingMembers.role));
  const byUser = new Map<string, AppBillingMember>();
  for (const row of rows) {
    const member = { userId: row.user_id, role: row.role, active: row.revoked_at === null };
    const existing = byUser.get(member.userId);
    if (
      !existing ||
      (!existing.active && member.active) ||
      (member.active && member.role === "administrator")
    )
      byUser.set(member.userId, member);
  }
  return [...byUser.values()];
}

export class GenericBillingMembershipService {
  async snapshot(
    registration: AppClientRegistration,
    billingAccountId: string,
  ): Promise<AppBillingMembershipSnapshot> {
    return writeTransaction(async (tx) => {
      const scope = await lockContext(tx, registration, billingAccountId);
      const [state] = await tx
        .select()
        .from(appBillingMembershipStates)
        .where(
          and(
            eq(appBillingMembershipStates.billing_account_id, billingAccountId),
            eq(appBillingMembershipStates.livemode, scope.livemode),
          ),
        );
      return {
        appId: scope.appId,
        billingAccountId,
        environment: registration.billingEnvironment,
        revision: String(state?.revision ?? 0),
        members: await members(tx, scope),
      };
    });
  }

  async synchronize(
    registration: AppClientRegistration,
    billingAccountId: string,
    raw: z.input<typeof synchronizeAppBillingMemberInput>,
  ): Promise<AppBillingMembershipChange> {
    const input = synchronizeAppBillingMemberInput.parse(raw);
    const digest = settlementDigest({
      appId: registration.appId,
      billingAccountId,
      environment: registration.billingEnvironment,
      clientId: registration.id,
      input,
    });
    return writeTransaction(async (tx) => {
      const scope = await lockContext(tx, registration, billingAccountId);
      const [prior] = await tx
        .select()
        .from(appBillingMembershipOperations)
        .where(
          and(
            eq(appBillingMembershipOperations.billing_account_id, billingAccountId),
            eq(appBillingMembershipOperations.livemode, scope.livemode),
            eq(appBillingMembershipOperations.idempotency_key, input.idempotencyKey),
          ),
        );
      if (prior) {
        if (
          prior.operation_kind !== "member_sync" ||
          !("member" in prior.result) ||
          prior.request_digest !== digest ||
          prior.client_registration_id !== registration.id
        )
          appBillingConflict("Membership retry changes its original operation");
        return prior.result;
      }
      if (scope.fenced && input.active) appBillingConflict("App membership activation is fenced");
      await tx
        .insert(appBillingMembershipStates)
        .values({
          app_id: scope.appId,
          billing_account_id: billingAccountId,
          livemode: scope.livemode,
        })
        .onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(appBillingMembershipStates)
        .where(
          and(
            eq(appBillingMembershipStates.billing_account_id, billingAccountId),
            eq(appBillingMembershipStates.livemode, scope.livemode),
          ),
        )
        .for("update");
      if (!state) appBillingConflict("App membership revision state is unavailable");
      if (state.revision !== Number(input.expectedRevision))
        throw new ElizaError("Refresh app membership before synchronizing a concurrent change", {
          code: "APP_BILLING_MEMBERSHIP_REVISION_CONFLICT",
          context: {
            billingAccountId,
            expectedRevision: input.expectedRevision,
            currentRevision: String(state.revision),
          },
        });
      const [principal] = await tx
        .select({
          active: users.is_active,
          deletedAt: users.deleted_at,
          anonymous: users.is_anonymous,
        })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("update");
      if (
        !principal ||
        (input.active && (!principal.active || principal.deletedAt || principal.anonymous))
      )
        appBillingConflict("Membership activation requires the member's verified Cloud identity");
      const existing = await tx
        .select()
        .from(appBillingMembers)
        .where(
          and(
            eq(appBillingMembers.app_id, scope.appId),
            eq(appBillingMembers.billing_account_id, billingAccountId),
            eq(appBillingMembers.user_id, input.userId),
            appBillingMembershipEnvironment(scope.livemode),
          ),
        )
        .for("update");
      const scopedGrant = existing.find((row) => row.livemode === scope.livemode);
      const protectedGrant =
        existing.find((row) => row.livemode === null && row.revoked_at === null) ??
        (scopedGrant?.role === "administrator" ? scopedGrant : undefined) ??
        (!scopedGrant ? existing.find((row) => row.livemode === null) : undefined);
      if (protectedGrant && (!input.active || protectedGrant.revoked_at !== null))
        appBillingConflict(
          "App backends cannot remove, reactivate or replace billing administrator grants",
        );
      const now = await readPostLockDatabaseNow(tx);
      if (!protectedGrant) {
        const member = existing.find((row) => row.livemode === scope.livemode);
        if (member)
          await tx
            .update(appBillingMembers)
            .set({ revoked_at: input.active ? null : now })
            .where(eq(appBillingMembers.id, member.id));
        else
          await tx.insert(appBillingMembers).values({
            app_id: scope.appId,
            billing_account_id: billingAccountId,
            user_id: input.userId,
            role: "member",
            livemode: scope.livemode,
            revoked_at: input.active ? null : now,
          });
      }
      for (const desired of input.seats) {
        if (!scope.scopes.some((row) => row.productFamilyKey === desired.productFamilyKey))
          appBillingConflict(
            "Seat assignment requires an existing subscription scope in this environment",
          );
      }
      for (const subscriptionScope of scope.scopes) {
        const desired = input.seats.find(
          (row) => row.productFamilyKey === subscriptionScope.productFamilyKey,
        );
        if (!input.active || desired)
          await setAppBillingSeat(tx, {
            scope: subscriptionScope,
            subject: input.userId,
            assigned: input.active && desired!.assigned,
            idempotencyKey: `member:${settlementDigest({ operation: input.idempotencyKey, clientId: registration.id, scopeId: subscriptionScope.scopeId })}`,
            now,
          });
      }
      const activeSeats = [];
      for (const subscriptionScope of scope.scopes) {
        const [seat] = await tx
          .select({ id: appBillingSeats.id })
          .from(appBillingSeats)
          .where(
            and(
              eq(appBillingSeats.billing_scope_id, subscriptionScope.scopeId),
              eq(appBillingSeats.subject, input.userId),
              isNull(appBillingSeats.revoked_at),
            ),
          );
        if (seat)
          activeSeats.push({
            productFamilyKey: subscriptionScope.productFamilyKey,
            seatId: seat.id,
          });
      }
      const result: AppBillingMembershipChange = {
        appId: scope.appId,
        billingAccountId,
        environment: registration.billingEnvironment,
        revision: String(state.revision + 1),
        member: {
          userId: input.userId,
          role: protectedGrant?.role ?? "member",
          active: input.active,
        },
        seats: activeSeats,
      };
      await tx
        .update(appBillingMembershipStates)
        .set({ revision: state.revision + 1 })
        .where(
          and(
            eq(appBillingMembershipStates.billing_account_id, billingAccountId),
            eq(appBillingMembershipStates.livemode, scope.livemode),
          ),
        );
      await tx.insert(appBillingMembershipOperations).values({
        app_id: scope.appId,
        billing_account_id: billingAccountId,
        livemode: scope.livemode,
        client_registration_id: registration.id,
        idempotency_key: input.idempotencyKey,
        request_digest: digest,
        result,
      });
      return result;
    });
  }
}
export const genericBillingMembershipService = new GenericBillingMembershipService();
