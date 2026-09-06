/**
 * Optional third-party anchoring for signed audit checkpoints.
 *
 * Disabled means exactly disabled: no sink is constructed and no network call
 * is made. RFC 3161 is the reference implementation; the interface is public
 * so another append-only witness can be supplied without changing bundle
 * assembly.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "@elizaos/logger";
import {
  canonicalCheckpointBytes,
  type SignedCheckpoint,
} from "./audit-checkpoint";

export type AuditCheckpointAnchorMode = "off" | "best-effort" | "required";

export interface Rfc3161CheckpointAnchorProof {
  v: 1;
  type: "rfc3161";
  sinkId: string;
  hashAlgorithm: "sha256";
  /** SHA-256 of canonicalCheckpointBytes(checkpoint.payload). */
  checkpointDigest: string;
  /** Request nonce, verified inside the signed TSTInfo by OpenSSL. */
  nonce: string;
  policyOid: string;
  genTime: string;
  accuracyMillis: number;
  verifiedAt: string;
  /** SHA-256 of the operator-configured acquisition trust-anchor PEM bytes. */
  trustAnchorSha256: string;
  /** Base64 DER TimeStampResp, including the TSA certificate when supplied. */
  timestampResponse: string;
}

/** Provider-native evidence from an operator-registered append-only witness. */
export interface CustomCheckpointAnchorProof {
  v: 1;
  type: "custom";
  /** Must equal the provider name used at registration/configuration. */
  provider: string;
  sinkId: string;
  hashAlgorithm: "sha256";
  /** SHA-256 of canonicalCheckpointBytes(checkpoint.payload). */
  checkpointDigest: string;
  /** Time at which the registered verifier accepted this exact proof. */
  verifiedAt: string;
  /** Opaque, JSON-serializable provider proof retained append-only in the bundle/DB. */
  evidence: Record<string, unknown>;
}

export type AuditCheckpointAnchorProof =
  | Rfc3161CheckpointAnchorProof
  | CustomCheckpointAnchorProof;

export interface AuditCheckpointAnchorSink {
  readonly id: string;
  anchor(checkpoint: SignedCheckpoint): Promise<AuditCheckpointAnchorProof>;
}

export type AuditCheckpointAnchorSinkFactory = () => AuditCheckpointAnchorSink;
export type AuditCheckpointAnchorProofVerifier = (
  checkpoint: SignedCheckpoint,
  proof: CustomCheckpointAnchorProof,
) => Promise<void> | void;

interface RegisteredAnchorProvider {
  factory: AuditCheckpointAnchorSinkFactory;
  verify: AuditCheckpointAnchorProofVerifier;
}

const registeredSinkProviders = new Map<string, RegisteredAnchorProvider>();

/** Register an operator-supplied append-only witness implementation. */
export function registerAuditCheckpointAnchorSink(
  provider: string,
  factory: AuditCheckpointAnchorSinkFactory,
  verify: AuditCheckpointAnchorProofVerifier,
): () => void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider) || provider === "rfc3161") {
    throw new AuditCheckpointAnchorError(
      "Custom checkpoint anchor provider name is invalid",
    );
  }
  if (typeof verify !== "function") {
    throw new AuditCheckpointAnchorError(
      "Custom checkpoint anchor provider requires a proof verifier",
    );
  }
  if (registeredSinkProviders.has(provider)) {
    throw new AuditCheckpointAnchorError(
      `Checkpoint anchor provider ${provider} is already registered`,
    );
  }
  const registration = { factory, verify };
  registeredSinkProviders.set(provider, registration);
  return () => {
    if (registeredSinkProviders.get(provider) === registration) {
      registeredSinkProviders.delete(provider);
    }
  };
}

export interface Rfc3161TimestampSinkOptions {
  url: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  caFile: string;
  untrustedFile?: string;
  expectedPolicyOid?: string;
  maxPastAgeMs?: number;
  maxFutureSkewMs?: number;
  opensslPath?: string;
}

export class AuditCheckpointAnchorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditCheckpointAnchorError";
  }
}

const MAX_TIMESTAMP_RESPONSE_BYTES = 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(content.length), content);
}

