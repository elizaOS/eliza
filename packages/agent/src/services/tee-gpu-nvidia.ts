/**
 * Fail-closed NVIDIA confidential-computing GPU attestation (Hopper/Blackwell
 * CC mode). Evidence comes from a sha256-pinned `nvattest collect-evidence`
 * compatible collector or from the caller, is appraised by NRAS
 * (`POST /v4/attest/gpu`, claims 3.0), and the returned detached EAT bundle
 * `[["JWT", overall], { "GPU-n": token }]` is verified locally: ES384 only,
 * pinned or x5c-anchored NRAS JWKS, issuer, time window, eat_nonce binding and
 * per-GPU appraisal claims. Only a verifier-branded result can be turned into
 * `gpuProtected` / `gpuFirmware` TEE evidence. Tokens and evidence are never
 * logged; failures throw `TEE_NVIDIA_GPU_ATTESTATION_REJECTED`.
 */
import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify as verifySignature,
  X509Certificate,
} from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute } from "node:path";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import type { TeeClaims, TeeMeasurements } from "./tee-evidence.ts";

/** NRAS v4 GPU appraisal endpoint (docs.nvidia.com attestation quick start). */
export const NVIDIA_NRAS_GPU_ATTEST_URL =
  "https://nras.attestation.nvidia.com/v4/attest/gpu";
/** NRAS signing keys; EC P-384 with an x5c chain, rotated frequently. */
export const NVIDIA_NRAS_JWKS_URL =
  "https://nras.attestation.nvidia.com/.well-known/jwks.json";
export const NVIDIA_NRAS_ISSUER = "https://nras.attestation.nvidia.com";
/**
 * SHA-256 (DER) of "NVIDIA Attestation Service GPU Intermediate 004", issued by
 * "NVIDIA Attestation Service CA 001", valid 2025-12-08..2029-12-08. Observed
 * as x5c[1] of every key in the production JWKS on 2026-09-28. Deployments
 * should re-confirm and pin it (or the CA) through signed configuration.
 */
export const NVIDIA_NRAS_GPU_INTERMEDIATE_004_SHA256 =
  "2df8907cf4d6c277b855d407ec178a649930a8e73f7294e8fce66e6ee27c5175";

export const NVIDIA_GPU_ATTESTATION_ERROR_CODE =
  "TEE_NVIDIA_GPU_ATTESTATION_REJECTED";

export type NvidiaGpuAttestationFailureReason =
  | "config"
  | "nonce"
  | "evidence"
  | "collector"
  | "transport"
  | "response"
  | "token-format"
  | "algorithm"
  | "key"
  | "signature"
  | "issuer"
  | "time"
  | "result"
  | "claims"
  | "policy"
  | "aborted";

function failure(
  reason: NvidiaGpuAttestationFailureReason,
  message: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code: NVIDIA_GPU_ATTESTATION_ERROR_CODE,
    context: { reason },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Reason attached to a rejection raised by this module, if any. */
export function nvidiaGpuAttestationFailureReason(
  error: unknown,
): NvidiaGpuAttestationFailureReason | undefined {
  if (
    error instanceof ElizaError &&
    error.code === NVIDIA_GPU_ATTESTATION_ERROR_CODE
  ) {
    return error.context?.reason as NvidiaGpuAttestationFailureReason;
  }
  return undefined;
}

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/i);
const nonceHex = z.string().regex(/^[0-9a-f]{64}$/i);
const httpsUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "must be an https URL",
  });
const architecture = z.enum(["HOPPER", "BLACKWELL"]);
export type NvidiaGpuArchitecture = z.infer<typeof architecture>;
const base64 = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const versionList = z.array(z.string().min(1)).min(1).optional();

const p384PublicJwk = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-384"),
  kid: z.string().min(1),
  x: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
  x5c: z.array(base64).min(1).optional(),
  alg: z.literal("ES384").optional(),
  use: z.literal("sig").optional(),
});
type P384PublicJwk = z.infer<typeof p384PublicJwk>;

