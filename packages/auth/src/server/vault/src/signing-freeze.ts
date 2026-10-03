import {
  agentWallets,
  and,
  eq,
  getDb,
  inArray,
  isNull,
  or,
  vaultSigningFreezes,
} from "../../db/src/index.ts";
import type { ChainFamily } from "../../shared/src/index.ts";

export type VaultFreezeScope = "tenant" | "agent" | "wallet";

export class VaultSigningFrozenError extends Error {
  readonly code = "VAULT_SIGNING_FROZEN";
  readonly scopeType: VaultFreezeScope;
  readonly freezeId: string;

  constructor(input: {
    scopeType: VaultFreezeScope;
    freezeId: string;
    reason?: string | null;
  }) {
    super(
      `Vault signing is frozen for ${input.scopeType}${input.reason ? `: ${input.reason}` : ""}`,
    );
    this.name = "VaultSigningFrozenError";
    this.scopeType = input.scopeType;
    this.freezeId = input.freezeId;
  }
}

export function isVaultSigningFrozenError(
  error: unknown,
): error is VaultSigningFrozenError {
  return error instanceof VaultSigningFrozenError;
}

export async function assertVaultSigningActive(input: {
  tenantId: string;
  agentId: string;
  chainFamily?: ChainFamily;
  venue?: string | null;
  walletAddress?: string | null;
  walletId?: string | null;
}): Promise<void> {
  const db = getDb();
  const walletIds = new Set<string>();

  if (input.walletId) {
    walletIds.add(input.walletId);
  }

  if (input.chainFamily || input.walletAddress || input.venue !== undefined) {
    const predicates = [eq(agentWallets.agentId, input.agentId)];
    if (input.chainFamily)
      predicates.push(eq(agentWallets.chainFamily, input.chainFamily));
    if (input.walletAddress)
      predicates.push(eq(agentWallets.address, input.walletAddress));
    if (input.venue !== undefined) {
      predicates.push(
        input.venue
          ? eq(agentWallets.venue, input.venue)
          : isNull(agentWallets.venue),
      );
    }
    const rows = await db
      .select({ id: agentWallets.id })
      .from(agentWallets)
      .where(and(...predicates));
    for (const row of rows) walletIds.add(row.id);
  }

  const walletFreezePredicate =
    walletIds.size > 0
      ? and(
          eq(vaultSigningFreezes.scopeType, "wallet"),
          inArray(vaultSigningFreezes.walletId, Array.from(walletIds)),
        )
      : undefined;

  const [freeze] = await db
    .select({
      id: vaultSigningFreezes.id,
      scopeType: vaultSigningFreezes.scopeType,
      reason: vaultSigningFreezes.reason,
    })
    .from(vaultSigningFreezes)
    .where(
      and(
        eq(vaultSigningFreezes.tenantId, input.tenantId),
        isNull(vaultSigningFreezes.liftedAt),
        walletFreezePredicate
          ? or(
              eq(vaultSigningFreezes.scopeType, "tenant"),
              and(
                eq(vaultSigningFreezes.scopeType, "agent"),
                eq(vaultSigningFreezes.agentId, input.agentId),
              ),
              walletFreezePredicate,
            )
          : or(
              eq(vaultSigningFreezes.scopeType, "tenant"),
              and(
                eq(vaultSigningFreezes.scopeType, "agent"),
                eq(vaultSigningFreezes.agentId, input.agentId),
              ),
            ),
      ),
    )
    .limit(1);

  if (freeze) {
    throw new VaultSigningFrozenError({
      scopeType: freeze.scopeType as VaultFreezeScope,
      freezeId: freeze.id,
      reason: freeze.reason,
    });
  }
}
