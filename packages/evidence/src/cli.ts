/**
 * Thin CLI over the bundle library: `create` opens a bundle, runs every silo
 * ingestor, and finalizes; `verify` re-hashes an existing bundle. All logic
 * lives in the library modules — this file only parses argv, wires provenance,
 * and formats output. It is a process boundary, so writing to the injected
 * stdout/stderr (console-backed when run as a script) is the product here, not
 * server logging; the library itself never logs. Tests call `runCli` directly
 * with a captured writer instead of spawning a child process.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, verifyBundle } from "./bundle.ts";
import { resolveSigningKey } from "./certify/keys.ts";
import {
  orchestrateCertify,
  parseReviewerVerdicts,
} from "./certify/orchestrate.ts";
import { parseRequirements } from "./certify/rollup.ts";
import { REVIEWER_KINDS, type ReviewerKind } from "./certify/schema.ts";
import { EvidenceError } from "./errors.ts";
import { ingestAllSilos } from "./ingest.ts";
import {
  buildEnvFingerprint,
  collectGitProvenance,
  resolveRunnerKind,
} from "./provenance.ts";
import { TIERS, type Tier } from "./schema.ts";

const USAGE = `Usage:
  bundle:create -- --tier <cpu|gpu|full> [--out <dir>] [--repo-root <dir>]
  bundle:verify -- <bundle-dir>
  certify       -- --tier <cpu|gpu|full> --reviewer-id <id> --reviewer-kind <agent|human>
                   [--reviewer-model <m>] [--reviewer-verdicts <file>] [--skip-matrix]
                   [--bundle <existing-dir>] [--requirements <file>] [--base-ref <ref>]
                   [--expires-hours <n>] [--key-file <pem>] [--cert-out <path>]
                   [--out <dir>] [--repo-root <dir>]

create   Open a new evidence bundle, ingest every known silo, finalize.
verify   Re-hash every artifact in an existing bundle and report integrity.
certify  One command: matrix → ingest → analyze → vision-qa → rollup →
         reviewer merge → sign → self-verify. Writes a signed certification.json
         and exits 0 only when it self-verifies (green), 1 when red.`;

/** Output sinks; injectable so tests capture instead of spawning. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

function parseCreateArgs(argv: string[]): {
  tier: Tier;
  outDir?: string;
  repoRoot?: string;
} {
  let tier: Tier | undefined;
  let outDir: string | undefined;
  let repoRoot: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new EvidenceError(`${arg} requires a value`, {
          code: "CLI_USAGE",
        });
      }
      index += 1;
      return next;
    };
    if (arg === "--tier") {
      const raw = value();
      if (!(TIERS as readonly string[]).includes(raw)) {
        throw new EvidenceError(
          `--tier must be one of ${TIERS.join("|")}, got: ${raw}`,
          { code: "CLI_USAGE" },
        );
      }
      tier = raw as Tier;
    } else if (arg === "--out") {
      outDir = value();
    } else if (arg === "--repo-root") {
      repoRoot = value();
    } else {
      throw new EvidenceError(`unknown argument: ${arg}`, {
        code: "CLI_USAGE",
      });
    }
  }
  if (tier === undefined) {
    throw new EvidenceError("--tier is required", { code: "CLI_USAGE" });
  }
  return { tier, outDir, repoRoot };
}

function defaultRepoRoot(): string {
  // src/cli.ts → src → packages/evidence → packages → repo root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

async function runCreate(argv: string[], io: CliIo): Promise<number> {
  const args = parseCreateArgs(argv);
  const repoRoot = path.resolve(args.repoRoot ?? defaultRepoRoot());
  const rootDir = path.resolve(
    args.outDir ?? path.join(repoRoot, "evidence", "runs"),
  );
  const git = collectGitProvenance(repoRoot);
  const runner = resolveRunnerKind(process.env);
  const bundle = createBundle({
    rootDir,
    provenance: {
      commit: git.commit,
      branch: git.branch,
      runner,
      tier: args.tier,
      envFingerprint: buildEnvFingerprint(args.tier),
    },
  });
  const ingestStart = Date.now();
  const results = await ingestAllSilos(bundle, repoRoot);
  const finalized = await bundle.finalize({
    timings: { "ingest.all": Date.now() - ingestStart },
  });

  const siloWidth = Math.max(...results.map((result) => result.silo.length));
  io.out(`bundle ${bundle.runId}`);
  io.out(
    `  commit ${git.commit} (${git.branch}) runner=${runner} tier=${args.tier}`,
  );
  io.out("");
  for (const result of results) {
    io.out(
      `  ${result.silo.padEnd(siloWidth)}  ${result.status.padEnd(8)}  ${
        result.status === "absent" ? "-" : String(result.artifactCount)
      }`,
    );
  }
  const total = results.reduce((sum, result) => sum + result.artifactCount, 0);
  io.out("");
  io.out(`  artifacts: ${total}`);
  io.out(`  manifest:  ${finalized.manifestPath}`);
  io.out(`  sha256:    ${finalized.manifestSha256}`);
  return 0;
}

async function runVerify(argv: string[], io: CliIo): Promise<number> {
  const [dir, ...rest] = argv;
  if (dir === undefined || rest.length > 0) {
    throw new EvidenceError("verify takes exactly one bundle directory", {
      code: "CLI_USAGE",
    });
  }
  const report = await verifyBundle(path.resolve(dir));
  io.out(`bundle ${report.runId}`);
  io.out(
    `  artifacts: ${report.artifactCount}  verified: ${report.verifiedCount}  issues: ${report.issues.length}`,
  );
  io.out(`  manifest sha256: ${report.manifestSha256}`);
  for (const issue of report.issues) {
    const detail =
      issue.expected !== undefined
        ? ` (expected ${issue.expected}, actual ${issue.actual})`
        : "";
    io.err(`  ${issue.issue}: ${issue.path}${detail}`);
  }
  io.out(report.ok ? "  OK" : "  FAILED");
  return report.ok ? 0 : 1;
}

function readJson(filePath: string, what: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    // error-policy:J2 context-adding rethrow — a missing input file is a
    // usage-level failure the invoking harness must see.
    throw new EvidenceError(`${what} unreadable: ${filePath}`, {
      code: "CLI_INPUT_UNREADABLE",
      cause: error,
      context: { filePath },
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    // error-policy:J3 untrusted input — malformed JSON is a typed failure.
    throw new EvidenceError(`${what} is not valid JSON: ${filePath}`, {
      code: "CLI_INPUT_INVALID",
      cause: error,
      context: { filePath },
    });
  }
}

interface CertifyArgs {
  tier: Tier;
  reviewerId?: string;
  reviewerKind?: ReviewerKind;
  reviewerModel?: string;
  reviewerVerdictsPath?: string;
  requirementsPath?: string;
  existingBundleDir?: string;
  skipMatrix: boolean;
  baseRef?: string;
  expiresHours?: number;
  keyFile?: string;
  certOut?: string;
  outDir?: string;
  repoRoot?: string;
}

function parseCertifyArgs(argv: string[]): CertifyArgs {
  const value = new Map<string, string>();
  const flags = new Set<string>();
  const valueFlags = new Set([
    "--tier",
    "--reviewer-id",
    "--reviewer-kind",
    "--reviewer-model",
    "--reviewer-verdicts",
    "--requirements",
    "--bundle",
    "--base-ref",
    "--expires-hours",
    "--key-file",
    "--cert-out",
    "--out",
    "--repo-root",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-matrix") {
      flags.add(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new EvidenceError(`${arg} requires a value`, {
          code: "CLI_USAGE",
        });
      }
      value.set(arg, next);
      index += 1;
      continue;
    }
    throw new EvidenceError(`unknown argument: ${arg}`, { code: "CLI_USAGE" });
  }
  const tierRaw = value.get("--tier");
  if (tierRaw === undefined) {
    throw new EvidenceError("--tier is required", { code: "CLI_USAGE" });
  }
  if (!(TIERS as readonly string[]).includes(tierRaw)) {
    throw new EvidenceError(
      `--tier must be one of ${TIERS.join("|")}, got: ${tierRaw}`,
      { code: "CLI_USAGE" },
    );
  }
  const reviewerId = value.get("--reviewer-id");
  const reviewerKindRaw = value.get("--reviewer-kind");
  if ((reviewerId === undefined) !== (reviewerKindRaw === undefined)) {
    throw new EvidenceError(
      "--reviewer-id and --reviewer-kind must be provided together",
      {
        code: "CLI_USAGE",
      },
    );
  }
  if (reviewerId === undefined && value.has("--reviewer-model")) {
    throw new EvidenceError(
      "--reviewer-model requires --reviewer-id and --reviewer-kind",
      {
        code: "CLI_USAGE",
      },
    );
  }
  if (
    reviewerKindRaw !== undefined &&
    !(REVIEWER_KINDS as readonly string[]).includes(reviewerKindRaw)
  ) {
    throw new EvidenceError(
      `--reviewer-kind must be one of ${REVIEWER_KINDS.join("|")}, got: ${reviewerKindRaw}`,
      { code: "CLI_USAGE" },
    );
  }
  const expiresRaw = value.get("--expires-hours");
  let expiresHours: number | undefined;
  if (expiresRaw !== undefined) {
    expiresHours = Number(expiresRaw);
    if (!Number.isFinite(expiresHours) || expiresHours <= 0) {
      throw new EvidenceError(
        `--expires-hours must be a positive number, got: ${expiresRaw}`,
        { code: "CLI_USAGE" },
      );
    }
  }
  return {
    tier: tierRaw as Tier,
    ...(reviewerId !== undefined ? { reviewerId } : {}),
    ...(reviewerKindRaw !== undefined
      ? { reviewerKind: reviewerKindRaw as ReviewerKind }
      : {}),
    reviewerModel: value.get("--reviewer-model"),
    reviewerVerdictsPath: value.get("--reviewer-verdicts"),
    requirementsPath: value.get("--requirements"),
    existingBundleDir: value.get("--bundle"),
    skipMatrix: flags.has("--skip-matrix"),
    baseRef: value.get("--base-ref"),
    expiresHours,
    keyFile: value.get("--key-file"),
    certOut: value.get("--cert-out"),
    outDir: value.get("--out"),
    repoRoot: value.get("--repo-root"),
  };
}

async function runCertify(argv: string[], io: CliIo): Promise<number> {
  const args = parseCertifyArgs(argv);
  const repoRoot = path.resolve(args.repoRoot ?? defaultRepoRoot());
  const signingKey = resolveSigningKey({
    env: process.env,
    ...(args.keyFile !== undefined ? { keyFile: args.keyFile } : {}),
  });
  const reviewerVerdicts =
    args.reviewerVerdictsPath !== undefined
      ? parseReviewerVerdicts(
          readJson(args.reviewerVerdictsPath, "reviewer verdicts file"),
          args.reviewerVerdictsPath,
        )
      : undefined;
  const requirements =
    args.requirementsPath !== undefined
      ? parseRequirements(
          readJson(args.requirementsPath, "requirements file"),
          args.requirementsPath,
        )
      : undefined;

  const result = await orchestrateCertify({
    tier: args.tier,
    repoRoot,
    signingKey,
    ...(args.reviewerId !== undefined && args.reviewerKind !== undefined
      ? {
          reviewer: {
            kind: args.reviewerKind,
            id: args.reviewerId,
            ...(args.reviewerModel !== undefined
              ? { model: args.reviewerModel }
              : {}),
          },
        }
      : {}),
    skipMatrix: args.skipMatrix,
    ...(reviewerVerdicts !== undefined ? { reviewerVerdicts } : {}),
    ...(requirements !== undefined ? { requirements } : {}),
    ...(args.existingBundleDir !== undefined
      ? { existingBundleDir: args.existingBundleDir }
      : {}),
    ...(args.baseRef !== undefined ? { baseRef: args.baseRef } : {}),
    ...(args.expiresHours !== undefined
      ? { expiresHours: args.expiresHours }
      : {}),
    ...(args.certOut !== undefined ? { certOut: args.certOut } : {}),
    ...(args.outDir !== undefined ? { outDir: args.outDir } : {}),
    io,
  });

  io.out("");
  io.out(`  bundle:   ${result.bundleDir}`);
  io.out(`  manifest: ${result.manifestSha256}`);
  io.out(`  cert:     ${result.certPath}`);
  io.out(`  verdict:  ${result.overallVerdict.toUpperCase()}`);
  if (!result.verify.ok) {
    for (const failure of result.verify.failures) {
      io.err(`  ${failure.code}: ${failure.message}`);
    }
  }
  return result.overallVerdict === "green" ? 0 : 1;
}

/** Parse argv (without node/script prefix) and run; returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "create") return await runCreate(rest, io);
    if (command === "verify") return await runVerify(rest, io);
    if (command === "certify") return await runCertify(rest, io);
    io.err(USAGE);
    return command === undefined || command === "--help" || command === "-h"
      ? 0
      : 1;
  } catch (error) {
    // error-policy:J1 process boundary — translate typed failures into a
    // structured stderr line + non-zero exit for the invoking harness.
    if (error instanceof EvidenceError) {
      io.err(`error [${error.code}]: ${error.message}`);
      if (error.code === "CLI_USAGE") io.err(USAGE);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  process.exitCode = await runCli(process.argv.slice(2), io);
}