export const nvidiaGpuAttestationConfiguration = z.object({
  nrasUrl: httpsUrl.default(NVIDIA_NRAS_GPU_ATTEST_URL),
  issuer: z.string().min(1).default(NVIDIA_NRAS_ISSUER),
  jwks: z.discriminatedUnion("source", [
    /** Offline/air-gapped: only these keys can sign accepted tokens. */
    z.object({
      source: z.literal("pinned"),
      keys: z.array(p384PublicJwk).min(1),
    }),
    /** Fetched over HTTPS; every used key's x5c must chain to an anchor. */
    z.object({
      source: z.literal("fetched"),
      url: httpsUrl.default(NVIDIA_NRAS_JWKS_URL),
      x5cTrustAnchorSha256: z.array(sha256Hex).min(1),
      cacheTtlMs: z.number().int().positive().max(3_600_000).default(600_000),
    }),
  ]),
  collector: z
    .object({
      /** `nvattest`-compatible binary: `collect-evidence --device gpu --nonce <hex> --format json`. */
      path: z.string().refine(isAbsolute),
      sha256: sha256Hex,
    })
    .optional(),
  /**
   * PEM trust roots replacing the default CA store for NRAS/JWKS HTTPS (a
   * private NRAS proxy). Omit to use the platform roots for NVIDIA's service.
   */
  trustedCaPem: z.string().includes("BEGIN CERTIFICATE").optional(),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(16 * 1024 * 1024)
    .default(4 * 1024 * 1024),
  clockSkewMs: z.number().int().nonnegative().max(300_000).default(60_000),
  maxTokenAgeMs: z.number().int().positive().max(3_600_000).default(300_000),
  policy: z
    .object({
      allowedArchitectures: z.array(architecture).min(1).optional(),
      allowedDriverVersions: versionList,
      allowedVbiosVersions: versionList,
      allowedHwModels: versionList,
      expectedGpuCount: z.number().int().positive().optional(),
      /** NRAS `x-nvidia-attestation-warning` rejects unless explicitly allowed. */
      allowAttestationWarnings: z.boolean().default(false),
    })
    .default({ allowAttestationWarnings: false }),
});
export type NvidiaGpuAttestationConfig = z.input<
  typeof nvidiaGpuAttestationConfiguration
>;
type Config = z.output<typeof nvidiaGpuAttestationConfiguration>;

const evidenceItem = z.object({ evidence: base64, certificate: base64 });
export const nvidiaGpuEvidenceSchema = z.object({
  arch: architecture,
  evidence_list: z.array(evidenceItem).min(1).max(64),
});
/** NRAS `evidence_list` payload; evidence/certificate are base64 as collected. */
export type NvidiaGpuEvidence = z.infer<typeof nvidiaGpuEvidenceSchema>;

/** `nvattest collect-evidence --format json` output. */
const collectorOutput = z.object({
  evidences: z
    .array(
      z.object({
        arch: z
          .string()
          .transform((value) => value.toUpperCase())
          .pipe(architecture),
        nonce: nonceHex,
        evidence: base64,
        certificate: base64,
      }),
    )
    .min(1)
    .max(64),
  result_code: z.literal(0),
});

export type NvidiaVerifiedGpu = {
  id: string;
  hwModel: string;
  driverVersion: string;
  vbiosVersion: string;
  ueid: string;
  oemid?: string;
};

export type NvidiaGpuVerifiedClaims = Readonly<{
  gpuProtected: true;
  gpuFirmware: Readonly<{ driver: string; vbios: string }>;
  /** Order-independent SHA-256 over every GPU's hwmodel/driver/vbios. */
  gpuFirmwareDigest: string;
  architecture: NvidiaGpuArchitecture;
  gpus: readonly Readonly<NvidiaVerifiedGpu>[];
  nonce: string;
  issuer: string;
  verifiedAt: string;
}>;

const verifiedResults = new WeakSet<object>();

