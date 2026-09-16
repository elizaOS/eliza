import { eq, inArray } from "drizzle-orm";
import { requireLoginValue } from "../../../required";
import type {
  AgentIdentity,
  PolicyRule,
  SignRequest,
  TxRecord,
} from "../../shared/src/index.ts";

export {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  sql,
} from "drizzle-orm";
// `isNull`, `isNotNull`, `gt`, `or` live on the `/sql` subpath because
// drizzle-orm@0.44 does not re-export them from the package root in a way
// that bun's test loader resolves (works at runtime via the cjs fallback,
// fails under `bun test` with "Export named 'isNull' not found").
export { gt, isNotNull, isNull, or } from "drizzle-orm/sql";
export {
  __resetAuditHmacKeyCacheForTests,
  type ActorType as AuditActorType,
  type AppendRequiredAudit,
  type AuditEventInput,
  type AuditTxLike,
  appendAuditEvent,
  appendAuditEventWithinTx,
  redactWebhookSecrets,
  withTenantAuditedTransaction,
  withTenantAuditedTransactionOnDb,
  withTenantAuditQueue,
  writeAuditEvent,
} from "./audit-chain";
export type { DatabaseDriver, NeonTransactionDbHandle } from "./client";
export {
  closeDb,
  createDb,
  createDbForRequest,
  createNeonHttpDb,
  createNeonTransactionDbForRequest,
  createPostgresClient,
  DATABASE_DEADLINE_EXCEEDED_MESSAGE,
  DatabaseDeadlineExceededError,
  getDatabaseDriver,
  getDatabaseUrl,
  getDb,
  getSql,
  hasTenantTransactionDatabase,
  setPGLiteOverride,
  waitUntilRequestDatabaseTask,
  withDatabaseDeadline,
  withRequestDatabase,
  withTenantTransactionDatabase,
} from "./client";
export { runMigrations } from "./migrate";
export {
  assessMigrationLedger,
  getMigrationExpectation,
  getMigrationLedgerExpectation,
  type MigrationExpectation,
  type MigrationLedgerEntry,
  type MigrationLedgerExpectation,
  type MigrationLedgerReadiness,
} from "./migration-status";
export {
  ALL_INVENTORIED_TABLES,
  BOOTSTRAP_ROOT_TABLES,
  DIRECT_TENANT_TABLES,
  HYBRID_SCOPE_TABLES,
  INDIRECT_TENANT_TABLES,
  INTENTIONALLY_GLOBAL_TABLES,
  TENANT_COLUMN_BACKFILL_TABLES,
} from "./rls-inventory";
// PGLite exports live in the `@stwd/db/pglite` subpath so Cloudflare Worker
// bundles can import `@stwd/db` without pulling node:fs/node:path dependencies.
export * from "./schema";
export * from "./schema-auth";
export {
  assertTenantRlsDriver,
  type TenantRlsDriver,
  type TenantTransactionCharacteristics,
  type TrustedTenantContext,
  tenantContextForInternalJob,
  tenantContextFromAuthenticatedPrincipal,
  withTenantRlsTransaction,
} from "./tenant-rls-context";

import type { Agent, Policy, Transaction } from "./schema";
import { policyTypeEnum } from "./schema";

export type DbAgentIdentity = AgentIdentity & {
  tenantId: string;
  updatedAt: Date;
};

export type DbPolicyRule = PolicyRule & {
  agentId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PersistedPolicyType = (typeof policyTypeEnum.enumValues)[number];
export type PersistedPolicyRule = Omit<PolicyRule, "type"> & {
  type: PersistedPolicyType;
};

export type TransactionRequestFields = Pick<
  Transaction,
  "toAddress" | "value" | "data" | "chainId"
>;

export type DbTxRecord = TxRecord;

export function isPersistedPolicyType(
  value: string,
): value is PersistedPolicyType {
  return (policyTypeEnum.enumValues as readonly string[]).includes(value);
}

export function toPersistedPolicyRule(policy: PolicyRule): PersistedPolicyRule {
  if (!isPersistedPolicyType(policy.type)) {
    throw new Error(`Unsupported persisted policy type: ${policy.type}`);
  }
  return policy;
}

export function toAgentIdentity(agent: Agent): DbAgentIdentity {
  return {
    id: agent.id,
    tenantId: agent.tenantId,
    name: agent.name,
    walletAddress: agent.walletAddress,
    platformId: agent.platformId ?? undefined,
    erc8004TokenId: agent.erc8004TokenId ?? undefined,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

/**
 * Query all wallet addresses for a single agent from the `agent_wallets` table.
 * Returns an empty object for legacy agents that pre-date multi-wallet support.
 */
export async function getAgentWalletAddresses(agentId: string): Promise<{
  evm?: string;
  solana?: string;
  bitcoin?: string;
  monero?: string;
}> {
  const { getDb } = await import("./client");
  const { agentWallets } = await import("./schema");
  const db = getDb();
  const rows = await db
    .select()
    .from(agentWallets)
    .where(eq(agentWallets.agentId, agentId));

  const result: {
    evm?: string;
    solana?: string;
    bitcoin?: string;
    monero?: string;
  } = {};
  for (const row of rows) {
    if (row.chainFamily === "evm") result.evm = row.address;
    if (row.chainFamily === "solana") result.solana = row.address;
    if (row.chainFamily === "bitcoin") result.bitcoin = row.address;
    if (row.chainFamily === "monero") result.monero = row.address;
  }
  return result;
}

/**
 * Query wallet addresses for multiple agents in a single DB round-trip.
 * Returns a Map from agentId → { evm?, solana?, bitcoin?, monero? }.
 */
export async function getAgentWalletAddressesBatch(
  agentIds: string[],
): Promise<
  Map<
    string,
    { evm?: string; solana?: string; bitcoin?: string; monero?: string }
  >
> {
  if (agentIds.length === 0) return new Map();

  const { getDb } = await import("./client");
  const { agentWallets } = await import("./schema");
  const db = getDb();
  const rows = await db
    .select()
    .from(agentWallets)
    .where(inArray(agentWallets.agentId, agentIds));

  const result = new Map<
    string,
    { evm?: string; solana?: string; bitcoin?: string; monero?: string }
  >();
  for (const row of rows) {
    if (!result.has(row.agentId)) result.set(row.agentId, {});
    const entry = requireLoginValue(
      result.get(row.agentId),
      "result.get(row.agentId)",
    );
    if (row.chainFamily === "evm") entry.evm = row.address;
    if (row.chainFamily === "solana") entry.solana = row.address;
    if (row.chainFamily === "bitcoin") entry.bitcoin = row.address;
    if (row.chainFamily === "monero") entry.monero = row.address;
  }
  return result;
}

export function toPolicyRule(policy: Policy): DbPolicyRule {
  return {
    id: policy.id,
    agentId: policy.agentId,
    type: policy.type,
    enabled: policy.enabled,
    config: policy.config,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

export function toSignRequest(transaction: Transaction): SignRequest {
  return {
    agentId: transaction.agentId,
    tenantId: "",
    to: transaction.toAddress,
    value: transaction.value,
    data: transaction.data ?? undefined,
    chainId: transaction.chainId,
  };
}

export function toTxRecord(transaction: Transaction): DbTxRecord {
  return {
    id: transaction.id,
    agentId: transaction.agentId,
    status: transaction.status,
    request: toSignRequest(transaction),
    txHash: transaction.txHash ?? undefined,
    policyResults: transaction.policyResults ?? [],
    createdAt: transaction.createdAt,
    signedAt: transaction.signedAt ?? undefined,
    confirmedAt: transaction.confirmedAt ?? undefined,
  };
}
