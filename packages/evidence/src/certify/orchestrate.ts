/**
 * The one-command certification orchestrator: chains the evidence pieces that
 * already exist (bundle builder, silo ingestors, analyzer runner, vision-QA,
 * verdict rollup, Ed25519 sign/verify) into a single `evidence:certify` run so
 * a keyholder produces a signed, self-verified `certification.json` in one
 * command. It reuses every downstream module unchanged — this file is glue and
 * honesty enforcement, never a reimplementation of any step.
 *
 * The chain (a fresh bundle): optional test matrix → capture its per-lane
 * pass/fail as `lanes/<lane>/result.json` → `createBundle` + `ingestAllSilos`
 * → `analyzeArtifacts` over the ingested pixels at the run tier (writes
 * `analysis.json` beside each subject) → optional VLM Q&A pass (honest skip
 * when no backend is configured) → `finalize` → mechanical `rollupBundle` →
 * reviewer merge (overrides/additions folded onto the rollup, recording the
 * reviewer identity) → `signCertification` → immediate offline
 * `verifyCertification` against the derived public key and the bundle itself.
 *
 * Honesty is structural, not advisory. The mechanical rollup drafts every lane
 * fail / skipped lane / analyzer expectation failure as a non-pass verdict; a
 * reviewer may `waive` such a subject (waivers require notes, which survive
 * into the signed cert) but may never flip a mechanically non-pass subject to
 * `pass` — that is rejected at merge time, the same hole the gate's
 * verdict-completeness check closes. The run self-verifies at the end, so
 * `overallVerdict` is `red` whenever the produced certification would fail the
 * #14547 gate; a red run still writes the truthful (failing) certification
 * rather than fabricating a green one.
 *
 * With `existingBundleDir` the create/ingest/analyze/vision steps are skipped
 * and a pre-built finalized bundle is certified as-is (rollup → review → sign
 * → verify), which is how the local-fallback certifier signs a bundle another
 * runner captured.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { analyzeArtifacts } from "../analyzers/runner.ts";
import { createBundle, type EvidenceBundle, verifyBundle } from "../bundle.ts";
import { EvidenceError, EvidenceValidationError } from "../errors.ts";
import { ingestAllSilos } from "../ingest.ts";
import {
  buildEnvFingerprint,
  collectGitProvenance,
  resolveRunnerKind,
} from "../provenance.ts";
import { parseMeta, type Tier } from "../schema.ts";
import {
  askBatch,
  buildQaRecord,
  resolveBackend,
  VISION_QA_ENV,
  type VisionQuestion,
  writeQaRecord,
} from "../vision-qa/index.ts";
import { derivePublicKeyPem, toPrivateKey } from "./keys.ts";
import {
  type CertificationRequirements,
  type RollupResult,
  rollupBundle,
} from "./rollup.ts";
import {
  type Certification,
  type CertificationPayload,
  type CertificationReviewer,
  type CertificationVerdict,
  REVIEWER_KINDS,
} from "./schema.ts";
import {
  type CertificationVerifyReport,
  signCertification,
  verifyCertification,
} from "./sign.ts";

/** One reviewer decision merged onto the mechanical rollup. */
export interface ReviewerOverride {
  subject: string;
  verdict: CertificationVerdict["verdict"];
  /** Bundle-relative evidence paths; defaults to the rollup subject's evidence. */
  evidence?: string[];
  notes?: string;
}

/** A `--reviewer-verdicts` document: reviewer identity plus per-subject overrides. */
export interface ReviewerVerdictsDocument {
  schema: 1;
  reviewer?: CertificationReviewer;
  verdicts: ReviewerOverride[];
}

const reviewerVerdictsSchema = z.strictObject({
  schema: z.literal(1),
  reviewer: z
    .strictObject({
      kind: z.enum(REVIEWER_KINDS),
      id: z.string().min(1),
      model: z.string().min(1).optional(),
    })
    .optional(),
  verdicts: z
    .array(
      z.strictObject({
        subject: z.string().min(1),
        verdict: z.enum(["pass", "fail", "waived"]),
        evidence: z.array(z.string()).optional(),
        notes: z.string().optional(),
      }),
    )
    .min(1),
});