const MAX_JWT_BYTES = 256 * 1024;
const ALLOWED_DIGEST_ALGS = new Set(["SHA-256", "SHA256"]);
/** Per-GPU claims 3.0 appraisal booleans which must all be exactly `true`. */
const REQUIRED_TRUE_GPU_CLAIMS = [
  "secboot",
  "x-nvidia-gpu-arch-check",
  "x-nvidia-gpu-attestation-report-parsed",
  "x-nvidia-gpu-attestation-report-nonce-match",
  "x-nvidia-gpu-attestation-report-signature-verified",
  "x-nvidia-gpu-attestation-report-cert-chain-fwid-match",
  "x-nvidia-gpu-driver-rim-fetched",
  "x-nvidia-gpu-driver-rim-schema-validated",
  "x-nvidia-gpu-driver-rim-signature-verified",
  "x-nvidia-gpu-driver-rim-version-match",
  "x-nvidia-gpu-driver-rim-measurements-available",
  "x-nvidia-gpu-vbios-rim-fetched",
  "x-nvidia-gpu-vbios-rim-schema-validated",
  "x-nvidia-gpu-vbios-rim-signature-verified",
  "x-nvidia-gpu-vbios-rim-version-match",
  "x-nvidia-gpu-vbios-rim-measurements-available",
  "x-nvidia-gpu-vbios-index-no-conflict",
] as const;
const REQUIRED_CERT_CHAIN_CLAIMS = [
  "x-nvidia-gpu-attestation-report-cert-chain",
  "x-nvidia-gpu-driver-rim-cert-chain",
  "x-nvidia-gpu-vbios-rim-cert-chain",
] as const;

type JwtPayload = Record<string, unknown>;

function linkedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw failure("aborted", "GPU attestation aborted", signal.reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64Url(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment))
    throw failure("token-format", "Token segment is not base64url");
  return Buffer.from(segment, "base64url");
}

function parseJsonSegment(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(segment).toString("utf8"));
  } catch (error) {
    // error-policy:J3 Malformed tokens never yield claims.
    throw failure("token-format", "Token segment is not JSON", error);
  }
  if (!isRecord(parsed))
    throw failure("token-format", "Token segment is not a JSON object");
  return parsed;
}

async function pinnedFile(path: string, digest: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw failure("collector", "GPU evidence collector must be a regular file");
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actual !== digest.toLowerCase())
    throw failure("collector", "GPU evidence collector digest mismatch");
}

/** HTTPS only, never follows redirects, bounded body, abortable. */
function httpsJson(
  url: string,
  init: { method: "GET" | "POST"; body?: string },
  config: Config,
  signal: AbortSignal,
): Promise<unknown> {
  const target = new URL(url);
  if (target.protocol !== "https:")
    throw failure("transport", "NVIDIA attestation endpoints must be HTTPS");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      target,
      {
        method: init.method,
        headers: {
          Accept: "application/json",
          ...(init.body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(init.body),
              }),
        },
        ...(config.trustedCaPem ? { ca: config.trustedCaPem } : {}),
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          res.destroy();
          reject(
            failure(
              "transport",
              status >= 300 && status < 400
                ? "NVIDIA attestation endpoint redirect refused"
                : `NVIDIA attestation endpoint returned HTTP ${status}`,
            ),
          );
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > config.maxResponseBytes) {
          res.destroy();
          reject(failure("response", "NRAS response exceeds size limit"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > config.maxResponseBytes) {
            res.destroy();
            reject(failure("response", "NRAS response exceeds size limit"));
          } else chunks.push(chunk);
        });
        res.on("error", (error) =>
          reject(failure("transport", "NRAS response stream failed", error)),
        );
        res.on("end", () => {
          if (size > config.maxResponseBytes) return;
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            // error-policy:J3 Non-JSON replies never yield attestation.
            reject(failure("response", "NRAS response is not JSON", error));
          }
        });
      },
    );
    req.on("error", (error) =>
      reject(
        signal.aborted
          ? failure("aborted", "GPU attestation aborted", signal.reason)
          : failure("transport", "NVIDIA attestation request failed", error),
      ),
    );
    req.end(init.body);
  });
}

type FetchedKey = { key: KeyObject; notAfter: number };