/** Digest anchored by the TSA. The Ed25519 signature authenticates these bytes separately. */
export function auditCheckpointAnchorDigest(
  checkpoint: SignedCheckpoint,
): string {
  return createHash("sha256")
    .update(canonicalCheckpointBytes(checkpoint.payload))
    .digest("hex");
}

/**
 * DER TimeStampReq v1 with SHA-256 MessageImprint, an unpredictable 128-bit
 * nonce, and certReq=true. The nonce is mandatory: it prevents a previously
 * issued token from satisfying a new required-mode acquisition.
 */
export function createRfc3161TimestampQuery(
  checkpointDigest: string,
  nonceBytes: Uint8Array = randomBytes(16),
): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(checkpointDigest)) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 checkpoint digest must be 32-byte lowercase hex",
    );
  }
  const sha256AlgorithmIdentifier = Uint8Array.from([
    0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02,
    0x01, 0x05, 0x00,
  ]);
  if (nonceBytes.length !== 16 || nonceBytes.every((byte) => byte === 0)) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 nonce must be a non-zero 128-bit value",
    );
  }
  const imprint = der(
    0x30,
    concatBytes(
      sha256AlgorithmIdentifier,
      der(0x04, hexToBytes(checkpointDigest)),
    ),
  );
  let integer = nonceBytes;
  while (integer.length > 1 && integer[0] === 0) integer = integer.slice(1);
  if ((integer[0] & 0x80) !== 0)
    integer = concatBytes(Uint8Array.of(0), integer);
  return der(
    0x30,
    concatBytes(
      der(0x02, Uint8Array.of(1)),
      imprint,
      der(0x02, integer),
      der(0x01, Uint8Array.of(0xff)),
    ),
  );
}

interface DerElement {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

function readDerElement(bytes: Uint8Array, offset: number): DerElement {
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  if (tag === undefined || firstLength === undefined) {
    throw new AuditCheckpointAnchorError("RFC 3161 response is truncated");
  }
  let length = 0;
  let contentStart = offset + 2;
  if ((firstLength & 0x80) === 0) {
    length = firstLength;
  } else {
    const lengthBytes = firstLength & 0x7f;
    if (
      lengthBytes < 1 ||
      lengthBytes > 3 ||
      contentStart + lengthBytes > bytes.length
    ) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 response has an invalid DER length",
      );
    }
    if (bytes[contentStart] === 0) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 response has a non-canonical DER length",
      );
    }
    for (let i = 0; i < lengthBytes; i++)
      length = length * 256 + bytes[contentStart + i];
    if (length < 128) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 response has a non-canonical DER length",
      );
    }
    contentStart += lengthBytes;
  }
  const end = contentStart + length;
  if (end > bytes.length)
    throw new AuditCheckpointAnchorError("RFC 3161 response is truncated");
  return { tag, start: offset, contentStart, end };
}

/** Reject malformed, denied, or token-less TSA responses before attaching them. */
export function assertGrantedRfc3161Response(bytes: Uint8Array): void {
  if (bytes.length < 7 || bytes.length > MAX_TIMESTAMP_RESPONSE_BYTES) {
    throw new AuditCheckpointAnchorError("RFC 3161 response size is invalid");
  }
  const outer = readDerElement(bytes, 0);
  if (outer.tag !== 0x30 || outer.end !== bytes.length) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 response is not one canonical DER sequence",
    );
  }
  const statusInfo = readDerElement(bytes, outer.contentStart);
  if (statusInfo.tag !== 0x30) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 response is missing PKIStatusInfo",
    );
  }
  const status = readDerElement(bytes, statusInfo.contentStart);
  if (status.tag !== 0x02 || status.end - status.contentStart !== 1) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 response has an invalid PKIStatus",
    );
  }
  const statusValue = bytes[status.contentStart];
  if (statusValue !== 0 && statusValue !== 1) {
    throw new AuditCheckpointAnchorError(
      `RFC 3161 TSA rejected the request (status ${statusValue})`,
    );
  }
  if (statusInfo.end >= outer.end) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 granted response did not include a timestamp token",
    );
  }
  const token = readDerElement(bytes, statusInfo.end);
  if (token.tag !== 0x30 || token.end !== outer.end) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 response contains an invalid timestamp token",
    );
  }
}