/** Validate an untrusted reviewer-verdicts value; throws typed invalid. */
export function parseReviewerVerdicts(
  value: unknown,
  described: string,
): ReviewerVerdictsDocument {
  const result = reviewerVerdictsSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join(".") || "$",
      message: issue.message,
    }));
    throw new EvidenceValidationError(
      `invalid reviewer verdicts (${described}): ${issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`,
      issues,
      { code: "REVIEWER_VERDICTS_INVALID" },
    );
  }
  return result.data;
}

/** Output sink for progress lines; the CLI supplies a console-backed writer. */
export interface CertifyIo {
  out(line: string): void;
  err(line: string): void;
}

const SILENT_IO: CertifyIo = { out: () => {}, err: () => {} };

/** One lane's pass/fail counts, captured from the test matrix. */
export interface MatrixLaneResult {
  lane: string;
  passed: number;
  failed: number;
  skipped: number;
  /** Combined stdout/stderr of the run, stored as a lane log artifact. */
  log?: string;
}

/** Result of a matrix run: one entry per lane it reports. */
export interface MatrixRunResult {
  command: string;
  lanes: MatrixLaneResult[];
}

/** Runs the test matrix and reports per-lane pass/fail; injectable for tests. */
export type MatrixRunner = (context: {
  repoRoot: string;
  tier: Tier;
  io: CertifyIo;
}) => Promise<MatrixRunResult>;

/** How one orchestration step resolved, recorded in the run summary. */
export interface StepOutcome {
  step: string;
  status: "ran" | "skipped" | "degraded";
  detail: string;
}

/** Options for {@link orchestrateCertify}. */
export interface CertifyOptions {
  tier: Tier;
  repoRoot: string;
  /** Directory holding run dirs for a fresh bundle; default `<repoRoot>/evidence/runs`. */
  outDir?: string;
  /** Certify this pre-built finalized bundle instead of creating one. */
  existingBundleDir?: string;
  /** Skip the test matrix; lane verdicts then come only from ingested silos. */
  skipMatrix?: boolean;
  /** Reviewer overrides/additions folded onto the mechanical rollup. */
  reviewerVerdicts?: ReviewerVerdictsDocument;
  /** Reviewer identity; required unless supplied by the reviewer-verdicts file. */
  reviewer?: CertificationReviewer;
  /** Ed25519 private key (PEM or KeyObject) held by the certifier. */
  signingKey: string | import("node:crypto").KeyObject;
  requirements?: CertificationRequirements;
  /** Promotion source ref recorded in the payload; default `develop`. */
  baseRef?: string;
  expiresHours?: number;
  /** Where to write the certification; default `<bundle>/certification.json`. */
  certOut?: string;
  /** Test matrix runner; default spawns `packages/scripts/run-all-tests.mjs`. */
  runMatrix?: MatrixRunner;
  /** Env for vision-QA backend resolution + provenance; default `process.env`. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  io?: CertifyIo;
}

/** Full result of an orchestrated certification run. */
export interface CertifyResult {
  bundleDir: string;
  manifestSha256: string;
  certPath: string;
  certification: Certification;
  /** `green` iff the produced certification self-verifies against the bundle. */
  overallVerdict: "green" | "red";
  verify: CertificationVerifyReport;
  rollup: RollupResult;
  steps: StepOutcome[];
  tier: Tier;
}

const CERTIFY_QUESTION: VisionQuestion = {
  id: "renders-cleanly",
  question:
    "Does this screenshot render as a complete, correct UI with no visible " +
    "error text, broken layout, blank/placeholder regions, or overlapping content?",
  expected: "yes",
};

/**
 * Default matrix runner: spawn the repo's cross-package test runner and record
 * a single `matrix` lane from its exit code. A non-zero exit is a lane failure
 * (`failed: 1`), never a skipped-and-forgotten result — the whole point is that
 * a red matrix produces a red certification. The full output is captured as the
 * lane log so a reviewer can read what failed.
 */
export const spawnRunAllTests: MatrixRunner = ({ repoRoot, io }) => {
  const script = path.join(
    repoRoot,
    "packages",
    "scripts",
    "run-all-tests.mjs",
  );
  const command = `node ${path.relative(repoRoot, script)}`;
  io.out(`  matrix: ${command}`);
  return new Promise<MatrixRunResult>((resolve, reject) => {
    const child = spawn("node", [script], {
      cwd: repoRoot,
      env: process.env,
    });
    let buffer = "";
    const capture = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      // error-policy:J2 context-adding rethrow — a runner that cannot even
      // launch is an environment failure the certifier must see, not a lane
      // result to fabricate.
      reject(
        new EvidenceError(`test matrix failed to launch: ${command}`, {
          code: "CERTIFY_MATRIX_LAUNCH",
          cause: error,
          context: { command },
        }),
      );
    });
    child.on("close", (code) => {
      const passed = code === 0 ? 1 : 0;
      const failed = code === 0 ? 0 : 1;
      resolve({
        command,
        lanes: [{ lane: "matrix", passed, failed, skipped: 0, log: buffer }],
      });
    });
  });
};