/** Returns the earliest notAfter (ms) of the verified chain segment. */
function verifyX5cChain(jwk: P384PublicJwk, anchors: Set<string>): number {
  if (!jwk.x5c)
    throw failure("key", "Fetched NRAS signing key has no x5c chain");
  let certs: X509Certificate[];
  try {
    certs = jwk.x5c.map(
      (entry) => new X509Certificate(Buffer.from(entry, "base64")),
    );
  } catch (error) {
    // error-policy:J3 Unparseable certificate chains never authorize a key.
    throw failure("key", "NRAS signing key x5c is not X.509", error);
  }
  const now = Date.now();
  let anchored = false;
  let notAfter = Number.POSITIVE_INFINITY;
  for (let i = 0; i < certs.length; i++) {
    const cert = certs[i];
    const validTo = Date.parse(cert.validTo);
    if (now < Date.parse(cert.validFrom) || !(now <= validTo))
      throw failure("key", "NRAS signing certificate is outside its validity");
    notAfter = Math.min(notAfter, validTo);
    if (anchors.has(createHash("sha256").update(cert.raw).digest("hex"))) {
      anchored = true;
      break;
    }
    const issuer = certs[i + 1];
    if (!issuer || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey))
      throw failure("key", "NRAS signing key x5c chain is not verifiable");
  }
  if (!anchored)
    throw failure("key", "NRAS signing key does not chain to a pinned anchor");
  const leaf = certs[0].publicKey.export({ format: "jwk" });
  if (leaf.crv !== "P-384" || leaf.x !== jwk.x || leaf.y !== jwk.y)
    throw failure("key", "NRAS signing key does not match its certificate");
  return notAfter;
}

class NrasKeyStore {
  private cached?: { at: number; keys: Map<string, FetchedKey> };
  private inFlight?: Promise<Map<string, FetchedKey>>;
  private readonly pinned?: Map<string, KeyObject>;

  constructor(private readonly config: Config) {
    if (config.jwks.source === "pinned") {
      this.pinned = new Map(
        config.jwks.keys.map((jwk) => [jwk.kid, toKeyObject(jwk)]),
      );
    }
  }

  async key(kid: string, signal: AbortSignal): Promise<KeyObject> {
    if (this.pinned) {
      const key = this.pinned.get(kid);
      if (!key) throw failure("key", "Token signed by an unpinned NRAS key");
      return key;
    }
    const jwks = this.config.jwks;
    if (jwks.source !== "fetched") throw failure("config", "Invalid JWKS mode");
    let keys =
      this.cached && Date.now() - this.cached.at < jwks.cacheTtlMs
        ? this.cached.keys
        : await this.refresh(signal);
    // NRAS rotates keys; an unknown kid forces one refresh before rejecting
    // unless the set was loaded within the last second.
    if (!keys.has(kid) && (this.cached?.at ?? 0) + 1_000 < Date.now())
      keys = await this.refresh(signal);
    const entry = keys.get(kid);
    if (!entry) throw failure("key", "Token signed by an unknown NRAS key");
    if (Date.now() > entry.notAfter)
      throw failure("key", "NRAS signing certificate has expired");
    return entry.key;
  }

