/**
 * On-device CoVE / AP-TEE quote: typed structure, real DICE cert-chain
 * verification, and mapping into the normalized `TeeEvidence` shape.
 *
 * Unlike the cloud TDX path (Phase B2), the on-device CoVE quote is rooted in
 * OUR OpenTitan-class RoT via a DICE chain (UDS -> CDI -> Alias key; the M-mode
 * TSM signs the quote with the DICE Alias key). Trust is self-rooted: there is
 * no dependency on Intel PCS collateral or a cloud QE. So a real quote-and-verify
 * is buildable and testable entirely locally with real cryptography.
 *
 * Format conformance. The measurement set, claim derivation, freshness shape,
 * and `reportData` binding mirror the chip-side reference serializer
 * (packages/research/chip/scripts/tee/teeevidence_quote.py): `kind:"cove"`,
 * `provider:"eliza-riscv"`, `verifier:"eliza-local-verifier"`,
 * `reportData = sha256(nonce_utf8 || ephemeral_pubkey)`. That model is unsigned
 * (the silicon attestation key is BLOCKED there). This module adds the real
 * cryptographic layer the silicon must reproduce: a DICE Ed25519 certificate
 * chain (RoT root -> DeviceID -> per-boot Alias) and an Alias signature over the
 * quote body. The chip DICE lane (packages/research/chip/fw/dice/cdi.{c,h},
 * ed25519_sign.{c,h}) derives DeviceID/Alias as Ed25519 keypairs from
 * CDI_monitor, so Ed25519 is the matching algorithm here (RFC 8032), not P-256.
 *
 * Certificates are canonical-JSON TBS bodies signed by their issuer's Ed25519
 * key, not X.509 DER. This is a deliberate format choice: a freestanding M-mode
 * TSM can emit byte-exact canonical JSON without an ASN.1 encoder, and the
 * verifier here is the reference the silicon reproduces. The TBS canonical form
 * is the documented contract (see `canonicalTbsBytes`).
 */

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
  timingSafeEqual,
} from "node:crypto";
import {
  normalizeTeeEvidence,
  type TeeClaims,
  type TeeEvidence,
  type TeeMeasurementName,
  type TeeMeasurements,
} from "@elizaos/agent/services/tee-evidence";

/** Measurement registers a CoVE quote carries (RTMR-equivalents). */
export type CoveMeasurements = {
  /** RoT boot register: extend over rom || lifecycle || BL1 || BL2. */
  boot: string;
  /** M-mode TSM / security-monitor image digest. */
  monitor: string;
  /** Guest OS register: kernel || initramfs || DTB at TVM finalize. */
  os: string;
  /** TEE policy JSON digest. */
  policy: string;
  /** Platform identity / device-policy digest (DeviceID SPKI-bound). */
  device: string;
  /** Agent package / protected-agent guest digest. */
  agent?: string;
  /** NPU firmware + queue-policy digest (private-inference path only). */
  npuFirmware?: string;
  /** Sealed model-weights digest (confidential-AI binding). */
  modelWeights?: string;
};

/** Boolean security conditions the quote attests. */
export type CoveClaims = {
  secureBoot: boolean;
  debugDisabled: boolean;
  productionLifecycle: boolean;
  memoryEncrypted: boolean;
  ioProtected: boolean;
  npuProtected: boolean;
  /** The M-mode TSM was measured and folded into the DICE chain. */
  monitorMeasured: boolean;
};

/**
 * A DICE certificate: a TBS body signed by the issuer's Ed25519 key. The
 * `subjectPublicKey`/`signature` are base64url raw 32-/64-byte Ed25519 values.
 * The chain links by `issuer === subject` of the parent cert.
 */
export type DiceCertificate = {
  /** Stable identity of the certificate subject (e.g. "E1-DICE-DeviceID"). */
  subject: string;
  /** Identity of the issuer; the parent cert's `subject` (root self-issues). */
  issuer: string;
  /** base64url raw 32-byte Ed25519 public key of the subject. */
  subjectPublicKey: string;
  /** Stage measurements folded into this layer's CDI (sha256:hex), if any. */
  measurements?: Partial<Record<TeeMeasurementName, string>>;
  /** Monotonic security version of the issuing layer (anti-rollback). */
  securityVersion: number;
  /** RFC3339 not-before instant. */
  notBefore: string;
  /** RFC3339 not-after instant. */
  notAfter: string;
  /** base64url raw 64-byte Ed25519 signature by the issuer over the TBS bytes. */
  signature: string;
};

