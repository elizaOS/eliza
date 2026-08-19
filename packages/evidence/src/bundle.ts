/**
 * Evidence-bundle builder and integrity verifier. One harness run produces one
 * `evidence/runs/<run-id>/` directory; artifacts are copied in, hashed as
 * stored, and inventoried in `manifest.json` beside a
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
 *
 * Integrity invariants: bundle paths are NFC-normalized at ingress (macOS NFD
 * vs linux NFC must not change manifest bytes for the same logical name);
 * `manifest.metaSha256` binds the meta.json bytes into the signed envelope
 * (forged provenance fails verification); and a verified bundle contains no
 * symlinks anywhere — `verifyBundle` lstat-classifies so a symlinked artifact
 * (mutable after signing) or a symlinked directory (mounting an unswept
 * external tree) is reported, never silently followed.
 */

import { createHash, randomUUID } from "node:crypto";
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
  /** Legacy selector retained for source compatibility; materialization is always copy-only. */
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
  issue:
    | "missing"
    | "size-mismatch"
    | "hash-mismatch"
    | "unlisted"
    | "symlink"
    | "hardlink"
    | "meta-mismatch";
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

function sameFileIdentity(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

function sameInode(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Create one bundle-owned envelope leaf without following an existing alias. */
function writeExclusiveEnvelope(filePath: string, bytes: Uint8Array): void {
  let descriptor: number | undefined;
  let createdIdentity: fs.BigIntStats | undefined;
  let completed = false;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    createdIdentity = fs.fstatSync(descriptor, { bigint: true });
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const written = fs.fstatSync(descriptor, { bigint: true });
    const published = fs.lstatSync(filePath, { bigint: true });
    if (
      !written.isFile() ||
      written.nlink !== 1n ||
      written.size !== BigInt(bytes.byteLength) ||
      published.isSymbolicLink() ||
      published.nlink !== 1n ||
      !sameInode(written, published)
    ) {
      throw new EvidenceError(`bundle envelope leaf is unsafe: ${filePath}`, {
        code: "BUNDLE_ENVELOPE_UNSAFE",
        context: { filePath },
      });
    }
    completed = true;
  } catch (error) {
    throw error instanceof EvidenceError
      ? error
      : new EvidenceError(`could not create bundle envelope: ${filePath}`, {
          code: "BUNDLE_ENVELOPE_UNSAFE",
          cause: error,
          context: { filePath },
        });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!completed && createdIdentity !== undefined) {
      try {
        const current = fs.lstatSync(filePath, { bigint: true });
        if (sameInode(createdIdentity, current) && current.nlink === 1n) {
          fs.rmSync(filePath);
        }
      } catch (cleanupError) {
        // error-policy:J6 best-effort cleanup after the envelope failure.
        void cleanupError;
      }
    }
  }
}