  private refresh(signal: AbortSignal): Promise<Map<string, FetchedKey>> {
    this.inFlight ??= this.load(signal).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async load(signal: AbortSignal): Promise<Map<string, FetchedKey>> {
    const jwks = this.config.jwks;
    if (jwks.source !== "fetched") throw failure("config", "Invalid JWKS mode");
    const body = await httpsJson(
      jwks.url,
      { method: "GET" },
      this.config,
      signal,
    );
    const parsed = z
      .object({ keys: z.array(z.unknown()).min(1) })
      .safeParse(body);
    if (!parsed.success) throw failure("key", "NRAS JWKS is malformed");
    const anchors = new Set(
      jwks.x5cTrustAnchorSha256.map((value) => value.toLowerCase()),
    );
    const keys = new Map<string, FetchedKey>();
    for (const candidate of parsed.data.keys) {
      const jwk = p384PublicJwk.safeParse(candidate);
      // Keys of other types can never verify an ES384 token; skip them.
      if (!jwk.success) continue;
      let notAfter: number;
      try {
        notAfter = verifyX5cChain(jwk.data, anchors);
      } catch {
        // error-policy:J3 An unanchored key is excluded, never trusted.
        continue;
      }
      keys.set(jwk.data.kid, { key: toKeyObject(jwk.data), notAfter });
    }
    this.cached = { at: Date.now(), keys };
    return keys;
  }
}

function toKeyObject(jwk: P384PublicJwk): KeyObject {
  const material = {
    kty: "EC",
    crv: "P-384",
    x: jwk.x,
    y: jwk.y,
  };
  try {
    return createPublicKey({ key: material, format: "jwk" });
  } catch (error) {
    // error-policy:J3 Invalid curve points never become verification keys.
    throw failure("key", "NRAS JWK is not a valid P-384 point", error);
  }
}

async function verifyJwt(
  token: string,
  keys: NrasKeyStore,
  config: Config,
  signal: AbortSignal,
): Promise<JwtPayload> {
  if (Buffer.byteLength(token) > MAX_JWT_BYTES)
    throw failure("token-format", "Token exceeds size limit");
  const parts = token.split(".");
  if (parts.length !== 3)
    throw failure("token-format", "Token is not a compact JWS");
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = parseJsonSegment(headerSegment);
  if (header.alg !== "ES384")
    throw failure("algorithm", "Token algorithm must be ES384");
  if ("crit" in header || "jwk" in header || "jku" in header || "x5u" in header)
    throw failure(
      "algorithm",
      "Token header carries unsupported key or crit parameters",
    );
  if (typeof header.kid !== "string" || header.kid.length === 0)
    throw failure("key", "Token has no key identifier");
  const key = await keys.key(header.kid, signal);
  const signature = decodeBase64Url(signatureSegment);
  if (signature.length !== 96)
    throw failure("signature", "ES384 signature has the wrong length");
  const valid = verifySignature(
    "sha384",
    Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
    { key, dsaEncoding: "ieee-p1363" },
    signature,
  );
  if (!valid) throw failure("signature", "Token signature is invalid");
  const payload = parseJsonSegment(payloadSegment);
  if (payload.iss !== config.issuer)
    throw failure("issuer", "Token issuer is not the pinned NRAS issuer");
  const now = Date.now() / 1000;
  const skew = config.clockSkewMs / 1000;
  const { exp, iat, nbf } = payload;
  if (typeof exp !== "number" || typeof iat !== "number")
    throw failure("time", "Token lacks exp/iat");
  if (exp <= now - skew) throw failure("time", "Token has expired");
  if (iat > now + skew) throw failure("time", "Token issued in the future");
  if (now - iat > config.maxTokenAgeMs / 1000 + skew)
    throw failure("time", "Token is older than the freshness window");
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > now + skew))
    throw failure("time", "Token is not yet valid");
  return payload;
}

function requireNonce(payload: JwtPayload, nonce: string): void {
  if (
    typeof payload.eat_nonce !== "string" ||
    payload.eat_nonce.toLowerCase() !== nonce
  )
    throw failure("nonce", "Token eat_nonce does not match the challenge");
}

function requiredString(payload: JwtPayload, claim: string): string {
  const value = payload[claim];
  if (typeof value !== "string" || value.trim() === "")
    throw failure("claims", `GPU token lacks ${claim}`);
  return value;
}

function appraiseGpu(
  id: string,
  payload: JwtPayload,
  nonce: string,
  config: Config,
): NvidiaVerifiedGpu {
  requireNonce(payload, nonce);
  if (payload.measres !== "success")
    throw failure("result", "GPU measurement result is not success");
  if (payload.dbgstat !== "disabled")
    throw failure("result", "GPU debug mode is not disabled");
  for (const claim of REQUIRED_TRUE_GPU_CLAIMS) {
    if (payload[claim] !== true)
      throw failure("result", `GPU appraisal claim ${claim} is not true`);
  }
  for (const claim of REQUIRED_CERT_CHAIN_CLAIMS) {
    const chain = payload[claim];
    if (
      !isRecord(chain) ||
      chain["x-nvidia-cert-status"] !== "valid" ||
      chain["x-nvidia-cert-ocsp-status"] !== "good"
    )
      throw failure("result", `GPU certificate chain ${claim} is not valid`);
  }
  if (
    payload["x-nvidia-attestation-warning"] !== undefined &&
    payload["x-nvidia-attestation-warning"] !== null &&
    payload["x-nvidia-attestation-warning"] !== false &&
    !config.policy.allowAttestationWarnings
  )
    throw failure("policy", "NRAS reported an attestation warning");
  const gpu: NvidiaVerifiedGpu = {
    id,
    hwModel: requiredString(payload, "hwmodel"),
    driverVersion: requiredString(payload, "x-nvidia-gpu-driver-version"),
    vbiosVersion: requiredString(payload, "x-nvidia-gpu-vbios-version"),
    ueid: requiredString(payload, "ueid"),
    ...(typeof payload.oemid === "string" ? { oemid: payload.oemid } : {}),
  };
  const policy = config.policy;
  if (
    (policy.allowedDriverVersions &&
      !policy.allowedDriverVersions.includes(gpu.driverVersion)) ||
    (policy.allowedVbiosVersions &&
      !policy.allowedVbiosVersions.includes(gpu.vbiosVersion)) ||
    (policy.allowedHwModels && !policy.allowedHwModels.includes(gpu.hwModel))
  )
    throw failure(
      "policy",
      "GPU firmware or model is not in the pinned policy",
    );
  return gpu;
}