/** The body the Alias key signs: binds measurements + report_data + freshness. */
export type CoveQuoteBody = {
  measurements: CoveMeasurements;
  claims: CoveClaims;
  securityVersion: number;
  /** sha256:hex of (nonce_utf8 || ephemeral_pubkey). Binds the live channel. */
  reportData: string;
  nonce: string;
  timestamp: string;
  hardwareVendor: string;
  platformVersion: string;
};

export type CoveQuote = {
  body: CoveQuoteBody;
  /**
   * RoT root -> DeviceID -> Alias. `chain[0]` self-issues (its `issuer` equals
   * its `subject` and it is verified against `trustedRotPublicKey`). The last
   * cert is the Alias leaf whose key signed `body`.
   */
  chain: [DiceCertificate, ...DiceCertificate[]];
  /** base64url raw 64-byte Ed25519 signature by the Alias key over the body. */
  signature: string;
};

export type CoveVerifyOptions = {
  /** The on-device RoT root public key, base64url raw 32-byte Ed25519. */
  trustedRotPublicKey: string;
  /** Wall-clock for validity-window checks. Defaults to Date.now(). */
  nowMs?: number;
  /** Reject quotes whose securityVersion is below this rollback floor. */
  minSecurityVersion?: number;
  /**
   * Nonce this verifier issued for the live channel. When supplied together
   * with `ephemeralPublicKey`, the quote's `body.reportData` MUST equal
   * `expectedReportData(expectedNonce, ephemeralPublicKey)` or verification
   * fails with `report-data-mismatch`. This is the anti-replay binding: a
   * passively captured quote carries a different nonce/epk digest and is
   * rejected. Omitting both only checks the digest is well-formed (legacy
   * format check) and leaves the quote replayable — pass them in production.
   */
  expectedNonce?: string;
  /** Ephemeral public key the verifier offered for this channel; bound with
   * `expectedNonce` into the expected `reportData`. */
  ephemeralPublicKey?: Buffer;
};

export type CoveVerifyResult =
  | { verified: true; body: CoveQuoteBody; aliasPublicKey: string }
  | { verified: false; reason: CoveVerifyFailure; detail: string };

export type CoveVerifyFailure =
  | "malformed-quote"
  | "empty-chain"
  | "root-anchor-mismatch"
  | "chain-link-broken"
  | "cert-signature-invalid"
  | "cert-expired"
  | "alias-signature-invalid"
  | "report-data-malformed"
  | "report-data-mismatch"
  | "security-version-too-low";

const ED25519_PUBLIC_KEY_LEN = 32;
const ED25519_SIGNATURE_LEN = 64;

/**
 * Canonical TBS bytes for a DICE certificate: UTF-8 of a JSON object with keys
 * in fixed order and no `signature` field. This is the exact byte string the
 * issuer signs and the verifier checks; the silicon must reproduce it byte for
 * byte. Order is fixed here (not `JSON.stringify` insertion order) so the
 * contract does not depend on object construction order.
 */
