/** Changes billing administrators under purchaser authority and the shared membership revision. Transfers retain seats, eligibility and authority in the other billing environment. */
import type { AppBillingAdministratorsSnapshot } from "@elizaos/cloud-sdk/app-billing-membership";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DbTransaction } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import { appBillingConflict } from "../../db/repositories/app-subscription-authority";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { appBillingAccounts, appBillingMembers } from "../../db/schemas/app-billing";
import {
  appBillingMembershipOperations,
  appBillingMembershipStates,
} from "../../db/schemas/app-billing-memberships";
import { appClientRegistrations } from "../../db/schemas/app-delegations";
import { apps } from "../../db/schemas/apps";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { settlementDigest } from "./settlement-digest";

export const changeAppBillingAdministratorInput = z
  .object({
    action: z.enum(["grant", "revoke", "transfer"]),
    userId: z.string().uuid(),
    expectedRevision: z
      .string()
      .regex(/^(0|[1-9]\d*)$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/),
  })
  .strict();

interface AdministratorIdentity {
  appId: string;
  billingAccountId: string;
  userId: string;
  clientId: string | null;
  environment: "test" | "live";
}

async function lockContext(tx: DbTransaction, identity: AdministratorIdentity, mutation: boolean) {
  const [hint] = await tx
    .select({ owner: apps.organization_id })
    .from(apps)
    .where(eq(apps.id, identity.appId));
  if (!hint) appBillingConflict("App billing account is unavailable");
  // All membership writers acquire the organization before accounts and member identities.
  const [organization] = await tx
    .select({
      id: organizations.id,
      active: organizations.is_active,
      lifecycle: organizations.account_lifecycle_state,
      fencedAt: organizations.paid_work_fenced_at,
    })
    .from(organizations)
    .where(eq(organizations.id, hint.owner))
    .for("update");
  const [app] = await tx
    .select({
      owner: apps.organization_id,
      active: apps.is_active,
      approved: apps.is_approved,
      review: apps.review_status,
    })
    .from(apps)
    .where(eq(apps.id, identity.appId));
  if (!organization || !app || app.owner !== organization.id)
    appBillingConflict("App ownership changed; refresh billing authority");
  if (identity.clientId !== null) {
    const [client] = await tx
      .select()
      .from(appClientRegistrations)
      .where(eq(appClientRegistrations.id, identity.clientId))
      .for("update");
    if (
      !client ||
      !client.is_active ||
      client.app_id !== identity.appId ||
      client.owner_organization_id !== organization.id ||
      client.billing_environment !== identity.environment ||
      !client.allowed_scopes.includes(mutation ? "billing:write" : "billing:read")
    )
      appBillingConflict("Current registered purchaser delegation is required");
  }
  const [account] = await tx
    .select()
    .from(appBillingAccounts)
    .where(
      and(
        eq(appBillingAccounts.id, identity.billingAccountId),
        eq(appBillingAccounts.app_id, identity.appId),
      ),
    )
    .for("update");
  if (!account || account.deleted_at) appBillingConflict("App billing account is unavailable");
  const grants = await tx
    .select()
    .from(appBillingMembers)
    .where(
      and(
        eq(appBillingMembers.billing_account_id, account.id),
        eq(appBillingMembers.app_id, identity.appId),
      ),
    )
    .orderBy(asc(appBillingMembers.user_id))
    .for("update");
  const principalIds = [...new Set([identity.userId, ...grants.map((row) => row.user_id)])].sort();
  const principals = await tx
    .select({
      id: users.id,
      active: users.is_active,
      deletedAt: users.deleted_at,
      anonymous: users.is_anonymous,
      lifecycle: users.account_lifecycle_state,
      fencedAt: users.auth_fenced_at,
      expiresAt: users.expires_at,
    })
    .from(users)
    .where(inArray(users.id, principalIds))
    .orderBy(asc(users.id))
    .for("update");
  const now = await readPostLockDatabaseNow(tx);
  const activeIds = new Set(
    principals
      .filter(
        (row) =>
          row.active &&
          row.deletedAt === null &&
          !row.anonymous &&
          row.lifecycle === "active" &&
          row.fencedAt === null &&
          (row.expiresAt === null || row.expiresAt > now),
      )
      .map((row) => row.id),
  );
  const livemode = identity.environment === "live";
  const activeGrants = grants.filter(
    (row) =>
      row.revoked_at === null &&
      (row.livemode === null || row.livemode === livemode) &&
      activeIds.has(row.user_id),
  );
  if (!activeGrants.some((row) => row.user_id === identity.userId))
    appBillingConflict("Current verified billing account membership is required");
  return {
    grants,
    activeGrants,
    livemode,
    fenced:
      !organization.active ||
      organization.lifecycle !== "active" ||
      organization.fencedAt !== null ||
      !app.active ||
      !app.approved ||
      app.review !== "approved",
  };
}

