/**
 * Certification signing and offline verification — the trust anchor of the
 * develop→main promotion gate (#14547). `signCertification` produces an
 * Ed25519 signature over `canonicalJsonBytes(payload)` (payload = the
 * certification without its `signature` field); `verifyCertification` is the
 * exact code the CI gate runs, entirely offline: no network, no git, just the
 * certification file, the committed public key, and optionally the bundle.
 *
 * Verification reports EVERY failure it can still determine, each under a
 * distinct typed code, so the gate can annotate all problems at once instead
 * of drip-feeding first-failure-only. What the signature proves — and does
 * not prove — matters: a valid signature proves a holder of the private key
 * signed exactly these verdicts over exactly this bundle manifest for exactly
 * this commit. It does NOT prove the review was diligent; that is why the
 * reviewer identity is part of the signed payload. `wrong-key` (a different
 * keypair) is deliberately distinguished from `bad-signature` (altered
 * payload) so key-rotation mistakes and tampering read differently in the
 * gate output.
 */

import { createHash, type KeyObject, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type VerifyReport, verifyBundle } from "../bundle.ts";
import { canonicalJsonBytes } from "../canonical.ts";
import { EvidenceError, EvidenceValidationError } from "../errors.ts";
import type { Tier } from "../schema.ts";
import {
  derivePublicKeyPem,
  fingerprintPublicKey,
  toPrivateKey,
  toPublicKey,
} from "./keys.ts";
import {
  type CertificationRequirements,
  type RollupResult,
  rollupBundle,
} from "./rollup.ts";
import {
  type Certification,
  type CertificationPayload,
  type CertificationVerdict,
  parseCertificationPayload,
  parseCertificationSignature,
  tierSatisfies,
} from "./schema.ts";

/**
 * Sign a certification payload. The payload is validated first — an invalid
 * payload (waived-without-notes, traversal evidence path, short commit sha)
 * must fail here, at the signer, not at the gate.
 */
export function signCertification(
  payload: CertificationPayload,
  privateKey: string | KeyObject,
): Certification {
  const parsed = parseCertificationPayload(payload, "payload to sign");
  const key = toPrivateKey(privateKey);
  const value = sign(null, canonicalJsonBytes(parsed), key).toString("base64");
  return {
    ...parsed,
    signature: {
      alg: "ed25519",
      publicKeyFingerprint: fingerprintPublicKey(derivePublicKeyPem(key)),
      value,
    },
  };
}

/** Distinct failure classifications; the gate maps these to check annotations. */
export const CERTIFICATION_FAILURE_CODES = [
  "schema-invalid",
  "unsigned",
  "bad-signature",
  "wrong-key",
  "stale",
  "commit-mismatch",
  "bundle-tampered",
  "verdict-failures",
  "verdict-incomplete",
  "tier-insufficient",
] as const;
export type CertificationFailureCode =
  (typeof CERTIFICATION_FAILURE_CODES)[number];

/** One verification failure; `context` is structured detail for annotations. */
export interface CertificationFailure {
  code: CertificationFailureCode;
  message: string;
  context?: Record<string, unknown>;
}

/** Options for {@link verifyCertification}. */
export interface CertificationVerifyOptions {
  /** SPKI PEM of the trusted public key — read from the BASE branch, never the PR head. */
  publicKeyPem: string;
  /** When given, the bundle hash and full artifact integrity are checked. */
  bundleDir?: string;
  /** When given, `payload.commit` must equal this sha exactly. */
  expectedCommit?: string;
  /** When given, `createdAt` older than this many hours fails `stale`. */
  maxAgeHours?: number;
  /** When given, the certification tier must satisfy this tier. */
  requiredTier?: Tier;
  /** Requirements used to derive the mechanical rollup for verdict-completeness checks. */
  requirements?: CertificationRequirements;
  /** Injectable clock for deterministic freshness tests. */
  now?: () => Date;
}

/** Full result of an offline verification pass. */
export interface CertificationVerifyReport {
  ok: boolean;
  certPath: string;
  failures: CertificationFailure[];
  /** Present whenever the payload half parsed, even if the signature did not. */
  payload?: CertificationPayload;
  /** Present only when payload and signature both parsed. */
  certification?: Certification;
  /** Bundle integrity report, when `bundleDir` was given and the bundle was readable. */
  bundle?: VerifyReport;
  /** Mechanical rollup used to check signed verdict completeness, when `bundleDir` was given. */
  rollup?: RollupResult;
}

/** Tolerate small signer/verifier clock skew without letting future-dated certs extend max-age windows. */
const CREATED_AT_FUTURE_SKEW_MS = 5 * 60_000;

function validationIssues(error: unknown): Record<string, unknown> {
  return error instanceof EvidenceValidationError
    ? { issues: error.issues }
    : {};
}

function findVerdictBySubject(
  verdicts: CertificationVerdict[],
): Map<string, CertificationVerdict> {
  const bySubject = new Map<string, CertificationVerdict>();
  for (const verdict of verdicts) bySubject.set(verdict.subject, verdict);
  return bySubject;
}