/**
 * Expected `gpuFirmware` measurement for a pinned fleet; equals the digest a
 * verified attestation of exactly these GPUs yields.
 */
export function nvidiaGpuFirmwareDigest(
  gpus: readonly Pick<
    NvidiaVerifiedGpu,
    "hwModel" | "driverVersion" | "vbiosVersion"
  >[],
): string {
  return firmwareDigest(gpus);
}

function firmwareDigest(
  gpus: readonly Pick<
    NvidiaVerifiedGpu,
    "hwModel" | "driverVersion" | "vbiosVersion"
  >[],
): string {
  const lines = gpus
    .map((gpu) => `${gpu.hwModel}\t${gpu.driverVersion}\t${gpu.vbiosVersion}`)
    .sort();
  return createHash("sha256")
    .update(`nvidia-gpu-firmware:v1\n${lines.join("\n")}`)
    .digest("hex");
}

/** Splits the RATS JSON-encoded detached EAT bundle NRAS returns. */
function splitEatBundle(body: unknown): {
  overall: string;
  detached: Record<string, string>;
} {
  if (
    !Array.isArray(body) ||
    body.length !== 2 ||
    !Array.isArray(body[0]) ||
    body[0].length !== 2 ||
    body[0][0] !== "JWT" ||
    typeof body[0][1] !== "string" ||
    !isRecord(body[1])
  )
    throw failure("response", "NRAS response is not a detached EAT bundle");
  const detached: Record<string, string> = {};
  for (const [key, value] of Object.entries(body[1])) {
    if (!/^GPU-\d+$/.test(key) || typeof value !== "string")
      throw failure("response", "NRAS detached token entry is malformed");
    detached[key] = value;
  }
  return { overall: body[0][1], detached };
}

function normalizeNonce(nonce: string): string {
  if (!nonceHex.safeParse(nonce).success)
    throw failure("nonce", "GPU attestation nonce must be 32 bytes of hex");
  return nonce.toLowerCase();
}

/**
 * Verifies NVIDIA CC-mode GPUs. `nonce` must be the caller's fresh 32-byte
 * challenge already bound to the CPU TEE report_data/session.
 */
export class NvidiaGpuAttestationVerifier {
  private readonly config: Config;
  private readonly keys: NrasKeyStore;

  constructor(input: NvidiaGpuAttestationConfig) {
    const parsed = nvidiaGpuAttestationConfiguration.safeParse(input);
    if (!parsed.success)
      throw failure(
        "config",
        "Invalid NVIDIA GPU attestation configuration",
        parsed.error,
      );
    this.config = parsed.data;
    this.keys = new NrasKeyStore(this.config);
  }