/** Write a JSON value to a scratch file and add it to the bundle at `bundlePath`. */
async function addJsonArtifact(
  bundle: EvidenceBundle,
  bundlePath: string,
  value: unknown,
  options: { kind: "report" | "log"; source: string; lane?: string },
): Promise<void> {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "certify-"));
  const scratch = path.join(scratchDir, path.posix.basename(bundlePath));
  fs.writeFileSync(scratch, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await bundle.addArtifact(scratch, {
      kind: options.kind,
      source: options.source,
      producedBy: "evidence:certify",
      bundlePath,
      ...(options.lane !== undefined ? { lane: options.lane } : {}),
    });
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** Add a lane's `result.json` (+ log, when present) so rollup scores the lane. */
async function addLaneResult(
  bundle: EvidenceBundle,
  lane: MatrixLaneResult,
): Promise<void> {
  await addJsonArtifact(
    bundle,
    `lanes/${lane.lane}/result.json`,
    { passed: lane.passed, failed: lane.failed, skipped: lane.skipped },
    { kind: "report", source: "test-matrix", lane: lane.lane },
  );
  if (lane.log !== undefined && lane.log.length > 0) {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "certify-log-"));
    const scratch = path.join(scratchDir, "matrix.log");
    fs.writeFileSync(scratch, lane.log);
    try {
      await bundle.addArtifact(scratch, {
        kind: "log",
        source: "test-matrix",
        lane: lane.lane,
        producedBy: "evidence:certify",
        bundlePath: `lanes/${lane.lane}/logs/matrix.log`,
      });
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }
}

/**
 * Run the VLM Q&A pass over the bundle's screenshots. When no backend is
 * configured this is an honest skip (recorded, never a fabricated green); a
 * configured backend runs the shared `askBatch` and writes a `qa.json` beside
 * each screenshot for the reviewer to fold into verdicts.
 */