function requireAdministrator(scope: Awaited<ReturnType<typeof lockContext>>, userId: string) {
  if (!scope.activeGrants.some((row) => row.user_id === userId && row.role === "administrator"))
    appBillingConflict("Current purchaser billing administrator authority is required");
}

function snapshot(
  identity: AdministratorIdentity,
  revision: number,
  administrators: string[],
): AppBillingAdministratorsSnapshot {
  return {
    appId: identity.appId,
    billingAccountId: identity.billingAccountId,
    environment: identity.environment,
    revision: String(revision),
    administrators: [...new Set(administrators)].sort(),
  };
}

export class GenericBillingAdministratorsService {
  async snapshot(identity: AdministratorIdentity): Promise<AppBillingAdministratorsSnapshot> {
    return writeTransaction(async (tx) => {
      const scope = await lockContext(tx, identity, false);
      const [state] = await tx
        .select()
        .from(appBillingMembershipStates)
        .where(
          and(
            eq(appBillingMembershipStates.billing_account_id, identity.billingAccountId),
            eq(appBillingMembershipStates.livemode, scope.livemode),
          ),
        );
      return snapshot(
        identity,
        state?.revision ?? 0,
        scope.activeGrants.filter((row) => row.role === "administrator").map((row) => row.user_id),
      );
    });
  }

