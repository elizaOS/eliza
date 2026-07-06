/**
 * Versioned evidence-bundle contract: manifest and provenance-meta types plus
 * runtime validation. This is the FROZEN schema-1 contract the rest of the
 * unified evidence harness (#14541) builds against — analyzers, VLM Q&A, and
 * the certify orchestrator all consume these exact names and semantics; widen
 * only additively under a schema bump. Interfaces are declared explicitly (the
 * contract) and the zod schemas are held mutually assignable at compile time,
 * so type and validator cannot drift apart. Parsing untrusted disk input
 * produces `EvidenceValidationError` with per-field issues (error-policy J3);
 * nothing is silently repaired. Artifact paths are bundle-relative posix and
 * traversal (`..`, absolute, backslash) is rejected at validation time so a
 * hostile manifest can never direct reads or writes outside its bundle dir.
 */

import { z } from "zod";
import { EvidenceValidationError } from "./errors.ts";

export const ARTIFACT_KINDS = [
  "screenshot",
  "video",
  "keyframe",
  "log",
  "trajectory",
  "report",
  "analysis",
  "qa",
  "html-tree",
  "other",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const RUNNER_KINDS = ["local", "vast", "ci"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];

export const TIERS = ["cpu", "gpu", "full"] as const;
export type Tier = (typeof TIERS)[number];

/** One file recorded in a bundle manifest. */
export interface ArtifactEntry {
  /** Bundle-relative posix path (no `..`, no leading `/`, no backslashes). */
  path: string;
  /** Lowercase hex sha256 of the artifact bytes as stored in the bundle. */
  sha256: string;
  bytes: number;
  kind: ArtifactKind;
  /** Producer id, e.g. `aesthetic-audit`. */
  source: string;
  /** Test lane the artifact belongs to (e2e, scenario, native, …), if known. */
  lane?: string;
  /** Tool or script that produced the artifact. */
  producedBy: string;
  /** ISO-8601 timestamp of when the artifact was added to the bundle. */
  createdAt: string;
}

/** `manifest.json`: the signed inventory of every artifact in a bundle. */
export interface BundleManifest {
  schema: 1;
  runId: string;
  createdAt: string;
  artifacts: ArtifactEntry[];
}

/** `meta.json`: provenance for the run that produced the bundle. */
export interface BundleMeta {
  schema: 1;
  runId: string;
  commit: string;
  branch: string;
  runner: RunnerKind;
  tier: Tier;
  startedAt: string;
  finishedAt?: string;
  envFingerprint: Record<string, string>;
  /** Wall-clock durations in milliseconds, keyed by phase (e.g. `ingest.reports`). */
  timings?: Record<string, number>;
}

/**
 * Bundle-relative posix path validator. Rejects traversal because manifest
 * paths are joined onto the bundle dir by `verifyBundle` and future consumers.
 */
export function isBundleRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/")) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
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

const artifactEntrySchema = z.strictObject({
  path: bundleRelativePath,
  sha256: sha256Hex,
  bytes: z.number().int().nonnegative(),
  kind: z.enum(ARTIFACT_KINDS),
  source: z.string().min(1),
  lane: z.string().min(1).optional(),
  producedBy: z.string().min(1),
  createdAt: isoTimestamp,
});

const bundleManifestSchema = z
  .strictObject({
    schema: z.literal(1),
    runId: z.string().min(1),
    createdAt: isoTimestamp,
    artifacts: z.array(artifactEntrySchema),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (seen.has(artifact.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", index, "path"],
          message: `duplicate artifact path: ${artifact.path}`,
        });
      }
      seen.add(artifact.path);
    }
  });

const bundleMetaSchema = z.strictObject({
  schema: z.literal(1),
  runId: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/, "must be a hex commit sha"),
  branch: z.string().min(1),
  runner: z.enum(RUNNER_KINDS),
  tier: z.enum(TIERS),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
  envFingerprint: z.record(z.string(), z.string()),
  timings: z.record(z.string(), z.number()).optional(),
});

// Compile-time drift guards: the zod schemas must stay mutually assignable
// with the frozen contract interfaces above.
type MutuallyAssignable<A, B> = A extends B
  ? B extends A
    ? true
    : never
  : never;
const _entryContract: MutuallyAssignable<
  z.infer<typeof artifactEntrySchema>,
  ArtifactEntry
> = true;
const _manifestContract: MutuallyAssignable<
  z.infer<typeof bundleManifestSchema>,
  BundleManifest
> = true;
const _metaContract: MutuallyAssignable<
  z.infer<typeof bundleMetaSchema>,
  BundleMeta
> = true;
void _entryContract;
void _manifestContract;
void _metaContract;

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
    { code: what === "bundle manifest" ? "MANIFEST_INVALID" : "META_INVALID" },
  );
}

/** Validate an untrusted value as a schema-1 manifest; throws typed invalid. */
export function parseManifest(
  value: unknown,
  described: string,
): BundleManifest {
  const result = bundleManifestSchema.safeParse(value);
  if (!result.success) throwInvalid("bundle manifest", described, result.error);
  return result.data;
}

/** Validate an untrusted value as schema-1 provenance meta; throws typed invalid. */
export function parseMeta(value: unknown, described: string): BundleMeta {
  const result = bundleMetaSchema.safeParse(value);
  if (!result.success) throwInvalid("bundle meta", described, result.error);
  return result.data;
}
