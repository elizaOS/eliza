/**
 * TEE key-release clients: turn a passing attestation into released key
 * material. `LocalTeeKeyReleaseClient` is a hardware-free HMAC KDF for dev and
 * unit tests; `HttpTeeKeyReleaseClient` is the production path that talks to an
 * RA-TLS KMS, binding each request to a fresh ephemeral X25519 key and
 * `report_data = SHA256(nonce || epk_pub)` so a passively captured quote or
 * wrapped key cannot be replayed. Also defines the
 * `x25519-hkdf-sha256-aes-256-gcm` wrap format plus the `wrapTeeReleaseKey`
 * and unwrap helpers a real KMS adapter reuses. Consumed by the
 * confidential-inference unseal path (`tee-confidential-inference.ts`).
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { TeeEvidence, TeeEvidenceProvider } from "./tee-evidence.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "./tee-policy.ts";

export type TeeKeyReleaseRequest = {
  keyId: string;
  context?: string;
  policy: TeeEvidencePolicy;
};

export type TeeKeyReleaseResult = {
  keyId: string;
  keyMaterialHex: string;
  decision: TeeEvidencePolicyDecision;
};

export type TeeKeyReleaseClient = {
  releaseKey: (request: TeeKeyReleaseRequest) => Promise<TeeKeyReleaseResult>;
};

/**
 * A provider that can re-collect evidence bound to a freshly issued
 * `report_data`. Real in-domain attestation agents accept a `reportData`
 * input and emit a quote whose `report_data` field equals it. The local
 * stand-in simply stamps it onto the evidence so the binding can be unit
 * tested without hardware.
 */
export type TeeReportDataChallenge = {
  /** Fresh verifier nonce the agent issued for this release request. */
  nonce: string;
  /** report_data = SHA256(nonce || epk_pub) the quote must be bound to. */
  reportDataHex: string;
};

export type TeeReportDataBoundEvidenceProvider = TeeEvidenceProvider & {
  collectEvidenceWithReportData?: (
    challenge: TeeReportDataChallenge,
  ) => Promise<TeeEvidence>;
};

export type LocalTeeKeyReleaseClientConfig = {
  evidenceProvider: TeeEvidenceProvider;
  masterSecretHex?: string;
  onDecision?: (decision: TeeEvidencePolicyDecision) => void;
};

export type HttpTeeKeyReleaseClientConfig = {
  baseUrl: string;
  evidenceProvider: TeeReportDataBoundEvidenceProvider;
  fetch?: typeof fetch;
  token?: string;
  onDecision?: (decision: TeeEvidencePolicyDecision) => void;
  env?: Record<string, string | undefined>;
  /**
   * Require RA-TLS-grade transport: refuse plain `http:` KMS URLs and refuse
   * to run while `NODE_TLS_REJECT_UNAUTHORIZED=0`. Set by the production
   * profile. Defends against dstack #609 (KMS attestation bypass via a
   * disabled-TLS gateway).
   */
  requireSecureTransport?: boolean;
};

/**
 * LOCAL/DEV ONLY. An HMAC KDF that models "deterministic app-key bound to
 * measured identity". It is NOT a KMS: the master secret lives in agent
 * memory. It must never be used under a production profile — the boot gate
 * routes production through {@link HttpTeeKeyReleaseClient} against a real
 * RA-TLS KMS. Kept solely as a hardware-free stand-in for unit tests and the
 * local harness.
 */
export class LocalTeeKeyReleaseClient implements TeeKeyReleaseClient {
  readonly mode = "local-dev-kdf" as const;
  private readonly masterSecret: Buffer;

  constructor(private readonly config: LocalTeeKeyReleaseClientConfig) {
    this.masterSecret = config.masterSecretHex
      ? Buffer.from(config.masterSecretHex, "hex")
      : randomBytes(32);
    if (this.masterSecret.length < 32) {
      throw new Error(
        "TEE key-release master secret must be at least 32 bytes.",
      );
    }
  }

