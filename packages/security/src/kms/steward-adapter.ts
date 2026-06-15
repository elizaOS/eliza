import {
  type EncryptResult,
  type GetOrCreateKeyOptions,
  type KeyHandle,
  type KeyId,
  type KeyVersion,
  type KmsClient,
  KmsError,
  type SignatureAlgorithm,
  type SignResult,
} from "./types.js";

/**
 * Production adapter — talks to Steward's credential-proxy / KMS endpoints.
 *
 * Steward (https://github.com/Steward-Fi/steward) is the open-source agent-
 * wallet / credential-proxy / auth platform Eliza uses in production. The
 * KMS endpoints listed below MUST exist on the Steward side for this adapter
 * to function. This adapter implements the client wire format and fails loudly
 * on missing or malformed Steward responses.
 *
 * Steward endpoint contract:
 *
 *   POST   /v1/kms/keys                          { keyId, rotationDays? } -> { keyId, version }
 *   POST   /v1/kms/keys/:keyId/rotate            -> { keyId, newVersion }
 *   GET    /v1/kms/keys/:keyId/versions          -> { versions: number[] }
 *   POST   /v1/kms/keys/:keyId/encrypt           { plaintext_b64, aad_b64? } -> { ciphertext_b64, nonce_b64, auth_tag_b64, version }
 *   POST   /v1/kms/keys/:keyId/decrypt           { ciphertext_b64, nonce_b64, auth_tag_b64, aad_b64?, version? } -> { plaintext_b64 }
 *   POST   /v1/kms/keys/:keyId/hmac              { data_b64 } -> { tag_b64 }
 *   POST   /v1/kms/keys/:keyId/hmac/verify       { data_b64, tag_b64 } -> { valid: boolean }
 *   POST   /v1/kms/keys/:keyId/sign              { data_b64, algorithm } -> { signature_b64, algorithm, version }
 *   POST   /v1/kms/keys/:keyId/verify            { data_b64, signature_b64, algorithm } -> { valid: boolean }
 *   GET    /v1/kms/keys/:keyId/public            { algorithm? } -> { public_key_b64, algorithm }
 *
 * All requests authenticate via short-lived OIDC bearer (preferred) or mTLS;
 * the adapter reuses the credential-proxy auth pattern from
 * `packages/cloud-api/src/steward/embedded.ts`.
 */

