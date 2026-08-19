/**
 * Silo ingestors: pure discovery + copy from the repo's existing evidence
 * silos into a bundle, with provenance stamped at ingest time. Producers keep
 * their native output layouts; each ingestor maps one named producer family to
 * `addArtifact` calls with the correct kind/source/lane. An ingestor reports
 * `absent` when none of its roots exist and `ingested` (possibly with zero
 * artifacts) when a root exists but is empty — absent and empty are different
 * results and are never conflated. This list is the sole normal-path producer
 * inventory. The reviewer consumes the resulting verified bundle rather than
 * independently crawling these roots. Coordinated runs snapshot content and
 * filesystem identity before executing lanes so unchanged persistent output is
 * excluded from the new run's provenance.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceBundle } from "./bundle.ts";
import { EvidenceError } from "./errors.ts";
import type { ArtifactKind } from "./schema.ts";

/** Honest per-silo outcome of an ingest pass. */
export interface IngestResult {
  silo: string;
  status: "ingested" | "absent";
  artifactCount: number;
}

/** A silo root, relative to the repo root; `label` namespaces multi-root silos. */
interface SiloRoot {
  label: string;
  dir: string;
}

interface SiloDefinition {
  silo: string;
  source: string;
  producedBy: string;
  lane?: string;
  roots: SiloRoot[];
  /** Per-silo kind override; receives the root-relative posix path. */
  classify?: (relPath: string, defaultKind: ArtifactKind) => ArtifactKind;
}

export interface SiloSnapshot {
  schema: 1;
  files: Record<
    string,
    { sha256: string; size: number; mtimeMs: number; ctimeMs: number }
  >;
}

function snapshotKey(silo: string, rootLabel: string, relPath: string): string {
  return `${silo}\0${rootLabel}\0${relPath}`;
}

interface StableCapture {
  sha256: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  stagedPath?: string;
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

/** Read one regular non-symlink file through a stable descriptor. */
function captureStableFile(
  filePath: string,
  stagingDir?: string,
): StableCapture {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sourceLstat = fs.lstatSync(filePath, { bigint: true });
    if (
      sourceLstat.isSymbolicLink() ||
      !sourceLstat.isFile() ||
      sourceLstat.nlink !== 1n
    ) {
      throw new EvidenceError(
        `evidence source is not a single-link regular file: ${filePath}`,
        {
          code: "SILO_SOURCE_UNSAFE",
          context: { filePath, nlink: sourceLstat.nlink.toString() },
        },
      );
    }
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const stagedPath = stagingDir
      ? path.join(
          stagingDir,
          `${process.pid}-${Date.now()}-${attempt}-${Math.random()}`,
        )
      : undefined;
    let stagedDescriptor: number | undefined;
    try {
      const before = fs.fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        !sameIdentity(sourceLstat, before)
      ) {
        throw new EvidenceError(
          `evidence source changed before capture: ${filePath}`,
          {
            code: "SILO_SOURCE_UNSAFE",
            context: { filePath },
          },
        );
      }
      if (stagedPath) {
        stagedDescriptor = fs.openSync(
          stagedPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
      }
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let total = 0;
      for (;;) {
        const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        const bytes = chunk.subarray(0, bytesRead);
        hash.update(bytes);
        if (stagedDescriptor !== undefined) {
          let offset = 0;
          while (offset < bytes.length) {
            const written = fs.writeSync(
              stagedDescriptor,
              bytes,
              offset,
              bytes.length - offset,
            );
            if (written === 0) {
              throw new EvidenceError(
                `could not stage evidence source bytes: ${filePath}`,
                { code: "SILO_SOURCE_UNSTABLE", context: { filePath } },
              );
            }
            offset += written;
          }
        }
        total += bytesRead;
      }
      if (stagedDescriptor !== undefined) {
        fs.fsyncSync(stagedDescriptor);
        fs.closeSync(stagedDescriptor);
        stagedDescriptor = undefined;
      }
      const after = fs.fstatSync(descriptor, { bigint: true });
      if (sameIdentity(before, after) && BigInt(total) === after.size) {
        return {
          sha256: hash.digest("hex"),
          size: total,
          mtimeMs: Number(after.mtimeNs) / 1_000_000,
          ctimeMs: Number(after.ctimeNs) / 1_000_000,
          ...(stagedPath ? { stagedPath } : {}),
        };
      }
    } finally {
      if (stagedDescriptor !== undefined) fs.closeSync(stagedDescriptor);
      fs.closeSync(descriptor);
    }
    if (stagedPath) fs.rmSync(stagedPath, { force: true });
  }
  throw new EvidenceError(
    `evidence source changed while being captured: ${filePath}`,
    {
      code: "SILO_SOURCE_UNSTABLE",
      context: { filePath, attempts: 3 },
    },
  );
}