  async releaseKey(
    request: TeeKeyReleaseRequest,
  ): Promise<TeeKeyReleaseResult> {
    const evidence = await this.config.evidenceProvider.collectEvidence();
    const decision = evaluateTeeEvidencePolicy(evidence, request.policy);
    this.config.onDecision?.(decision);
    if (!decision.trusted || !decision.evidence) {
      throw new Error(
        `TEE key release rejected evidence: ${decision.detail ?? decision.reason}`,
      );
    }
    return {
      keyId: request.keyId,
      keyMaterialHex: deriveKeyMaterial({
        masterSecret: this.masterSecret,
        keyId: request.keyId,
        context: request.context,
        agentMeasurement: decision.evidence.measurements?.agent,
        policyMeasurement: decision.evidence.measurements?.policy,
        deviceMeasurement: decision.evidence.measurements?.device,
      }),
      decision,
    };
  }
}

type ReportDataBinding = {
  nonce: string;
  reportDataHex: string;
  privateKey: KeyObject;
  publicKeyDer: Buffer;
};

export class HttpTeeKeyReleaseClient implements TeeKeyReleaseClient {
  private readonly baseUrl: string;
  private readonly request: typeof fetch;

  constructor(private readonly config: HttpTeeKeyReleaseClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl, {
      requireHttps: config.requireSecureTransport === true,
    });
    if (config.requireSecureTransport === true) {
      assertSecureTransportEnv(config.env ?? process.env);
    }
    this.request = config.fetch ?? fetch;
  }

  async releaseKey(
    request: TeeKeyReleaseRequest,
  ): Promise<TeeKeyReleaseResult> {
    // Generate a fresh ephemeral X25519 keypair + nonce per request and bind
    // report_data = SHA256(nonce || epk_pub). This closes the replay gap: a
    // passively captured quote/key cannot be reused because it is bound to an
    // ephemeral key that never leaves this process. The policy carries the
    // nonce we issued, so evaluateTeeEvidencePolicy rejects nonce-mismatch.
    const binding = createReportDataBinding();
    const policy: TeeEvidencePolicy = {
      ...request.policy,
      expectedNonce: binding.nonce,
    };
    const evidence = await collectEvidenceBoundToReportData(
      this.config.evidenceProvider,
      binding,
    );
    assertEvidenceReportDataMatches(evidence, binding.reportDataHex);

    const response = await this.request(
      new URL("/v1/tee/key-release", this.baseUrl),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.config.token === undefined
            ? {}
            : { authorization: `Bearer ${this.config.token}` }),
        },
        body: JSON.stringify({
          keyId: request.keyId,
          context: request.context,
          policy,
          evidence,
          nonce: binding.nonce,
          ephemeralPublicKey: binding.publicKeyDer.toString("base64"),
          reportData: binding.reportDataHex,
        }),
      },
    );
    const payload = await readJsonResponse(response);
    const decision = payload.decision;
    if (decision) {
      this.config.onDecision?.(decision);
    }
    if (!response.ok || !decision?.trusted) {
      throw new Error(
        `TEE key release rejected evidence: ${
          decision?.detail ?? decision?.reason ?? response.status
        }`,
      );
    }
    // The KMS MUST echo the nonce we issued. A response that omits or alters
    // it is treated as a replay/forgery and rejected before any key is used.
    if (
      typeof payload.nonce !== "string" ||
      !constantTimeStringEquals(payload.nonce, binding.nonce)
    ) {
      throw new Error(
        "TEE key release response did not echo the request nonce.",
      );
    }
    if (typeof payload.keyId !== "string" || payload.keyId !== request.keyId) {
      throw new Error("TEE key release response is malformed.");
    }
    // The KMS MUST return the key wrapped to the ephemeral public key the
    // client generated for THIS request (plan §3.2 step 5). We unwrap with the
    // matching private key, which never left this process — so a passively
    // captured response cannot be decrypted by anyone else, and a key not
    // actually wrapped to our epk fails the AEAD tag check below.
    const wrapped = parseWrappedTeeKey(payload.wrappedKey);
    const keyMaterialHex = unwrapTeeReleaseKey(
      wrapped,
      binding.privateKey,
      binding.nonce,
    );
    // Zeroize the ephemeral binding inputs we still hold in memory.
    binding.publicKeyDer.fill(0);
    return {
      keyId: payload.keyId,
      keyMaterialHex,
      decision,
    };
  }
}

