import type {
  AgentBackupPlainStateData,
  AgentBackupStoredStateData,
  EncryptedAgentBackupStateData,
} from "../schemas/agent-sandboxes";
import { decryptField, type EncryptedField, encryptField } from "./field-crypto";

const TABLE = "agent_sandbox_backups";
const COLUMN = "state_data";
const KIND = "encrypted-agent-backup-state";

function coords(backupId: string) {
  return { table: TABLE, rowId: backupId, column: COLUMN };
}

export function isEncryptedAgentBackupStateData(
  value: unknown,
): value is EncryptedAgentBackupStateData {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === KIND &&
    record.algorithm === "kms-aes-256-gcm" &&
    typeof record.ciphertext === "string" &&
    typeof record.nonce === "string" &&
    typeof record.auth_tag === "string" &&
    typeof record.kms_key_id === "string" &&
    typeof record.kms_key_version === "number"
  );
}

export async function encryptAgentBackupStateData(
  orgId: string,
  backupId: string,
  stateData: AgentBackupStoredStateData,
): Promise<EncryptedAgentBackupStateData> {
  if (isEncryptedAgentBackupStateData(stateData)) return stateData;
  const encrypted = await encryptField(orgId, JSON.stringify(stateData), coords(backupId));
  return {
    kind: KIND,
    algorithm: "kms-aes-256-gcm",
    ...encrypted,
  };
}

export async function decryptAgentBackupStateData(
  backupId: string,
  stateData: AgentBackupStoredStateData,
): Promise<AgentBackupPlainStateData> {
  if (!isEncryptedAgentBackupStateData(stateData)) return stateData;
  const encrypted: EncryptedField = {
    ciphertext: stateData.ciphertext,
    nonce: stateData.nonce,
    auth_tag: stateData.auth_tag,
    kms_key_id: stateData.kms_key_id,
    kms_key_version: stateData.kms_key_version,
  };
  return JSON.parse(await decryptField(encrypted, coords(backupId))) as AgentBackupPlainStateData;
}
