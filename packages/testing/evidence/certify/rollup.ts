/**
 * Mechanical verdict rollup: walk a finalized evidence bundle and derive draft
 * per-subject verdicts from the machine-readable inputs — per-lane
 * `result.json` pass/fail/skip counts, `analysis.json` expectation failures,
 * and caller-declared artifact requirements. The output is the starting point
 * a reviewer edits before signing, never the final word: rollup can only say
 * what the machines saw, and the certification records who reviewed it.
 *
 * Honest-skip doctrine (#14506): a lane with skipped tests — or a required
 * lane missing from the bundle entirely — drafts as `fail` unless the
 * requirements file marks that lane optional WITH a reason, in which case it
 * drafts as `waived` carrying that reason (waived requires notes, so the
 * reason survives into the signed certification). An unparseable lane result
 * or analysis document is itself a failing finding — a broken reporter must
 * never read as a green lane.
 *
 * Subject namespaces are fixed: `lane:<lane>` for lane results,
 * `analysis:<bundle path>` for failing analyses, and caller-chosen subjects
 * for artifact requirements (which may not collide with the reserved
 * prefixes). This keeps rollup output signable as-is: certification schema
 * rejects duplicate subjects.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EvidenceValidationError } from "../errors.ts";
import {
  type BundleManifest,
  isBundleRelativePath,
  parseManifest,
} from "../schema.ts";
import {
  type CertificationVerdict,
  certificationVerdictSchema,
} from "./schema.ts";

/** One lane entry in a requirements file. */
export interface LaneRequirement {
  lane: string;
  /** `true` allows the lane to be skipped/absent — only with a `reason`. */
  optional?: boolean;
  reason?: string;
}

/** One required-artifact entry: exactly one of `path` (exact) or `pathPrefix`. */
export interface ArtifactRequirement {
  subject: string;
  path?: string;
  pathPrefix?: string;
}

/** Caller-declared requirements consumed by {@link rollupBundle}. */
export interface CertificationRequirements {
  schema: 1;
  lanes?: LaneRequirement[];
  artifacts?: ArtifactRequirement[];
}

const bundleRelativePath = z.string().refine(isBundleRelativePath, {
  message:
    "must be a bundle-relative posix path with no empty, `.`, or `..` segments",
});

// Prefixes match raw string starts (`visual/` matches `visual/audit/home.png`),
// so a single trailing slash is legal where a bundle path would reject it.
const bundlePathPrefix = z
  .string()
  .refine(
    (value) =>
      isBundleRelativePath(value.endsWith("/") ? value.slice(0, -1) : value),
    {
      message:
        "must be a bundle-relative posix path prefix (a trailing `/` is allowed)",
    },
  );

const laneRequirementSchema = z
  .strictObject({
    lane: z.string().min(1),
    optional: z.boolean().optional(),
    reason: z.string().optional(),
  })
  .superRefine((requirement, ctx) => {
    if (
      requirement.optional === true &&
      (requirement.reason === undefined ||
        requirement.reason.trim().length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "optional lanes require a non-empty reason",
      });
    }
  });

const artifactRequirementSchema = z
  .strictObject({
    subject: z.string().min(1),
    path: bundleRelativePath.optional(),
    pathPrefix: bundlePathPrefix.optional(),
  })
  .superRefine((requirement, ctx) => {
    if (
      (requirement.path === undefined) ===
      (requirement.pathPrefix === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of path or pathPrefix is required",
      });
    }
    if (/^(lane|analysis):/.test(requirement.subject)) {
      ctx.addIssue({
        code: "custom",
        path: ["subject"],
        message: "subjects may not use the reserved lane:/analysis: prefixes",
      });
    }
  });

const requirementsSchema = z
  .strictObject({
    schema: z.literal(1),
    lanes: z.array(laneRequirementSchema).optional(),
    artifacts: z.array(artifactRequirementSchema).optional(),
  })
  .superRefine((requirements, ctx) => {
    const lanes = new Set<string>();
    for (const [index, lane] of (requirements.lanes ?? []).entries()) {
      if (lanes.has(lane.lane)) {
        ctx.addIssue({
          code: "custom",
          path: ["lanes", index, "lane"],
          message: `duplicate lane requirement: ${lane.lane}`,
        });
      }
      lanes.add(lane.lane);
    }
    const subjects = new Set<string>();
    for (const [index, artifact] of (requirements.artifacts ?? []).entries()) {
      if (subjects.has(artifact.subject)) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", index, "subject"],
          message: `duplicate artifact requirement subject: ${artifact.subject}`,
        });
      }
      subjects.add(artifact.subject);
    }
  });