export interface VerifiedRfc3161Token {
  policyOid: string;
  genTime: string;
  accuracyMillis: number;
  trustAnchorSha256: string;
}

function parseAccuracyMillis(text: string): number | null {
  const line = text.match(/^Accuracy:\s*(.+)$/m)?.[1];
  if (!line || /^\s*unspecified\s*$/i.test(line)) return null;
  let foundComponent = false;
  const number = (name: string) => {
    const value = line.match(
      new RegExp(`(?:0x([0-9a-f]+)|([0-9]+))\\s+${name}`, "i"),
    );
    if (value) foundComponent = true;
    return value
      ? Number.parseInt(value[1] ?? value[2], value[1] ? 16 : 10)
      : 0;
  };
  const accuracyMillis =
    number("seconds") * 1000 + number("millis") + number("micros") / 1000;
  return foundComponent ? accuracyMillis : Number.NaN;
}

/**
 * Strict acquisition verification. `openssl ts -verify -queryfile` validates
 * the TimeStampResp/CMS SignedData/TSTInfo structure, signed message imprint,
 * signed nonce, signer EKU/signature, and certificate path to `caFile`.
 */
export function verifyRfc3161TimestampResponse(input: {
  query: Uint8Array;
  response: Uint8Array;
  caFile: string;
  untrustedFile?: string;
  expectedPolicyOid?: string;
  opensslPath?: string;
  requestStartedAt: number;
  verifiedAt?: number;
  maxPastAgeMs: number;
  maxFutureSkewMs: number;
}): VerifiedRfc3161Token {
  const directory = mkdtempSync(join(tmpdir(), "steward-tsa-acquire-"));
  const queryPath = join(directory, "request.tsq");
  const responsePath = join(directory, "response.tsr");
  const caPath = join(directory, "trusted-ca.pem");
  const untrustedPath = join(directory, "untrusted.pem");
  const openssl = input.opensslPath ?? "openssl";
  try {
    const caBytes = readFileSync(input.caFile);
    writeFileSync(queryPath, input.query, { mode: 0o600 });
    writeFileSync(responsePath, input.response, { mode: 0o600 });
    writeFileSync(caPath, caBytes, { mode: 0o600 });
    if (input.untrustedFile) {
      writeFileSync(untrustedPath, readFileSync(input.untrustedFile), {
        mode: 0o600,
      });
    }
    const inspected = spawnSync(
      openssl,
      ["ts", "-reply", "-in", responsePath, "-text"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (inspected.error || inspected.status !== 0) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 CMS/TSTInfo trust verification failed",
      );
    }
    const text = inspected.stdout;
    const policyOid = text.match(/^Policy OID:\s*([^\s]+)\s*$/m)?.[1];
    const timeText = text.match(/^Time stamp:\s*(.+)$/m)?.[1];
    const nonce = text.match(/^Nonce:\s*(0x[0-9a-f]+|[0-9]+)\s*$/im)?.[1];
    if (
      !policyOid ||
      !timeText ||
      !nonce ||
      !/^Hash Algorithm:\s*sha256\s*$/im.test(text)
    ) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 TSTInfo is missing required signed fields",
      );
    }
    if (input.expectedPolicyOid && policyOid !== input.expectedPolicyOid) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 TSA policy OID is not allowed",
      );
    }
    const genTimeMs = Date.parse(timeText);
    if (!Number.isFinite(genTimeMs)) {
      throw new AuditCheckpointAnchorError("RFC 3161 genTime is not parseable");
    }
    // RFC 3161 tokens are long-lived evidence. Validate the TSA certificate
    // path at the signed generation time, rather than at the later acquisition
    // or audit time when the signing certificate may legitimately be expired.
    // The inspected time is not trusted until this verification succeeds.
    const args = [
      "ts",
      "-verify",
      "-queryfile",
      queryPath,
      "-in",
      responsePath,
      "-CAfile",
      caPath,
      "-attime",
      String(Math.floor(genTimeMs / 1000)),
    ];
    if (input.untrustedFile) args.push("-untrusted", untrustedPath);
    const verified = spawnSync(openssl, args, {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (verified.error || verified.status !== 0) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 CMS/TSTInfo trust verification failed",
        {
          cause: verified.error,
        },
      );
    }
    const accuracyMillis = parseAccuracyMillis(text);
    if (accuracyMillis === null) {
      throw new AuditCheckpointAnchorError("RFC 3161 accuracy is missing");
    }
    if (!Number.isFinite(accuracyMillis) || accuracyMillis < 0) {
      throw new AuditCheckpointAnchorError("RFC 3161 accuracy is invalid");
    }
    const verifiedAt = input.verifiedAt ?? Date.now();
    // The signed time can be anywhere inside [genTime-accuracy,
    // genTime+accuracy]. Require the entire interval to fit the configured
    // acquisition window; mere overlap would let an imprecise TSA bypass the
    // freshness bound.
    if (
      genTimeMs - accuracyMillis <
      input.requestStartedAt - input.maxPastAgeMs
    ) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 genTime is stale for this acquisition",
      );
    }
    if (genTimeMs + accuracyMillis > verifiedAt + input.maxFutureSkewMs) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 genTime is implausibly in the future",
      );
    }
    return {
      policyOid,
      genTime: new Date(genTimeMs).toISOString(),
      accuracyMillis,
      trustAnchorSha256: createHash("sha256").update(caBytes).digest("hex"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function readTimestampResponse(
  response: Response,
  signal: AbortSignal,
  deadline: Promise<never>,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(
      await Promise.race([response.arrayBuffer(), deadline]),
    );
    if (bytes.length > MAX_TIMESTAMP_RESPONSE_BYTES) {
      throw new AuditCheckpointAnchorError("RFC 3161 response exceeds 1 MiB");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => {
    void Promise.resolve(reader.cancel()).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.length;
      if (total > MAX_TIMESTAMP_RESPONSE_BYTES) {
        cancel();
        throw new AuditCheckpointAnchorError("RFC 3161 response exceeds 1 MiB");
      }
      chunks.push(chunk);
    }
    return concatBytes(...chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      reader.releaseLock();
    } catch {
      // A hostile or already-cancelled stream must not replace the sanitized
      // transport error or extend the acquisition deadline.
    }
  }
}

function validateTimestampUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuditCheckpointAnchorError(
      "STEWARD_AUDIT_RFC3161_URL must be a valid URL",
    );
  }
  if (url.username || url.password) {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 URL must not contain credentials",
    );
  }
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new AuditCheckpointAnchorError(
      "RFC 3161 URL must use HTTPS in production",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AuditCheckpointAnchorError("RFC 3161 URL must use HTTP or HTTPS");
  }
  return url;
}

