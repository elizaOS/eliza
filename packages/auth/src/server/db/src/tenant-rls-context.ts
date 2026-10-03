import { is, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { containsAsciiControl } from "../../shared/src/text-boundaries";

declare const trustedTenantContextBrand: unique symbol;
const trustedTenantContexts = new WeakSet<object>();
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const AUTHORITY_METHOD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type TenantRlsDriver =
  | "postgres-js"
  | "pglite"
  | "neon-http"
  | "neon-websocket";

/**
 * An application-internal capability minted only after authentication or by a
 * named background job. Request headers and body fields are not valid inputs to
 * the transaction helper.
 */
export interface TrustedTenantContext {
  readonly tenantId: string;
  readonly userId?: string;
  readonly authority:
    | {
        readonly kind: "authenticated-principal";
        readonly method: string;
        readonly subject: string;
      }
    | { readonly kind: "internal-job"; readonly job: string };
  readonly [trustedTenantContextBrand]: true;
}

function assertTenantId(tenantId: string): void {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new Error("RLS_TENANT_CONTEXT_INVALID");
  }
}

export function tenantContextFromAuthenticatedPrincipal(input: {
  tenantId: string;
  method: string;
  subject: string;
  userId?: string;
}): TrustedTenantContext {
  assertTenantId(input.tenantId);
  if (
    !AUTHORITY_METHOD_PATTERN.test(input.method) ||
    input.subject.length === 0 ||
    input.subject.length > 255 ||
    containsAsciiControl(input.subject)
  )
    throw new Error("RLS_TENANT_AUTHORITY_INVALID");
  if (
    input.userId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.userId,
    )
  ) {
    throw new Error("RLS_USER_CONTEXT_INVALID");
  }
  const context = Object.freeze({
    tenantId: input.tenantId,
    ...(input.userId ? { userId: input.userId } : {}),
    authority: Object.freeze({
      kind: "authenticated-principal" as const,
      method: input.method,
      subject: input.subject,
    }),
  }) as TrustedTenantContext;
  trustedTenantContexts.add(context);
  return context;
}

export function tenantContextForInternalJob(input: {
  tenantId: string;
  job: string;
}): TrustedTenantContext {
  assertTenantId(input.tenantId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.job)) {
    throw new Error("RLS_TENANT_JOB_INVALID");
  }
  const context = Object.freeze({
    tenantId: input.tenantId,
    authority: Object.freeze({ kind: "internal-job" as const, job: input.job }),
  }) as TrustedTenantContext;
  trustedTenantContexts.add(context);
  return context;
}

export function assertTenantRlsDriver(driver: TenantRlsDriver): void {
  if (driver === "neon-http") {
    throw new Error(
      "RLS_TRANSACTION_UNSUPPORTED: neon-http has no callback transactions; use a transaction-capable Workers database transport",
    );
  }
}

interface TenantTransactionExecutor {
  execute(query: unknown): Promise<unknown>;
}

interface TenantTransactionalDatabase<Tx extends TenantTransactionExecutor> {
  transaction<T>(callback: (tx: Tx) => Promise<T>): Promise<T>;
}

export interface TenantTransactionCharacteristics {
  isolationLevel?: "repeatable read";
  readOnly?: boolean;
}

function hasTrustedBrand(context: unknown): context is TrustedTenantContext {
  return (
    typeof context === "object" &&
    context !== null &&
    trustedTenantContexts.has(context)
  );
}

function rowsOf(result: unknown): unknown[] {
  return Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] } | null)?.rows ?? []);
}

function contextSettings(result: unknown): {
  tenantId: unknown;
  userId: unknown;
} {
  const row = rowsOf(result)[0] as
    | { tenant_id?: unknown; user_id?: unknown }
    | undefined;
  return { tenantId: row?.tenant_id, userId: row?.user_id };
}

/**
 * Run one tenant unit of work on one checked-out connection. `set_config(...,
 * true)` is transaction-local, so commit, rollback, and pool reuse clear the
 * context. Never replace this with session-level SET on a pooled connection.
 */
export async function withTenantRlsTransaction<
  Tx extends TenantTransactionExecutor,
  T,
>(
  db: TenantTransactionalDatabase<Tx>,
  driver: TenantRlsDriver,
  context: TrustedTenantContext,
  callback: (tx: Tx) => Promise<T>,
  characteristics?: TenantTransactionCharacteristics,
): Promise<T> {
  assertTenantRlsDriver(driver);
  if (!hasTrustedBrand(context))
    throw new Error("RLS_TENANT_CONTEXT_UNTRUSTED");
  assertTenantId(context.tenantId);
  // Calling `.transaction()` on a Drizzle PgTransaction opens a savepoint,
  // not an independent transaction. SET LOCAL would then survive the helper
  // callback until the unknown outer transaction ends.
  if (is(db, PgTransaction)) throw new Error("RLS_TENANT_TRANSACTION_NESTED");

  const outcome = await db.transaction(async (tx) => {
    if (
      driver !== "pglite" &&
      characteristics?.isolationLevel === "repeatable read"
    ) {
      await tx.execute(
        characteristics.readOnly
          ? sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
          : sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
      );
    }
    // A non-empty value here means this connection carries a session-level
    // setting or the helper was nested inside another tenant transaction.
    // Overwriting either would conceal a lifecycle bug and could restore the
    // stale session value after commit, so reject before exposing the tx.
    const prior = await tx.execute(sql`
      SELECT
        NULLIF(current_setting('steward.tenant_id', true), '') AS tenant_id,
        NULLIF(current_setting('steward.user_id', true), '') AS user_id
    `);
    const priorContext = contextSettings(prior);
    if (priorContext.tenantId != null || priorContext.userId != null) {
      // Clear the session-scoped contamination and commit that cleanup before
      // reporting the error. Throwing inside this transaction would roll the
      // reset back and return a still-dangerous connection to the pool.
      await tx.execute(sql`SELECT set_config('steward.tenant_id', '', false)`);
      await tx.execute(sql`SELECT set_config('steward.user_id', '', false)`);
      const cleared = await tx.execute(sql`
        SELECT
          NULLIF(current_setting('steward.tenant_id', true), '') AS tenant_id,
          NULLIF(current_setting('steward.user_id', true), '') AS user_id
      `);
      const clearedContext = contextSettings(cleared);
      if (clearedContext.tenantId != null || clearedContext.userId != null) {
        throw new Error("RLS_TENANT_CONTEXT_CLEAR_FAILED");
      }
      return { kind: "dirty" as const };
    }

    await tx.execute(
      sql`SELECT set_config('steward.tenant_id', ${context.tenantId}, true)`,
    );
    await tx.execute(
      sql`SELECT set_config('steward.user_id', ${context.userId ?? ""}, true)`,
    );
    const result = await tx.execute(sql`
      SELECT
        current_setting('steward.tenant_id', true) AS tenant_id,
        NULLIF(current_setting('steward.user_id', true), '') AS user_id
    `);
    const boundContext = contextSettings(result);
    if (
      boundContext.tenantId !== context.tenantId ||
      (boundContext.userId ?? undefined) !== context.userId
    )
      throw new Error("RLS_TENANT_CONTEXT_NOT_BOUND");
    return { kind: "ok" as const, value: await callback(tx) };
  });
  if (outcome.kind === "dirty") throw new Error("RLS_TENANT_CONTEXT_DIRTY");
  return outcome.value;
}