// Directory names that never contain evidence; everything else in a silo is
// treated as an artifact so nothing silently disappears from the bundle.
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".turbo"]);

const KIND_BY_EXTENSION: Record<string, ArtifactKind> = {
  ".png": "screenshot",
  ".jpg": "screenshot",
  ".jpeg": "screenshot",
  ".gif": "screenshot",
  ".webp": "screenshot",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".jsonl": "trajectory",
  ".log": "log",
  ".txt": "log",
  ".json": "report",
  ".xml": "report",
  ".html": "report",
  ".md": "report",
};

function classifyByExtension(relPath: string): ArtifactKind {
  return (
    KIND_BY_EXTENSION[path.posix.extname(relPath).toLowerCase()] ?? "other"
  );
}

function walkSiloFiles(root: string, relBase = ""): string[] {
  const before = fs.lstatSync(root, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new EvidenceError(
      `unsafe directory in evidence producer tree: ${root}`,
      {
        code: "SILO_SOURCE_UNSAFE",
        context: { root },
      },
    );
  }
  const files: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    const full = path.join(root, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      throw new EvidenceError(`symlink in evidence producer tree: ${full}`, {
        code: "SILO_SOURCE_UNSAFE",
      });
    } else if (stat.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      files.push(...walkSiloFiles(full, rel));
    } else if (stat.isFile()) {
      files.push(rel);
    }
  }
  const after = fs.lstatSync(root, { bigint: true });
  if (!after.isDirectory() || !sameIdentity(before, after)) {
    throw new EvidenceError(
      `evidence producer directory changed while being inventoried: ${root}`,
      { code: "SILO_SOURCE_UNSTABLE", context: { root } },
    );
  }
  return files;
}

function assertCanonicalRoot(repoRoot: string, rootDir: string): void {
  const relative = path.relative(repoRoot, rootDir);
  let cursor = repoRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) return;
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new EvidenceError(
        `canonical evidence root crosses a symlink: ${cursor}`,
        {
          code: "SILO_SOURCE_UNSAFE",
          context: { rootDir, cursor },
        },
      );
    }
  }
  const physicalRepo = fs.realpathSync(repoRoot);
  const physicalRoot = fs.realpathSync(rootDir);
  if (!overlaps(physicalRepo, physicalRoot)) {
    throw new EvidenceError(
      `canonical evidence root escapes the repository: ${rootDir}`,
      {
        code: "SILO_SOURCE_UNSAFE",
        context: { rootDir, physicalRoot },
      },
    );
  }
}