  /** Runs the pinned collector; evidence is unverified until appraised. */
  async collectEvidence(
    nonce: string,
    abortSignal?: AbortSignal,
  ): Promise<NvidiaGpuEvidence> {
    const challenge = normalizeNonce(nonce);
    const collector = this.config.collector;
    if (!collector)
      throw failure("config", "No pinned GPU evidence collector configured");
    const signal = linkedSignal(this.config.timeoutMs, abortSignal);
    throwIfAborted(signal);
    await pinnedFile(collector.path, collector.sha256);
    throwIfAborted(signal);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        collector.path,
        [
          "collect-evidence",
          "--device",
          "gpu",
          "--nonce",
          challenge,
          "--format",
          "json",
        ],
        {
          // No inherited loader, proxy or NVIDIA SDK override variables.
          env: { PATH: "/usr/bin:/bin" },
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let rejected: Error | undefined;
      const stop = (error: Error) => {
        rejected ??= error;
        if (process.platform === "win32" || child.pid === undefined) {
          child.kill("SIGKILL");
          return;
        }
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // error-policy:J6 An exited process group needs no teardown.
          child.kill("SIGKILL");
        }
      };
      const abort = () =>
        stop(
          failure("aborted", "GPU evidence collection aborted", signal.reason),
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const count = (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.config.maxResponseBytes) {
          stop(
            failure("collector", "GPU evidence collector output exceeds limit"),
          );
          return false;
        }
        return true;
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (count(chunk)) chunks.push(chunk);
      });
      child.stderr.on("data", count);
      child.on("error", (error) => {
        rejected ??= failure(
          "collector",
          "GPU evidence collector failed",
          error,
        );
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", abort);
        if (rejected) reject(rejected);
        else if (code !== 0)
          reject(
            failure("collector", "GPU evidence collector exited non-zero"),
          );
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    let output: z.infer<typeof collectorOutput>;
    try {
      output = collectorOutput.parse(JSON.parse(stdout));
    } catch (error) {
      // error-policy:J3 Malformed collector output never becomes evidence.
      throw failure(
        "collector",
        "GPU evidence collector output is malformed",
        error,
      );
    }
    const arch = output.evidences[0].arch;
    for (const item of output.evidences) {
      if (item.nonce.toLowerCase() !== challenge)
        throw failure(
          "nonce",
          "Collected GPU evidence is bound to another nonce",
        );
      if (item.arch !== arch)
        throw failure("evidence", "Collected GPU evidence mixes architectures");
    }
    return this.parseEvidence({
      arch,
      evidence_list: output.evidences.map(({ evidence, certificate }) => ({
        evidence,
        certificate,
      })),
    });
  }

  /**
   * Collects (or accepts caller evidence), appraises with NRAS and verifies
   * the EAT bundle locally. Throws unless every GPU is verified.
   */
  async attest(
    nonce: string,
    options: { evidence?: NvidiaGpuEvidence; signal?: AbortSignal } = {},
  ): Promise<NvidiaGpuVerifiedClaims> {
    const challenge = normalizeNonce(nonce);
    const signal = linkedSignal(this.config.timeoutMs, options.signal);
    const evidence = options.evidence
      ? this.parseEvidence(options.evidence)
      : await this.collectEvidence(challenge, signal);
    throwIfAborted(signal);
    const body = JSON.stringify({
      nonce: challenge,
      arch: evidence.arch,
      evidence_list: evidence.evidence_list,
      claims_version: "3.0",
    });
    if (Buffer.byteLength(body) > this.config.maxResponseBytes)
      throw failure("evidence", "GPU evidence exceeds protocol size limit");
    const response = await httpsJson(
      this.config.nrasUrl,
      { method: "POST", body },
      this.config,
      signal,
    );
    return this.#verifyEatBundle(challenge, evidence, response, signal);
  }

  /** Only the authenticated NRAS exchange may supply a detached bundle. */
  async #verifyEatBundle(
    nonce: string,
    evidence: NvidiaGpuEvidence,
    response: unknown,
    abortSignal?: AbortSignal,
  ): Promise<NvidiaGpuVerifiedClaims> {
    const challenge = normalizeNonce(nonce);
    const submitted = this.parseEvidence(evidence);
    const signal = linkedSignal(this.config.timeoutMs, abortSignal);
    const { overall, detached } = splitEatBundle(response);
    const overallClaims = await verifyJwt(
      overall,
      this.keys,
      this.config,
      signal,
    );
    requireNonce(overallClaims, challenge);
    if (overallClaims["x-nvidia-ver"] !== "3.0")
      throw failure("claims", "NRAS token is not claims version 3.0");
    if (overallClaims["x-nvidia-overall-att-result"] !== true)
      throw failure("result", "NRAS overall attestation result is not true");
    const submods = overallClaims.submods;
    if (!isRecord(submods))
      throw failure("claims", "NRAS overall token lacks submods");
    const ids = Object.keys(detached).sort();
    const expectedIds = submitted.evidence_list.map(
      (_, index) => `GPU-${index}`,
    );
    if (
      JSON.stringify(ids) !== JSON.stringify([...expectedIds].sort()) ||
      JSON.stringify(Object.keys(submods).sort()) !== JSON.stringify(ids)
    )
      throw failure(
        "claims",
        "NRAS results do not cover exactly the submitted GPUs",
      );
    // The submods digest covers NRAS's pre-serialization claims JSON, which is
    // not reproducible from the signed token; each detached token is instead
    // verified independently (signature, issuer, time and eat_nonce). The
    // bundle mapping must therefore come from the authenticated NRAS HTTPS
    // response above; accepting caller-supplied detached mappings would lose
    // that binding. Distinct signed device identities are required below.
    for (const id of ids) {
      const entry = submods[id];
      if (
        !Array.isArray(entry) ||
        entry[0] !== "DIGEST" ||
        !Array.isArray(entry[1]) ||
        !ALLOWED_DIGEST_ALGS.has(entry[1][0]) ||
        !sha256Hex.safeParse(entry[1][1]).success
      )
        throw failure("claims", "NRAS submods digest entry is malformed");
    }
    const gpus: NvidiaVerifiedGpu[] = [];
    const deviceIdentities = new Set<string>();
    for (const id of ids) {
      throwIfAborted(signal);
      const payload = await verifyJwt(
        detached[id],
        this.keys,
        this.config,
        signal,
      );
      const gpu = appraiseGpu(id, payload, challenge, this.config);
      if (deviceIdentities.has(gpu.ueid))
        throw failure("claims", "NRAS results repeat a GPU device identity");
      deviceIdentities.add(gpu.ueid);
      gpus.push(gpu);
    }
    const policy = this.config.policy;
    if (
      policy.expectedGpuCount !== undefined &&
      gpus.length !== policy.expectedGpuCount
    )
      throw failure("policy", "Verified GPU count does not match policy");
    if (
      policy.allowedArchitectures &&
      !policy.allowedArchitectures.includes(submitted.arch)
    )
      throw failure("policy", "GPU architecture is not allowed by policy");
    const driver = gpus[0].driverVersion;
    const vbios = gpus[0].vbiosVersion;
    if (
      gpus.some(
        (gpu) => gpu.driverVersion !== driver || gpu.vbiosVersion !== vbios,
      )
    )
      throw failure(
        "policy",
        "GPUs report heterogeneous driver or VBIOS versions",
      );
    const result: NvidiaGpuVerifiedClaims = Object.freeze({
      gpuProtected: true as const,
      gpuFirmware: Object.freeze({ driver, vbios }),
      gpuFirmwareDigest: firmwareDigest(gpus),
      architecture: submitted.arch,
      gpus: Object.freeze(gpus.map((gpu) => Object.freeze(gpu))),
      nonce: challenge,
      issuer: this.config.issuer,
      verifiedAt: new Date().toISOString(),
    });
    verifiedResults.add(result);
    return result;
  }

