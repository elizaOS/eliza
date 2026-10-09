/**
 * Certification contract: the signed claim that a keyholder reviewed a
 * specific evidence bundle for a specific commit. `certification.json` is the
 * only artifact that travels with a develop→main promotion PR, and the CI gate
 * (#14547) accepts or rejects the promotion purely on this file plus the
 * committed public key — so parsing is strict by design: unknown top-level
 * fields, unknown verdict values, and absolute/traversal evidence paths are
 * rejected outright. Forward compatibility happens through a `schema` version
 * bump, never through silent tolerance, because any byte an attacker can add
 * without invalidating the parse is a byte the gate cannot reason about.
 *
 * The signature covers `canonicalJsonBytes(payload)` where payload is the
 * certification without its `signature` field (see `../canonical.ts`: sorted
 * keys, no whitespace, one trailing newline). Interfaces are the frozen
 * schema-1 contract; the zod validators are held mutually assignable with them
 * at compile time, mirroring `../schema.ts`.
 */

import { z } from "zod";
import { EvidenceValidationError } from "../errors.ts";
import { isBundleRelativePath, TIERS, type Tier } from "../schema.ts";

export const VERDICT_VALUES = ["pass", "fail", "waived"] as const;
export type VerdictValue = (typeof VERDICT_VALUES)[number];

export const REVIEWER_KINDS = ["agent", "human"] as const;
export type ReviewerKind = (typeof REVIEWER_KINDS)[number];

/** One reviewed subject (a lane, a view, a required artifact, …). */
export interface CertificationVerdict {
  subject: string;
  verdict: VerdictValue;
  /** Bundle-relative posix paths backing the verdict; may be empty for a missing-artifact fail. */
  evidence: string[];
  /** Required (non-blank) when verdict is `waived`; optional context otherwise. */
  notes?: string;
}

/** Who performed the review. Recorded because the signature proves a keyholder reviewed the bundle, not that the review was diligent. */
export interface CertificationReviewer {
  kind: ReviewerKind;
  id: string;
  /** Model identifier when `kind` is `agent`. */
  model?: string;
}

/** Detached Ed25519 signature envelope over the canonical payload bytes. */
export interface CertificationSignature {
  alg: "ed25519";
  /** First 16 hex chars of sha256(SPKI DER) of the signing public key. */
  publicKeyFingerprint: string;
  /** Base64 of the 64-byte Ed25519 signature. */
  value: string;
}

/** The signed portion of a certification — everything except `signature`. */
export interface CertificationPayload {
  schema: 1;
  /** sha256 hex of the bundle's `manifest.json` bytes exactly as stored. */
  bundleSha: string;
  /** Full 40-hex commit sha the evidence was produced from. */
  commit: string;
  branch: string;
  /** Ref the run was based on (the promotion source, normally `develop`). */
  baseRef: string;
  tier: Tier;
  verdicts: CertificationVerdict[];
  reviewer: CertificationReviewer;
  createdAt: string;
  /** Optional hard expiry; verification fails `stale` past this instant. */
  expiresAt?: string;
}

/** A complete `certification.json`: signed payload plus signature envelope. */
export interface Certification extends CertificationPayload {
  signature: CertificationSignature;
}

const bundleRelativePath = z.string().refine(isBundleRelativePath, {
  message:
    "must be a bundle-relative posix path with no empty, `.`, or `..` segments",
});

const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

const isoTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO-8601 timestamp",
  });

export const certificationVerdictSchema = z
  .strictObject({
    subject: z.string().min(1),
    verdict: z.enum(VERDICT_VALUES),
    evidence: z.array(bundleRelativePath),
    notes: z.string().optional(),
  })
  .superRefine((verdict, ctx) => {
    // A waiver without a reason is indistinguishable from rubber-stamping;
    // the schema makes the reason mandatory rather than trusting convention.
    if (
      verdict.verdict === "waived" &&
      (verdict.notes === undefined || verdict.notes.trim().length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["notes"],
        message: "waived verdicts require non-empty notes",
      });
    }
  });