type MutuallyAssignable<A, B> = A extends B
  ? B extends A
    ? true
    : never
  : never;
const _requirementsContract: MutuallyAssignable<
  z.infer<typeof requirementsSchema>,
  CertificationRequirements
> = true;
void _requirementsContract;

/** Validate an untrusted value as a requirements document; throws typed invalid. */
export function parseRequirements(
  value: unknown,
  described: string,
): CertificationRequirements {
  const result = requirementsSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "$",
      message: issue.message,
    }));
    throw new EvidenceValidationError(
      `invalid certification requirements (${described}): ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
      issues,
      { code: "REQUIREMENTS_INVALID" },
    );
  }
  return result.data;
}

// Lane results come from heterogeneous runners, so extra fields are tolerated;
// the three counters are the contract (loose is deliberate here — strictness
// belongs to the signed certification, not to third-party reporter output).
const laneResultSchema = z.looseObject({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

// The analysis contract rollup understands, matching the shape produced by
// packages/app/scripts/lib/visual-qa.mjs and expected from #14542 analyzers:
// an optional top-level `verdict` and an optional `checks[]` with `ok` flags.
const analysisDocumentSchema = z.looseObject({
  verdict: z.string().optional(),
  checks: z
    .array(
      z.looseObject({
        name: z.string().optional(),
        ok: z.boolean(),
        detail: z.string().optional(),
      }),
    )
    .optional(),
});

/** Per-lane rollup line in the summary. */
export interface LaneRollup {
  lane: string;
  /** Bundle-relative path of the lane's result.json; absent for a missing lane. */
  resultPath?: string;
  passed: number;
  failed: number;
  skipped: number;
  verdict: CertificationVerdict["verdict"];
  note: string;
}

/** One analysis document that contained failures. */
export interface AnalysisFinding {
  path: string;
  failures: string[];
}

/** Machine summary accompanying the draft verdicts. */
export interface RollupSummary {
  lanes: LaneRollup[];
  analysesScanned: number;
  analysisFindings: AnalysisFinding[];
  missingArtifacts: { subject: string; requirement: string }[];
  counts: { pass: number; fail: number; waived: number };
}

/** Rollup output: draft verdicts (reviewer-editable) plus the summary. */
export interface RollupResult {
  schema: 1;
  verdicts: CertificationVerdict[];
  summary: RollupSummary;
}

/** Validate an untrusted value as a rollup/verdicts document; throws typed invalid. */
export function parseVerdictsDocument(
  value: unknown,
  described: string,
): { verdicts: CertificationVerdict[] } {
  // The document a reviewer hands to `certify:sign` is the (possibly edited)
  // rollup output; `summary` is advisory and ignored by signing. Duplicate
  // subjects and waived-without-notes are re-checked by the payload schema at
  // sign time, but each verdict is fully validated here so a bad edit fails
  // at the file it lives in.
  const envelope = z
    .strictObject({
      schema: z.literal(1),
      verdicts: z.array(certificationVerdictSchema).min(1),
      summary: z.unknown().optional(),
    })
    .safeParse(value);
  if (!envelope.success) {
    const issues = envelope.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "$",
      message: issue.message,
    }));
    throw new EvidenceValidationError(
      `invalid verdicts document (${described}): ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
      issues,
      { code: "VERDICTS_INVALID" },
    );
  }
  return { verdicts: envelope.data.verdicts };
}

function readBundleJson(
  bundleDir: string,
  relPath: string,
): { value: unknown } | { error: string } {
  const filePath = path.join(bundleDir, ...relPath.split("/"));
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    // error-policy:J3 a manifest-listed file that cannot be read is a failing
    // finding for its subject, surfaced in the draft verdicts — never skipped.
    return { error: `unreadable: ${(error as Error).message}` };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    // error-policy:J3 malformed reporter JSON drafts as a fail with the parse
    // error in notes; a broken reporter must never read as a green lane.
    return { error: `not valid JSON: ${(error as Error).message}` };
  }
}

