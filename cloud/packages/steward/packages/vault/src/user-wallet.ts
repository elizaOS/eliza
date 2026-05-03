/**
 * user-wallet.ts — User wallet auto-provisioning
 *
 * When a user is created (via any auth method), this module provisions a
 * Steward-managed embedded wallet for them. The wallet is a standard Steward
 * agent scoped to a personal tenant (`personal-<userId>`), with sensible
 * default policies pre-applied.
 */

import { agents, getDb, policies, type policyTypeEnum } from "@stwd/db";
import type { AgentIdentity, PolicyRule } from "@stwd/shared";
import { eq } from "drizzle-orm";
import { parseEther } from "viem";

import type { Vault } from "./vault";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UserWalletResult {
  userId: string;
  agentId: string; // Steward agent ID backing this wallet
  tenantId: string; // personal tenant scoping this wallet
  walletAddress: string;
  chainType: "evm";
}

// ─── Default policies ─────────────────────────────────────────────────────────

type PersistedPolicyType = (typeof policyTypeEnum.enumValues)[number];
type PersistedPolicyRule = Omit<PolicyRule, "type"> & {
  type: PersistedPolicyType;
};

/**
 * Sensible default policies for a user's personal wallet.
 *
 * - Spending limits: 0.5 ETH/tx, 2 ETH/day, 10 ETH/week
 * - Rate limits: 10 tx/hr, 50 tx/day
 */
export const USER_WALLET_DEFAULT_POLICIES: PersistedPolicyRule[] = [
  {
    id: "user-spend-limit",
    type: "spending-limit",
    enabled: true,
    config: {
      maxPerTx: parseEther("0.5").toString(), // 0.5 ETH per transaction
      maxPerDay: parseEther("2.0").toString(), // 2 ETH daily
      maxPerWeek: parseEther("10.0").toString(), // 10 ETH weekly
    },
  },
  {
    id: "user-rate-limit",
    type: "rate-limit",
    enabled: true,
    config: {
      maxTxPerHour: 10,
      maxTxPerDay: 50,
    },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Deterministic agent/tenant IDs from a userId so lookups are cheap. */
function agentIdFor(userId: string): string {
  return `user-wallet-${userId}`;
}

function tenantIdFor(userId: string, overrideTenantId?: string): string {
  return overrideTenantId ?? `personal-${userId}`;
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Provision a Steward-managed wallet for a new user.
 *
 * - Creates a Steward agent scoped to the user's personal tenant.
 * - Applies `USER_WALLET_DEFAULT_POLICIES` automatically.
 * - Idempotent: if the agent already exists, returns its existing identity
 *   without throwing.
 *
 * @param vault        The Vault instance to use for agent creation.
 * @param userId       The application user ID (UUID or opaque string).
 * @param displayName  Human-readable name for the wallet (e.g. "Alice's Wallet").
 * @param tenantId     Optional tenant to scope to. Defaults to `personal-<userId>`.
 */
export async function provisionUserWallet(
  vault: Vault,
  userId: string,
  displayName: string,
  tenantId?: string,
): Promise<UserWalletResult> {
  if (!userId || userId.trim().length === 0) {
    throw new Error("userId is required");
  }
  if (!displayName || displayName.trim().length === 0) {
    throw new Error("displayName is required");
  }

  const agentId = agentIdFor(userId);
  const resolvedTenantId = tenantIdFor(userId, tenantId);

  let agent: AgentIdentity;

  // Try to create; fall through if already exists
  try {
    agent = await vault.createAgent(
      resolvedTenantId,
      agentId,
      `${displayName}'s Wallet`,
      `user:${userId}`,
    );

    // Apply default policies for newly-provisioned wallet
    await applyUserWalletDefaults(userId, resolvedTenantId);

    console.log(
      `[UserWallet] Provisioned wallet for user "${userId}" — address ${agent.walletAddress}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("already exists")) {
      // Wallet exists — fetch it
      const existing = await vault.getAgent(resolvedTenantId, agentId);
      if (!existing) {
        throw new Error(
          `User wallet agent "${agentId}" reported as existing but could not be fetched`,
        );
      }
      agent = existing;
      console.log(
        `[UserWallet] Existing wallet found for user "${userId}" — address ${agent.walletAddress}`,
      );
    } else {
      throw err;
    }
  }

  return {
    userId,
    agentId: agent.id,
    tenantId: resolvedTenantId,
    walletAddress: agent.walletAddress,
    chainType: "evm",
  };
}

/**
 * Look up an existing user wallet without creating one.
 *
 * Returns the agent identity if found, or `null` if not yet provisioned.
 *
 * @param vault   The Vault instance.
 * @param userId  The application user ID.
 * @param tenantId Optional override tenant (defaults to `personal-<userId>`).
 */
export async function getUserWallet(
  vault: Vault,
  userId: string,
  tenantId?: string,
): Promise<AgentIdentity | null> {
  const agentId = agentIdFor(userId);
  const resolvedTenantId = tenantIdFor(userId, tenantId);

  const agent = await vault.getAgent(resolvedTenantId, agentId);
  return agent ?? null;
}

/**
 * Apply (or re-apply) the default policy set to a user's wallet.
 * Replaces any existing policies on the agent with `USER_WALLET_DEFAULT_POLICIES`.
 *
 * @param userId    The application user ID.
 * @param tenantId  Optional override tenant (defaults to `personal-<userId>`).
 */
export async function applyUserWalletDefaults(userId: string, _tenantId?: string): Promise<void> {
  const agentId = agentIdFor(userId);
  const db = getDb();

  // Ensure the agent exists in the DB before inserting policies
  const [agentRow] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));

  if (!agentRow) {
    throw new Error(`Cannot apply default policies: agent "${agentId}" not found in database`);
  }

  // Replace policies atomically
  await db.delete(policies).where(eq(policies.agentId, agentId));
  await db.insert(policies).values(
    USER_WALLET_DEFAULT_POLICIES.map((policy) => ({
      id: `${policy.id}-${userId}`, // unique per user to avoid PK collisions
      agentId,
      type: policy.type,
      enabled: policy.enabled,
      config: policy.config,
    })),
  );

  console.log(
    `[UserWallet] Default policies applied for user "${userId}" (${USER_WALLET_DEFAULT_POLICIES.length} rules)`,
  );
}
