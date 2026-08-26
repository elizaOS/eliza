/**
 * Protected, idempotent repair for the first-party mobile App Auth registration.
 *
 * The command intentionally reports invariant names only. Database URLs, row
 * identifiers, and user-controlled values never cross the CLI boundary.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  MOBILE_APP_AUTH_REDIRECT_ORIGIN,
  MOBILE_APP_AUTH_REDIRECT_URI,
  mobileAppAuthDatabaseConnection,
  requireMobileAppAuthAppId,
  verifyDatabaseMobileAppAuthRegistration,
} from "./verify-mobile-app-auth-registration.ts";

const { Client } = pg;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Operation = "diagnose" | "repair";

class RegistrationRepairError extends Error {
  override readonly name = "RegistrationRepairError";
}

function fail(invariant: string): never {
  throw new RegistrationRepairError(invariant);
}

function requireUuid(value: unknown, invariant: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(invariant);
  return value;
}

function optionalUuid(value: unknown, invariant: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  return requireUuid(value, invariant);
}

export function databaseFailureInvariant(error: unknown): string {
  if (typeof error !== "object" || error === null) return "database.unknown";
  const code = "code" in error ? String(error.code) : "unknown";
  const safeCodes = new Set([
    "23503", // foreign_key_violation
    "23505", // unique_violation
    "25P02", // failed transaction
    "40001", // serialization_failure
    "42703", // undefined_column
    "42P01", // undefined_table
    "42883", // undefined_function/operator
  ]);
  return `database.${safeCodes.has(code) ? code : "connection_or_query"}`;
}

export const REQUIRED_REGISTRATION_TABLES = [
  "apps",
  "organizations",
  "users",
  "api_keys",
] as const;

export function missingRegistrationTableInvariant(
  table: (typeof REQUIRED_REGISTRATION_TABLES)[number],
): string {
  return `schema.missing_${table}`;
}

export async function diagnoseRequiredRegistrationSchema(
  databaseUrl: string,
): Promise<void> {
  const { url, ssl } = mobileAppAuthDatabaseConnection(databaseUrl);
  const client = new Client({ connectionString: url, ...(ssl ? { ssl } : {}) });
  try {
    await client.connect();
    for (const table of REQUIRED_REGISTRATION_TABLES) {
      const result = await client.query<{ exists: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS exists",
        [`public.${table}`],
      );
      if (result.rows[0]?.exists !== true) {
        fail(missingRegistrationTableInvariant(table));
      }
    }
  } catch (error) {
    if (error instanceof RegistrationRepairError) throw error;
    fail(databaseFailureInvariant(error));
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function diagnose(
  databaseUrl: string,
  appId: string,
  verify: typeof verifyDatabaseMobileAppAuthRegistration = verifyDatabaseMobileAppAuthRegistration,
): Promise<void> {
  try {
    await verify(databaseUrl, appId);
    console.log("[MobileAppAuthRegistration] valid");
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    const invariant = cause
      ? databaseFailureInvariant(cause)
      : error instanceof Error
        ? error.message
        : "registration.unknown";
    fail(invariant);
  }
}

export interface RegistrationRepairClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export async function repairRegistrationTransaction(
  client: RegistrationRepairClient,
  appId: string,
  protectedOrganizationId?: string,
  protectedOwnerUserId?: string,
): Promise<void> {
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "eliza-mobile-app-auth-registration",
    ]);

    const existing = await client.query<{
      organization_id: string;
      created_by_user_id: string;
      api_key_id: string | null;
    }>(
      `SELECT organization_id::text, created_by_user_id::text, api_key_id::text
         FROM apps WHERE id = $1::uuid FOR UPDATE`,
      [appId],
    );
    const current = existing.rows[0];
    if (
      current &&
      ((protectedOrganizationId &&
        current.organization_id !== protectedOrganizationId) ||
        (protectedOwnerUserId &&
          current.created_by_user_id !== protectedOwnerUserId))
    ) {
      fail("registration.explicit_ownership_match");
    }
    const organizationId = current?.organization_id ?? protectedOrganizationId;
    const ownerUserId = current?.created_by_user_id ?? protectedOwnerUserId;
    if (!organizationId) fail("input.organization_id_for_creation");
    if (!ownerUserId) fail("input.owner_user_id_for_creation");

    const authority = await client.query<{
      organization_active: boolean;
      owner_active: boolean;
      owner_matches_organization: boolean;
      owner_role: string | null;
    }>(
      `SELECT COALESCE(org.is_active, FALSE) AS organization_active,
              COALESCE(owner.is_active AND owner.deleted_at IS NULL, FALSE) AS owner_active,
              COALESCE(owner.organization_id = org.id, FALSE) AS owner_matches_organization,
              owner.role AS owner_role
         FROM organizations AS org
         LEFT JOIN users AS owner ON owner.id = $2::uuid
        WHERE org.id = $1::uuid
        LIMIT 1`,
      [organizationId, ownerUserId],
    );
    const authorityRow = authority.rows[0];
    if (!authorityRow?.organization_active)
      fail("authority.organization_active");
    if (!authorityRow.owner_active) fail("authority.owner_active");
    if (!authorityRow.owner_matches_organization)
      fail("authority.same_organization");
    if (
      authorityRow.owner_role !== "owner" &&
      authorityRow.owner_role !== "admin"
    ) {
      fail("authority.owner_or_admin");
    }

    const duplicate = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count
         FROM apps
        WHERE id <> $1::uuid
          AND is_active = TRUE
          AND is_approved = TRUE
          AND allowed_origins @> jsonb_build_array($2::text)`,
      [appId, MOBILE_APP_AUTH_REDIRECT_URI],
    );
    if (duplicate.rows[0]?.count !== 0)
      fail("registration.unique_callback_owner");

    const apiKeyId = current?.api_key_id ?? randomUUID();
    if (current?.api_key_id) {
      const key = await client.query<{
        organization_id: string;
        user_id: string;
      }>(
        `SELECT organization_id::text, user_id::text
           FROM api_keys WHERE id = $1::uuid FOR UPDATE`,
        [current.api_key_id],
      );
      const keyRow = key.rows[0];
      if (
        keyRow &&
        (keyRow.organization_id !== organizationId ||
          keyRow.user_id !== ownerUserId)
      ) {
        fail("registration.generated_key_ownership");
      }
      if (keyRow) {
        await client.query(
          `UPDATE api_keys
              SET is_active = FALSE, deleted_at = COALESCE(deleted_at, NOW())
            WHERE id = $1::uuid`,
          [current.api_key_id],
        );
      }
    }

    if (current) {
      await client.query(
        `UPDATE apps
            SET app_url = $2,
                allowed_origins = jsonb_build_array($3::text),
                is_active = TRUE,
                is_approved = TRUE,
                api_key_id = $4::uuid,
                updated_at = NOW()
          WHERE id = $1::uuid`,
        [
          appId,
          MOBILE_APP_AUTH_REDIRECT_ORIGIN,
          MOBILE_APP_AUTH_REDIRECT_URI,
          apiKeyId,
        ],
      );
    } else {
      await client.query(
        `INSERT INTO apps
           (id, name, description, slug, organization_id, created_by_user_id,
            app_url, allowed_origins, api_key_id, is_active, is_approved)
         VALUES
           ($1::uuid, 'Eliza Mobile', 'First-party Eliza mobile authentication client',
            $2, $3::uuid, $4::uuid, $5, jsonb_build_array($6::text),
            $7::uuid, TRUE, TRUE)`,
        [
          appId,
          `eliza-mobile-auth-${appId.slice(0, 8)}`,
          organizationId,
          ownerUserId,
          MOBILE_APP_AUTH_REDIRECT_ORIGIN,
          MOBILE_APP_AUTH_REDIRECT_URI,
          apiKeyId,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof RegistrationRepairError) throw error;
    fail(databaseFailureInvariant(error));
  }
}

async function repair(
  databaseUrl: string,
  appId: string,
  organizationId?: string,
  ownerUserId?: string,
): Promise<void> {
  const { url, ssl } = mobileAppAuthDatabaseConnection(databaseUrl);
  const client = new Client({ connectionString: url, ...(ssl ? { ssl } : {}) });
  try {
    await client.connect();
    await repairRegistrationTransaction(
      client,
      appId,
      organizationId,
      ownerUserId,
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  await diagnose(databaseUrl, appId);
  console.log("[MobileAppAuthRegistration] repaired_and_verified");
}

function parseOperation(value: string | undefined): Operation {
  if (value === "diagnose" || value === "repair") return value;
  return fail("input.operation");
}

async function main(): Promise<void> {
  const operation = parseOperation(process.argv[2]);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("input.database_url");
  const appId = requireMobileAppAuthAppId(
    process.env.ELIZA_MOBILE_APP_AUTH_APP_ID,
  );
  if (operation === "diagnose") {
    await diagnoseRequiredRegistrationSchema(databaseUrl);
    return await diagnose(databaseUrl, appId);
  }
  const organizationId = optionalUuid(
    process.env.ELIZA_MOBILE_APP_AUTH_ORGANIZATION_ID,
    "input.organization_id",
  );
  const ownerUserId = optionalUuid(
    process.env.ELIZA_MOBILE_APP_AUTH_OWNER_USER_ID,
    "input.owner_user_id",
  );
  await repair(databaseUrl, appId, organizationId, ownerUserId);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const invariant =
      error instanceof RegistrationRepairError
        ? error.message
        : "registration.unexpected";
    console.error(`[MobileAppAuthRegistration] failed invariant=${invariant}`);
    process.exitCode = 1;
  });
}