/**
 * A key wrapped to the requesting agent's ephemeral X25519 public key. The KMS
 * performs X25519 ECDH against the agent's epk, derives an AES-256 key with
 * HKDF-SHA256 (salted by the request nonce), and AES-256-GCM-encrypts the
 * released key material. Only the holder of the ephemeral private key (the
 * in-domain agent) can unwrap it.
 */
export type WrappedTeeKey = {
  algorithm: "x25519-hkdf-sha256-aes-256-gcm";
  /** KMS ephemeral X25519 public key, base64 SPKI DER. */
  kmsEphemeralPublicKey: string;
  ivBase64: string;
  authTagBase64: string;
  ciphertextBase64: string;
};

const WRAP_ALGORITHM = "x25519-hkdf-sha256-aes-256-gcm" as const;
const WRAP_HKDF_INFO = "elizaos-tee-key-release/v1";

function deriveWrapKey(sharedSecret: Buffer, nonceHex: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(nonceHex, "hex"),
      Buffer.from(WRAP_HKDF_INFO, "utf8"),
      32,
    ),
  );
}

/**
 * KMS-side helper: wrap `keyMaterialHex` to the agent's ephemeral public key.
 * Exported so a real KMS adapter, the local harness, and tests produce the
 * exact wire shape {@link HttpTeeKeyReleaseClient} unwraps. The wrap key is
 * zeroized after use.
 */
export function wrapTeeReleaseKey(options: {
  keyMaterialHex: string;
  agentEphemeralPublicKeyDerBase64: string;
  nonceHex: string;
}): WrappedTeeKey {
  const keyMaterial = Buffer.from(options.keyMaterialHex, "hex");
  const agentPub = createPublicKey({
    key: Buffer.from(options.agentEphemeralPublicKeyDerBase64, "base64"),
    format: "der",
    type: "spki",
  });
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey, publicKey: agentPub });
  const wrapKey = deriveWrapKey(shared, options.nonceHex);
  shared.fill(0);
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", wrapKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(keyMaterial),
      cipher.final(),
    ]);
    return {
      algorithm: WRAP_ALGORITHM,
      kmsEphemeralPublicKey: publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64"),
      ivBase64: iv.toString("base64"),
      authTagBase64: cipher.getAuthTag().toString("base64"),
      ciphertextBase64: ciphertext.toString("base64"),
    };
  } finally {
    wrapKey.fill(0);
    keyMaterial.fill(0);
  }
}

function unwrapTeeReleaseKey(
  wrapped: WrappedTeeKey,
  agentPrivateKey: KeyObject,
  nonceHex: string,
): string {
  const kmsPub = createPublicKey({
    key: Buffer.from(wrapped.kmsEphemeralPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({
    privateKey: agentPrivateKey,
    publicKey: kmsPub,
  });
  const wrapKey = deriveWrapKey(shared, nonceHex);
  shared.fill(0);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      wrapKey,
      Buffer.from(wrapped.ivBase64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(wrapped.authTagBase64, "base64"));
    // A key not actually wrapped to our epk (wrong shared secret) fails the
    // GCM tag check here rather than yielding usable material.
    const keyMaterial = Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertextBase64, "base64")),
      decipher.final(),
    ]);
    const hex = keyMaterial.toString("hex");
    keyMaterial.fill(0);
    if (!/^[a-f0-9]{64}$/.test(hex)) {
      throw new Error("Unwrapped TEE key material must be 32 bytes.");
    }
    return hex;
  } finally {
    wrapKey.fill(0);
  }
}

