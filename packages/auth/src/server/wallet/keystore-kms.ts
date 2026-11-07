import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EncryptedKey } from "./keystore";
import type { KeystoreBackend, KeystoreContext } from "./keystore-backend";

const ENVELOPE_PREFIX = "kms-envelope:v1:";
const AWS_BACKEND_ID = "kms-envelope:aws-kms";
const PKCS11_BACKEND_ID = "kms-envelope:pkcs11";

type KmsProvider = "aws" | "pkcs11";

export interface AwsKmsClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface AwsKmsEnvelopeOptions {
  provider: "aws";
  keyId?: string;
  region?: string;
  client?: AwsKmsClientLike;
}

export interface Pkcs11ClientLike {
  wrapKey(
    dataKey: Uint8Array,
    context?: KeystoreContext,
  ): Promise<Uint8Array> | Uint8Array;
  unwrapKey(
    wrappedDataKey: Uint8Array,
    context?: KeystoreContext,
  ): Promise<Uint8Array> | Uint8Array;
}

export interface Pkcs11KmsEnvelopeOptions {
  provider: "pkcs11";
  modulePath?: string;
  pin?: string;
  keyLabel?: string;
  client?: Pkcs11ClientLike;
}

export type KmsEnvelopeOptions =
  | AwsKmsEnvelopeOptions
  | Pkcs11KmsEnvelopeOptions;

interface EnvelopeMetadata {
  backend: string;
  provider: KmsProvider;
  keyId?: string;
  wrappedDataKey: string;
}

interface AwsEncryptCommandInput {
  KeyId: string;
  Plaintext: Uint8Array;
  EncryptionContext?: Record<string, string>;
}