export class Rfc3161TimestampSink implements AuditCheckpointAnchorSink {
  readonly id = "rfc3161";
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly options: Rfc3161TimestampSinkOptions;

  constructor(options: Rfc3161TimestampSinkOptions) {
    this.url = validateTimestampUrl(options.url);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 60_000
    ) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 timeout must be between 100 and 60000ms",
      );
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!options.caFile?.trim()) {
      throw new AuditCheckpointAnchorError(
        "RFC 3161 trusted CA file is required",
      );
    }
    this.options = options;
  }

  async anchor(
    checkpoint: SignedCheckpoint,
  ): Promise<Rfc3161CheckpointAnchorProof> {
    const checkpointDigest = auditCheckpointAnchorDigest(checkpoint);
    const nonceBytes = randomBytes(16);
    const nonce = bytesToHex(nonceBytes);
    const query = createRfc3161TimestampQuery(checkpointDigest, nonceBytes);
    const requestStartedAt = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new AuditCheckpointAnchorError(
            "RFC 3161 timestamp request timed out",
          ),
        );
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            Accept: "application/timestamp-reply",
            "Content-Type": "application/timestamp-query",
          },
          // Both Node/Bun and Workers accept Uint8Array bodies. workers-types in
          // this package narrows BodyInit incompatibly, so preserve the runtime
          // value while widening only the compile-time view.
          body: query as unknown as string,
          redirect: "error",
          signal: controller.signal,
        }),
        deadline,
      ]);
      if (!response.ok) {
        throw new AuditCheckpointAnchorError(
          `RFC 3161 TSA returned HTTP ${response.status}`,
        );
      }
      if (
        (response.headers.get("content-type") ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/timestamp-reply"
      ) {
        throw new AuditCheckpointAnchorError(
          "RFC 3161 TSA returned an invalid content type",
        );
      }
      const declaredLength = Number(
        response.headers.get("content-length") ?? "0",
      );
      if (
        !Number.isFinite(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > MAX_TIMESTAMP_RESPONSE_BYTES
      ) {
        throw new AuditCheckpointAnchorError("RFC 3161 response exceeds 1 MiB");
      }
      const bytes = await readTimestampResponse(
        response,
        controller.signal,
        deadline,
      );
      assertGrantedRfc3161Response(bytes);
      const verifiedAt = Date.now();
      const verified = verifyRfc3161TimestampResponse({
        query,
        response: bytes,
        caFile: this.options.caFile,
        untrustedFile: this.options.untrustedFile,
        expectedPolicyOid: this.options.expectedPolicyOid,
        opensslPath: this.options.opensslPath,
        requestStartedAt,
        verifiedAt,
        maxPastAgeMs: this.options.maxPastAgeMs ?? 5 * 60_000,
        maxFutureSkewMs: this.options.maxFutureSkewMs ?? 5 * 60_000,
      });
      return {
        v: 1,
        type: "rfc3161",
        sinkId: this.id,
        hashAlgorithm: "sha256",
        checkpointDigest,
        nonce,
        policyOid: verified.policyOid,
        genTime: verified.genTime,
        accuracyMillis: verified.accuracyMillis,
        verifiedAt: new Date(verifiedAt).toISOString(),
        trustAnchorSha256: verified.trustAnchorSha256,
        timestampResponse: bytesToBase64(bytes),
      };
    } catch (error) {
      if (error instanceof AuditCheckpointAnchorError) throw error;
      throw new AuditCheckpointAnchorError(
        "RFC 3161 timestamp request failed",
        {
          cause: error,
        },
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function configuredMode(): AuditCheckpointAnchorMode {
  const value =
    process.env.STEWARD_AUDIT_CHECKPOINT_ANCHOR_MODE?.trim() || "off";
  if (value === "off" || value === "best-effort" || value === "required")
    return value;
  throw new AuditCheckpointAnchorError(
    "STEWARD_AUDIT_CHECKPOINT_ANCHOR_MODE must be off, best-effort, or required",
  );
}

export function configuredAuditCheckpointAnchor(): {
  mode: AuditCheckpointAnchorMode;
  sink?: AuditCheckpointAnchorSink;
  provider?: string;
  verify?: AuditCheckpointAnchorProofVerifier;
} {
  const mode = configuredMode();
  if (mode === "off") return { mode };
  const provider =
    process.env.STEWARD_AUDIT_CHECKPOINT_ANCHOR_PROVIDER?.trim() || "rfc3161";
  if (provider !== "rfc3161") {
    const registration = registeredSinkProviders.get(provider);
    if (!registration) {
      throw new AuditCheckpointAnchorError(
        `Checkpoint anchor provider ${provider} is not registered`,
      );
    }
    return {
      mode,
      provider,
      sink: registration.factory(),
      verify: registration.verify,
    };
  }
  const url = process.env.STEWARD_AUDIT_RFC3161_URL?.trim();
  if (!url) {
    throw new AuditCheckpointAnchorError(
      "STEWARD_AUDIT_RFC3161_URL is required when checkpoint anchoring is enabled",
    );
  }
  const rawTimeout = process.env.STEWARD_AUDIT_RFC3161_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : undefined;
  const caFile = process.env.STEWARD_AUDIT_RFC3161_CA_FILE?.trim();
  if (!caFile) {
    throw new AuditCheckpointAnchorError(
      "STEWARD_AUDIT_RFC3161_CA_FILE is required when RFC 3161 anchoring is enabled",
    );
  }
  const seconds = (name: string, fallback: number) => {
    const raw = process.env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isSafeInteger(value) || value < 0 || value > 3600) {
      throw new AuditCheckpointAnchorError(
        `${name} must be an integer from 0 to 3600 seconds`,
      );
    }
    return value * 1000;
  };
  return {
    mode,
    provider: "rfc3161",
    sink: new Rfc3161TimestampSink({
      url,
      timeoutMs,
      caFile,
      untrustedFile: process.env.STEWARD_AUDIT_RFC3161_UNTRUSTED_FILE?.trim(),
      expectedPolicyOid: process.env.STEWARD_AUDIT_RFC3161_POLICY_OID?.trim(),
      maxPastAgeMs: seconds("STEWARD_AUDIT_RFC3161_MAX_AGE_SECONDS", 300),
      maxFutureSkewMs: seconds(
        "STEWARD_AUDIT_RFC3161_MAX_FUTURE_SKEW_SECONDS",
        300,
      ),
    }),
  };
}

function assertCustomAnchorProofShape(
  checkpoint: SignedCheckpoint,
  sink: AuditCheckpointAnchorSink,
  provider: string,
  proof: AuditCheckpointAnchorProof,
): asserts proof is CustomCheckpointAnchorProof {
  if (proof.type !== "custom") {
    throw new AuditCheckpointAnchorError(
      "Custom checkpoint anchor sink returned a non-custom proof",
    );
  }
  if (
    proof.v !== 1 ||
    proof.provider !== provider ||
    proof.sinkId !== sink.id ||
    proof.hashAlgorithm !== "sha256" ||
    proof.checkpointDigest !== auditCheckpointAnchorDigest(checkpoint) ||
    !Number.isFinite(Date.parse(proof.verifiedAt)) ||
    !proof.evidence ||
    typeof proof.evidence !== "object" ||
    Array.isArray(proof.evidence)
  ) {
    throw new AuditCheckpointAnchorError(
      "Custom checkpoint anchor proof does not bind the configured provider, sink, and checkpoint",
    );
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(proof.evidence);
  } catch {
    throw new AuditCheckpointAnchorError(
      "Custom checkpoint anchor evidence must be JSON serializable",
    );
  }
  if (!encoded || new TextEncoder().encode(encoded).length > 1024 * 1024) {
    throw new AuditCheckpointAnchorError(
      "Custom checkpoint anchor evidence must be non-empty and at most 1 MiB",
    );
  }
}

/** Anchor according to environment policy; required mode never degrades silently. */
export async function maybeAnchorAuditCheckpoint(
  checkpoint: SignedCheckpoint,
  configured: {
    mode: AuditCheckpointAnchorMode;
    sink?: AuditCheckpointAnchorSink;
    provider?: string;
    verify?: AuditCheckpointAnchorProofVerifier;
  } = configuredAuditCheckpointAnchor(),
): Promise<AuditCheckpointAnchorProof | undefined> {
  if (configured.mode === "off") return undefined;
  if (!configured.sink) {
    throw new AuditCheckpointAnchorError(
      "Checkpoint anchor sink is not configured",
    );
  }
  try {
    const proof = await configured.sink.anchor(checkpoint);
    const provider = configured.provider ?? proof.type;
    if (provider === "rfc3161") {
      if (
        proof.type !== "rfc3161" ||
        proof.sinkId !== configured.sink.id ||
        proof.checkpointDigest !== auditCheckpointAnchorDigest(checkpoint)
      ) {
        throw new AuditCheckpointAnchorError(
          "RFC 3161 checkpoint proof does not bind the configured sink and checkpoint",
        );
      }
      return proof;
    }
    if (!configured.verify) {
      throw new AuditCheckpointAnchorError(
        "Custom checkpoint anchor provider requires a proof verifier",
      );
    }
    assertCustomAnchorProofShape(checkpoint, configured.sink, provider, proof);
    await configured.verify(checkpoint, proof);
    return { ...proof, verifiedAt: new Date().toISOString() };
  } catch (error) {
    if (configured.mode === "required") {
      throw error instanceof AuditCheckpointAnchorError
        ? error
        : new AuditCheckpointAnchorError(
            "Required checkpoint anchoring failed",
            { cause: error },
          );
    }
    logger.error(
      {
        details: [
          "[audit] best-effort checkpoint anchoring failed; returning unanchored bundle",
        ],
      },
      "[Login:audit-checkpoint-anchor] error",
    );
    return undefined;
  }
}
