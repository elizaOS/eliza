import {
  NotImplementedError,
  KmsError,
  type EncryptResult,
  type GetOrCreateKeyOptions,
  type KeyHandle,
  type KeyId,
  type KeyVersion,
  type KmsClient,
  type SignResult,
  type SignatureAlgorithm,
} from "./types.js";

/**
 * Production adapter — talks to Steward's credential-proxy / KMS endpoints.
 *
 * Steward (https://github.com/Steward-Fi/steward) is the open-source agent-
 * wallet / credential-proxy / auth platform Eliza uses in production. The
 * KMS endpoints listed below MUST exist on the Steward side for this adapter
 * to function. Until then every method throws `NotImplementedError` with the
 * exact endpoint path that needs to be implemented.
 *
 * Steward changes required (TODO(steward-soc2)):
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

  // The HTTP plumbing is wired but every call route is a stub until Steward
  // ships the endpoints above. We keep the helper to make the wire format
  // explicit and easy to flip on once Steward is ready.
  private async call(
    _method: "GET" | "POST",
    path: string,
    _body?: unknown,
  ): Promise<never> {
    // TODO(steward-soc2): remove this throw once Steward implements the endpoint.
    throw new NotImplementedError(
      `Steward endpoint not yet available: ${endpoint(this.baseUrl, path)}`,
    );
  }

  async getOrCreateKey(
    keyId: KeyId,
    opts: GetOrCreateKeyOptions = {},
  ): Promise<KeyHandle> {
    return this.call("POST", `/v1/kms/keys`, { keyId, ...opts });
  }

  async rotateKey(
    keyId: KeyId,
  ): Promise<{ keyId: KeyId; newVersion: KeyVersion }> {
    return this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/rotate`,
    );
  }

  async listKeyVersions(keyId: KeyId): Promise<KeyVersion[]> {
    return this.call(
      "GET",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/versions`,
    );
  }

  async encrypt(
    keyId: KeyId,
    _plaintext: Uint8Array,
    _aad?: Uint8Array,
  ): Promise<EncryptResult> {
    return this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/encrypt`,
    );
  }

  async decrypt(
    keyId: KeyId,
    _ciphertext: Uint8Array,
    _nonce: Uint8Array,
    _authTag: Uint8Array,
    _aad?: Uint8Array,
    _keyVersion?: KeyVersion,
  ): Promise<Uint8Array> {
    return this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/decrypt`,
    );
  }

  async hmac(keyId: KeyId, _data: Uint8Array): Promise<Uint8Array> {
    return this.call("POST", `/v1/kms/keys/${encodeURIComponent(keyId)}/hmac`);
  }

  async hmacVerify(
    keyId: KeyId,
    _data: Uint8Array,
    _tag: Uint8Array,
  ): Promise<boolean> {
    return this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/hmac/verify`,
    );
  }

  async sign(
    keyId: KeyId,
    _data: Uint8Array,
    _algo?: SignatureAlgorithm,
  ): Promise<SignResult> {
    return this.call("POST", `/v1/kms/keys/${encodeURIComponent(keyId)}/sign`);
  }

  async verify(
    keyId: KeyId,
    _data: Uint8Array,
    _signature: Uint8Array,
    _algo?: SignatureAlgorithm,
  ): Promise<boolean> {
    return this.call(
      "POST",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/verify`,
    );
  }

  async getPublicKey(keyId: KeyId): Promise<Uint8Array> {
    return this.call(
      "GET",
      `/v1/kms/keys/${encodeURIComponent(keyId)}/public`,
    );
  }

  /** Exposed for diagnostics — the auth token the adapter will use next. */
  async _resolveToken(): Promise<string> {
    return this.tokenProvider();
  }
}