export function canonicalTbsBytes(cert: DiceCertificate): Buffer {
  const ordered: Record<string, unknown> = {
    subject: cert.subject,
    issuer: cert.issuer,
    subjectPublicKey: cert.subjectPublicKey,
    securityVersion: cert.securityVersion,
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
  };
  if (cert.measurements !== undefined) {
    ordered.measurements = sortObject(cert.measurements);
  }
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/**
 * Canonical body bytes the Alias key signs over: UTF-8 of the quote body with a
 * fixed key order. Reproducible byte-for-byte by the silicon TSM.
 */
export function canonicalBodyBytes(body: CoveQuoteBody): Buffer {
  const ordered = {
    measurements: sortObject(body.measurements),
    claims: sortObject(body.claims),
    securityVersion: body.securityVersion,
    reportData: body.reportData,
    nonce: body.nonce,
    timestamp: body.timestamp,
    hardwareVendor: body.hardwareVendor,
    platformVersion: body.platformVersion,
  };
  return Buffer.from(JSON.stringify(ordered), "utf8");
}

/**
 * Verify a CoVE quote with real Ed25519 cryptography:
 *   1. Each cert in the chain is signed by the next-up issuer; the root cert is
 *      verified against `trustedRotPublicKey` (the self-rooted device anchor).
 *   2. The chain links: cert[i].issuer === cert[i-1].subject and the issuer key
 *      that verifies cert[i] is cert[i-1].subjectPublicKey.
 *   3. The Alias leaf key signs the quote body.
 *   4. Every cert is within its validity window.
 *   5. securityVersion is at or above the rollback floor.
 *   6. When `expectedNonce`/`ephemeralPublicKey` are supplied, `body.reportData`
 *      equals `expectedReportData(expectedNonce, ephemeralPublicKey)` — the
 *      live-channel binding that defeats quote replay.
 *
 * Never returns `verified:true` without a passing Ed25519 signature check at
 * every link and over the body.
 */
export function verifyCoveQuote(
  quote: unknown,
  options: CoveVerifyOptions,
): CoveVerifyResult {
  const parsed = parseQuote(quote);
  if (parsed === undefined) {
    return fail("malformed-quote", "Quote is not a well-formed CoVE quote.");
  }

  const { chain, body, signature } = parsed;
  if (chain.length === 0) {
    return fail("empty-chain", "DICE certificate chain is empty.");
  }

  const nowMs = options.nowMs ?? Date.now();
  const anchorKey = importEd25519PublicKey(options.trustedRotPublicKey);
  if (anchorKey === undefined) {
    return fail(
      "root-anchor-mismatch",
      "Trusted RoT public key is not a valid Ed25519 key.",
    );
  }

  // The root cert must be signed by the trusted on-device RoT anchor.
  const root = chain[0];
  if (
    !ed25519VerifyDetached(canonicalTbsBytes(root), root.signature, anchorKey)
  ) {
    return fail(
      "root-anchor-mismatch",
      "Root certificate is not signed by the trusted RoT public key.",
    );
  }

  // Walk the chain: each cert is signed by the previous cert's subject key.
  let issuerKey = importEd25519PublicKey(root.subjectPublicKey);
  if (issuerKey === undefined) {
    return fail("malformed-quote", "Root subject public key is invalid.");
  }
  let issuerSubject = root.subject;
  const expiry = certWindowFailure(root, nowMs);
  if (expiry !== undefined) return expiry;

  for (let i = 1; i < chain.length; i++) {
    const cert = chain[i];
    if (cert.issuer !== issuerSubject) {
      return fail(
        "chain-link-broken",
        `Certificate "${cert.subject}" issuer "${cert.issuer}" does not match parent subject "${issuerSubject}".`,
      );
    }
    if (
      !ed25519VerifyDetached(canonicalTbsBytes(cert), cert.signature, issuerKey)
    ) {
      return fail(
        "cert-signature-invalid",
        `Certificate "${cert.subject}" signature does not verify against its issuer.`,
      );
    }
    const window = certWindowFailure(cert, nowMs);
    if (window !== undefined) return window;

    const nextKey = importEd25519PublicKey(cert.subjectPublicKey);
    if (nextKey === undefined) {
      return fail(
        "malformed-quote",
        `Certificate "${cert.subject}" public key is invalid.`,
      );
    }
    issuerKey = nextKey;
    issuerSubject = cert.subject;
  }

  // The Alias leaf key (the last cert's subject key) signs the quote body.
  const aliasLeaf = chain[chain.length - 1];
  const aliasKey = importEd25519PublicKey(aliasLeaf.subjectPublicKey);
  if (aliasKey === undefined) {
    return fail("malformed-quote", "Alias leaf public key is invalid.");
  }
  if (!ed25519VerifyDetached(canonicalBodyBytes(body), signature, aliasKey)) {
    return fail(
      "alias-signature-invalid",
      "Quote body signature does not verify against the Alias key.",
    );
  }

  if (!isSha256Digest(body.reportData)) {
    return fail(
      "report-data-malformed",
      "reportData is not a sha256 digest of (nonce || ephemeral pubkey).",
    );
  }

  if (
    options.expectedNonce !== undefined &&
    options.ephemeralPublicKey !== undefined
  ) {
    const expected = expectedReportData(
      options.expectedNonce,
      options.ephemeralPublicKey,
    );
    if (!constantTimeAsciiEquals(body.reportData, expected)) {
      return fail(
        "report-data-mismatch",
        "reportData is not bound to the nonce/ephemeral key this verifier issued.",
      );
    }
  }

  const floor = options.minSecurityVersion;
  if (floor !== undefined && body.securityVersion < floor) {
    return fail(
      "security-version-too-low",
      `Quote security version ${body.securityVersion} is below the rollback floor ${floor}.`,
    );
  }

  return {
    verified: true,
    body,
    aliasPublicKey: aliasLeaf.subjectPublicKey,
  };
}

/**
 * Recompute the report_data binding the verifier expects:
 * sha256(nonce_utf8 || ephemeral_pubkey). The caller compares this against the
 * verified quote's `body.reportData` to prove the quote is bound to the live
 * channel (the nonce it issued and the ephemeral key it will receive secrets on).
 */
export function expectedReportData(
  nonce: string,
  ephemeralPublicKey: Buffer,
): string {
  const hash = createHash("sha256");
  hash.update(Buffer.from(nonce, "utf8"));
  hash.update(ephemeralPublicKey);
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Map a verified CoVE quote body into the normalized `TeeEvidence` shape so
 * `evaluateTeeEvidencePolicy` consumes it identically to dstack/TDX evidence.
 * Pass the result of a successful `verifyCoveQuote` — never an unverified body.
 */
export function coveQuoteToTeeEvidence(
  result: Extract<CoveVerifyResult, { verified: true }>,
): TeeEvidence {
  const { body } = result;
  const measurements: TeeMeasurements = {
    boot: body.measurements.boot,
    monitor: body.measurements.monitor,
    os: body.measurements.os,
    policy: body.measurements.policy,
    device: body.measurements.device,
  };
  if (body.measurements.agent !== undefined) {
    measurements.agent = body.measurements.agent;
  }
  if (body.measurements.npuFirmware !== undefined) {
    measurements.npuFirmware = body.measurements.npuFirmware;
  }
  if (body.measurements.modelWeights !== undefined) {
    measurements.modelWeights = body.measurements.modelWeights;
  }

  const claims: TeeClaims = {
    secureBoot: body.claims.secureBoot,
    debugDisabled: body.claims.debugDisabled,
    productionLifecycle: body.claims.productionLifecycle,
    memoryEncrypted: body.claims.memoryEncrypted,
    ioProtected: body.claims.ioProtected,
    npuProtected: body.claims.npuProtected,
    monitorMeasured: body.claims.monitorMeasured,
  };

  return normalizeTeeEvidence({
    kind: "cove",
    provider: "eliza-riscv",
    hardwareVendor: body.hardwareVendor,
    platformVersion: body.platformVersion,
    securityVersion: body.securityVersion,
    measurements,
    freshness: {
      nonce: body.nonce,
      timestamp: body.timestamp,
      verifier: "eliza-local-verifier",
    },
    claims,
    reportData: body.reportData,
  });
}

function certWindowFailure(
  cert: DiceCertificate,
  nowMs: number,
): Extract<CoveVerifyResult, { verified: false }> | undefined {
  const notBefore = Date.parse(cert.notBefore);
  const notAfter = Date.parse(cert.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    return fail(
      "cert-expired",
      `Certificate "${cert.subject}" has an unparseable validity window.`,
    );
  }
  if (nowMs < notBefore || nowMs > notAfter) {
    return fail(
      "cert-expired",
      `Certificate "${cert.subject}" is outside its validity window.`,
    );
  }
  return undefined;
}

function ed25519VerifyDetached(
  message: Buffer,
  signatureB64Url: string,
  publicKey: KeyObject,
): boolean {
  const signature = decodeFixedBase64Url(
    signatureB64Url,
    ED25519_SIGNATURE_LEN,
  );
  if (signature === undefined) return false;
  return cryptoVerify(null, message, publicKey, signature);
}

function importEd25519PublicKey(b64Url: string): KeyObject | undefined {
  const raw = decodeFixedBase64Url(b64Url, ED25519_PUBLIC_KEY_LEN);
  if (raw === undefined) return undefined;
  // Wrap the 32-byte raw key in the Ed25519 SPKI DER prefix.
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const der = Buffer.concat([spkiPrefix, raw]);
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return undefined;
  }
}

function decodeFixedBase64Url(
  value: string,
  expectedLen: number,
): Buffer | undefined {
  if (typeof value !== "string") return undefined;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    return undefined;
  }
  return decoded.length === expectedLen ? decoded : undefined;
}