const certificationReviewerSchema = z.strictObject({
  kind: z.enum(REVIEWER_KINDS),
  id: z.string().min(1),
  model: z.string().min(1).optional(),
});

const certificationSignatureSchema = z.strictObject({
  alg: z.literal("ed25519"),
  publicKeyFingerprint: z
    .string()
    .regex(/^[0-9a-f]{16}$/, "must be 16 lowercase hex characters"),
  value: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64")
    .refine((value) => Buffer.from(value, "base64").length === 64, {
      message: "must decode to a 64-byte Ed25519 signature",
    }),
});

const payloadShape = {
  schema: z.literal(1),
  bundleSha: sha256Hex,
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/, "must be a full 40-hex commit sha"),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  tier: z.enum(TIERS),
  verdicts: z.array(certificationVerdictSchema).min(1),
  reviewer: certificationReviewerSchema,
  createdAt: isoTimestamp,
  expiresAt: isoTimestamp.optional(),
} as const;

function refinePayload(
  payload: {
    verdicts: CertificationVerdict[];
    createdAt: string;
    expiresAt?: string;
  },
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, verdict] of payload.verdicts.entries()) {
    if (seen.has(verdict.subject)) {
      ctx.addIssue({
        code: "custom",
        path: ["verdicts", index, "subject"],
        message: `duplicate verdict subject: ${verdict.subject}`,
      });
    }
    seen.add(verdict.subject);
  }
  if (
    payload.expiresAt !== undefined &&
    Date.parse(payload.expiresAt) <= Date.parse(payload.createdAt)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "expiresAt must be after createdAt",
    });
  }
}

const certificationPayloadSchema = z
  .strictObject(payloadShape)
  .superRefine(refinePayload);

const certificationSchema = z
  .strictObject({ ...payloadShape, signature: certificationSignatureSchema })
  .superRefine(refinePayload);

// Compile-time drift guards: the zod schemas must stay mutually assignable
// with the frozen contract interfaces above.
type MutuallyAssignable<A, B> = A extends B
  ? B extends A
    ? true
    : never
  : never;
const _verdictContract: MutuallyAssignable<
  z.infer<typeof certificationVerdictSchema>,
  CertificationVerdict
> = true;
const _payloadContract: MutuallyAssignable<
  z.infer<typeof certificationPayloadSchema>,
  CertificationPayload
> = true;
const _certificationContract: MutuallyAssignable<
  z.infer<typeof certificationSchema>,
  Certification
> = true;
void _verdictContract;
void _payloadContract;
void _certificationContract;

function throwInvalid(
  what: string,
  described: string,
  error: z.ZodError,
): never {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "$",
    message: issue.message,
  }));
  throw new EvidenceValidationError(
    `invalid ${what} (${described}): ${issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("; ")}`,
    issues,
    { code: "CERTIFICATION_INVALID" },
  );
}

/** Validate an untrusted value as a signed certification; throws typed invalid. */
export function parseCertification(
  value: unknown,
  described: string,
): Certification {
  const result = certificationSchema.safeParse(value);
  if (!result.success) throwInvalid("certification", described, result.error);
  return result.data;
}

/** Validate an untrusted value as an unsigned certification payload; throws typed invalid. */
export function parseCertificationPayload(
  value: unknown,
  described: string,
): CertificationPayload {
  const result = certificationPayloadSchema.safeParse(value);
  if (!result.success) {
    throwInvalid("certification payload", described, result.error);
  }
  return result.data;
}

/** Validate an untrusted value as a signature envelope; throws typed invalid. */
export function parseCertificationSignature(
  value: unknown,
  described: string,
): CertificationSignature {
  const result = certificationSignatureSchema.safeParse(value);
  if (!result.success) {
    throwInvalid("certification signature", described, result.error);
  }
  return result.data;
}

/**
 * Tier sufficiency: `full` ⊇ `gpu` ⊇ `cpu` (the order of `TIERS`). A cert can
 * satisfy a gate requirement at or below its own tier, never above.
 */
export function tierSatisfies(actual: Tier, required: Tier): boolean {
  return TIERS.indexOf(actual) >= TIERS.indexOf(required);
}
