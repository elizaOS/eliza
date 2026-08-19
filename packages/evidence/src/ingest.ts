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

function hashFile(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
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

function* walkSiloFiles(root: string, relBase = ""): Generator<string> {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      yield* walkSiloFiles(path.join(root, entry.name), rel);
    } else if (entry.isFile()) {
      yield rel;
    }
  }
}

async function ingestSilo(
  bundle: EvidenceBundle,
  repoRoot: string,
  definition: SiloDefinition,
  baseline?: SiloSnapshot,
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
    for (const rel of walkSiloFiles(rootDir)) {
      const sourcePath = path.join(rootDir, ...rel.split("/"));
      const previous =
        baseline?.files[snapshotKey(definition.silo, root.label, rel)];
      if (previous !== undefined) {
        const stat = fs.statSync(sourcePath);
        if (
          previous.size === stat.size &&
          previous.mtimeMs === stat.mtimeMs &&
          previous.ctimeMs === stat.ctimeMs &&
          previous.sha256 === hashFile(sourcePath)
        ) {
          continue;
        }
      }
      const defaultKind = classifyByExtension(rel);
      const kind = definition.classify?.(rel, defaultKind) ?? defaultKind;
      await bundle.addArtifact(sourcePath, {
        kind,
        source: definition.source,
        ...(definition.lane !== undefined ? { lane: definition.lane } : {}),
        producedBy: definition.producedBy,
        relativePath: namespace ? `${root.label}/${rel}` : rel,
      });
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

/**
 * Hash the current canonical producer inventory before a coordinated run.
 * Passing the result back to ingestion makes the resulting bundle contain only
 * new or content-changed artifacts from that run; an untouched stale file can
 * never be relabeled with the new bundle's commit provenance.
 */
export function captureSiloSnapshot(repoRoot: string): SiloSnapshot {
  const files: SiloSnapshot["files"] = {};
  for (const definition of SILO_DEFINITIONS) {
    for (const root of definition.roots) {
      const rootDir = path.join(repoRoot, root.dir);
      if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
        continue;
      }
      for (const rel of walkSiloFiles(rootDir)) {
        const filePath = path.join(rootDir, ...rel.split("/"));
        const stat = fs.statSync(filePath);
        files[snapshotKey(definition.silo, root.label, rel)] = {
          sha256: hashFile(filePath),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
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
  const results: IngestResult[] = [];
  for (const definition of SILO_DEFINITIONS) {
    results.push(await ingestSilo(bundle, repoRoot, definition, baseline));
  }
  return results;
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
  return ingestSilo(bundle, repoRoot, definition);
}