function isSha256Digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function constantTimeAsciiEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseQuote(value: unknown): CoveQuote | undefined {
  if (!isRecord(value)) return undefined;
  const { body, chain, signature } = value;
  if (typeof signature !== "string") return undefined;
  if (!Array.isArray(chain) || chain.length === 0) return undefined;

  const parsedChain: DiceCertificate[] = [];
  for (const entry of chain) {
    const cert = parseCertificate(entry);
    if (cert === undefined) return undefined;
    parsedChain.push(cert);
  }
  const parsedBody = parseBody(body);
  if (parsedBody === undefined) return undefined;

  return {
    body: parsedBody,
    chain: parsedChain as [DiceCertificate, ...DiceCertificate[]],
    signature,
  };
}

function parseCertificate(value: unknown): DiceCertificate | undefined {
  if (!isRecord(value)) return undefined;
  const subject = stringField(value, "subject");
  const issuer = stringField(value, "issuer");
  const subjectPublicKey = stringField(value, "subjectPublicKey");
  const notBefore = stringField(value, "notBefore");
  const notAfter = stringField(value, "notAfter");
  const signature = stringField(value, "signature");
  const securityVersion = integerField(value, "securityVersion");
  if (
    subject === undefined ||
    issuer === undefined ||
    subjectPublicKey === undefined ||
    notBefore === undefined ||
    notAfter === undefined ||
    signature === undefined ||
    securityVersion === undefined
  ) {
    return undefined;
  }
  const cert: DiceCertificate = {
    subject,
    issuer,
    subjectPublicKey,
    securityVersion,
    notBefore,
    notAfter,
    signature,
  };
  const measurements = parseStringMap(value.measurements);
  if (value.measurements !== undefined && measurements === undefined) {
    return undefined;
  }
  if (measurements !== undefined) cert.measurements = measurements;
  return cert;
}