  async change(
    identity: AdministratorIdentity,
    raw: z.input<typeof changeAppBillingAdministratorInput>,
  ): Promise<AppBillingAdministratorsSnapshot> {
    const input = changeAppBillingAdministratorInput.parse(raw);
    const digest = settlementDigest({
      appId: identity.appId,
      billingAccountId: identity.billingAccountId,
      userId: identity.userId,
      clientId: identity.clientId,
      environment: identity.environment,
      input,
    });
    return writeTransaction(async (tx) => {
      const scope = await lockContext(tx, identity, true);
      const [prior] = await tx
        .select()
        .from(appBillingMembershipOperations)
        .where(
          and(
            eq(appBillingMembershipOperations.billing_account_id, identity.billingAccountId),
            eq(appBillingMembershipOperations.livemode, scope.livemode),
            eq(appBillingMembershipOperations.idempotency_key, input.idempotencyKey),
          ),
        );
      // A completed transfer demotes its actor. Current ordinary membership may recover that immutable receipt.
      if (prior) {
        if (
          prior.operation_kind !== "administrator_change" ||
          !("administrators" in prior.result) ||
          prior.actor_user_id !== identity.userId ||
          prior.client_registration_id !== identity.clientId ||
          prior.request_digest !== digest
        )
          appBillingConflict("Administrator retry changes its original operation");
        return prior.result;
      }
      requireAdministrator(scope, identity.userId);
      if (scope.fenced) appBillingConflict("App administrator changes are fenced");
      if (input.action === "transfer" && input.userId === identity.userId)
        appBillingConflict("Transfer requires a different accepted member");
      await tx
        .insert(appBillingMembershipStates)
        .values({
          app_id: identity.appId,
          billing_account_id: identity.billingAccountId,
          livemode: scope.livemode,
        })
        .onConflictDoNothing();
      const [state] = await tx
        .select()
        .from(appBillingMembershipStates)
        .where(
          and(
            eq(appBillingMembershipStates.billing_account_id, identity.billingAccountId),
            eq(appBillingMembershipStates.livemode, scope.livemode),
          ),
        )
        .for("update");
      if (!state) appBillingConflict("App membership revision state is unavailable");
      if (state.revision !== Number(input.expectedRevision))
        throw new ElizaError("Refresh app membership before changing administrators", {
          code: "APP_BILLING_MEMBERSHIP_REVISION_CONFLICT",
          context: {
            billingAccountId: identity.billingAccountId,
            expectedRevision: input.expectedRevision,
            currentRevision: String(state.revision),
          },
        });
      if (
        input.action !== "revoke" &&
        !scope.activeGrants.some((row) => row.user_id === input.userId)
      )
        appBillingConflict("Administrator grants require an active accepted Cloud member");
      const administrators = new Set(
        scope.activeGrants.filter((row) => row.role === "administrator").map((row) => row.user_id),
      );
      const demoted =
        input.action === "transfer"
          ? identity.userId
          : input.action === "revoke"
            ? input.userId
            : null;
      if (input.action !== "revoke") administrators.add(input.userId);
      if (demoted !== null) {
        if (
          !scope.grants.some(
            (row) =>
              row.user_id === demoted &&
              row.role === "administrator" &&
              row.revoked_at === null &&
              (row.livemode === null || row.livemode === scope.livemode),
          )
        )
          appBillingConflict("The selected member is not a billing administrator");
        administrators.delete(demoted);
      }
      if (administrators.size === 0)
        appBillingConflict("At least one active billing administrator must remain");
      const now = await readPostLockDatabaseNow(tx);
      const setRole = async (
        userId: string,
        livemode: boolean,
        role: "administrator" | "member",
      ) => {
        const existing = scope.grants.find(
          (row) => row.user_id === userId && row.livemode === livemode,
        );
        if (existing)
          await tx
            .update(appBillingMembers)
            .set({ role, revoked_at: null })
            .where(eq(appBillingMembers.id, existing.id));
        else
          await tx.insert(appBillingMembers).values({
            app_id: identity.appId,
            billing_account_id: identity.billingAccountId,
            user_id: userId,
            livemode,
            role,
          });
      };
      if (input.action !== "revoke") await setRole(input.userId, scope.livemode, "administrator");
      if (demoted !== null) {
        const global = scope.grants.find(
          (row) => row.user_id === demoted && row.livemode === null && row.revoked_at === null,
        );
        if (global) {
          await tx
            .update(appBillingMembers)
            .set({ revoked_at: now })
            .where(eq(appBillingMembers.id, global.id));
          await setRole(demoted, !scope.livemode, "administrator");
        }
        await setRole(demoted, scope.livemode, "member");
      }
      const result = snapshot(identity, state.revision + 1, [...administrators]);
      await tx
        .update(appBillingMembershipStates)
        .set({ revision: state.revision + 1 })
        .where(
          and(
            eq(appBillingMembershipStates.billing_account_id, identity.billingAccountId),
            eq(appBillingMembershipStates.livemode, scope.livemode),
          ),
        );
      await tx.insert(appBillingMembershipOperations).values({
        app_id: identity.appId,
        billing_account_id: identity.billingAccountId,
        livemode: scope.livemode,
        operation_kind: "administrator_change",
        actor_user_id: identity.userId,
        client_registration_id: identity.clientId,
        idempotency_key: input.idempotencyKey,
        request_digest: digest,
        result,
      });
      return result;
    });
  }
}
export const genericBillingAdministratorsService = new GenericBillingAdministratorsService();