export interface StewardKmsOptions {
  /** Base URL of the Steward instance, e.g. https://steward.example.com */
  baseUrl: string;
  /** OIDC bearer token (short-lived). Caller is responsible for refresh. */
  tokenProvider: () => Promise<string>;
  /** Optional fetch override (e.g. undici with mTLS dispatcher). */
  fetch?: typeof fetch;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function endpoint(base: string, path: string): string {
  return `${trimSlash(base)}${path}`;
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string, field: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch (err) {
    throw new KmsError(
      `Steward KMS response field ${field} is not valid base64: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new KmsError(`Steward KMS response missing string field: ${field}`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new KmsError(`Steward KMS response missing integer field: ${field}`);
  }
  return value;
}

function requireBoolean(
  record: Record<string, unknown>,
  field: string,
): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new KmsError(`Steward KMS response missing boolean field: ${field}`);
  }
  return value;
}

function optionalBase64(
  field: string,
  bytes?: Uint8Array,
): Record<string, string> {
  return bytes ? { [field]: encodeBase64(bytes) } : {};
}

export class StewardKmsAdapter implements KmsClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StewardKmsOptions) {
    if (!opts.baseUrl) throw new KmsError("StewardKmsAdapter requires baseUrl");
    this.baseUrl = trimSlash(opts.baseUrl);
    this.tokenProvider = opts.tokenProvider;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const token = await this.tokenProvider();
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const url = endpoint(this.baseUrl, path);
    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    let parsed: unknown = {};
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new KmsError(
          `Steward KMS ${method} ${path} returned invalid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (!response.ok) {
      const message =
        isRecord(parsed) && typeof parsed.error === "string"
          ? parsed.error
          : isRecord(parsed) && typeof parsed.message === "string"
            ? parsed.message
            : text.trim();
      throw new KmsError(
        `Steward KMS ${method} ${path} failed (${response.status}${
          response.statusText ? ` ${response.statusText}` : ""
        })${message ? `: ${message}` : ""}`,
      );
    }

    if (!isRecord(parsed)) {
      throw new KmsError(
        `Steward KMS ${method} ${path} returned non-object JSON`,
      );
    }
    return parsed;
  }

  async getOrCreateKey(
    keyId: KeyId,
    opts: GetOrCreateKeyOptions = {},
  ): Promise<KeyHandle> {
    const out = await this.call("POST", `/v1/kms/keys`, { keyId, ...opts });
    return {
      keyId: requireString(out, "keyId"),
      version: requireNumber(out, "version"),
    };
  }

  async rotateKey(
    keyId: KeyId,
  ): Promise<{ keyId: KeyId; newVersion: KeyVersion }> {
    const out = await this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/rotate`,
    );
    return {
      keyId: requireString(out, "keyId"),
      newVersion: requireNumber(out, "newVersion"),
    };
  }

  async listKeyVersions(keyId: KeyId): Promise<KeyVersion[]> {
    const out = await this.call(
      "GET",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/versions`,
    );
    const versions = out.versions;
    if (
      !Array.isArray(versions) ||
      versions.some((version) => !Number.isInteger(version))
    ) {
      throw new KmsError("Steward KMS response missing integer versions array");
    }
    return versions;
  }

  async encrypt(
    keyId: KeyId,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Promise<EncryptResult> {
    const out = await this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/encrypt`,
      {
        plaintext_b64: encodeBase64(plaintext),
        ...optionalBase64("aad_b64", aad),
      },
    );
    return {
      ciphertext: decodeBase64(
        requireString(out, "ciphertext_b64"),
        "ciphertext_b64",
      ),
      nonce: decodeBase64(requireString(out, "nonce_b64"), "nonce_b64"),
      authTag: decodeBase64(requireString(out, "auth_tag_b64"), "auth_tag_b64"),
      keyId,
      keyVersion: requireNumber(out, "version"),
    };
  }

  async decrypt(
    keyId: KeyId,
    ciphertext: Uint8Array,
    nonce: Uint8Array,
    authTag: Uint8Array,
    aad?: Uint8Array,
    keyVersion?: KeyVersion,
  ): Promise<Uint8Array> {
    const out = await this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/decrypt`,
      {
        ciphertext_b64: encodeBase64(ciphertext),
        nonce_b64: encodeBase64(nonce),
        auth_tag_b64: encodeBase64(authTag),
        ...(keyVersion !== undefined ? { version: keyVersion } : {}),
        ...optionalBase64("aad_b64", aad),
      },
    );
    return decodeBase64(requireString(out, "plaintext_b64"), "plaintext_b64");
  }

  async hmac(keyId: KeyId, data: Uint8Array): Promise<Uint8Array> {
    const out = await this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/hmac`,
      { data_b64: encodeBase64(data) },
    );
    return decodeBase64(requireString(out, "tag_b64"), "tag_b64");
  }

  async hmacVerify(
    keyId: KeyId,
    data: Uint8Array,
    tag: Uint8Array,
  ): Promise<boolean> {
    const out = await this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/hmac/verify`,
      {
        data_b64: encodeBase64(data),
        tag_b64: encodeBase64(tag),
      },
    );
    return requireBoolean(out, "valid");
  }

  async sign(
    keyId: KeyId,
    data: Uint8Array,
    algo: SignatureAlgorithm = "ed25519",
  ): Promise<SignResult> {
    const out = await this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/sign`,
      { data_b64: encodeBase64(data), algorithm: algo },
    );
    const algorithm = requireString(out, "algorithm") as SignatureAlgorithm;
    if (algorithm !== "ed25519" && algorithm !== "rsa-pss-sha256") {
      throw new KmsError(
        `Steward KMS response has unsupported algorithm: ${algorithm}`,
      );
    }
    return {
      signature: decodeBase64(
        requireString(out, "signature_b64"),
        "signature_b64",
      ),
      algorithm,
      keyId,
      keyVersion: requireNumber(out, "version"),
    };
  }

  async verify(
    keyId: KeyId,
    data: Uint8Array,
    signature: Uint8Array,
    algo: SignatureAlgorithm = "ed25519",
  ): Promise<boolean> {
    const out = await this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/verify`,
      {
        data_b64: encodeBase64(data),
        signature_b64: encodeBase64(signature),
        algorithm: algo,
      },
    );
    return requireBoolean(out, "valid");
  }

  async getPublicKey(keyId: KeyId): Promise<Uint8Array> {
    const out = await this.call(
      "GET",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/public`,
    );
    return decodeBase64(requireString(out, "public_key_b64"), "public_key_b64");
  }

  /** Exposed for diagnostics — the auth token the adapter will use next. */
  async _resolveToken(): Promise<string> {
    return this.tokenProvider();
  }
}
