// Coordinates cloud service encryption behavior behind route handlers.
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";

export class DecryptionError extends Error {
  constructor(
    message: string,
    public readonly phase: "dek_decryption" | "value_decryption",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DecryptionError";
  }
}

export interface EncryptionResult {
  encryptedValue: string;
  encryptedDek: string;
  nonce: string;
  authTag: string;
  keyId: string;
}

export interface DecryptionParams {
  encryptedValue: string;
  encryptedDek: string;
  nonce: string;
  authTag: string;
}

export interface KMSProvider {
  generateDataKey(): Promise<{
    plaintext: Buffer;
    ciphertext: string;
    keyId: string;
  }>;
  decrypt(ciphertext: string): Promise<Buffer>;
  isConfigured(): boolean;
}

export class LocalKMSProvider implements KMSProvider {
  private masterKeyHex?: string;
  private keyId = "local-kms-key";

  constructor(masterKeyHex?: string) {
    this.masterKeyHex = masterKeyHex;
  }

  private getMasterKey(): Buffer {
    const env = getCloudAwareEnv();
    const keySource = this.masterKeyHex || env.SECRETS_MASTER_KEY;
    if (!keySource) {
      // Fail CLOSED. Previously this silently derived an all-zero master key
      // ("0".repeat(64)) outside production, so any staging/preview/self-host
      // env that held real secrets but did not set NODE_ENV=production (or
      // forgot SECRETS_MASTER_KEY) encrypted every DEK under a publicly-known
      // key — a DB read then trivially recovered plaintext. Never derive the
      // zero key. Production always throws; non-prod requires an explicit,
      // loud ALLOW_INSECURE_DEV_KMS=1 opt-in for local development only.
      if (env.NODE_ENV === "production" || env.ALLOW_INSECURE_DEV_KMS !== "1") {
        throw new Error(
          "SECRETS_MASTER_KEY is required to encrypt/decrypt secrets. " +
            "Generate one with `openssl rand -hex 32`. " +
            "For local development only, set ALLOW_INSECURE_DEV_KMS=1 to use an " +
            "insecure all-zero key (never in production or with real secrets).",
        );
      }
      logger.warn(
        "[LocalKMSProvider] SECRETS_MASTER_KEY is unset and ALLOW_INSECURE_DEV_KMS=1 — " +
          "using an INSECURE, publicly-known all-zero master key. Every secret encrypted " +
          "in this process is effectively PLAINTEXT. Use this ONLY for local development.",
      );
      return Buffer.alloc(32, 0);
    }
    if (keySource.length !== 64) throw new Error("Master key must be 64 hex characters (32 bytes)");
    return Buffer.from(keySource, "hex");
  }

  async generateDataKey() {
    const masterKey = this.getMasterKey();
    const plaintext = randomBytes(32);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    masterKey.fill(0);
    return { plaintext, ciphertext, keyId: this.keyId };
  }

  async decrypt(ciphertext: string): Promise<Buffer> {
    const masterKey = this.getMasterKey();
    const data = Buffer.from(ciphertext, "base64");
    try {
      const decipher = createDecipheriv("aes-256-gcm", masterKey, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
    } finally {
      masterKey.fill(0);
    }
  }

  isConfigured = () => true;
}

type KMSClientType = {
  send(command: unknown): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
};

/**
 * @deprecated AWS KMS is being retired. New deployments should use
 * {@link LocalKMSProvider} with `SECRETS_MASTER_KEY` (AES-256-GCM).
 *
 * This provider is retained only so existing deployments that previously
 * encrypted DEKs under a provisioned AWS KMS key can still decrypt their
 * secrets. To migrate off AWS KMS:
 *   1. Set `SECRETS_MASTER_KEY` to a 64-hex-char value.
 *   2. Unset `AWS_KMS_KEY_ID` so {@link SecretsEncryptionService} picks
 *      {@link LocalKMSProvider} for new encryptions.
 *   3. Call `SecretsEncryptionService.rotate()` over all stored secrets
 *      to re-encrypt each DEK under the local master key.
 *   4. Once all secrets are rotated, this class and the
 *      `@aws-sdk/client-kms` dependency can be removed.
 *
 * See `packages/cloud/infra/cloud/AWS_RETIREMENT.md` for the full plan.
 */
export class AWSKMSProvider implements KMSProvider {
  private static deprecationWarned = false;
  private keyId = process.env.AWS_KMS_KEY_ID || "";
  private region = process.env.AWS_REGION || "us-east-1";
  private client: KMSClientType | null = null;

