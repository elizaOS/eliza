/**
 * CLI for the video evidence lanes: `walkthrough` runs the data-driven driver
 * over one or all shipped definitions and ingests each produced video (normalized
 * + keyframe-analyzed) into a bundle; `ingest` normalizes and ingests an already
 * recorded video (a producer's webm/mov) into a bundle. Like the bundle CLI this
 * is a thin process boundary: it parses argv, opens or reuses a bundle with real
 * git provenance, drives the library, and prints an honest summary. The library
 * never logs; stdout/stderr here are the product.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBundle, type EvidenceBundle } from "../bundle.ts";
import { EvidenceError } from "../errors.ts";
import {
  buildEnvFingerprint,
  collectGitProvenance,
  resolveRunnerKind,
} from "../provenance.ts";
import { TIERS, type Tier } from "../schema.ts";
import {
  ingestVideo,
  VIDEO_GRANULARITIES,
  type VideoGranularity,
} from "./ingest.ts";
import {
  loadAllWalkthroughDefs,
  loadWalkthroughDef,
  runAndIngestWalkthrough,
} from "./walkthroughs.ts";

const USAGE = `Usage:
  video:walkthrough -- --def <file|all> [--bundle <dir>] [--base-url <url>] [--tier <cpu|gpu|full>] [--out <scratch>]
  video:ingest      -- --file <video> --granularity <element|feature|walkthrough> --slug <slug> [--bundle <dir>] [--tier <cpu|gpu|full>]

walkthrough  Run the driver over a walkthrough definition (or all shipped ones)
             and ingest each video with keyframe analysis into a bundle.
ingest       Normalize + ingest an already-recorded video into a bundle.`;

/** Output sinks; injectable so tests capture instead of spawning. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

function defaultRepoRoot(): string {
  // src/video/cli.ts → video → src → packages/evidence → packages → repo root.
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
}

interface ParsedArgs {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[], known: Set<string>): ParsedArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new EvidenceError(`unexpected positional argument: ${arg}`, {
        code: "CLI_USAGE",
      });
    }
    const key = arg.slice(2);
    if (!known.has(key)) {
      throw new EvidenceError(`unknown argument: ${arg}`, {
        code: "CLI_USAGE",
      });
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(key);
    } else {
      values.set(key, next);
      index += 1;
    }
  }
  return { values, flags };
}

function parseTier(raw: string | undefined): Tier {
  if (raw === undefined) return "cpu";
  if (!(TIERS as readonly string[]).includes(raw)) {
    throw new EvidenceError(
      `--tier must be one of ${TIERS.join("|")}, got: ${raw}`,
      {
        code: "CLI_USAGE",
      },
    );
  }
  return raw as Tier;
}

/** Open a fresh bundle under `--bundle`'s parent (or evidence/runs) with real provenance. */
function openBundle(
  bundleDir: string | undefined,
  repoRoot: string,
  tier: Tier,
): EvidenceBundle {
  const git = collectGitProvenance(repoRoot);
  const runner = resolveRunnerKind(process.env);
  const provenance = {
    commit: git.commit,
    branch: git.branch,
    runner,
    tier,
    envFingerprint: buildEnvFingerprint(tier),
  };
  if (bundleDir !== undefined) {
    // A caller-named bundle dir is the run dir itself: use its parent as the
    // rootDir and its basename as the fixed runId so the bundle lands exactly there.
    const resolved = path.resolve(bundleDir);
    return createBundle({
      rootDir: path.dirname(resolved),
      provenance,
      runId: path.basename(resolved),
    });
  }
  return createBundle({
    rootDir: path.join(repoRoot, "evidence", "runs"),
    provenance,
  });
}