async function runVisionQaPass(
  bundle: EvidenceBundle,
  env: NodeJS.ProcessEnv,
  io: CertifyIo,
): Promise<StepOutcome> {
  let backend: ReturnType<typeof resolveBackend>;
  try {
    backend = resolveBackend({}, env);
  } catch (error) {
    // error-policy:J4 explicit degrade — a keyless run has no VLM; that is a
    // designed "unavailable" outcome recorded honestly, distinct from a run
    // where every screenshot passed Q&A.
    if (
      error instanceof EvidenceError &&
      error.code === "VISION_NOT_CONFIGURED"
    ) {
      io.out("  vision-qa: skipped (no backend configured)");
      return {
        step: "vision-qa",
        status: "skipped",
        detail: "no VLM backend configured (keyless run)",
      };
    }
    throw error;
  }

  const screenshots = bundle.artifacts.filter(
    (artifact) => artifact.kind === "screenshot",
  );
  if (screenshots.length === 0) {
    io.out(`  vision-qa: ${backend}, no screenshots to review`);
    return {
      step: "vision-qa",
      status: "ran",
      detail: `${backend}: no screenshots in bundle`,
    };
  }

  const entries = screenshots.map((artifact) => ({
    imagePath: path.join(bundle.dir, ...artifact.path.split("/")),
    questions: [CERTIFY_QUESTION],
    bundlePath: artifact.path,
  }));
  const results = await askBatch(
    entries.map(({ imagePath, questions }) => ({ imagePath, questions })),
    {
      backend,
      cacheDir: bundle.dir,
      ...(backend === "local" && env[VISION_QA_ENV.baseUrl] !== undefined
        ? { baseUrl: env[VISION_QA_ENV.baseUrl] }
        : {}),
      ...(backend === "anthropic" &&
      env[VISION_QA_ENV.anthropicKey] !== undefined
        ? { apiKey: env[VISION_QA_ENV.anthropicKey] }
        : {}),
      ...(backend === "openai" && env[VISION_QA_ENV.openaiKey] !== undefined
        ? { apiKey: env[VISION_QA_ENV.openaiKey] }
        : {}),
      ...(backend === "local" && env[VISION_QA_ENV.openaiKey] !== undefined
        ? { apiKey: env[VISION_QA_ENV.openaiKey] }
        : {}),
    },
  );
  for (let index = 0; index < results.length; index += 1) {
    const entry = entries[index];
    const { result } = results[index];
    // buildQaRecord is called for its validation side; writeQaRecord persists.
    void buildQaRecord(entry.bundlePath, entry.questions, result);
    await writeQaRecord(bundle, entry.bundlePath, entry.questions, result);
  }
  io.out(`  vision-qa: ${backend}, ${results.length} screenshot(s) reviewed`);
  return {
    step: "vision-qa",
    status: "ran",
    detail: `${backend}: ${results.length} screenshot(s) reviewed`,
  };
}

/**
 * Fold reviewer overrides onto the mechanical rollup. Every rollup subject is
 * carried through (dropping one would make the cert fail the gate's
 * completeness check); an override replaces a subject's verdict/notes/evidence,
 * and a subject not in the rollup is added as a reviewer-supplied verdict.
 * Flipping a mechanically non-pass subject to `pass` is refused — the honest
 * escape hatch is `waived` (which the schema forces to carry notes).
 */
export function mergeReviewerVerdicts(
  rollup: RollupResult,
  overrides: ReviewerOverride[],
): CertificationVerdict[] {
  const bySubject = new Map<string, CertificationVerdict>();
  const mechanical = new Map<string, CertificationVerdict["verdict"]>();
  for (const verdict of rollup.verdicts) {
    bySubject.set(verdict.subject, { ...verdict });
    mechanical.set(verdict.subject, verdict.verdict);
  }
  for (const override of overrides) {
    const mechanicalVerdict = mechanical.get(override.subject);
    if (
      mechanicalVerdict !== undefined &&
      mechanicalVerdict !== "pass" &&
      override.verdict === "pass"
    ) {
      throw new EvidenceError(
        `reviewer cannot mark mechanically ${mechanicalVerdict} subject '${override.subject}' as pass; waive it with notes instead`,
        {
          code: "CERTIFY_FALSE_PASS",
          context: { subject: override.subject, mechanicalVerdict },
        },
      );
    }
    const existing = bySubject.get(override.subject);
    const evidence = override.evidence ?? existing?.evidence ?? [];
    bySubject.set(override.subject, {
      subject: override.subject,
      verdict: override.verdict,
      evidence,
      ...(override.notes !== undefined ? { notes: override.notes } : {}),
    });
  }
  return [...bySubject.values()].sort((a, b) =>
    a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0,
  );
}

