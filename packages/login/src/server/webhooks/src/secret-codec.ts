import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { logger } from "@elizaos/logger";

const PREFIX = "stwd_whsec_v1:";
const DEFAULT_KDF_SALT = "steward-webhook-secret-v1";

type EncryptedWebhookSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
  salt: string;
};

function env(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } })
      .process?.env ?? {}
  );
}

let warnedDevSecret = false;

function rootKey(): Buffer {
  const currentEnv = env();
  const masterPassword =
    currentEnv.STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY ??
    currentEnv.STEWARD_MASTER_PASSWORD;
  if (!masterPassword) {
    if (currentEnv.NODE_ENV === "production") {
      throw new Error(
        "STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY or STEWARD_MASTER_PASSWORD is required to encrypt webhook secrets",
      );
    }
    // SEC-102: the insecure dev key is reachable ONLY when NODE_ENV is
    // explicitly a development value. A deploy that simply forgot NODE_ENV must
    // not fall through to a publicly-known key on the strength of an env flag.
    if (
      currentEnv.NODE_ENV !== "development" &&
      currentEnv.NODE_ENV !== "test"
    ) {
      throw new Error(
        `Refusing the insecure webhook dev key: NODE_ENV is not an explicit development value (${
          currentEnv.NODE_ENV === undefined
            ? "unset"
            : JSON.stringify(currentEnv.NODE_ENV)
        }). Set NODE_ENV=development for local development, or configure STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY / STEWARD_MASTER_PASSWORD.`,
      );
    }
    // The insecure dev fallback must be explicitly opted into; never in production.
    // Canonical var is STEWARD_ALLOW_DEV_SECRETS; singular accepted for back-compat.
    if (
      currentEnv.STEWARD_ALLOW_DEV_SECRETS !== "true" &&
      currentEnv.STEWARD_ALLOW_DEV_SECRET !== "true"
    ) {
      throw new Error(
        "No webhook secret encryption key set. Set STEWARD_WEBHOOK_SECRET_ENCRYPTION_KEY / STEWARD_MASTER_PASSWORD, or set STEWARD_ALLOW_DEV_SECRETS=true to use the insecure dev key (local development only).",
      );
    }
    if (!warnedDevSecret) {
      warnedDevSecret = true;
      logger.warn(
        {
          details: [
            "[steward] WARNING: using the insecure hardcoded dev key to encrypt webhook secrets (STEWARD_ALLOW_DEV_SECRET=true). Secrets are trivially decryptable. Never use this outside local development.",
          ],
        },
        "[Login:secret-codec] warn",
      );
    }
    return scryptSync("dev-secret", DEFAULT_KDF_SALT, 32) as Buffer;
  }

  const configuredSalt =
    currentEnv.STEWARD_WEBHOOK_SECRET_KDF_SALT ?? currentEnv.STEWARD_KDF_SALT;
  if (!configuredSalt && currentEnv.NODE_ENV === "production") {
    throw new Error(
      "STEWARD_WEBHOOK_SECRET_KDF_SALT or STEWARD_KDF_SALT is required in production",
    );
  }
  const salt = configuredSalt
    ? Buffer.from(configuredSalt, "hex")
    : Buffer.from(DEFAULT_KDF_SALT);
  if (configuredSalt && salt.length < 16) {
    throw new Error("Webhook secret KDF salt must decode to at least 16 bytes");
  }
  return scryptSync(masterPassword, salt, 32) as Buffer;
}

function deriveRecordKey(recordSalt: Buffer): Buffer {
  return scryptSync(rootKey(), recordSalt, 32) as Buffer;
}

export function isEncryptedWebhookSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptWebhookSecret(secret: string): string {
  if (isEncryptedWebhookSecret(secret)) return secret;
  const iv = randomBytes(16);
  const salt = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", deriveRecordKey(salt), iv);
  let ciphertext = cipher.update(secret, "utf8", "hex");
  ciphertext += cipher.final("hex");
  const payload: EncryptedWebhookSecret = {
    ciphertext,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    salt: salt.toString("hex"),
  };
  return `${PREFIX}${JSON.stringify(payload)}`;
}

export function decryptWebhookSecret(secret: string): string {
  if (!isEncryptedWebhookSecret(secret)) return secret;
  const encoded = secret.slice(PREFIX.length);
  const payload = JSON.parse(encoded) as EncryptedWebhookSecret;
  const iv = Buffer.from(payload.iv, "hex");
  const salt = Buffer.from(payload.salt, "hex");
  const tag = Buffer.from(payload.tag, "hex");
  const decipher = createDecipheriv("aes-256-gcm", deriveRecordKey(salt), iv);
  decipher.setAuthTag(tag);
  let plaintext = decipher.update(payload.ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");
  return plaintext;
}