interface AwsDecryptCommandInput {
  CiphertextBlob: Uint8Array;
  EncryptionContext?: Record<string, string>;
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(value: string): Uint8Array {
  return Buffer.from(value, "hex");
}

function encodeMetadata(metadata: EnvelopeMetadata): string {
  return `${ENVELOPE_PREFIX}${Buffer.from(JSON.stringify(metadata), "utf8").toString("hex")}`;
}

function decodeMetadata(encrypted: EncryptedKey): EnvelopeMetadata | undefined {
  if (encrypted.backend && encrypted.wrappedDataKey) {
    return {
      backend: encrypted.backend,
      provider: encrypted.provider === "pkcs11" ? "pkcs11" : "aws",
      keyId: encrypted.keyId,
      wrappedDataKey: encrypted.wrappedDataKey,
    };
  }

  if (!encrypted.salt.startsWith(ENVELOPE_PREFIX)) {
    return undefined;
  }

  const encoded = encrypted.salt.slice(ENVELOPE_PREFIX.length);
  return JSON.parse(
    Buffer.from(encoded, "hex").toString("utf8"),
  ) as EnvelopeMetadata;
}

function contextToAwsEncryptionContext(
  context?: KeystoreContext,
): Record<string, string> | undefined {
  if (!context) return undefined;
  const entries = Object.entries({
    tenantId: context.tenantId,
    agentId: context.agentId,
    venue: context.venue ?? undefined,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

function encryptWithDataKey(
  privateKey: string,
  dataKey: Buffer,
): Pick<EncryptedKey, "ciphertext" | "iv" | "tag"> {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  let ciphertext = cipher.update(privateKey, "utf8", "hex");
  ciphertext += cipher.final("hex");
  return {
    ciphertext,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

function decryptWithDataKey(encrypted: EncryptedKey, dataKey: Buffer): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dataKey,
    Buffer.from(encrypted.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
  let plaintext = decipher.update(encrypted.ciphertext, "hex", "utf8");
  plaintext += decipher.final("utf8");
  return plaintext;
}

export class KmsEnvelopeKeystore implements KeystoreBackend {
  readonly id: string;

  private readonly options: KmsEnvelopeOptions;

  private readonly awsClientIsInjected: boolean;

  private awsClient?: AwsKmsClientLike;

  constructor(options?: Partial<KmsEnvelopeOptions>) {
    const resolved = resolveKmsEnvelopeOptions(options);
    this.options = resolved;
    this.id = resolved.provider === "aws" ? AWS_BACKEND_ID : PKCS11_BACKEND_ID;
    this.awsClientIsInjected =
      resolved.provider === "aws" && Boolean(resolved.client);
    if (resolved.provider === "aws") {
      this.awsClient = resolved.client;
    }
  }

  static fromEnv(): KmsEnvelopeKeystore {
    return new KmsEnvelopeKeystore();
  }

  async encrypt(
    privateKey: string,
    context?: KeystoreContext,
  ): Promise<EncryptedKey> {
    const dataKey = randomBytes(32);
    try {
      const wrappedDataKey = await this.wrapDataKey(dataKey, context);
      const encrypted = encryptWithDataKey(privateKey, dataKey);
      const metadata: EnvelopeMetadata = {
        backend: this.id,
        provider: this.options.provider,
        keyId: getConfiguredKeyId(this.options),
        wrappedDataKey: bytesToHex(wrappedDataKey),
      };
      return {
        ...encrypted,
        salt: encodeMetadata(metadata),
        backend: metadata.backend,
        provider: metadata.provider,
        keyId: metadata.keyId,
        wrappedDataKey: metadata.wrappedDataKey,
      };
    } finally {
      dataKey.fill(0);
    }
  }

  async decrypt(
    encrypted: EncryptedKey,
    context?: KeystoreContext,
  ): Promise<string> {
    const metadata = decodeMetadata(encrypted);
    if (!metadata) {
      throw new Error(
        "Encrypted key was not produced by a KMS envelope backend",
      );
    }
    if (metadata.backend !== this.id) {
      throw new Error(
        `Encrypted key backend mismatch: expected ${this.id}, got ${metadata.backend}`,
      );
    }
    if (metadata.provider !== this.options.provider) {
      throw new Error(
        `Encrypted key provider mismatch: expected ${this.options.provider}, got ${metadata.provider}`,
      );
    }

    const unwrappedDataKey = await this.unwrapDataKey(
      hexToBytes(metadata.wrappedDataKey),
      context,
    );
    const dataKey = Buffer.from(bytesToHex(unwrappedDataKey), "hex");
    try {
      if (dataKey.length !== 32) {
        throw new Error("KMS provider returned an invalid data key length");
      }
      return decryptWithDataKey(encrypted, dataKey);
    } finally {
      dataKey.fill(0);
    }
  }

  private async wrapDataKey(
    dataKey: Uint8Array,
    context?: KeystoreContext,
  ): Promise<Uint8Array> {
    if (this.options.provider === "aws") {
      const keyId = getConfiguredKeyId(this.options);
      if (!keyId) {
        throw new Error(
          "STEWARD_KMS_KEY_ID or STEWARD_AWS_KMS_KEY_ARN is required for AWS KMS",
        );
      }
      const client = await this.getAwsClient();
      const command = await this.createAwsEncryptCommand({
        KeyId: keyId,
        Plaintext: dataKey,
        EncryptionContext: contextToAwsEncryptionContext(context),
      });
      const response = (await client.send(command)) as {
        CiphertextBlob?: Uint8Array;
      };
      if (!response.CiphertextBlob) {
        throw new Error("AWS KMS Encrypt did not return CiphertextBlob");
      }
      return response.CiphertextBlob;
    }

    const client = await this.getPkcs11Client();
    return client.wrapKey(dataKey, context);
  }

  private async unwrapDataKey(
    wrappedDataKey: Uint8Array,
    context?: KeystoreContext,
  ): Promise<Uint8Array> {
    if (this.options.provider === "aws") {
      const client = await this.getAwsClient();
      const command = await this.createAwsDecryptCommand({
        CiphertextBlob: wrappedDataKey,
        EncryptionContext: contextToAwsEncryptionContext(context),
      });
      const response = (await client.send(command)) as {
        Plaintext?: Uint8Array;
      };
      if (!response.Plaintext) {
        throw new Error("AWS KMS Decrypt did not return Plaintext");
      }
      return response.Plaintext;
    }

    const client = await this.getPkcs11Client();
    return client.unwrapKey(wrappedDataKey, context);
  }

  private async getAwsClient(): Promise<AwsKmsClientLike> {
    if (this.options.provider !== "aws") {
      throw new Error("AWS KMS client requested for non AWS provider");
    }
    if (this.awsClient) return this.awsClient;

    const moduleName = "@aws-sdk/client-kms";
    const aws = (await import(moduleName)) as {
      KMSClient: new (config: { region?: string }) => AwsKmsClientLike;
    };
    this.awsClient = new aws.KMSClient({ region: this.options.region });
    return this.awsClient;
  }

  private async createAwsEncryptCommand(
    input: AwsEncryptCommandInput,
  ): Promise<unknown> {
    if (this.awsClientIsInjected)
      return { input, commandName: "EncryptCommand" };
    const moduleName = "@aws-sdk/client-kms";
    const aws = (await import(moduleName)) as {
      EncryptCommand: new (input: AwsEncryptCommandInput) => unknown;
    };
    return new aws.EncryptCommand(input);
  }

  private async createAwsDecryptCommand(
    input: AwsDecryptCommandInput,
  ): Promise<unknown> {
    if (this.awsClientIsInjected)
      return { input, commandName: "DecryptCommand" };
    const moduleName = "@aws-sdk/client-kms";
    const aws = (await import(moduleName)) as {
      DecryptCommand: new (input: AwsDecryptCommandInput) => unknown;
    };
    return new aws.DecryptCommand(input);
  }

  private async getPkcs11Client(): Promise<Pkcs11ClientLike> {
    if (this.options.provider !== "pkcs11") {
      throw new Error("PKCS#11 client requested for non PKCS#11 provider");
    }
    if (this.options.client) return this.options.client;

    const moduleName = "graphene-pk11";
    await import(moduleName);
    throw new Error(
      "PKCS#11 support requires a Pkcs11ClientLike adapter for C_WrapKey and C_UnwrapKey in this release",
    );
  }
}

export function resolveKmsEnvelopeOptions(
  options?: Partial<KmsEnvelopeOptions>,
): KmsEnvelopeOptions {
  const provider = (options?.provider ??
    process.env.STEWARD_KMS_PROVIDER ??
    "aws") as KmsProvider;
  if (provider === "aws") {
    const awsOptions = options as Partial<AwsKmsEnvelopeOptions> | undefined;
    return {
      provider: "aws",
      keyId:
        awsOptions?.keyId ??
        process.env.STEWARD_KMS_KEY_ID ??
        process.env.STEWARD_AWS_KMS_KEY_ARN,
      region:
        awsOptions?.region ??
        process.env.STEWARD_AWS_REGION ??
        process.env.AWS_REGION,
      client: awsOptions?.client,
    };
  }
  if (provider === "pkcs11") {
    const pkcs11Options = options as
      | Partial<Pkcs11KmsEnvelopeOptions>
      | undefined;
    return {
      provider: "pkcs11",
      modulePath:
        pkcs11Options?.modulePath ?? process.env.STEWARD_PKCS11_MODULE,
      pin: pkcs11Options?.pin ?? process.env.STEWARD_PKCS11_PIN,
      keyLabel: pkcs11Options?.keyLabel ?? process.env.STEWARD_PKCS11_KEY_LABEL,
      client: pkcs11Options?.client,
    };
  }
  throw new Error(`Unsupported STEWARD_KMS_PROVIDER: ${provider}`);
}

function getConfiguredKeyId(options: KmsEnvelopeOptions): string | undefined {
  return options.provider === "aws" ? options.keyId : options.keyLabel;
}