  private parseEvidence(evidence: NvidiaGpuEvidence): NvidiaGpuEvidence {
    const parsed = nvidiaGpuEvidenceSchema.safeParse(evidence);
    if (!parsed.success)
      throw failure("evidence", "GPU evidence is malformed", parsed.error);
    return parsed.data;
  }
}

/**
 * The only supported way to derive TEE GPU claims: accepts solely results
 * produced by `NvidiaGpuAttestationVerifier` in this process, and requires the
 * result to be bound to `expectedNonce` (the challenge in the CPU quote).
 */
export function gpuClaimsFromVerifiedNvidiaAttestation(
  verified: NvidiaGpuVerifiedClaims,
  expectedNonce: string,
): {
  claims: Required<Pick<TeeClaims, "gpuProtected">>;
  measurements: Required<Pick<TeeMeasurements, "gpuFirmware">>;
  freshness: { nonce: string; timestamp: string; verifier: string };
} {
  if (!verifiedResults.has(verified))
    throw failure(
      "result",
      "GPU claims require a locally verified NVIDIA attestation",
    );
  if (verified.nonce !== normalizeNonce(expectedNonce))
    throw failure(
      "nonce",
      "Verified GPU attestation is bound to another nonce",
    );
  return {
    claims: { gpuProtected: true },
    measurements: { gpuFirmware: verified.gpuFirmwareDigest },
    freshness: {
      nonce: verified.nonce,
      timestamp: verified.verifiedAt,
      verifier: `nvidia-nras:${verified.issuer}`,
    },
  };
}
