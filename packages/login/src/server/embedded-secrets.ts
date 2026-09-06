/**
 * Derives independent keys for new local databases and records which keys the
 * host owns. Existing databases require their original keys; missing settings
 * must never silently change the encryption root or invalidate an audit chain.
 */
import { scryptSync } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ElizaError } from "@elizaos/core/errors";

export function resolveEmbeddedSecrets(
  dataDir: string,
  masterPassword: string,
  configured: { kdfSalt?: string; auditKey?: string },
): { kdfSalt: string; auditKey: string } {
  if (configured.kdfSalt && configured.auditKey) {
    return { kdfSalt: configured.kdfSalt, auditKey: configured.auditKey };
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dataDir).isDirectory()) {
    throw new ElizaError("Local login data must use a real directory", {
      code: "LOGIN_DATA_DIRECTORY_INVALID",
    });
  }
  const marker = join(dataDir, ".login-key-derivation.json");
  let kdf = !configured.kdfSalt;
  let audit = !configured.auditKey;
  if (existsSync(marker)) {
    const record: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (
      typeof record !== "object" ||
      record === null ||
      !("version" in record) ||
      record.version !== 1 ||
      !("kdf" in record) ||
      typeof record.kdf !== "boolean" ||
      !("audit" in record) ||
      typeof record.audit !== "boolean"
    ) {
      throw new ElizaError(
        "Local login key metadata is invalid; restore the original metadata",
        { code: "LOGIN_KEY_METADATA_INVALID" },
      );
    }
    kdf = record.kdf;
    audit = record.audit;
  } else {
    const existing = readdirSync(dataDir).some(
      (file) => file !== ".master-password",
    );
    if (existing) {
      throw new ElizaError(
        "Existing login data requires its original STEWARD_KDF_SALT and STEWARD_AUDIT_HMAC_KEY before migration",
        { code: "LOGIN_MIGRATION_KEYS_REQUIRED" },
      );
    }
    writeFileSync(marker, `${JSON.stringify({ version: 1, kdf, audit })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  }
  if ((!configured.kdfSalt && !kdf) || (!configured.auditKey && !audit)) {
    throw new ElizaError(
      "Restore the configured login encryption and audit keys before restarting",
      { code: "LOGIN_CONFIGURED_KEYS_REQUIRED" },
    );
  }
  return {
    kdfSalt:
      configured.kdfSalt ||
      scryptSync(masterPassword, "elizaos/login/local-kdf/v1", 32).toString(
        "hex",
      ),
    auditKey:
      configured.auditKey ||
      scryptSync(masterPassword, "elizaos/login/local-audit/v1", 32).toString(
        "hex",
      ),
  };
}
