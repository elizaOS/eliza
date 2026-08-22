/**
 * Read-only adapter from the current validated vault pointer to the exact KMS
 * wrapping authority required by manifest-v3 capture. It intentionally lives
 * outside the restore/occurrence repository so it cannot add a writer or
 * change restore lock ordering.
 */

import { ElizaError } from "@elizaos/core";
import { orgKey } from "@elizaos/core/security/kms";
import { and, eq } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { loadCurrentAgentVaultKeyAuthority } from "../../db/repositories/agent-vault-key-authority";
import { agentVaultKeyGenerations } from "../../db/schemas/agent-vault-key-authority";

export interface AgentBackupCaptureV3VaultAuthority {
  vaultKeyAuthority: Awaited<ReturnType<typeof loadCurrentAgentVaultKeyAuthority>>;
  kms: { provider: "steward"; keyId: string; keyVersion: number };
}

function vaultCaptureError(code: string, message: string): never {
  throw new ElizaError(message, { code, severity: "fatal" });
}

/**
 * Load a validated current pointer, bind it to its activation generation, and
 * re-read the current pointer to fence a concurrent rotation.
 */
export async function loadAgentBackupCaptureV3VaultAuthority(input: {
  organizationId: string;
  agentId: string;
  sourceActivationGeneration: string;
}): Promise<AgentBackupCaptureV3VaultAuthority> {
  const initial = await loadCurrentAgentVaultKeyAuthority(input);
  const [generation] = await dbWrite
    .select({
      generationId: agentVaultKeyGenerations.generation_id,
      sourceActivationGeneration: agentVaultKeyGenerations.source_activation_generation,
      kmsKeyId: agentVaultKeyGenerations.kms_key_id,
      kmsKeyVersion: agentVaultKeyGenerations.kms_key_version,
      authorityReceiptDigest: agentVaultKeyGenerations.authority_receipt_digest,
    })
    .from(agentVaultKeyGenerations)
    .where(
      and(
        eq(agentVaultKeyGenerations.organization_id, input.organizationId),
        eq(agentVaultKeyGenerations.agent_id, input.agentId),
        eq(agentVaultKeyGenerations.generation_id, initial.generationId),
        eq(agentVaultKeyGenerations.source_activation_generation, input.sourceActivationGeneration),
      ),
    )
    .limit(1);
  if (
    !generation ||
    generation.generationId !== initial.generationId ||
    generation.sourceActivationGeneration !== input.sourceActivationGeneration ||
    generation.authorityReceiptDigest !== initial.receiptDigest ||
    generation.kmsKeyId !== orgKey(input.organizationId, "dek") ||
    generation.kmsKeyVersion < 1n ||
    generation.kmsKeyVersion > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    vaultCaptureError(
      "AGENT_BACKUP_V3_VAULT_AUTHORITY_INVALID",
      "Current vault generation lacks the exact capture/KMS authority",
    );
  }
  const confirmed = await loadCurrentAgentVaultKeyAuthority(input);
  if (
    confirmed.generationId !== initial.generationId ||
    confirmed.receiptDigest !== initial.receiptDigest
  ) {
    vaultCaptureError(
      "AGENT_BACKUP_V3_VAULT_AUTHORITY_CHANGED",
      "Vault authority rotated while capture context was being resolved",
    );
  }
  return Object.freeze({
    vaultKeyAuthority: initial,
    kms: Object.freeze({
      provider: "steward" as const,
      keyId: generation.kmsKeyId,
      keyVersion: Number(generation.kmsKeyVersion),
    }),
  });
}