const LANE_RESULT_PATTERN = /^lanes\/([^/]+)\/result\.json$/;

function loadManifest(bundleDir: string): BundleManifest {
  const manifestPath = path.join(bundleDir, "manifest.json");
  const read = readBundleJson(bundleDir, "manifest.json");
  if ("error" in read) {
    throw new EvidenceValidationError(
      `bundle manifest unusable for rollup: ${manifestPath} ${read.error}`,
      [{ path: "$", message: read.error }],
      { code: "MANIFEST_INVALID", context: { bundleDir } },
    );
  }
  return parseManifest(read.value, manifestPath);
}

/**
 * Derive draft verdicts and a machine summary from a finalized bundle.
 * Requirements (when given) declare which lanes may be skipped and which
 * artifacts must exist; without them every skip and every skipped lane fails.
 */
export function rollupBundle(
  bundleDir: string,
  options: { requirements?: CertificationRequirements } = {},
): RollupResult {
  const manifest = loadManifest(bundleDir);
  const requirements = options.requirements;
  const optionalLanes = new Map<string, string>();
  const requiredLanes = new Set<string>();
  for (const lane of requirements?.lanes ?? []) {
    if (lane.optional === true) {
      // parseRequirements guarantees a non-empty reason for optional lanes.
      optionalLanes.set(lane.lane, lane.reason as string);
    } else {
      requiredLanes.add(lane.lane);
    }
  }

  const verdicts: CertificationVerdict[] = [];
  const lanes: LaneRollup[] = [];

  const seenLanes = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const match = LANE_RESULT_PATTERN.exec(artifact.path);
    if (match === null) continue;
    const lane = match[1];
    seenLanes.add(lane);
    const read = readBundleJson(bundleDir, artifact.path);
    const parsed =
      "error" in read ? undefined : laneResultSchema.safeParse(read.value);
    if (parsed === undefined || !parsed.success) {
      const problem =
        "error" in read
          ? read.error
          : `missing/invalid passed|failed|skipped counters`;
      const note = `lane result ${problem}`;
      lanes.push({
        lane,
        resultPath: artifact.path,
        passed: 0,
        failed: 0,
        skipped: 0,
        verdict: "fail",
        note,
      });
      verdicts.push({
        subject: `lane:${lane}`,
        verdict: "fail",
        evidence: [artifact.path],
        notes: note,
      });
      continue;
    }
    const { passed, failed, skipped } = parsed.data;
    const counts = `passed=${passed} failed=${failed} skipped=${skipped}`;
    if (failed > 0) {
      lanes.push({
        lane,
        resultPath: artifact.path,
        passed,
        failed,
        skipped,
        verdict: "fail",
        note: counts,
      });
      verdicts.push({
        subject: `lane:${lane}`,
        verdict: "fail",
        evidence: [artifact.path],
        notes: counts,
      });
    } else if (skipped > 0) {
      const reason = optionalLanes.get(lane);
      if (reason !== undefined) {
        const note = `${counts}; lane optional: ${reason}`;
        lanes.push({
          lane,
          resultPath: artifact.path,
          passed,
          failed,
          skipped,
          verdict: "waived",
          note,
        });
        verdicts.push({
          subject: `lane:${lane}`,
          verdict: "waived",
          evidence: [artifact.path],
          notes: note,
        });
      } else {
        const note = `${counts}; skips fail unless the requirements mark this lane optional-with-reason`;
        lanes.push({
          lane,
          resultPath: artifact.path,
          passed,
          failed,
          skipped,
          verdict: "fail",
          note,
        });
        verdicts.push({
          subject: `lane:${lane}`,
          verdict: "fail",
          evidence: [artifact.path],
          notes: note,
        });
      }
    } else {
      lanes.push({
        lane,
        resultPath: artifact.path,
        passed,
        failed,
        skipped,
        verdict: "pass",
        note: counts,
      });
      verdicts.push({
        subject: `lane:${lane}`,
        verdict: "pass",
        evidence: [artifact.path],
        notes: counts,
      });
    }
  }

  // Required lanes with no result.json in the bundle: absent evidence is a
  // failure, not an omission; optional lanes draft as waived with the reason.
  for (const lane of requirements?.lanes ?? []) {
    if (seenLanes.has(lane.lane)) continue;
    if (lane.optional === true) {
      const note = `lane absent from bundle; lane optional: ${lane.reason}`;
      lanes.push({
        lane: lane.lane,
        passed: 0,
        failed: 0,
        skipped: 0,
        verdict: "waived",
        note,
      });
      verdicts.push({
        subject: `lane:${lane.lane}`,
        verdict: "waived",
        evidence: [],
        notes: note,
      });
    } else {
      const note = "required lane has no result.json in the bundle";
      lanes.push({
        lane: lane.lane,
        passed: 0,
        failed: 0,
        skipped: 0,
        verdict: "fail",
        note,
      });
      verdicts.push({
        subject: `lane:${lane.lane}`,
        verdict: "fail",
        evidence: [],
        notes: note,
      });
    }
  }

  let analysesScanned = 0;
  const analysisFindings: AnalysisFinding[] = [];
  for (const artifact of manifest.artifacts) {
    if (artifact.kind !== "analysis" || !artifact.path.endsWith(".json")) {
      continue;
    }
    analysesScanned += 1;
    const read = readBundleJson(bundleDir, artifact.path);
    const parsed =
      "error" in read
        ? undefined
        : analysisDocumentSchema.safeParse(read.value);
    const failures: string[] = [];
    if (parsed === undefined || !parsed.success) {
      failures.push(
        "error" in read
          ? `analysis ${read.error}`
          : "analysis document has an unrecognized shape",
      );
    } else {
      const document = parsed.data;
      if (document.verdict !== undefined && document.verdict !== "pass") {
        failures.push(`verdict:${document.verdict}`);
      }
      for (const [index, check] of (document.checks ?? []).entries()) {
        if (!check.ok) {
          failures.push(
            `check:${check.name ?? String(index)}${check.detail !== undefined ? ` (${check.detail})` : ""}`,
          );
        }
      }
    }
    if (failures.length > 0) {
      analysisFindings.push({ path: artifact.path, failures });
      verdicts.push({
        subject: `analysis:${artifact.path}`,
        verdict: "fail",
        evidence: [artifact.path],
        notes: failures.join("; "),
      });
    }
  }

  const missingArtifacts: { subject: string; requirement: string }[] = [];
  const manifestPaths = manifest.artifacts.map((artifact) => artifact.path);
  const manifestPathSet = new Set(manifestPaths);
  for (const requirement of requirements?.artifacts ?? []) {
    if (requirement.path !== undefined) {
      if (manifestPathSet.has(requirement.path)) {
        verdicts.push({
          subject: requirement.subject,
          verdict: "pass",
          evidence: [requirement.path],
          notes: `required artifact present: ${requirement.path}`,
        });
      } else {
        missingArtifacts.push({
          subject: requirement.subject,
          requirement: requirement.path,
        });
        verdicts.push({
          subject: requirement.subject,
          verdict: "fail",
          evidence: [],
          notes: `required artifact missing: ${requirement.path}`,
        });
      }
      continue;
    }
    const prefix = requirement.pathPrefix as string;
    const matches = manifestPaths.filter((entry) => entry.startsWith(prefix));
    if (matches.length > 0) {
      verdicts.push({
        subject: requirement.subject,
        verdict: "pass",
        evidence: matches.slice(0, 8),
        notes: `${matches.length} artifact(s) under ${prefix}`,
      });
    } else {
      missingArtifacts.push({
        subject: requirement.subject,
        requirement: `${prefix}*`,
      });
      verdicts.push({
        subject: requirement.subject,
        verdict: "fail",
        evidence: [],
        notes: `no artifacts under required prefix: ${prefix}`,
      });
    }
  }

  verdicts.sort((a, b) =>
    a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0,
  );
  const counts = { pass: 0, fail: 0, waived: 0 };
  for (const verdict of verdicts) counts[verdict.verdict] += 1;

  return {
    schema: 1,
    verdicts,
    summary: {
      lanes,
      analysesScanned,
      analysisFindings,
      missingArtifacts,
      counts,
    },
  };
}