async function ingestSilo(
  bundle: EvidenceBundle,
  repoRoot: string,
  definition: SiloDefinition,
  baseline?: SiloSnapshot,
  stagingDir?: string,
): Promise<IngestResult> {
  const presentRoots = definition.roots.filter((root) =>
    fs.existsSync(path.join(repoRoot, root.dir)),
  );
  if (presentRoots.length === 0) {
    return { silo: definition.silo, status: "absent", artifactCount: 0 };
  }
  const namespace = definition.roots.length > 1;
  let artifactCount = 0;
  for (const root of presentRoots) {
    const rootDir = path.join(repoRoot, root.dir);
    assertCanonicalRoot(repoRoot, rootDir);
    const rootStat = fs.lstatSync(rootDir);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new EvidenceError(
        `canonical evidence root is not a regular directory: ${rootDir}`,
        {
          code: "SILO_SOURCE_UNSAFE",
          context: { rootDir },
        },
      );
    }
    for (const rel of walkSiloFiles(rootDir)) {
      const sourcePath = path.join(rootDir, ...rel.split("/"));
      assertCanonicalRoot(repoRoot, sourcePath);
      const captured = captureStableFile(sourcePath, stagingDir);
      assertCanonicalRoot(repoRoot, sourcePath);
      const previous =
        baseline?.files[snapshotKey(definition.silo, root.label, rel)];
      if (previous !== undefined) {
        if (
          previous.size === captured.size &&
          previous.mtimeMs === captured.mtimeMs &&
          previous.ctimeMs === captured.ctimeMs &&
          previous.sha256 === captured.sha256
        ) {
          if (captured.stagedPath)
            fs.rmSync(captured.stagedPath, { force: true });
          continue;
        }
      }
      const defaultKind = classifyByExtension(rel);
      const kind = definition.classify?.(rel, defaultKind) ?? defaultKind;
      if (!captured.stagedPath) {
        throw new EvidenceError(
          "stable ingest capture did not produce staged bytes",
          {
            code: "SILO_SOURCE_UNSTABLE",
            context: { sourcePath },
          },
        );
      }
      await bundle.addArtifact(captured.stagedPath, {
        kind,
        source: definition.source,
        ...(definition.lane !== undefined ? { lane: definition.lane } : {}),
        producedBy: definition.producedBy,
        relativePath: namespace ? `${root.label}/${rel}` : rel,
      });
      fs.rmSync(captured.stagedPath, { force: true });
      artifactCount += 1;
    }
  }
  return { silo: definition.silo, status: "ingested", artifactCount };
}

/**
 * The known silos, in ingest order. Sources are stable producer ids that
 * downstream analyzers key on; changing one is a schema-level decision.
 */
const SILO_DEFINITIONS: SiloDefinition[] = [
  {
    silo: "e2e-recordings",
    source: "e2e-recordings",
    producedBy: "scripts/e2e-recordings/run-all.mjs",
    lane: "e2e",
    roots: [{ label: "repo", dir: "e2e-recordings" }],
  },
  {
    silo: "aesthetic-audit",
    source: "aesthetic-audit",
    producedBy: "packages/app audit:app",
    roots: [{ label: "app", dir: "packages/app/aesthetic-audit-output" }],
    // Manual-review markdown is a per-page reviewer verdict, not a generated
    // report; downstream certification treats it as analysis input.
    classify: (relPath, defaultKind) =>
      relPath.startsWith("manual-review/") && relPath.endsWith(".md")
        ? "analysis"
        : defaultKind,
  },
  {
    silo: "device-e2e",
    source: "device-e2e",
    producedBy: "packages/app/scripts/lib/device-e2e-bundle.mjs",
    lane: "native",
    roots: [{ label: "app", dir: "packages/app/device-e2e-output" }],
  },
  {
    silo: "playwright-test-results",
    source: "app-test-results",
    producedBy: "packages/app Playwright and native test lanes",
    lane: "e2e",
    roots: [{ label: "app", dir: "packages/app/test-results" }],
  },
  {
    silo: "ios-device-capture",
    source: "ios-device-capture",
    producedBy: "packages/app iOS capture and device-log lanes",
    lane: "native",
    roots: [
      { label: "boot-capture", dir: "packages/app/ios/build/boot-capture" },
      { label: "device-logs", dir: "packages/app/ios/build/device-logs" },
    ],
  },
  {
    silo: "walkthrough-reports",
    source: "walkthrough",
    producedBy: "walkthrough capture lanes",
    roots: [{ label: "repo", dir: "reports/walkthrough" }],
  },
  {
    silo: "live-test-runs",
    source: "live-test-runs",
    producedBy: "packages/scripts/run-live-test-with-artifacts.mjs",
    roots: [{ label: "repo", dir: "reports/live-test-runs" }],
  },
  {
    silo: "scenario-runner",
    source: "scenario-runner",
    producedBy: "packages/scenario-runner/bin/eliza-scenarios",
    lane: "scenario",
    roots: [{ label: "repo", dir: "reports/scenarios" }],
  },
];

