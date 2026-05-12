import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

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
    if (!keySource && env.NODE_ENV === "production") {
      throw new Error("SECRETS_MASTER_KEY environment variable is required in production");
    }
    const key = keySource || "0".repeat(64);
    if (key.length !== 64) throw new Error("Master key must be 64 hex characters (32 bytes)");
    return Buffer.from(key, "hex");
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

export class AWSKMSProvider implements KMSProvider {
  private keyId = process.env.AWS_KMS_KEY_ID || "";
  private region = process.env.AWS_REGION || "us-east-1";
  private client: KMSClientType | null = null;

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

  async encrypt(plaintext: string): Promise<EncryptionResult> {
    const { plaintext: dek, ciphertext: encryptedDek, keyId } = await this.kms.generateDataKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce);
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

  async decrypt({
    encryptedValue,
    encryptedDek,
    nonce,
    authTag,
  }: DecryptionParams): Promise<string> {
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
      decipher.setAuthTag(Buffer.from(authTag, "base64"));
      const result = Buffer.concat([
        decipher.update(Buffer.from(encryptedValue, "base64")),
        decipher.final(),
      ]).toString("utf8");
      return result;
    } catch (error) {
      throw new DecryptionError(
        "Failed to decrypt secret value — stored encryption data may be corrupted",
        "value_decryption",
        error,
      );
    } finally {
      dek.fill(0);
    }
  }

  async rotate(params: DecryptionParams): Promise<EncryptionResult> {
    return this.encrypt(await this.decrypt(params));
  }
}

let instance: SecretsEncryptionService | null = null;

export const getEncryptionService = () => instance || (instance = new SecretsEncryptionService());
export const createEncryptionService = (kms?: KMSProvider) => new SecretsEncryptionService(kms);