function parseWrappedTeeKey(value: unknown): WrappedTeeKey {
  if (!value || typeof value !== "object") {
    throw new Error("TEE key release response did not include a wrapped key.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.algorithm !== WRAP_ALGORITHM) {
    throw new Error(
      `TEE key release wrap algorithm must be "${WRAP_ALGORITHM}".`,
    );
  }
  for (const field of [
    "kmsEphemeralPublicKey",
    "ivBase64",
    "authTagBase64",
    "ciphertextBase64",
  ] as const) {
    if (typeof candidate[field] !== "string" || candidate[field] === "") {
      throw new Error(`TEE key release wrapped key is missing "${field}".`);
    }
  }
  return value as WrappedTeeKey;
}

function createReportDataBinding(): ReportDataBinding {
  const nonce = randomBytes(32).toString("hex");
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const reportDataHex = createHash("sha256")
    .update(Buffer.from(nonce, "hex"))
    .update(publicKeyDer)
    .digest("hex");
  return { nonce, reportDataHex, privateKey, publicKeyDer };
}

async function collectEvidenceBoundToReportData(
  provider: TeeReportDataBoundEvidenceProvider,
  binding: ReportDataBinding,
): Promise<TeeEvidence> {
  if (typeof provider.collectEvidenceWithReportData === "function") {
    return await provider.collectEvidenceWithReportData({
      nonce: binding.nonce,
      reportDataHex: binding.reportDataHex,
    });
  }
  // No report_data-aware provider: stamp the binding so the policy nonce check
  // still applies. A real in-domain agent supplies collectEvidenceWithReportData
  // so the quote's report_data is genuinely bound; this fallback only carries
  // the nonce/reportData fields and must not be relied on for hardware trust.
  const evidence = await provider.collectEvidence();
  return {
    ...evidence,
    reportData: binding.reportDataHex,
    freshness: {
      ...(evidence.freshness ?? {}),
      nonce: binding.nonce,
    },
  };
}

function assertEvidenceReportDataMatches(
  evidence: TeeEvidence,
  reportDataHex: string,
): void {
  if (
    evidence.reportData !== undefined &&
    !constantTimeStringEquals(
      evidence.reportData.toLowerCase(),
      reportDataHex.toLowerCase(),
    )
  ) {
    throw new Error(
      "TEE evidence report_data is not bound to the request nonce/epk.",
    );
  }
}

function deriveKeyMaterial(options: {
  masterSecret: Buffer;
  keyId: string;
  context?: string;
  agentMeasurement?: string;
  policyMeasurement?: string;
  deviceMeasurement?: string;
}): string {
  return createHmac("sha256", options.masterSecret)
    .update(`key:${options.keyId}\n`)
    .update(`context:${options.context ?? ""}\n`)
    .update(`agent:${options.agentMeasurement ?? ""}\n`)
    .update(`policy:${options.policyMeasurement ?? ""}\n`)
    .update(`device:${options.deviceMeasurement ?? ""}\n`)
    .digest("hex");
}

async function readJsonResponse(response: Response): Promise<{
  keyId?: unknown;
  wrappedKey?: unknown;
  nonce?: unknown;
  decision?: TeeEvidencePolicyDecision;
}> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as {
      keyId?: unknown;
      wrappedKey?: unknown;
      nonce?: unknown;
      decision?: TeeEvidencePolicyDecision;
    };
  } catch {
    throw new Error("TEE key release response is not valid JSON.");
  }
}

function constantTimeStringEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizeBaseUrl(
  value: string,
  options: { requireHttps: boolean },
): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TEE key release baseUrl must be http(s).");
  }
  if (options.requireHttps && url.protocol !== "https:") {
    throw new Error(
      "TEE key release requires an https:/RA-TLS KMS URL under the production profile.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function assertSecureTransportEnv(
  env: Record<string, string | undefined>,
): void {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error(
      "Refusing TEE key release with NODE_TLS_REJECT_UNAUTHORIZED=0 under the production profile.",
    );
  }
}