function parseBody(value: unknown): CoveQuoteBody | undefined {
  if (!isRecord(value)) return undefined;
  const measurements = parseMeasurements(value.measurements);
  const claims = parseClaims(value.claims);
  const reportData = stringField(value, "reportData");
  const nonce = stringField(value, "nonce");
  const timestamp = stringField(value, "timestamp");
  const hardwareVendor = stringField(value, "hardwareVendor");
  const platformVersion = stringField(value, "platformVersion");
  const securityVersion = integerField(value, "securityVersion");
  if (
    measurements === undefined ||
    claims === undefined ||
    reportData === undefined ||
    nonce === undefined ||
    timestamp === undefined ||
    hardwareVendor === undefined ||
    platformVersion === undefined ||
    securityVersion === undefined
  ) {
    return undefined;
  }
  return {
    measurements,
    claims,
    securityVersion,
    reportData,
    nonce,
    timestamp,
    hardwareVendor,
    platformVersion,
  };
}

function parseMeasurements(value: unknown): CoveMeasurements | undefined {
  if (!isRecord(value)) return undefined;
  const boot = stringField(value, "boot");
  const monitor = stringField(value, "monitor");
  const os = stringField(value, "os");
  const policy = stringField(value, "policy");
  const device = stringField(value, "device");
  if (
    boot === undefined ||
    monitor === undefined ||
    os === undefined ||
    policy === undefined ||
    device === undefined
  ) {
    return undefined;
  }
  const measurements: CoveMeasurements = { boot, monitor, os, policy, device };
  const agent = stringField(value, "agent");
  const npuFirmware = stringField(value, "npuFirmware");
  const modelWeights = stringField(value, "modelWeights");
  if (agent !== undefined) measurements.agent = agent;
  if (npuFirmware !== undefined) measurements.npuFirmware = npuFirmware;
  if (modelWeights !== undefined) measurements.modelWeights = modelWeights;
  return measurements;
}

function parseClaims(value: unknown): CoveClaims | undefined {
  if (!isRecord(value)) return undefined;
  const keys = [
    "secureBoot",
    "debugDisabled",
    "productionLifecycle",
    "memoryEncrypted",
    "ioProtected",
    "npuProtected",
    "monitorMeasured",
  ] as const;
  const claims = {} as CoveClaims;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw !== "boolean") return undefined;
    claims[key] = raw;
  }
  return claims;
}

function parseStringMap(
  value: unknown,
): Partial<Record<TeeMeasurementName, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const out: Partial<Record<TeeMeasurementName, string>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") return undefined;
    out[key] = raw;
  }
  return out;
}

function sortObject<T extends Record<string, unknown>>(
  value: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = value[key];
  }
  return out;
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

function integerField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  return typeof raw === "number" && Number.isInteger(raw) ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(
  reason: CoveVerifyFailure,
  detail: string,
): Extract<CoveVerifyResult, { verified: false }> {
  return { verified: false, reason, detail };
}

/**
 * Standard-format CoVE verifier for X.509 DER chains carrying a TCG DICE
 * `DiceTcbInfo` extension, as emitted by real RISC-V CoVE TSMs (Salus / rice).
 * This is an additional accepted evidence format; the canonical-JSON path above
 * is unchanged. See `cove-quote-x509.ts`.
 */
export {
  type CoveX509Cert,
  type CoveX509VerifyFailure,
  type CoveX509VerifyOptions,
  type CoveX509VerifyResult,
  coveX509ToTeeEvidence,
  type DiceFwId,
  type DiceTcbInfo,
  decodeDiceTcbInfoFromCert,
  ED25519_OID,
  SHA384_OID,
  TCG_DICE_TCB_INFO_OID,
  verifyCoveX509Chain,
} from "./cove-quote-x509.ts";
