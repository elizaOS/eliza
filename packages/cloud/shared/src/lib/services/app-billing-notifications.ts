/**
 * Delivers committed app subscription hints through the existing outbox and callback signature.
 * Configuration is app-owner and environment scoped; staged keys use the shared encrypted-field
 * store. Receiver acknowledgements never grant access or alter billing state.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  type AppBillingNotification,
  type AppBillingNotificationConfig,
  createAppNotificationSignature,
} from "@elizaos/cloud-sdk/app-notifications";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { dbWrite, writeTransaction } from "../../db/helpers";
import { lockAppBillingScope } from "../../db/repositories/app-subscription-authority";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { appBillingScopes, appSubscriptionOutbox } from "../../db/schemas/app-billing";
import { appBillingNotificationEndpoints } from "../../db/schemas/app-billing-delivery";
import { appClientRegistrations } from "../../db/schemas/app-delegations";
import { apps } from "../../db/schemas/apps";
import { organizations } from "../../db/schemas/organizations";
import { assertSafeOutboundUrlSync } from "../security/outbound-url";
import { safeFetch } from "../security/safe-fetch";
import { fieldEncryption } from "./field-encryption";

type Endpoint = typeof appBillingNotificationEndpoints.$inferSelect;
export interface NotificationOwner {
  appId: string;
  organizationId: string;
  clientRegistrationId: string;
}
const fail = (code: string, message: string): never => {
  throw new ElizaError(message, { code });
};
const coords = (id: string) => ({
  table: "app_billing_notification_endpoints",
  rowId: id,
  column: "signing_secret",
});

async function owner(tx: DbTransaction, input: NotificationOwner) {
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(eq(organizations.id, input.organizationId), eq(organizations.is_active, true)))
    .for("update");
  const [app] = await tx
    .select({ id: apps.id, origins: apps.allowed_origins, url: apps.app_url })
    .from(apps)
    .where(
      and(
        eq(apps.id, input.appId),
        eq(apps.organization_id, input.organizationId),
        eq(apps.is_active, true),
      ),
    )
    .for("update");
  const [client] = await tx
    .select()
    .from(appClientRegistrations)
    .where(
      and(
        eq(appClientRegistrations.id, input.clientRegistrationId),
        eq(appClientRegistrations.app_id, input.appId),
        eq(appClientRegistrations.owner_organization_id, input.organizationId),
        eq(appClientRegistrations.is_active, true),
      ),
    );
  if (!org || !app || !client)
    fail(
      "APP_NOTIFICATION_FORBIDDEN",
      "A current app owner and registered billing environment are required",
    );
  const [endpoint] = await tx
    .select()
    .from(appBillingNotificationEndpoints)
    .where(
      and(
        eq(appBillingNotificationEndpoints.app_id, input.appId),
        eq(appBillingNotificationEndpoints.livemode, client.billing_environment === "live"),
      ),
    )
    .for("update");
  return { app, client, endpoint: endpoint ?? null };
}
function revision(endpoint: Endpoint | null, expected: string | null) {
  if ((endpoint ? String(endpoint.revision) : null) !== expected)
    fail(
      "APP_NOTIFICATION_CONFLICT",
      "Notification configuration changed; read current state before retrying",
    );
}
async function config(
  tx: DbTransaction,
  appId: string,
  livemode: boolean,
  endpoint: Endpoint | null,
): Promise<AppBillingNotificationConfig> {
  const [stats] = await tx
    .select({
      pending: sql<number>`count(*) FILTER (WHERE ${appSubscriptionOutbox.state} IN ('pending','processing'))::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${appSubscriptionOutbox.error_code} IS NOT NULL AND ${appSubscriptionOutbox.state}<>'delivered')::int`,
      delivered: sql<string | null>`max(${appSubscriptionOutbox.delivered_at})::text`,
    })
    .from(appSubscriptionOutbox)
    .innerJoin(appBillingScopes, eq(appBillingScopes.id, appSubscriptionOutbox.billing_scope_id))
    .where(and(eq(appBillingScopes.app_id, appId), eq(appBillingScopes.livemode, livemode)));
  if (!stats) fail("APP_NOTIFICATION_UNAVAILABLE", "Notification delivery status is unavailable");
  return {
    appId,
    environment: livemode ? "live" : "test",
    endpointUrl: endpoint?.endpoint_url ?? null,
    enabled: endpoint?.enabled ?? false,
    revision: endpoint ? String(endpoint.revision) : null,
    keyId: endpoint?.active_key_id ?? null,
    pendingKeyId: endpoint?.pending_key_id ?? null,
    lastDeliveredAt: stats.delivered ? new Date(stats.delivered).toISOString() : null,
    pendingCount: stats.pending,
    failedCount: stats.failed,
  };
}

export class AppBillingNotifications {
  constructor(private readonly transport: typeof safeFetch = safeFetch) {}
  async read(input: NotificationOwner) {
    return writeTransaction(async (tx) => {
      const state = await owner(tx, input);
      return config(tx, input.appId, state.client.billing_environment === "live", state.endpoint);
    });
  }
  async configure(
    input: NotificationOwner & {
      endpointUrl: string;
      enabled: boolean;
      expectedRevision: string | null;
    },
  ) {
    const url = assertSafeOutboundUrlSync(input.endpointUrl);
    if (url.protocol !== "https:" || url.hash)
      fail(
        "APP_NOTIFICATION_INVALID",
        "Notification endpoint must be an exact HTTPS URL without a fragment",
      );
    return writeTransaction(async (tx) => {
      const state = await owner(tx, input);
      revision(state.endpoint, input.expectedRevision);
      const origins = new Set(
        [...state.app.origins, state.app.url].map((value) => new URL(value).origin),
      );
      if (!origins.has(url.origin))
        fail(
          "APP_NOTIFICATION_INVALID",
          "Notification endpoint must use a registered application origin",
        );
      if (input.enabled && !state.endpoint?.active_key_id)
        fail(
          "APP_NOTIFICATION_KEY_REQUIRED",
          "Install and activate a signing key before enabling delivery",
        );
      const now = await readPostLockDatabaseNow(tx);
      const [saved] = state.endpoint
        ? await tx
            .update(appBillingNotificationEndpoints)
            .set({
              endpoint_url: url.toString(),
              enabled: input.enabled,
              revision: state.endpoint.revision + 1,
              updated_at: now,
            })
            .where(eq(appBillingNotificationEndpoints.id, state.endpoint.id))
            .returning()
        : await tx
            .insert(appBillingNotificationEndpoints)
            .values({
              app_id: input.appId,
              organization_id: input.organizationId,
              livemode: state.client.billing_environment === "live",
              endpoint_url: url.toString(),
              enabled: false,
            })
            .returning();
      if (!saved)
        fail("APP_NOTIFICATION_UNAVAILABLE", "Notification configuration was not persisted");
      return config(tx, input.appId, saved.livemode, saved);
    });
  }
  async prepareKey(input: NotificationOwner & { expectedRevision: string | null }) {
    // Encryption may initialize the organization's key outside the config transaction.
    // Only ciphertext enters the transactional endpoint record; a lost response requires rotation.
    const existing = await this.read(input);
    if (!existing.revision)
      fail("APP_NOTIFICATION_INVALID", "Configure an endpoint before preparing its signing key");
    const [endpoint] = await dbWrite
      .select()
      .from(appBillingNotificationEndpoints)
      .where(
        and(
          eq(appBillingNotificationEndpoints.app_id, input.appId),
          eq(appBillingNotificationEndpoints.livemode, existing.environment === "live"),
        ),
      );
    if (!endpoint) fail("APP_NOTIFICATION_UNAVAILABLE", "Notification endpoint is unavailable");
    const secret = `ens_${randomBytes(32).toString("base64url")}`;
    const encrypted = await fieldEncryption.encrypt(
      input.organizationId,
      secret,
      coords(endpoint.id),
    );
    const result = await writeTransaction(async (tx) => {
      const state = await owner(tx, input);
      revision(state.endpoint, input.expectedRevision);
      if (!state.endpoint || state.endpoint.id !== endpoint.id)
        fail("APP_NOTIFICATION_CONFLICT", "Notification endpoint changed during key preparation");
      const [saved] = await tx
        .update(appBillingNotificationEndpoints)
        .set({
          pending_key_id: randomUUID(),
          pending_secret: encrypted,
          revision: state.endpoint.revision + 1,
          updated_at: await readPostLockDatabaseNow(tx),
        })
        .where(eq(appBillingNotificationEndpoints.id, endpoint.id))
        .returning();
      if (!saved) fail("APP_NOTIFICATION_UNAVAILABLE", "Notification key was not persisted");
      return config(tx, input.appId, saved.livemode, saved);
    });
    return { config: result, signingSecret: secret };
  }
  async activateKey(
    input: NotificationOwner & { expectedRevision: string | null; pendingKeyId: string },
  ) {
    return writeTransaction(async (tx) => {
      const state = await owner(tx, input);
      revision(state.endpoint, input.expectedRevision);
      if (
        !state.endpoint ||
        state.endpoint.pending_key_id !== input.pendingKeyId ||
        !state.endpoint.pending_secret
      )
        fail("APP_NOTIFICATION_CONFLICT", "The prepared signing key is no longer current");
      const [saved] = await tx
        .update(appBillingNotificationEndpoints)
        .set({
          active_key_id: state.endpoint.pending_key_id,
          active_secret: state.endpoint.pending_secret,
          pending_key_id: null,
          pending_secret: null,
          revision: state.endpoint.revision + 1,
          updated_at: await readPostLockDatabaseNow(tx),
        })
        .where(eq(appBillingNotificationEndpoints.id, state.endpoint.id))
        .returning();
      if (!saved) fail("APP_NOTIFICATION_UNAVAILABLE", "Signing key activation was not persisted");
      return config(tx, input.appId, saved.livemode, saved);
    });
  }
  async claim() {
    const [candidate] = await dbWrite
      .select({ id: appSubscriptionOutbox.id, scopeId: appSubscriptionOutbox.billing_scope_id })
      .from(appSubscriptionOutbox)
      .innerJoin(appBillingScopes, eq(appBillingScopes.id, appSubscriptionOutbox.billing_scope_id))
      .innerJoin(
        appBillingNotificationEndpoints,
        and(
          eq(appBillingNotificationEndpoints.app_id, appBillingScopes.app_id),
          eq(appBillingNotificationEndpoints.livemode, appBillingScopes.livemode),
          eq(appBillingNotificationEndpoints.organization_id, appBillingScopes.organization_id),
        ),
      )
      .where(
        and(
          eq(appBillingNotificationEndpoints.enabled, true),
          lte(appSubscriptionOutbox.next_attempt_at, sql`clock_timestamp()`),
          or(
            eq(appSubscriptionOutbox.state, "pending"),
            and(
              eq(appSubscriptionOutbox.state, "processing"),
              lte(appSubscriptionOutbox.lease_expires_at, sql`clock_timestamp()`),
            ),
          ),
        ),
      )
      .orderBy(asc(appSubscriptionOutbox.next_attempt_at), asc(appSubscriptionOutbox.id))
      .limit(1);
    if (!candidate) return null;
    return writeTransaction(async (tx) => {
      const scope = await lockAppBillingScope(tx, candidate.scopeId, true);
      const [row] = await tx
        .select()
        .from(appSubscriptionOutbox)
        .where(eq(appSubscriptionOutbox.id, candidate.id))
        .for("update", { skipLocked: true });
      const now = await readPostLockDatabaseNow(tx);
      if (
        !row ||
        row.next_attempt_at > now ||
        !["pending", "processing"].includes(row.state) ||
        (row.lease_expires_at && row.lease_expires_at > now)
      )
        return null;
      const [endpoint] = await tx
        .select()
        .from(appBillingNotificationEndpoints)
        .where(
          and(
            eq(appBillingNotificationEndpoints.app_id, scope.appId),
            eq(appBillingNotificationEndpoints.organization_id, scope.organizationId),
            eq(appBillingNotificationEndpoints.livemode, scope.livemode),
          ),
        );
      if (!endpoint?.enabled || !endpoint.active_key_id || !endpoint.active_secret) {
        await tx
          .update(appSubscriptionOutbox)
          .set({
            state: "pending",
            lease_token: null,
            lease_expires_at: null,
            next_attempt_at: new Date(now.getTime() + 60_000),
            error_code: "APP_NOTIFICATION_DISABLED",
          })
          .where(eq(appSubscriptionOutbox.id, row.id));
        return null;
      }
      const token = randomUUID();
      const [claimed] = await tx
        .update(appSubscriptionOutbox)
        .set({
          state: "processing",
          attempts: row.attempts + 1,
          lease_token: token,
          lease_expires_at: new Date(now.getTime() + 60_000),
          endpoint_revision: endpoint.revision,
          error_code: null,
        })
        .where(eq(appSubscriptionOutbox.id, row.id))
        .returning();
      if (!claimed)
        fail("APP_NOTIFICATION_UNAVAILABLE", "Notification delivery lease was not persisted");
      const envelope: AppBillingNotification = {
        version: 1,
        id: row.id,
        event: "app.subscription.updated",
        appId: scope.appId,
        environment: scope.livemode ? "live" : "test",
        billingAccountId: scope.billingAccountId,
        productFamilyKey: scope.productFamilyKey,
        subscriptionRevision: String(row.subscription_revision),
        occurredAt: row.created_at.toISOString(),
      };
      return { row: claimed, endpoint, envelope };
    });
  }
  async finish(
    claim: NonNullable<Awaited<ReturnType<AppBillingNotifications["claim"]>>>,
    errorCode: string | null,
  ) {
    const [result] = await dbWrite
      .update(appSubscriptionOutbox)
      .set({
        state: errorCode ? "pending" : "delivered",
        delivered_at: errorCode ? null : sql`clock_timestamp()`,
        lease_token: null,
        lease_expires_at: null,
        error_code: errorCode,
        next_attempt_at: sql`clock_timestamp()+(${Math.min(3600, 2 ** claim.row.attempts)} * interval '1 second')`,
      })
      .where(
        and(
          eq(appSubscriptionOutbox.id, claim.row.id),
          eq(appSubscriptionOutbox.state, "processing"),
          eq(appSubscriptionOutbox.lease_token, claim.row.lease_token!),
          sql`${appSubscriptionOutbox.lease_expires_at}>clock_timestamp()`,
        ),
      )
      .returning({ id: appSubscriptionOutbox.id });
    return result ? (errorCode ? "retried" : "delivered") : "stale";
  }
  async deliver(claim: NonNullable<Awaited<ReturnType<AppBillingNotifications["claim"]>>>) {
    let errorCode: string | null = null;
    try {
      const [lease] = await dbWrite
        .select({ id: appSubscriptionOutbox.id })
        .from(appSubscriptionOutbox)
        .where(
          and(
            eq(appSubscriptionOutbox.id, claim.row.id),
            eq(appSubscriptionOutbox.state, "processing"),
            eq(appSubscriptionOutbox.lease_token, claim.row.lease_token!),
            sql`${appSubscriptionOutbox.lease_expires_at}>clock_timestamp()`,
          ),
        );
      if (!lease) return "stale" as const;
      const [current] = await dbWrite
        .select()
        .from(appBillingNotificationEndpoints)
        .where(
          and(
            eq(appBillingNotificationEndpoints.id, claim.endpoint.id),
            eq(appBillingNotificationEndpoints.revision, claim.endpoint.revision),
            eq(appBillingNotificationEndpoints.enabled, true),
          ),
        );
      if (!current || !current.active_secret)
        fail(
          "APP_NOTIFICATION_CONFIG_CHANGED",
          "Notification target or key changed before dispatch",
        );
      const secret = await fieldEncryption.decrypt(current.active_secret!, coords(current.id));
      const timestamp = new Date().toISOString(),
        body = JSON.stringify(claim.envelope);
      const response = await this.transport(current.endpoint_url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Event": claim.envelope.event,
          "X-Eliza-Timestamp": timestamp,
          "X-Eliza-Delivery": claim.envelope.id,
          "X-Eliza-Key-Id": current.active_key_id!,
          "X-Eliza-Signature": await createAppNotificationSignature(secret, timestamp, body),
        },
        body,
      });
      await response.body?.cancel();
      if (!response.ok)
        fail("APP_NOTIFICATION_HTTP_FAILED", "Application did not acknowledge the notification");
    } catch (error) {
      // error-policy:J4 Delivery remains durable and visibly pending for retry; no billing mutation is rolled back.
      errorCode = error instanceof ElizaError ? error.code : "APP_NOTIFICATION_TRANSPORT_FAILED";
    }
    return this.finish(claim, errorCode);
  }
  async drain(limit = 25) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail("APP_NOTIFICATION_INVALID", "Delivery batch must contain 1 to 100 records");
    const result = { delivered: 0, retried: 0, stale: 0 };
    for (let index = 0; index < limit; index++) {
      const claim = await this.claim();
      if (!claim) break;
      result[await this.deliver(claim)]++;
    }
    return result;
  }
}
export const appBillingNotifications = new AppBillingNotifications();
