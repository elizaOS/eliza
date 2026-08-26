/**
 * Persists OAuth credential material for a connector account and reads the
 * resulting refs back out. `persistConnectorCredentialRefs` writes each secret
 * to the first available durable vault (connector credential store or vault)
 * and records a `vaultRef` pointer on the account via storage; it refuses to
 * proceed unless both a vault writer and a ref writer exist, so an account is
 * never marked connected without durable credentials. The in-memory SECRETS
 * service is deliberately NOT a writer — tokens stored there die with the
 * process while the persisted ref dangles (#18080); it remains a read-side
 * probe only.
 * `credentialRefRecordsFromMetadata` is the read side, extracting ref records
 * from account metadata for the credential resolver. Consumed by the connector
 * account provider on OAuth completion and by `DefaultGoogleCredentialResolver`.
 */

export type {
  ConnectorCredentialPersistResult,
  ConnectorCredentialRefMetadata,
} from "@elizaos/core";
export {
  CONNECTOR_CREDENTIAL_STORE_SERVICE_TYPES,
  CONNECTOR_VAULT_SERVICE_TYPES,
  persistConnectorCredentialRefs,
} from "@elizaos/core";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { readonly [key: string]: JsonValue };
type JsonRecord = Record<string, JsonValue>;

/**
 * Runtime service names probed, in precedence order, for the durable
 * connector credential store and the vault. The credential resolver's read
 * path (`credential-resolver.ts`) resolves EXACTLY this set in this order:
 * any store a credential can be written to must be findable under the same
 * name after a restart, or the persisted vaultRef dangles and every
 * credential read comes back empty.
 */
export const CORE_SECRETS_SERVICE_TYPE = "SECRETS";

export interface ConnectorCredentialRefRecordLike {
  credentialType: string;
  vaultRef?: string | null;
  metadata?: JsonRecord | null;
  expiresAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  version?: string | number | null;
}

export function credentialRefRecordsFromMetadata(
  metadata: unknown
): ConnectorCredentialRefRecordLike[] {
  const record = asRecord(metadata);
  if (!record) return [];

  const oauth = asRecord(record.oauth);
  return [
    ...credentialRefsFromUnknown(record.credentialRefs),
    ...credentialRefsFromUnknown(record.oauthCredentialRefs),
    ...credentialRefsFromUnknown(oauth?.credentialRefs),
  ];
}

function credentialRefsFromUnknown(value: unknown): ConnectorCredentialRefRecordLike[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const ref = credentialRefFromRecord(asRecord(entry));
      return ref ? [ref] : [];
    });
  }

  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([credentialType, entry]) => {
    const entryRecord = asRecord(entry);
    if (entryRecord) {
      const ref = credentialRefFromRecord({
        credentialType,
        ...entryRecord,
      });
      return ref ? [ref] : [];
    }
    const vaultRef = nonEmptyString(entry);
    return vaultRef ? [{ credentialType, vaultRef }] : [];
  });
}

function credentialRefFromRecord(
  record: JsonRecord | undefined
): ConnectorCredentialRefRecordLike | null {
  if (!record) return null;
  const credentialType = nonEmptyString(record.credentialType ?? record.type ?? record.name);
  const vaultRef = nonEmptyString(record.vaultRef ?? record.ref);
  if (!credentialType || !vaultRef) return null;
  return {
    credentialType,
    vaultRef,
    metadata: asRecord(record.metadata) ?? null,
    expiresAt: record.expiresAt as ConnectorCredentialRefRecordLike["expiresAt"],
    updatedAt: record.updatedAt as ConnectorCredentialRefRecordLike["updatedAt"],
    version: (record.version ??
      record.credentialVersion) as ConnectorCredentialRefRecordLike["version"],
  };
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