/** Atomically replace one owned output leaf without following its old inode. */
export function writeOwnedFileAtomic(
  filePath: string,
  bytes: string | Uint8Array,
): void {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const staged = fs.fstatSync(descriptor, { bigint: true });
    if (!staged.isFile() || staged.nlink !== 1n) {
      throw new EvidenceError(
        `owned output temporary leaf is unsafe: ${filePath}`,
        {
          code: "OWNED_OUTPUT_UNSAFE",
          context: { filePath },
        },
      );
    }
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
    const published = fs.lstatSync(filePath, { bigint: true });
    if (
      published.isSymbolicLink() ||
      published.nlink !== 1n ||
      !sameInode(staged, published)
    ) {
      throw new EvidenceError(`owned output leaf changed: ${filePath}`, {
        code: "OWNED_OUTPUT_UNSAFE",
        context: { filePath },
      });
    }
  } catch (error) {
    throw error instanceof EvidenceError
      ? error
      : new EvidenceError(`could not publish owned output: ${filePath}`, {
          code: "OWNED_OUTPUT_UNSAFE",
          cause: error,
          context: { filePath },
        });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

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

/** Allow only the reserved certification envelope leaf inside a bundle. */
export function assertSafeCertificationOutput(
  bundleDir: string,
  outputPath: string,
): void {
  const physicalBundle = physicalPath(bundleDir);
  // Publication replaces the final directory entry rather than following it,
  // so resolve aliases in its parent while preserving the owned leaf itself.
  const resolvedOutput = path.resolve(outputPath);
  const physicalOutput = path.join(
    physicalPath(path.dirname(resolvedOutput)),
    path.basename(resolvedOutput),
  );
  const relative = path.relative(physicalBundle, physicalOutput);
  const insideBundle =
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  if (
    insideBundle &&
    physicalOutput !== path.join(physicalBundle, "certification.json")
  ) {
    throw new EvidenceError(
      `certification output may not replace bundle contents: ${outputPath}`,
      {
        code: "CERTIFICATION_OUTPUT_UNSAFE",
        context: { bundleDir, outputPath },
      },
    );
  }
}

/** Keep non-envelope certification outputs outside the finalized bundle. */
export function assertSafeAuxiliaryOutput(
  bundleDir: string,
  outputPath: string,
): void {
  const physicalBundle = physicalPath(bundleDir);
  const resolvedOutput = path.resolve(outputPath);
  const physicalOutput = path.join(
    physicalPath(path.dirname(resolvedOutput)),
    path.basename(resolvedOutput),
  );
  const relative = path.relative(physicalBundle, physicalOutput);
  const insideBundle =
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`));
  if (insideBundle) {
    throw new EvidenceError(
      `auxiliary output may not replace bundle contents: ${outputPath}`,
      {
        code: "CERTIFICATION_OUTPUT_UNSAFE",
        context: { bundleDir, outputPath },
      },
    );
  }
}

/** Copy and hash one single-link file through stable no-follow descriptors. */
function materialize(
  sourcePath: string,
  destPath: string,
): { sha256: string; bytes: number } {
  const sourceLstat = fs.lstatSync(sourcePath, { bigint: true });
  if (
    sourceLstat.isSymbolicLink() ||
    !sourceLstat.isFile() ||
    sourceLstat.nlink !== 1n
  ) {
    throw new EvidenceError(
      `artifact source is not a single-link regular file: ${sourcePath}`,
      {
        code: "ARTIFACT_SOURCE_UNSAFE",
        context: { sourcePath, nlink: sourceLstat.nlink.toString() },
      },
    );
  }
  const source = fs.openSync(
    sourcePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let destination: number | undefined;
  let destinationCreated = false;
  try {
    const before = fs.fstatSync(source, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !sameFileIdentity(sourceLstat, before)
    ) {
      throw new EvidenceError(
        `artifact source changed before copy: ${sourcePath}`,
        { code: "ARTIFACT_SOURCE_UNSTABLE", context: { sourcePath } },
      );
    }
    destination = fs.openSync(
      destPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    destinationCreated = true;
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let total = 0n;
    for (;;) {
      const bytesRead = fs.readSync(source, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      let offset = 0;
      while (offset < bytesRead) {
        const written = fs.writeSync(
          destination,
          chunk,
          offset,
          bytesRead - offset,
        );
        if (written === 0) {
          throw new EvidenceError(
            `artifact destination stopped accepting bytes: ${destPath}`,
            { code: "ARTIFACT_COPY_FAILED", context: { destPath } },
          );
        }
        offset += written;
      }
      total += BigInt(bytesRead);
    }
    fs.fsyncSync(destination);
    const after = fs.fstatSync(source, { bigint: true });
    const stored = fs.fstatSync(destination, { bigint: true });
    const published = fs.lstatSync(destPath, { bigint: true });
    if (
      after.nlink !== 1n ||
      total !== after.size ||
      !sameFileIdentity(before, after) ||
      !stored.isFile() ||
      stored.nlink !== 1n ||
      stored.size !== total ||
      published.isSymbolicLink() ||
      published.nlink !== 1n ||
      !sameInode(stored, published)
    ) {
      throw new EvidenceError(
        `artifact source or destination changed while being copied: ${sourcePath}`,
        { code: "ARTIFACT_SOURCE_UNSTABLE", context: { sourcePath } },
      );
    }
    return { sha256: hash.digest("hex"), bytes: Number(total) };
  } catch (error) {
    if (destination !== undefined) {
      fs.closeSync(destination);
      destination = undefined;
    }
    if (destinationCreated) fs.rmSync(destPath, { force: true });
    throw error;
  } finally {
    if (destination !== undefined) fs.closeSync(destination);
    fs.closeSync(source);
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
  private readonly provenance: BundleProvenance;
  private readonly startedAt: string;
  private readonly entries: ArtifactEntry[] = [];
  private readonly claimedPaths = new Set<string>();
  private finalized = false;
  constructor(options: CreateBundleOptions) {
    this.now = options.now ?? (() => new Date());
    this.provenance = options.provenance;
    const started = this.now();
    this.startedAt = started.toISOString();
    this.runId =
      options.runId ??
      formatRunId(started, options.provenance.commit, options.provenance.tier);
    if (
      this.runId === "." ||
      this.runId === ".." ||
      this.runId.includes("/") ||
      this.runId.includes("\\") ||
      this.runId.includes("\0") ||
      this.runId.normalize("NFC") !== this.runId
    ) {
      throw new EvidenceError(
        `bundle run id is not a safe path leaf: ${this.runId}`,
        {
          code: "BUNDLE_RUN_ID_INVALID",
          context: { runId: this.runId },
        },
      );
    }
    this.dir = path.join(options.rootDir, this.runId);
    fs.mkdirSync(options.rootDir, { recursive: true });
    try {
      // A non-recursive mkdir claims the run leaf atomically. Recursive mkdir
      // would accept a symlink planted between an existence check and creation.
      fs.mkdirSync(this.dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new EvidenceError(
          `bundle directory already exists: ${this.dir}`,
          {
            code: "BUNDLE_DIR_EXISTS",
            cause: error,
            context: { dir: this.dir },
          },
        );
      }
      throw new EvidenceError(
        `could not create bundle directory: ${this.dir}`,
        {
          code: "BUNDLE_DIR_CREATE_FAILED",
          cause: error,
          context: { dir: this.dir },
        },
      );
    }
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
   * The artifacts added so far, as a snapshot copy. The certify orchestrator
   * (#14546) reads this after silo ingest to hand the analyzer runner its work
   * list before `finalize()` seals the manifest — the runner then adds its
   * `analysis.json` back through `addArtifact`, so a live view (not a snapshot)
   * would iterate over its own emissions. Callers must not mutate the result.
   */
  get artifacts(): readonly ArtifactEntry[] {
    return [...this.entries];
  }

  /**
   * Copy `filePath` into the bundle and record its manifest entry.
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
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
      // error-policy:J2 context-adding rethrow — a vanished source file must
      // fail the ingest, not silently shrink the bundle.
      throw new EvidenceError(`artifact source file missing: ${filePath}`, {
        code: "ARTIFACT_MISSING",
        cause: error,
        context: { filePath },
      });
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
      throw new EvidenceError(
        `artifact source is not a single-link regular file: ${filePath}`,
        {
          code: "ARTIFACT_SOURCE_UNSAFE",
          context: { filePath },
        },
      );
    }
    const rel = options.relativePath ?? path.basename(filePath);
    // NFC-normalize at ingress: macOS reports NFD filenames, linux NFC; the
    // same logical name must produce identical manifest bytes on both.
    const bundlePath = (
      options.bundlePath ?? familyPath(options, rel)
    ).normalize("NFC");
    if (!isBundleRelativePath(bundlePath)) {
      throw new EvidenceError(
        `artifact bundle path is not bundle-relative posix: ${bundlePath}`,
        { code: "ARTIFACT_PATH_INVALID", context: { bundlePath, filePath } },
      );
    }
    if (ENVELOPE_FILES.has(bundlePath)) {
      throw new EvidenceError(
        `artifact bundle path is reserved for bundle metadata: ${bundlePath}`,
        {
          code: "ARTIFACT_PATH_RESERVED",
          context: { bundlePath, filePath },
        },
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
    const { sha256, bytes } = materialize(filePath, destPath);
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
    // Order matters: meta bytes are written and hashed BEFORE the manifest is
    // built, so `metaSha256` binds provenance into the signed envelope.
    const metaBytes = canonicalJsonBytes(meta);
    const metaPath = path.join(this.dir, "meta.json");
    writeExclusiveEnvelope(metaPath, metaBytes);
    const manifest: BundleManifest = {
      schema: 1,
      runId: this.runId,
      createdAt: finishedAt,
      metaSha256: createHash("sha256").update(metaBytes).digest("hex"),
      artifacts,
    };
    const manifestBytes = canonicalJsonBytes(manifest);
    const manifestPath = path.join(this.dir, "manifest.json");
    writeExclusiveEnvelope(manifestPath, manifestBytes);
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

// lstat-based classification: symlinks (file or directory targets) are yielded
// as their own kind and never followed — following one would let a bundle
// reference mutable-after-signing external bytes or mount an unswept tree.
function* walkEntries(
  root: string,
  relBase = "",
): Generator<{ rel: string; kind: "file" | "symlink"; nlink?: number }> {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase === "" ? entry.name : `${relBase}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      yield { rel, kind: "symlink" };
    } else if (entry.isDirectory()) {
      yield* walkEntries(path.join(root, entry.name), rel);
    } else if (entry.isFile()) {
      yield {
        rel,
        kind: "file",
        nlink: fs.lstatSync(path.join(root, entry.name)).nlink,
      };
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
  const symlinkFlagged = new Set<string>();
  const hardlinkFlagged = new Set<string>();
  let verifiedCount = 0;
  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(dir, ...artifact.path.split("/"));
    let stat: fs.Stats;
    try {
      // lstat, not stat: a listed artifact replaced by a symlink to an
      // external file with matching bytes must fail, not verify green.
      stat = fs.lstatSync(artifactPath);
    } catch {
      // error-policy:J1 boundary translation — verify IS the integrity
      // boundary; a listed-but-absent artifact becomes a structured
      // "missing" finding in the report, never a swallowed failure.
      issues.push({ path: artifact.path, issue: "missing" });
      continue;
    }
    if (stat.isSymbolicLink()) {
      issues.push({ path: artifact.path, issue: "symlink" });
      symlinkFlagged.add(artifact.path);
      continue;
    }
    if (!stat.isFile()) {
      issues.push({ path: artifact.path, issue: "missing" });
      continue;
    }
    if (stat.nlink !== 1) {
      issues.push({ path: artifact.path, issue: "hardlink" });
      hardlinkFlagged.add(artifact.path);
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

  // Bind provenance: meta.json bytes must hash to manifest.metaSha256.
  const metaPath = path.join(dir, "meta.json");
  let metaBytes: Buffer | undefined;
  try {
    metaBytes = fs.readFileSync(metaPath);
  } catch {
    // error-policy:J1 boundary translation — absent provenance is a
    // structured "meta-mismatch" finding, part of the integrity report.
    issues.push({
      path: "meta.json",
      issue: "meta-mismatch",
      expected: manifest.metaSha256,
      actual: "missing",
    });
  }
  if (metaBytes !== undefined) {
    const metaSha256 = createHash("sha256").update(metaBytes).digest("hex");
    if (metaSha256 !== manifest.metaSha256) {
      issues.push({
        path: "meta.json",
        issue: "meta-mismatch",
        expected: manifest.metaSha256,
        actual: metaSha256,
      });
    }
  }

  const listed = new Set(manifest.artifacts.map((artifact) => artifact.path));
  for (const entry of walkEntries(dir)) {
    if (entry.kind === "symlink") {
      if (!symlinkFlagged.has(entry.rel)) {
        issues.push({ path: entry.rel, issue: "symlink" });
      }
      continue;
    }
    if (entry.nlink !== 1 && !hardlinkFlagged.has(entry.rel)) {
      issues.push({ path: entry.rel, issue: "hardlink" });
    }
    if (ENVELOPE_FILES.has(entry.rel)) continue;
    if (!listed.has(entry.rel)) {
      issues.push({ path: entry.rel, issue: "unlisted" });
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