async function runWalkthroughCommand(
  argv: string[],
  io: CliIo,
): Promise<number> {
  const { values } = parseArgs(
    argv,
    new Set(["def", "bundle", "base-url", "tier", "out", "repo-root"]),
  );
  const defArg = values.get("def");
  if (defArg === undefined) {
    throw new EvidenceError("--def <file|all> is required", {
      code: "CLI_USAGE",
    });
  }
  const repoRoot = path.resolve(values.get("repo-root") ?? defaultRepoRoot());
  const tier = parseTier(values.get("tier"));
  const bundle = openBundle(values.get("bundle"), repoRoot, tier);
  // Scratch must live OUTSIDE the bundle dir: verifyBundle sweeps for unlisted
  // files, and the driver's raw webm/screenshots are not manifest artifacts.
  const outRoot = values.get("out")
    ? path.resolve(values.get("out") as string)
    : fs.mkdtempSync(path.join(os.tmpdir(), "evidence-walkthrough-"));
  const cleanupScratch = values.get("out") === undefined;
  const baseUrl = values.get("base-url");

  const defs =
    defArg === "all"
      ? loadAllWalkthroughDefs()
      : [
          {
            def: loadWalkthroughDef(path.resolve(defArg)),
            file: path.resolve(defArg),
          },
        ];

  io.out(`bundle ${bundle.runId}`);
  let ran = 0;
  try {
    for (const { def } of defs) {
      if (def.requiresApp && baseUrl === undefined) {
        io.err(
          `  ${def.slug.padEnd(16)} skipped   requires --base-url (requiresApp)`,
        );
        continue;
      }
      const result = await runAndIngestWalkthrough(def, bundle, {
        out: path.join(outRoot, def.slug),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      const norm = result.ingest.normalize.status;
      io.out(
        `  ${def.slug.padEnd(16)} ${def.granularity.padEnd(11)} ` +
          `steps=${result.stepCount} ` +
          `norm=${norm} keyframes=${result.ingest.keyframeCount} video=${result.ingest.video.path}`,
      );
      ran += 1;
    }
  } finally {
    if (cleanupScratch) fs.rmSync(outRoot, { recursive: true, force: true });
  }
  const finalized = await bundle.finalize();
  io.out("");
  io.out(`  walkthroughs ran: ${ran}`);
  io.out(`  manifest:  ${finalized.manifestPath}`);
  io.out(`  sha256:    ${finalized.manifestSha256}`);
  return ran > 0 ? 0 : 1;
}

async function runIngestCommand(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs(
    argv,
    new Set(["file", "granularity", "slug", "bundle", "tier", "repo-root"]),
  );
  const file = values.get("file");
  const granularityRaw = values.get("granularity");
  const slug = values.get("slug");
  if (
    file === undefined ||
    granularityRaw === undefined ||
    slug === undefined
  ) {
    throw new EvidenceError(
      "--file, --granularity, and --slug are all required",
      {
        code: "CLI_USAGE",
      },
    );
  }
  if (!(VIDEO_GRANULARITIES as readonly string[]).includes(granularityRaw)) {
    throw new EvidenceError(
      `--granularity must be one of ${VIDEO_GRANULARITIES.join("|")}, got: ${granularityRaw}`,
      { code: "CLI_USAGE" },
    );
  }
  const repoRoot = path.resolve(values.get("repo-root") ?? defaultRepoRoot());
  const tier = parseTier(values.get("tier"));
  const bundle = openBundle(values.get("bundle"), repoRoot, tier);
  const result = await ingestVideo(bundle, path.resolve(file), {
    granularity: granularityRaw as VideoGranularity,
    slug,
    source: "video-ingest",
    producedBy: "video:ingest",
    tier,
  });
  const finalized = await bundle.finalize();
  io.out(`bundle ${bundle.runId}`);
  io.out(`  video:     ${result.video.path}`);
  io.out(`  normalize: ${result.normalize.status}`);
  io.out(`  keyframes: ${result.keyframeCount}`);
  io.out(`  manifest:  ${finalized.manifestPath}`);
  io.out(`  sha256:    ${finalized.manifestSha256}`);
  return 0;
}

/** Parse argv (without node/script prefix) and run; returns the exit code. */
export async function runVideoCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "walkthrough") return await runWalkthroughCommand(rest, io);
    if (command === "ingest") return await runIngestCommand(rest, io);
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
  process.exitCode = await runVideoCli(process.argv.slice(2), io);
}