function resolveReviewer(options: CertifyOptions): CertificationReviewer {
  const reviewer = options.reviewer ?? options.reviewerVerdicts?.reviewer;
  if (reviewer === undefined) {
    throw new EvidenceError(
      "certify requires a reviewer identity (--reviewer-id/--reviewer-kind or a reviewer block in --reviewer-verdicts)",
      { code: "CERTIFY_REVIEWER_MISSING" },
    );
  }
  return reviewer;
}

/**
 * Build (or adopt) an evidence bundle and drive it through the full
 * certification chain, returning the signed certification and its self-verify
 * report. Throws typed `EvidenceError`s for operator failures (no reviewer, a
 * false-pass override, a launch failure); a legitimately failing bundle is not
 * an error — it produces a signed cert with `overallVerdict: "red"`.
 */
export async function orchestrateCertify(
  options: CertifyOptions,
): Promise<CertifyResult> {
  const io = options.io ?? SILENT_IO;
  const env = options.env ?? process.env;
  const now = options.now;
  const reviewer = resolveReviewer(options);
  const privateKey = toPrivateKey(options.signingKey);
  const publicKeyPem = derivePublicKeyPem(privateKey);
  const steps: StepOutcome[] = [];

  let bundleDir: string;
  let manifestSha256: string;
  let tier: Tier;
  let commit: string;
  let branch: string;

  if (options.existingBundleDir !== undefined) {
    bundleDir = path.resolve(options.existingBundleDir);
    const report = await verifyBundle(bundleDir);
    if (!report.ok) {
      throw new EvidenceError(
        `refusing to certify: existing bundle failed integrity with ${report.issues.length} issue(s)`,
        { code: "CERTIFY_BUNDLE_TAMPERED", context: { bundleDir } },
      );
    }
    const meta = parseMeta(
      JSON.parse(fs.readFileSync(path.join(bundleDir, "meta.json"), "utf8")),
      path.join(bundleDir, "meta.json"),
    );
    manifestSha256 = report.manifestSha256;
    tier = meta.tier;
    commit = meta.commit;
    branch = meta.branch;
    io.out(`certifying existing bundle ${report.runId} (tier=${tier})`);
    steps.push({
      step: "bundle",
      status: "ran",
      detail: `adopted pre-built bundle ${report.runId}`,
    });
  } else {
    tier = options.tier;
    const git = collectGitProvenance(options.repoRoot);
    commit = git.commit;
    branch = git.branch;
    const runner = resolveRunnerKind(env);
    const rootDir = path.resolve(
      options.outDir ?? path.join(options.repoRoot, "evidence", "runs"),
    );
    const bundle = createBundle({
      rootDir,
      provenance: {
        commit,
        branch,
        runner,
        tier,
        envFingerprint: buildEnvFingerprint(tier),
      },
      ...(now !== undefined ? { now } : {}),
    });
    bundleDir = bundle.dir;
    io.out(`bundle ${bundle.runId} (tier=${tier})`);

    if (options.skipMatrix === true) {
      steps.push({
        step: "matrix",
        status: "skipped",
        detail: "--skip-matrix; lane verdicts come from ingested silos only",
      });
      io.out("  matrix: skipped (--skip-matrix)");
    } else {
      const runMatrix = options.runMatrix ?? spawnRunAllTests;
      const matrix = await runMatrix({ repoRoot: options.repoRoot, tier, io });
      for (const lane of matrix.lanes) await addLaneResult(bundle, lane);
      const failedLanes = matrix.lanes.filter((lane) => lane.failed > 0);
      steps.push({
        step: "matrix",
        status: failedLanes.length > 0 ? "degraded" : "ran",
        detail: `${matrix.command}: ${matrix.lanes.length} lane(s), ${failedLanes.length} failing`,
      });
    }

    const ingest = await ingestAllSilos(bundle, options.repoRoot);
    const ingestedCount = ingest.reduce(
      (sum, result) => sum + result.artifactCount,
      0,
    );
    steps.push({
      step: "ingest",
      status: "ran",
      detail: `${ingest.filter((r) => r.status === "ingested").length} silo(s), ${ingestedCount} artifact(s)`,
    });
    io.out(
      `  ingest: ${ingestedCount} artifact(s) from ${ingest.length} silo(s)`,
    );

    const analyzeInputs = bundle.artifacts;
    const analysis = await analyzeArtifacts(bundle.dir, analyzeInputs, {
      tier,
      bundle,
    });
    steps.push({
      step: "analyze",
      status: "ran",
      detail: `${analysis.subjects.length} subject(s) analyzed at tier ${tier}`,
    });
    io.out(`  analyze: ${analysis.subjects.length} subject(s) at tier ${tier}`);

    steps.push(await runVisionQaPass(bundle, env, io));

    await addJsonArtifact(
      bundle,
      "certify/run-summary.json",
      { schema: 1, tier, commit, branch, steps },
      { kind: "report", source: "evidence:certify" },
    );

    const finalized = await bundle.finalize();
    manifestSha256 = finalized.manifestSha256;
    io.out(`  finalize: manifest sha256 ${manifestSha256}`);
  }

  const rollup = rollupBundle(bundleDir, {
    ...(options.requirements !== undefined
      ? { requirements: options.requirements }
      : {}),
  });
  steps.push({
    step: "rollup",
    status: "ran",
    detail: `${rollup.verdicts.length} subject(s) (pass=${rollup.summary.counts.pass} fail=${rollup.summary.counts.fail} waived=${rollup.summary.counts.waived})`,
  });

  const verdicts = mergeReviewerVerdicts(
    rollup,
    options.reviewerVerdicts?.verdicts ?? [],
  );
  const reviewCounts = { pass: 0, fail: 0, waived: 0 };
  for (const verdict of verdicts) reviewCounts[verdict.verdict] += 1;
  steps.push({
    step: "review",
    status: "ran",
    detail: `${reviewer.kind}:${reviewer.id} — ${verdicts.length} verdict(s) (pass=${reviewCounts.pass} fail=${reviewCounts.fail} waived=${reviewCounts.waived})`,
  });

  const createdAt = (now ?? (() => new Date()))();
  const payload: CertificationPayload = {
    schema: 1,
    bundleSha: manifestSha256,
    commit,
    branch,
    baseRef: options.baseRef ?? "develop",
    tier,
    verdicts,
    reviewer,
    createdAt: createdAt.toISOString(),
    ...(options.expiresHours !== undefined
      ? {
          expiresAt: new Date(
            createdAt.getTime() + options.expiresHours * 3_600_000,
          ).toISOString(),
        }
      : {}),
  };
  const certification = signCertification(payload, privateKey);
  const certPath = path.resolve(
    options.certOut ?? path.join(bundleDir, "certification.json"),
  );
  fs.writeFileSync(certPath, `${JSON.stringify(certification, null, 2)}\n`);
  steps.push({
    step: "sign",
    status: "ran",
    detail: `signed ${certPath} (key ${certification.signature.publicKeyFingerprint})`,
  });

  // Self-verify against the derived public key AND the bundle so the run's own
  // `overallVerdict` matches exactly what the #14547 gate would compute — a
  // false-pass, a stray fail, or a tampered bundle turns the run red here.
  const verify = await verifyCertification(certPath, {
    publicKeyPem,
    bundleDir,
    ...(options.requirements !== undefined
      ? { requirements: options.requirements }
      : {}),
    ...(now !== undefined ? { now } : {}),
  });
  const overallVerdict = verify.ok ? "green" : "red";
  io.out(
    `certification ${overallVerdict.toUpperCase()} — ${certPath}` +
      (verify.ok
        ? ""
        : `\n  failures: ${verify.failures.map((f) => f.code).join(", ")}`),
  );

  return {
    bundleDir,
    manifestSha256,
    certPath,
    certification,
    overallVerdict,
    verify,
    rollup,
    steps,
    tier,
  };
}
