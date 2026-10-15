/** Blocks enrolled Durable Objects before a policy write, then publishes after COMMIT. */
import { ElizaError } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { sqlRows } from "../../db/execute-helpers";
import {
  dbWrite,
  registerAfterCommit,
  registerBeforeCommit,
  writeTransaction,
} from "../../db/helpers";
import type { RuntimeDurableObjectNamespace } from "../../types/cloud-worker-env";
import { getCloudAwareEnv, getCloudBinding } from "../runtime/cloud-bindings";

export class InferencePolicyFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferencePolicyFenceError";
  }
}

const transactionFences = new WeakMap<DbTransaction, Set<string>>();

interface MutationOptions {
  organizationIds: string[];
  mutationId?: string;
  /** Bootstrap also fences organizations that have not yet enrolled. */
  enable?: boolean;
  /** Internal rollback after every canonical escrow grant has closed. */
  disable?: boolean;
}

async function policyCall(
  organizationId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>("INFERENCE_ADMISSION_GATES");
  if (!namespace)
    throw new InferencePolicyFenceError("Inference policy Durable Object binding is missing");
  const response = await namespace.getByName(organizationId).fetch(
    new Request(`https://inference-admission.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!response.ok)
    throw new InferencePolicyFenceError("Inference policy publication was not acknowledged");
  return response.json();
}

interface MutationPermit {
  blocked: true;
  mutationId: string;
  fenceToken: string;
  validUntil: number;
  rateWindowEndsAt?: number;
}

async function beginPolicyMutation(
  organizationId: string,
  mutationId: string,
  disable = false,
): Promise<MutationPermit> {
  const result = await policyCall(organizationId, "/policy-mutation/begin", {
    organizationId,
    mutationId,
    disable,
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("blocked" in result) ||
    result.blocked !== true ||
    !("mutationId" in result) ||
    result.mutationId !== mutationId ||
    !("fenceToken" in result) ||
    typeof result.fenceToken !== "string" ||
    !("validUntil" in result) ||
    typeof result.validUntil !== "number" ||
    !Number.isFinite(result.validUntil) ||
    result.validUntil <= Date.now()
  )
    throw new InferencePolicyFenceError("Inference policy mutation permit is invalid");
  if (
    disable &&
    (!("rateWindowEndsAt" in result) ||
      typeof result.rateWindowEndsAt !== "number" ||
      !Number.isSafeInteger(result.rateWindowEndsAt))
  )
    throw new InferencePolicyFenceError("Inference rollback rate boundary is invalid");
  return result as MutationPermit;
}

async function rollbackIsReady(organizationId: string, permit: MutationPermit): Promise<boolean> {
  const result = await policyCall(organizationId, "/policy-mutation/disable-ready", {
    organizationId,
    mutationId: permit.mutationId,
    fenceToken: permit.fenceToken,
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("ready" in result) ||
    typeof result.ready !== "boolean"
  )
    throw new InferencePolicyFenceError("Inference rollback acknowledgement is invalid");
  return result.ready;
}

export async function readBudgetPolicyEpoch(
  tx: DbTransaction,
  organizationId: string,
): Promise<string | null> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true") return null;
  const [row] = await sqlRows<{ epoch: string }>(
    tx,
    sql`SELECT epoch::text AS epoch FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid AND enabled`,
  );
  return row?.epoch ?? null;
}

/** Recovery must take this lock before deciding a missing receipt means rollback. */
export async function lockInferencePolicyMutation(
  tx: DbTransaction,
  organizationId: string,
  mutationId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${mutationId}`}, 0))`,
  );
}

export async function withInferencePolicyMutation<T>(
  options: MutationOptions,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  return writeTransaction((tx) => withInferencePolicyMutationInTransaction(tx, options, fn));
}

export async function withInferencePolicyMutationInTransaction<T>(
  tx: DbTransaction,
  options: MutationOptions,
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true") {
    if (options.enable || options.disable)
      throw new InferencePolicyFenceError("Inference funded budget admission is disabled");
    return fn(tx);
  }
  if (options.enable && options.disable)
    throw new InferencePolicyFenceError("Policy enrollment and rollback cannot share one command");
  const active = transactionFences.get(tx) ?? new Set<string>();
  const organizationIds: string[] = [];
  for (const organizationId of [...new Set(options.organizationIds)].sort()) {
    if (active.has(organizationId)) {
      if (options.disable)
        throw new InferencePolicyFenceError("Rollback requires its own managed policy transaction");
      continue;
    }
    if (options.enable || (await readBudgetPolicyEpoch(tx, organizationId)) !== null)
      organizationIds.push(organizationId);
  }
  if (organizationIds.length === 0) return fn(tx);
  const mutationId = options.mutationId ?? crypto.randomUUID();
  const publications: Array<{ organizationId: string; fenceToken: string }> = [];
  // Registration verifies exact outer transaction ownership before any DO side effect.
  registerAfterCommit(tx, async () => {
    if (publications.length === 0) return;
    for (const publication of publications) {
      await policyCall(publication.organizationId, "/policy-mutation/commit", {
        ...publication,
        mutationId,
      });
      await dbWrite.execute(
        sql`UPDATE inference_policy_mutations SET phase = 'complete', updated_at = clock_timestamp() WHERE organization_id = ${publication.organizationId}::uuid AND mutation_id = ${mutationId} AND phase = 'applied'`,
      );
    }
  });
  for (const organizationId of organizationIds) {
    const result = await beginPolicyMutation(organizationId, mutationId, options.disable === true);
    if (options.disable && !(await rollbackIsReady(organizationId, result)))
      throw new InferencePolicyFenceError("Inference rollback rate window has not ended");
    await lockInferencePolicyMutation(tx, organizationId, mutationId);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inference-policy:${organizationId}`}, 0))`,
    );
    await tx.execute(
      sql`INSERT INTO inference_policy_authorities (organization_id) SELECT ${organizationId}::uuid WHERE NOT EXISTS (SELECT 1 FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid)`,
    );
    await tx.execute(
      sql`INSERT INTO inference_policy_mutations (organization_id, mutation_id, fence_token, permit_expires_at, applying_txid, phase) VALUES (${organizationId}::uuid, ${mutationId}, ${result.fenceToken}, ${new Date(result.validUntil)}, txid_current(), 'applying')`,
    );
    // The authority row serializes enrollment and epoch increments across concurrent commands.
    await tx.execute(
      sql`SELECT organization_id FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid FOR UPDATE`,
    );
    publications.push({ organizationId, fenceToken: result.fenceToken });
    active.add(organizationId);
    transactionFences.set(tx, active);
  }
  registerBeforeCommit(tx, async () => {
    for (const { organizationId } of publications) {
      await tx.execute(
        sql`UPDATE inference_policy_authorities SET enabled = ${!options.disable}, epoch = epoch + 1, updated_at = clock_timestamp() WHERE organization_id = ${organizationId}::uuid`,
      );
      await tx.execute(
        sql`UPDATE inference_policy_mutations SET phase = 'applied', epoch = (SELECT epoch FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid), updated_at = clock_timestamp() WHERE organization_id = ${organizationId}::uuid AND mutation_id = ${mutationId} AND applying_txid = txid_current() AND phase = 'applying'`,
      );
    }
  });
  return fn(tx);
}

/** An absent receipt is conclusive only after the DO permit expired and this lock completed. */
export async function inspectInferencePolicyMutation(
  organizationId: string,
  mutationId: string,
): Promise<
  { state: "absent" } | { state: "applied" | "complete"; fenceToken: string; epoch: string }
> {
  return writeTransaction(async (tx) => {
    await lockInferencePolicyMutation(tx, organizationId, mutationId);
    const [row] = await sqlRows<{ phase: string; fence_token: string; epoch: string | null }>(
      tx,
      sql`SELECT phase, fence_token, epoch::text AS epoch FROM inference_policy_mutations WHERE organization_id = ${organizationId}::uuid AND mutation_id = ${mutationId}`,
    );
    if (!row) return { state: "absent" };
    if ((row.phase !== "applied" && row.phase !== "complete") || row.epoch === null)
      throw new InferencePolicyFenceError("Inference policy mutation outcome is not committed");
    return { state: row.phase, fenceToken: row.fence_token, epoch: row.epoch };
  });
}

/** Account and moderation changes affect every organization that issued this user's keys. */
export async function withInferenceUserPolicyMutation<T>(
  userId: string,
  additionalOrganizationIds: string[],
  fn: (tx: DbTransaction) => Promise<T>,
  transaction?: DbTransaction,
): Promise<T> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true")
    return transaction ? fn(transaction) : writeTransaction(fn);
  const rows = await sqlRows<{ organization_id: string }>(
    transaction ?? dbWrite,
    sql`SELECT organization_id FROM users WHERE id = ${userId}::uuid AND organization_id IS NOT NULL UNION SELECT organization_id FROM api_keys WHERE user_id = ${userId}::uuid`,
  );
  const options = {
    organizationIds: [...rows.map((row) => row.organization_id), ...additionalOrganizationIds],
  };
  return transaction
    ? withInferencePolicyMutationInTransaction(transaction, options, fn)
    : withInferencePolicyMutation(options, fn);
}

/** Authorize subsequent policy writes through the exact outer transaction's COMMIT. */
export async function ensureInferencePolicyMutation(
  tx: DbTransaction,
  organizationId: string,
): Promise<void> {
  await withInferencePolicyMutationInTransaction(
    tx,
    { organizationIds: [organizationId] },
    async () => {},
  );
}

export class InferencePolicyDrainPendingError extends ElizaError {
  constructor(organizationId: string) {
    super("Inference escrow must finish reconciliation before rollback", {
      code: "INFERENCE_POLICY_DRAIN_PENDING",
      severity: "ephemeral",
      context: { organizationId },
    });
  }
}

/** Keep the feature and binding enabled while reclaiming, draining, and withdrawing authority. */
export async function disableInferenceBudgetAdmission(organizationId: string): Promise<void> {
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true") {
    throw new InferencePolicyFenceError(
      "Keep funded budget admission enabled until rollback is acknowledged",
    );
  }
  const [preflight] = await sqlRows<{ id: string }>(
    dbWrite,
    sql`SELECT id FROM inference_funding_budget_grants WHERE organization_id = ${organizationId}::uuid AND closed_at IS NULL LIMIT 1`,
  );
  if (preflight) throw new InferencePolicyDrainPendingError(organizationId);
  const [authority] = await sqlRows<{ enabled: boolean }>(
    dbWrite,
    sql`SELECT enabled FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid`,
  );
  const mutationId = crypto.randomUUID();
  if (authority?.enabled) {
    const permit = await beginPolicyMutation(organizationId, mutationId, true);
    // No database transaction is open while the DO blocks the rest of this window.
    while (!(await rollbackIsReady(organizationId, permit))) {
      if (Date.now() >= permit.validUntil)
        throw new InferencePolicyFenceError("Inference rollback permit expired");
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(1000, Math.max(1, permit.rateWindowEndsAt! - Date.now()))),
      );
    }
  }
  await withInferencePolicyMutation(
    { organizationIds: [organizationId], mutationId, disable: true },
    async (tx) => {
      // A concurrent mint owns this same organization lock until its grant commits.
      // The subsequent statement must use a fresh snapshot after waiting for it.
      const [organization] = await sqlRows<{ id: string }>(
        tx,
        sql`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`,
      );
      if (!organization)
        throw new InferencePolicyFenceError("Inference policy organization does not exist");
      const [open] = await sqlRows<{ id: string }>(
        tx,
        sql`SELECT id FROM inference_funding_budget_grants WHERE organization_id = ${organizationId}::uuid AND closed_at IS NULL LIMIT 1`,
      );
      if (open) throw new InferencePolicyDrainPendingError(organizationId);
    },
  );
  await confirmInferencePolicyAuthCacheWithdrawal(organizationId);
}

async function confirmInferencePolicyAuthCacheWithdrawal(organizationId: string): Promise<void> {
  const keys = await sqlRows<{ key_hash: string }>(
    dbWrite,
    sql`SELECT key_hash FROM api_keys WHERE organization_id = ${organizationId}::uuid`,
  );
  const { invalidateInferenceAuthContextsByKeyHashes } = await import("./inference-auth-cache");
  await invalidateInferenceAuthContextsByKeyHashes(keys.map((key) => key.key_hash));
}

/** Old deployments have no delegation metadata; partial installation must remain unavailable. */
async function inferencePolicyMetadataAvailable(tx?: DbTransaction): Promise<boolean> {
  const [tables] = await sqlRows<{
    authorities: boolean;
    mutations: boolean;
    grants: boolean;
    receipts: boolean;
  }>(
    tx ?? dbWrite,
    sql`SELECT to_regclass('inference_policy_authorities') IS NOT NULL AS authorities,
      to_regclass('inference_policy_mutations') IS NOT NULL AS mutations,
      to_regclass('inference_funding_budget_grants') IS NOT NULL AS grants,
      to_regclass('inference_funding_budget_receipts') IS NOT NULL AS receipts`,
  );
  if (!tables) throw new InferencePolicyFenceError("Inference policy metadata is unavailable");
  const available = Object.values(tables);
  if (available.every((exists) => exists)) return true;
  if (
    available.every((exists) => !exists) &&
    getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true"
  )
    return false;
  throw new InferencePolicyFenceError("Inference policy metadata migration is incomplete");
}

/** Drain and withdraw delegated authority before irreversible account resource cleanup. */
export async function prepareInferencePolicyForAccountDeletion(
  organizationId: string,
): Promise<void> {
  if (!(await inferencePolicyMetadataAvailable())) return;
  const [authority] = await sqlRows<{ enabled: boolean }>(
    dbWrite,
    sql`SELECT enabled FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid`,
  );
  if (!authority) return;
  if (!authority.enabled) {
    // Rollback commits before cache withdrawal; a retry must confirm that remaining effect.
    await confirmInferencePolicyAuthCacheWithdrawal(organizationId);
    return;
  }
  if (getCloudAwareEnv().INFERENCE_FUNDED_BUDGET_ADMISSION !== "true")
    throw new InferencePolicyFenceError(
      "Keep funded budget admission enabled until rollback is acknowledged",
    );
  const { inferenceBudgetGateRequest } = await import("./inference-funded-budget-admission");
  const result = await inferenceBudgetGateRequest<unknown>(organizationId, "/budget/reclaim", {
    organizationId,
  });
  if (
    typeof result !== "object" ||
    result === null ||
    !("released" in result) ||
    result.released !== true ||
    !("pending" in result) ||
    typeof result.pending !== "boolean"
  )
    throw new InferencePolicyFenceError("Inference escrow reclaim was not acknowledged");
  if (result.pending) throw new InferencePolicyDrainPendingError(organizationId);
  await disableInferenceBudgetAdmission(organizationId);
}

/** Remove nonfinancial policy receipts only after their ordinary rollback is acknowledged. */
export async function clearDisabledInferencePolicyForAccountDeletion(
  tx: DbTransaction,
  organizationId: string,
): Promise<void> {
  if (!(await inferencePolicyMetadataAvailable(tx))) return;
  const [authority] = await sqlRows<{ enabled: boolean }>(
    tx,
    sql`SELECT enabled FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid FOR UPDATE`,
  );
  if (authority?.enabled) throw new InferencePolicyDrainPendingError(organizationId);
  const [pending] = await sqlRows<{ mutation_id: string }>(
    tx,
    sql`SELECT mutation_id FROM inference_policy_mutations WHERE organization_id = ${organizationId}::uuid AND phase <> 'complete' LIMIT 1`,
  );
  if (pending) throw new InferencePolicyDrainPendingError(organizationId);
  const [history] = await sqlRows<{ retained: boolean }>(
    tx,
    sql`SELECT EXISTS (SELECT 1 FROM inference_funding_budget_grants WHERE organization_id = ${organizationId}::uuid) OR EXISTS (SELECT 1 FROM inference_funding_budget_receipts WHERE organization_id = ${organizationId}::uuid) AS retained`,
  );
  if (history?.retained !== false)
    throw new ElizaError("Inference escrow history requires its retained-audit erasure owner", {
      code: "INFERENCE_BUDGET_HISTORY_RETENTION_REQUIRED",
      context: { organizationId },
      severity: "ephemeral",
    });
  await tx.execute(
    sql`DELETE FROM inference_policy_mutations WHERE organization_id = ${organizationId}::uuid`,
  );
  await tx.execute(
    sql`DELETE FROM inference_policy_authorities WHERE organization_id = ${organizationId}::uuid AND NOT enabled`,
  );
}
