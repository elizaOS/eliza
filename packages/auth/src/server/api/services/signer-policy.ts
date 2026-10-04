import type { agentSigners } from "../../db/index";

export function signerHasPermission(
  permissions: readonly string[],
  required: string,
): boolean {
  const family = required.includes("_")
    ? `${required.split("_")[0]}:*`
    : `${required}:*`;
  return (
    permissions.includes("*") ||
    (required.startsWith("sign_") && permissions.includes("sign:*")) ||
    permissions.includes(required) ||
    permissions.includes(family)
  );
}

export function redactSignerMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const {
    credentialHash: _credentialHash,
    credentialCreatedAt: _credentialCreatedAt,
    credentialLastUsedAt: _credentialLastUsedAt,
    ...safeMetadata
  } = metadata;
  return safeMetadata;
}

export function toSignerResponse(row: typeof agentSigners.$inferSelect) {
  return {
    id: row.id,
    tenantId: row.tenantId,
    agentId: row.agentId,
    signerType: row.signerType,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    keyType: row.keyType,
    publicKey: row.publicKey,
    address: row.address,
    chainFamily: row.chainFamily,
    label: row.label,
    permissions: row.permissions,
    policyIds: row.policyIds,
    metadata: redactSignerMetadata(row.metadata),
    hasCredential: typeof row.metadata.credentialHash === "string",
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
