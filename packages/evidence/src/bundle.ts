/**
 * Evidence-bundle builder and integrity verifier. One harness run produces one
 * `evidence/runs/<run-id>/` directory; artifacts are hardlinked (same volume)
 * or copied in, hashed as stored, and inventoried in `manifest.json` beside a
 * provenance `meta.json`. Certification (#14546) signs sha256(manifest bytes),
 * so `finalize()` writes the manifest canonically: artifacts sorted by path
 * (UTF-16 code-unit order), object keys sorted, no whitespace variance, one
 * trailing newline — see `canonical.ts`. Byte-stability given identical inputs
 * is a hard requirement, which is why the clock is injectable rather than
 * ambient. Default artifact placement is a deterministic kind→family mapping
 * (below); callers needing exact placement (wave-2 analyzers writing
 * `analysis.json` beside pixels) pass `bundlePath` explicitly.
 *
 *   screenshot → visual/<source>/<rel>      keyframe → video/<source>/keyframes/<rel>
 *   video      → video/<source>/<rel>       trajectory → trajectories/<source>/<rel>
 *   html-tree  → html-trees/<rel>           log  → lanes/<lane>/logs/<rel> (lane-less: misc)
 *   report     → lanes/<lane>/<rel> (lane-less: misc)
 *   analysis | qa | other → misc/<source>/<rel>
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJsonBytes } from "./canonical.ts";
import { EvidenceError } from "./errors.ts";
import {
  type ArtifactEntry,
  type ArtifactKind,
  type BundleManifest,
  type BundleMeta,
  isBundleRelativePath,
  parseManifest,
  type RunnerKind,
  type Tier,
} from "./schema.ts";

/** Provenance facts the caller must supply when opening a bundle. */
export interface BundleProvenance {
  commit: string;
  branch: string;
  runner: RunnerKind;
  tier: Tier;
  envFingerprint: Record<string, string>;
}

/** Options for {@link createBundle}. */
export interface CreateBundleOptions {
  /** Directory that holds run dirs, e.g. `<repo>/evidence/runs`. */
  rootDir: string;
  provenance: BundleProvenance;
  /** Injectable clock so tests produce byte-identical manifests. */
  now?: () => Date;
  /** Override the derived `<utc stamp>-<shortsha>-<tier>` run id (tests). */
  runId?: string;
  /** `auto` hardlinks and falls back to copy across volumes; `copy` always copies. */
  linkMode?: "auto" | "copy";
}

/** Options for {@link EvidenceBundle.addArtifact}. */
export interface AddArtifactOptions {
  kind: ArtifactKind;
  /** Producer id recorded on the entry, e.g. `aesthetic-audit`. */
  source: string;
  lane?: string;
  /** Tool or script that produced the artifact. */
  producedBy: string;
  /** Path within the kind's family dir; defaults to the file's basename. */
  relativePath?: string;
  /** Exact bundle-relative destination, bypassing the family mapping. */
  bundlePath?: string;
}

/** Result of {@link EvidenceBundle.finalize}. */
export interface FinalizeResult {
  manifest: BundleManifest;
  meta: BundleMeta;
  manifestPath: string;
  metaPath: string;
  /** sha256 of the canonical manifest bytes — the value certification signs. */
  manifestSha256: string;
}

/** One integrity problem found by {@link verifyBundle}. */
export interface VerifyIssue {
  path: string;
  issue: "missing" | "size-mismatch" | "hash-mismatch" | "unlisted";
  expected?: string;
  actual?: string;
}

/** Result of {@link verifyBundle}. */
export interface VerifyReport {
  ok: boolean;
  runId: string;
  artifactCount: number;
  verifiedCount: number;
  issues: VerifyIssue[];
  /** sha256 of the manifest bytes exactly as stored on disk. */
  manifestSha256: string;
}

/** Files at the bundle root that are part of the envelope, not artifacts. */
const ENVELOPE_FILES = new Set([
  "manifest.json",
  "meta.json",
  "certification.json",
]);

function utcStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Derive the canonical run id: `<utc yyyymmdd-hhmmss>-<shortsha>-<tier>`. */
export function formatRunId(date: Date, commit: string, tier: Tier): string {
  return `${utcStamp(date)}-${commit.slice(0, 7)}-${tier}`;
}