function verdictCompletenessFailure(
  payload: CertificationPayload,
  rollup: RollupResult,
): CertificationFailure | undefined {
  const signedBySubject = findVerdictBySubject(payload.verdicts);
  const missingSubjects: string[] = [];
  const falsePassSubjects: string[] = [];

  for (const mechanical of rollup.verdicts) {
    const signed = signedBySubject.get(mechanical.subject);
    if (signed === undefined) {
      missingSubjects.push(mechanical.subject);
      continue;
    }
    if (mechanical.verdict !== "pass" && signed.verdict === "pass") {
      falsePassSubjects.push(mechanical.subject);
    }
  }

  if (missingSubjects.length === 0 && falsePassSubjects.length === 0) {
    return undefined;
  }

  const details: string[] = [];
  if (missingSubjects.length > 0) {
    details.push(`missing ${missingSubjects.length} rollup subject(s)`);
  }
  if (falsePassSubjects.length > 0) {
    details.push(
      `${falsePassSubjects.length} mechanically non-pass subject(s) signed as pass`,
    );
  }
  return {
    code: "verdict-incomplete",
    message: `signed verdicts do not cover the bundle rollup: ${details.join("; ")}`,
    context: {
      missingSubjects,
      falsePassSubjects,
    },
  };
}

/**
 * Verify a certification file offline. Collects every determinable failure;
 * only an unreadable/unparseable certification file short-circuits (there is
 * nothing left to check). Throws only for verifier misconfiguration (an
 * invalid trusted public key) — that is an operator error, not a verification
 * outcome an attacker should be able to induce.
 */