function physicalPath(filePath: string): string {
  let cursor = path.resolve(filePath);
  const missing: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.push(path.basename(cursor));
    cursor = parent;
  }
  const existing = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor;
  return path.join(existing, ...missing.reverse());
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

/** Reject bundle output that could be discovered as producer evidence. */
export function assertSafeBundleOutput(
  repoRoot: string,
  outputRoot: string,
): void {
  const physicalOutput = physicalPath(outputRoot);
  for (const definition of SILO_DEFINITIONS) {
    for (const root of definition.roots) {
      const producer = path.join(repoRoot, root.dir);
      if (fs.existsSync(producer)) {
        assertCanonicalRoot(repoRoot, producer);
      }
      const physicalProducer = physicalPath(producer);
      if (
        overlaps(physicalOutput, physicalProducer) ||
        overlaps(physicalProducer, physicalOutput)
      ) {
        throw new EvidenceError(
          `bundle output overlaps canonical evidence root: ${producer}`,
          {
            code: "BUNDLE_OUTPUT_UNSAFE",
            context: { outputRoot, producer },
          },
        );
      }
    }
  }
}

/**
 * Hash the current canonical producer inventory before a coordinated run.
 * Passing the result back to ingestion makes the resulting bundle contain only
 * new or written/replaced artifacts from that run; an untouched stale file can
 * never be relabeled with the new bundle's commit provenance.
 */
export function captureSiloSnapshot(repoRoot: string): SiloSnapshot {
  const files: SiloSnapshot["files"] = {};
  for (const definition of SILO_DEFINITIONS) {
    for (const root of definition.roots) {
      const rootDir = path.join(repoRoot, root.dir);
      if (!fs.existsSync(rootDir)) {
        continue;
      }
      assertCanonicalRoot(repoRoot, rootDir);
      const rootStat = fs.lstatSync(rootDir);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new EvidenceError(
          `canonical evidence root is not a regular directory: ${rootDir}`,
          {
            code: "SILO_SOURCE_UNSAFE",
            context: { rootDir },
          },
        );
      }
      for (const rel of walkSiloFiles(rootDir)) {
        const filePath = path.join(rootDir, ...rel.split("/"));
        const captured = captureStableFile(filePath);
        files[snapshotKey(definition.silo, root.label, rel)] = {
          sha256: captured.sha256,
          size: captured.size,
          mtimeMs: captured.mtimeMs,
          ctimeMs: captured.ctimeMs,
        };
      }
    }
  }
  return { schema: 1, files };
}

/** Silo names, exported for CLI help and downstream orchestration. */
export const SILO_NAMES: readonly string[] = SILO_DEFINITIONS.map(
  (definition) => definition.silo,
);

/** Run every known silo ingestor against `repoRoot`, in declaration order. */
export async function ingestAllSilos(
  bundle: EvidenceBundle,
  repoRoot: string,
  baseline?: SiloSnapshot,
): Promise<IngestResult[]> {
  assertSafeBundleOutput(repoRoot, bundle.dir);
  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-evidence-ingest-"),
  );
  const results: IngestResult[] = [];
  try {
    for (const definition of SILO_DEFINITIONS) {
      results.push(
        await ingestSilo(bundle, repoRoot, definition, baseline, stagingDir),
      );
    }
    return results;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Run a single named silo ingestor; unknown names are a caller bug. */
export async function ingestNamedSilo(
  bundle: EvidenceBundle,
  repoRoot: string,
  silo: string,
): Promise<IngestResult> {
  const definition = SILO_DEFINITIONS.find((entry) => entry.silo === silo);
  if (definition === undefined) {
    throw new EvidenceError(`unknown evidence silo: ${silo}`, {
      code: "SILO_UNKNOWN",
      context: { silo, known: [...SILO_NAMES] },
    });
  }
  assertSafeBundleOutput(repoRoot, bundle.dir);
  const stagingDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-evidence-ingest-"),
  );
  try {
    return await ingestSilo(
      bundle,
      repoRoot,
      definition,
      undefined,
      stagingDir,
    );
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}
