/** Reads paginated pending schedule commands and their current-source relationship from one primary snapshot, without claiming provider completion. */
import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { PendingSubscriptionCommandsDto } from "../../lib/types/cloud-api";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import {
  billingSubscriptions,
  organizationSubscriptionAuthorities,
} from "../schemas/billing-subscriptions";
import { organizations } from "../schemas/organizations";
import { billingSubscriptionCommands as commands } from "../schemas/subscription-billing-operations";
import { users } from "../schemas/users";

const cursorSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.string().uuid(),
    createdAt: z.string().datetime({ precision: 6 }),
    id: z.string().uuid(),
  })
  .strict();
function invalidCursor(): never {
  throw new ElizaError("Use the next cursor returned for this organization", {
    code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID",
  });
}
function decodeCursor(value: string | undefined, organizationId: string) {
  if (value === undefined) return null;
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) invalidCursor();
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    // error-policy:J3 A malformed cursor is an explicit invalid request, never a restarted page.
    throw new ElizaError("Invalid subscription command cursor", {
      code: "SUBSCRIPTION_COMMAND_CURSOR_INVALID",
      cause: error,
    });
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success || result.data.organizationId !== organizationId) invalidCursor();
  return result.data;
}
function forbidden(): never {
  throw new ElizaError("Current organization billing manager access is required", {
    code: "SUBSCRIPTION_CANCELLATION_FORBIDDEN",
  });
}
export async function readPendingSubscriptionCommands(input: {
  organizationId: string;
  actorId: string;
  limit: number;
  cursor?: string;
}): Promise<PendingSubscriptionCommandsDto> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new ElizaError("Page limit must be an integer from 1 to 100", {
      code: "SUBSCRIPTION_COMMAND_PAGE_INVALID",
    });
  const cursor = decodeCursor(input.cursor, input.organizationId);
  return dbWrite.transaction(
    async (tx) => {
      const [clock] = await sqlRows<{ observed_at: string }>(
        tx,
        sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at`,
      );
      if (!clock)
        throw new ElizaError("Primary database clock is unavailable", {
          code: "PRIMARY_DATABASE_CLOCK_UNAVAILABLE",
        });
      const [org] = await tx
        .select({
          active: organizations.is_active,
          state: organizations.account_lifecycle_state,
          deletion: organizations.account_deletion_request_id,
          fenced: organizations.paid_work_fenced_at,
        })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId));
      const [actor] = await tx
        .select({
          organizationId: users.organization_id,
          role: users.role,
          active: users.is_active,
          anonymous: users.is_anonymous,
          deleted: users.deleted_at,
          expired: sql<boolean>`${users.expires_at} IS NOT NULL AND ${users.expires_at} <= ${clock.observed_at}::timestamptz`,
        })
        .from(users)
        .where(eq(users.id, input.actorId));
      if (
        !org ||
        !org.active ||
        org.state !== "active" ||
        org.deletion !== null ||
        org.fenced !== null ||
        !actor ||
        actor.organizationId !== input.organizationId ||
        !actor.active ||
        actor.anonymous ||
        actor.deleted !== null ||
        actor.expired ||
        (actor.role !== "owner" && actor.role !== "admin")
      )
        forbidden();
      const [authority] = await tx
        .select()
        .from(organizationSubscriptionAuthorities)
        .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId));
      const [source] =
        authority?.state === "current" && authority.subscription_id !== null
          ? await tx
              .select({
                id: billingSubscriptions.id,
                revision: sql<string>`${billingSubscriptions.lifecycle_revision}::text`,
              })
              .from(billingSubscriptions)
              .where(
                and(
                  eq(billingSubscriptions.organization_id, input.organizationId),
                  eq(billingSubscriptions.id, authority.subscription_id),
                ),
              )
          : [];
      const rows = await tx
        .select({
          id: commands.id,
          subscriptionId: commands.subscription_id,
          kind: commands.kind,
          status: commands.status,
          expectedRevision: sql<string | null>`${commands.expected_subscription_revision}::text`,
          createdAt: sql<string>`to_char(${commands.created_at} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          lease: sql<
            "not_started" | "unleased" | "active" | "expired"
          >`CASE WHEN ${commands.status}='PREPARED' THEN 'not_started' WHEN ${commands.lease_expires_at} IS NULL THEN 'unleased' WHEN ${commands.lease_expires_at} <= ${clock.observed_at}::timestamptz THEN 'expired' ELSE 'active' END`,
        })
        .from(commands)
        .where(
          and(
            eq(commands.organization_id, input.organizationId),
            inArray(commands.kind, ["cancel", "resume"]),
            inArray(commands.status, ["PREPARED", "OUTCOME_UNKNOWN"]),
            cursor
              ? sql`(${commands.created_at},${commands.id}) < (${cursor.createdAt}::timestamptz,${cursor.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(desc(commands.created_at), desc(commands.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const items = page.map((row) => {
        if (
          row.subscriptionId === null ||
          row.expectedRevision === null ||
          (row.kind !== "cancel" && row.kind !== "resume") ||
          (row.status !== "PREPARED" && row.status !== "OUTCOME_UNKNOWN")
        )
          throw new ElizaError("Pending command authority is invalid", {
            code: "SUBSCRIPTION_COMMAND_STATE_UNAVAILABLE",
          });
        return {
          commandId: row.id,
          subscriptionId: row.subscriptionId,
          kind: row.kind,
          status: row.status,
          expectedSubscriptionRevision: row.expectedRevision,
          createdAt: row.createdAt,
          lease: row.lease,
          source: {
            state: source
              ? source.id === row.subscriptionId && source.revision === row.expectedRevision
                ? ("current" as const)
                : ("changed" as const)
              : authority?.state === "none"
                ? ("changed" as const)
                : ("unavailable" as const),
            currentSubscriptionRevision: source ? source.revision : null,
          },
        };
      });
      const last = page.at(-1);
      const nextCursor =
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                organizationId: input.organizationId,
                createdAt: last.createdAt,
                id: last.id,
              }),
            ).toString("base64url")
          : null;
      return { observedAt: clock.observed_at, items, nextCursor };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