export async function verifyCertification(
  certPath: string,
  options: CertificationVerifyOptions,
): Promise<CertificationVerifyReport> {
  // Resolve the trusted key first: if the configured key is garbage the run
  // must abort loudly instead of reporting a misleading verification failure.
  const publicKey = toPublicKey(options.publicKeyPem);
  const trustedFingerprint = fingerprintPublicKey(publicKey);
  const now = options.now ?? (() => new Date());

  const failures: CertificationFailure[] = [];
  const report: CertificationVerifyReport = {
    ok: false,
    certPath,
    failures,
  };

  let rawText: string;
  try {
    rawText = fs.readFileSync(certPath, "utf8");
  } catch (error) {
    // error-policy:J1 boundary translation — the gate consumes a structured
    // report; an absent certification is a distinct, actionable failure.
    failures.push({
      code: "schema-invalid",
      message: `certification file unreadable: ${certPath} (${(error as Error).message})`,
    });
    return report;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error) {
    // error-policy:J3 untrusted input — malformed JSON is a typed failure in
    // the report, never an exception the gate has to interpret.
    failures.push({
      code: "schema-invalid",
      message: `certification is not valid JSON: ${(error as Error).message}`,
    });
    return report;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    failures.push({
      code: "schema-invalid",
      message: "certification must be a JSON object",
    });
    return report;
  }

  const { signature: rawSignature, ...rawPayload } = raw as Record<
    string,
    unknown
  >;

  let payload: CertificationPayload | undefined;
  try {
    payload = parseCertificationPayload(rawPayload, certPath);
    report.payload = payload;
  } catch (error) {
    // error-policy:J3 typed invalid — recorded so the remaining independent
    // checks can still run and the gate sees every problem at once.
    failures.push({
      code: "schema-invalid",
      message: (error as Error).message,
      context: validationIssues(error),
    });
  }

  if (rawSignature === undefined) {
    failures.push({
      code: "unsigned",
      message: "certification has no signature field",
    });
  } else {
    let signatureValid = false;
    let signatureEnvelope: Certification["signature"] | undefined;
    try {
      signatureEnvelope = parseCertificationSignature(rawSignature, certPath);
      signatureValid = true;
    } catch (error) {
      // error-policy:J3 typed invalid — a malformed envelope is schema-level,
      // not a cryptographic verdict.
      failures.push({
        code: "schema-invalid",
        message: (error as Error).message,
        context: validationIssues(error),
      });
    }
    if (signatureValid && signatureEnvelope !== undefined) {
      if (signatureEnvelope.publicKeyFingerprint !== trustedFingerprint) {
        failures.push({
          code: "wrong-key",
          message: `certification was signed by a different key (fingerprint ${signatureEnvelope.publicKeyFingerprint}, trusted key is ${trustedFingerprint})`,
          context: {
            certificationFingerprint: signatureEnvelope.publicKeyFingerprint,
            trustedFingerprint,
          },
        });
      } else if (payload !== undefined) {
        const signedBytes = canonicalJsonBytes(payload);
        let cryptoOk = false;
        try {
          cryptoOk = verify(
            null,
            signedBytes,
            publicKey,
            Buffer.from(signatureEnvelope.value, "base64"),
          );
        } catch {
          // error-policy:J3 node:crypto throws on structurally impossible
          // signatures; for verification that is the same outcome as false.
          cryptoOk = false;
        }
        if (!cryptoOk) {
          failures.push({
            code: "bad-signature",
            message:
              "signature does not verify over the canonical payload bytes — the payload was altered after signing",
          });
        } else {
          report.certification = { ...payload, signature: signatureEnvelope };
        }
      }
    }
  }

  if (payload !== undefined) {
    if (options.bundleDir !== undefined) {
      const manifestPath = path.join(options.bundleDir, "manifest.json");
      let manifestBytes: Buffer | undefined;
      try {
        manifestBytes = fs.readFileSync(manifestPath);
      } catch (error) {
        // error-policy:J1 boundary translation — a bundle without a manifest
        // cannot back this certification; that is a tamper-class failure.
        failures.push({
          code: "bundle-tampered",
          message: `bundle manifest unreadable: ${manifestPath} (${(error as Error).message})`,
        });
      }
      if (manifestBytes !== undefined) {
        const actualSha = createHash("sha256")
          .update(manifestBytes)
          .digest("hex");
        if (actualSha !== payload.bundleSha) {
          failures.push({
            code: "bundle-tampered",
            message: `bundle manifest hash mismatch: certification signed ${payload.bundleSha}, bundle has ${actualSha}`,
            context: { expected: payload.bundleSha, actual: actualSha },
          });
        }
        try {
          const bundleReport = await verifyBundle(options.bundleDir);
          report.bundle = bundleReport;
          if (!bundleReport.ok) {
            failures.push({
              code: "bundle-tampered",
              message: `bundle integrity check failed: ${bundleReport.issues
                .map((issue) => `${issue.issue}:${issue.path}`)
                .join(", ")}`,
              context: { issues: bundleReport.issues },
            });
          } else {
            const rollup = rollupBundle(options.bundleDir, {
              requirements: options.requirements,
            });
            report.rollup = rollup;
            const completenessFailure = verdictCompletenessFailure(
              payload,
              rollup,
            );
            if (completenessFailure !== undefined) {
              failures.push(completenessFailure);
            }
          }
        } catch (error) {
          // error-policy:J1 boundary translation — structural bundle failures
          // (invalid manifest or rollup inputs) land in the report as tampering.
          failures.push({
            code: "bundle-tampered",
            message: `bundle unverifiable for certification: ${(error as Error).message}`,
            context: error instanceof EvidenceError ? { code: error.code } : {},
          });
        }
      }
    }

    if (
      options.expectedCommit !== undefined &&
      payload.commit !== options.expectedCommit
    ) {
      failures.push({
        code: "commit-mismatch",
        message: `certification is for commit ${payload.commit}, expected ${options.expectedCommit}`,
        context: {
          certified: payload.commit,
          expected: options.expectedCommit,
        },
      });
    }

    const nowDate = now();
    const nowMs = nowDate.getTime();
    const createdAtMs = Date.parse(payload.createdAt);
    if (createdAtMs - nowMs > CREATED_AT_FUTURE_SKEW_MS) {
      failures.push({
        code: "stale",
        message: `certification createdAt ${payload.createdAt} is in the future`,
        context: {
          createdAt: payload.createdAt,
          now: nowDate.toISOString(),
          skewMs: createdAtMs - nowMs,
          allowedSkewMs: CREATED_AT_FUTURE_SKEW_MS,
        },
      });
    }
    if (options.maxAgeHours !== undefined) {
      const ageMs = nowMs - createdAtMs;
      const maxMs = options.maxAgeHours * 3_600_000;
      if (ageMs > maxMs) {
        failures.push({
          code: "stale",
          message: `certification created ${payload.createdAt} is older than ${options.maxAgeHours}h`,
          context: { createdAt: payload.createdAt, ageMs, maxMs },
        });
      }
    }
    if (
      payload.expiresAt !== undefined &&
      nowMs > Date.parse(payload.expiresAt)
    ) {
      failures.push({
        code: "stale",
        message: `certification expired at ${payload.expiresAt}`,
        context: { expiresAt: payload.expiresAt },
      });
    }

    if (
      options.requiredTier !== undefined &&
      !tierSatisfies(payload.tier, options.requiredTier)
    ) {
      failures.push({
        code: "tier-insufficient",
        message: `certification tier ${payload.tier} does not satisfy required tier ${options.requiredTier}`,
        context: { tier: payload.tier, requiredTier: options.requiredTier },
      });
    }

    const failing = payload.verdicts.filter(
      (verdict) => verdict.verdict === "fail",
    );
    if (failing.length > 0) {
      failures.push({
        code: "verdict-failures",
        message: `${failing.length} failing verdict(s): ${failing
          .map((verdict) => verdict.subject)
          .join(", ")}`,
        context: { subjects: failing.map((verdict) => verdict.subject) },
      });
    }
  }

  report.ok = failures.length === 0;
  return report;
}
