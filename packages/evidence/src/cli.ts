/**
 * Thin CLI over the bundle library: `create` opens a bundle, runs every silo
 * ingestor, and finalizes; `verify` re-hashes an existing bundle. All logic
 * lives in the library modules — this file only parses argv, wires provenance,
 * and formats output. It is a process boundary, so writing to the injected
 * stdout/stderr (console-backed when run as a script) is the product here, not
 * server logging; the library itself never logs. Tests call `runCli` directly
 * with a captured writer instead of spawning a child process.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, verifyBundle } from "./bundle.ts";
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

create   Open a new evidence bundle, ingest every known silo, finalize.
verify   Re-hash every artifact in an existing bundle and report integrity.`;

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

/** Parse argv (without node/script prefix) and run; returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "create") return await runCreate(rest, io);
    if (command === "verify") return await runVerify(rest, io);
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