  constructor() {
    if (!AWSKMSProvider.deprecationWarned) {
      AWSKMSProvider.deprecationWarned = true;
      logger.warn(
        "[AWSKMSProvider] AWS KMS is deprecated and pending removal. " +
          "Migrate to LocalKMSProvider by setting SECRETS_MASTER_KEY and rotating stored secrets. " +
          "See packages/cloud/infra/cloud/AWS_RETIREMENT.md (Stage 3).",
      );
    }
  }

  private async getClient(): Promise<KMSClientType> {
    if (this.client) return this.client;
    const { KMSClient } = await import("@aws-sdk/client-kms");
    this.client = new KMSClient({
      region: this.region,
      ...(process.env.AWS_ACCESS_KEY_ID &&
        process.env.AWS_SECRET_ACCESS_KEY && {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }),
    });
    return this.client;
  }

  async generateDataKey() {
    const { GenerateDataKeyCommand } = await import("@aws-sdk/client-kms");
    const response = await (await this.getClient()).send(
      new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256" }),
    );
    if (!response.Plaintext || !response.CiphertextBlob) {
      throw new Error("KMS GenerateDataKey returned empty response");
    }
    return {
      plaintext: Buffer.from(response.Plaintext),
      ciphertext: Buffer.from(response.CiphertextBlob).toString("base64"),
      keyId: this.keyId,
    };
  }

  async decrypt(ciphertext: string): Promise<Buffer> {
    const { DecryptCommand } = await import("@aws-sdk/client-kms");
    const response = await (await this.getClient()).send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertext, "base64"),
        KeyId: this.keyId,
      }),
    );
    if (!response.Plaintext) throw new Error("KMS Decrypt returned empty response");
    return Buffer.from(response.Plaintext);
  }

  isConfigured = () => !!this.keyId;
}

export class SecretsEncryptionService {
  private kms: KMSProvider;

  constructor(kms?: KMSProvider) {
    this.kms = kms || (process.env.AWS_KMS_KEY_ID ? new AWSKMSProvider() : new LocalKMSProvider());
  }

  isConfigured = () => this.kms.isConfigured();

  async encrypt(plaintext: string, aad?: string): Promise<EncryptionResult> {
    const { plaintext: dek, ciphertext: encryptedDek, keyId } = await this.kms.generateDataKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
    // AAD binds the ciphertext to a caller-supplied context (e.g.
    // `table|rowId|column`). GCM folds the AAD into the auth tag, so a
    // ciphertext relocated to a different row/column decrypts only if the
    // caller presents the same AAD — an attacker with DB-write cannot move a
    // ciphertext between rows and still decrypt it. Omitting the AAD preserves
    // the pre-existing on-disk format (backward compatible).
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    dek.fill(0);
    return {
      encryptedValue: encrypted.toString("base64"),
      encryptedDek,
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyId,
    };
  }

  async decrypt(
    { encryptedValue, encryptedDek, nonce, authTag }: DecryptionParams,
    aad?: string,
  ): Promise<string> {
    let dek: Buffer;
    try {
      dek = await this.kms.decrypt(encryptedDek);
    } catch (error) {
      throw new DecryptionError(
        "Failed to decrypt data encryption key — SECRETS_MASTER_KEY may have changed since this secret was stored",
        "dek_decryption",
        error,
      );
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(nonce, "base64"));
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(Buffer.from(authTag, "base64"));
      const result = Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return result;
    } catch (error) {
      throw new DecryptionError(
        "Failed to decrypt secret value — stored encryption data may be corrupted or AAD mismatch (row/column relocation)",
        "value_decryption",
        error,
      );
    } finally {
      dek.fill(0);
    }
  }

  async rotate(params: DecryptionParams, aad?: string): Promise<EncryptionResult> {
    return this.encrypt(await this.decrypt(params, aad), aad);
  }
}

let instance: SecretsEncryptionService | null = null;

export const getEncryptionService = () => instance || (instance = new SecretsEncryptionService());
export const createEncryptionService = (kms?: KMSProvider) => new SecretsEncryptionService(kms);