async function sha256File(
  filePath: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function materialize(
  sourcePath: string,
  destPath: string,
  linkMode: "auto" | "copy",
  link: (source: string, dest: string) => void = fs.linkSync,
): void {
  if (linkMode === "copy") {
    fs.copyFileSync(sourcePath, destPath);
    return;
  }
  try {
    link(sourcePath, destPath);
  } catch (error) {
    // error-policy:J4 EXDEV means the silo lives on a different volume than the
    // bundle; copying is the designed fallback. Every other failure rethrows.
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    fs.copyFileSync(sourcePath, destPath);
  }
}

function familyPath(options: AddArtifactOptions, rel: string): string {
  const { kind, source, lane } = options;
  switch (kind) {
    case "screenshot":
      return `visual/${source}/${rel}`;
    case "keyframe":
      return `video/${source}/keyframes/${rel}`;
    case "video":
      return `video/${source}/${rel}`;
    case "trajectory":
      return `trajectories/${source}/${rel}`;
    case "html-tree":
      return `html-trees/${rel}`;
    case "log":
      return lane !== undefined
        ? `lanes/${lane}/logs/${rel}`
        : `misc/${source}/${rel}`;
    case "report":
      return lane !== undefined
        ? `lanes/${lane}/${rel}`
        : `misc/${source}/${rel}`;
    default:
      return `misc/${source}/${rel}`;
  }
}

/**
 * A bundle being built. Add artifacts, then `finalize()` exactly once; the
 * builder is single-use and refuses writes after finalization.
 */
export class EvidenceBundle {
  readonly runId: string;
  readonly dir: string;
  private readonly now: () => Date;
  private readonly linkMode: "auto" | "copy";
  private readonly provenance: BundleProvenance;
  private readonly startedAt: string;
  private readonly entries: ArtifactEntry[] = [];
  private readonly claimedPaths = new Set<string>();
  private finalized = false;
  /** Test-only seam for simulating cross-volume link failures (EXDEV). */
  private readonly link?: (source: string, dest: string) => void;

  constructor(
    options: CreateBundleOptions & {
      link?: (source: string, dest: string) => void;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.linkMode = options.linkMode ?? "auto";
    this.provenance = options.provenance;
    this.link = options.link;
    const started = this.now();
    this.startedAt = started.toISOString();
    this.runId =
      options.runId ??
      formatRunId(started, options.provenance.commit, options.provenance.tier);
    this.dir = path.join(options.rootDir, this.runId);
    if (fs.existsSync(this.dir)) {
      throw new EvidenceError(`bundle directory already exists: ${this.dir}`, {
        code: "BUNDLE_DIR_EXISTS",
        context: { dir: this.dir },
      });
    }
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private assertOpen(operation: string): void {
    if (this.finalized) {
      throw new EvidenceError(`${operation} called after finalize()`, {
        code: "BUNDLE_FINALIZED",
        context: { runId: this.runId },
      });
    }
  }

  /**
   * Copy/hardlink `filePath` into the bundle and record its manifest entry.
   * The hash is computed from the bytes as stored in the bundle, so a corrupt
   * copy is caught at add time rather than at certification time.
   */
  async addArtifact(
    filePath: string,
    options: AddArtifactOptions,
  ): Promise<ArtifactEntry> {
    this.assertOpen("addArtifact");
    if (
      options.relativePath !== undefined &&
      options.bundlePath !== undefined
    ) {
      throw new EvidenceError(
        "addArtifact accepts relativePath or bundlePath, not both",
        { code: "ARTIFACT_PLACEMENT_AMBIGUOUS", context: { filePath } },
      );
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      // error-policy:J2 context-adding rethrow — a vanished source file must
      // fail the ingest, not silently shrink the bundle.
      throw new EvidenceError(`artifact source file missing: ${filePath}`, {
        code: "ARTIFACT_MISSING",
        cause: error,
        context: { filePath },
      });
    }
    if (!stat.isFile()) {
      throw new EvidenceError(`artifact source is not a file: ${filePath}`, {
        code: "ARTIFACT_MISSING",
        context: { filePath },
      });
    }
    const rel = options.relativePath ?? path.basename(filePath);
    const bundlePath = options.bundlePath ?? familyPath(options, rel);
    if (!isBundleRelativePath(bundlePath)) {
      throw new EvidenceError(
        `artifact bundle path is not bundle-relative posix: ${bundlePath}`,
        { code: "ARTIFACT_PATH_INVALID", context: { bundlePath, filePath } },
      );
    }
    if (this.claimedPaths.has(bundlePath)) {
      throw new EvidenceError(
        `artifact bundle path already claimed: ${bundlePath}`,
        { code: "ARTIFACT_PATH_COLLISION", context: { bundlePath, filePath } },
      );
    }
    const destPath = path.join(this.dir, ...bundlePath.split("/"));
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    materialize(filePath, destPath, this.linkMode, this.link);
    const { sha256, bytes } = await sha256File(destPath);
    const entry: ArtifactEntry = {
      path: bundlePath,
      sha256,
      bytes,
      kind: options.kind,
      source: options.source,
      ...(options.lane !== undefined ? { lane: options.lane } : {}),
      producedBy: options.producedBy,
      createdAt: this.now().toISOString(),
    };
    this.claimedPaths.add(bundlePath);
    this.entries.push(entry);
    return entry;
  }

  /**
   * Sort artifacts, write canonical `manifest.json` and `meta.json`, and seal
   * the bundle. Returns the sha256 of the manifest bytes for signing.
   */
  async finalize(
    options: { timings?: Record<string, number> } = {},
  ): Promise<FinalizeResult> {
    this.assertOpen("finalize");
    this.finalized = true;
    const artifacts = [...this.entries].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const finishedAt = this.now().toISOString();
    const manifest: BundleManifest = {
      schema: 1,
      runId: this.runId,
      createdAt: finishedAt,
      artifacts,
    };
    const meta: BundleMeta = {
      schema: 1,
      runId: this.runId,
      commit: this.provenance.commit,
      branch: this.provenance.branch,
      runner: this.provenance.runner,
      tier: this.provenance.tier,
      startedAt: this.startedAt,
      finishedAt,
      envFingerprint: this.provenance.envFingerprint,
      ...(options.timings !== undefined ? { timings: options.timings } : {}),
    };
    const manifestBytes = canonicalJsonBytes(manifest);
    const manifestPath = path.join(this.dir, "manifest.json");
    const metaPath = path.join(this.dir, "meta.json");
    fs.writeFileSync(manifestPath, manifestBytes);
    fs.writeFileSync(metaPath, canonicalJsonBytes(meta));
    return {
      manifest,
      meta,
      manifestPath,
      metaPath,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    };
  }
}

/** Open a new bundle run dir under `options.rootDir`. */
export function createBundle(options: CreateBundleOptions): EvidenceBundle {
  return new EvidenceBundle(options);
}

function* walkFiles(root: string, relBase = ""): Generator<string> {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      yield* walkFiles(path.join(root, entry.name), rel);
    } else if (entry.isFile()) {
      yield rel;
    }
  }
}

/**
 * Re-hash every manifest artifact and sweep for unlisted files. Structural
 * problems (unreadable/invalid manifest) throw typed errors; per-artifact
 * integrity problems land in the report so certification can show all of them.
 */
export async function verifyBundle(dir: string): Promise<VerifyReport> {
  const manifestPath = path.join(dir, "manifest.json");
  let raw: Buffer;
  try {
    raw = fs.readFileSync(manifestPath);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — no manifest means nothing to
    // verify against; that is a structural failure, not an empty report.
    throw new EvidenceError(`bundle manifest unreadable: ${manifestPath}`, {
      code: "MANIFEST_UNREADABLE",
      cause: error,
      context: { dir },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    // error-policy:J3 untrusted disk input — malformed JSON is a typed
    // invalid-manifest failure, never a silently-empty manifest.
    throw new EvidenceError(
      `bundle manifest is not valid JSON: ${manifestPath}`,
      {
        code: "MANIFEST_INVALID",
        cause: error,
        context: { dir },
      },
    );
  }
  const manifest = parseManifest(parsed, manifestPath);

  const issues: VerifyIssue[] = [];
  let verifiedCount = 0;
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(dir, ...artifact.path.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(artifactPath);
    } catch {
      // error-policy:J3 a listed-but-absent artifact is exactly what this
      // report exists to surface; recorded as an issue, not swallowed.
      issues.push({ path: artifact.path, issue: "missing" });
      continue;
    }
    if (stat.size !== artifact.bytes) {
      issues.push({
        path: artifact.path,
        issue: "size-mismatch",
        expected: String(artifact.bytes),
        actual: String(stat.size),
      });
      continue;
    }
    const { sha256 } = await sha256File(artifactPath);
    if (sha256 !== artifact.sha256) {
      issues.push({
        path: artifact.path,
        issue: "hash-mismatch",
        expected: artifact.sha256,
        actual: sha256,
      });
      continue;
    }
    verifiedCount += 1;
  }

  const listed = new Set(manifest.artifacts.map((artifact) => artifact.path));
  for (const rel of walkFiles(dir)) {
    if (ENVELOPE_FILES.has(rel)) continue;
    if (!listed.has(rel)) {
      issues.push({ path: rel, issue: "unlisted" });
    }
  }

  return {
    ok: issues.length === 0,
    runId: manifest.runId,
    artifactCount: manifest.artifacts.length,
    verifiedCount,
    issues,
    manifestSha256: createHash("sha256").update(raw).digest("hex"),
  };
}
