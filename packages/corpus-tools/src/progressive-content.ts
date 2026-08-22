/**
 * Generates deterministic, streamed large-content corpora for paging,
 * authorization, reassembly, and resource-usage tests. The manifest is the
 * mechanical oracle: it records stable source hashes and exact planted-canary
 * byte ranges without retaining source-sized buffers in memory.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  buildProgressiveFormatFixtureOracles,
  extractProgressiveFormatFixture,
  generateProgressiveFormatFixtures,
  type ProgressiveFormatFixture,
} from "./progressive-content-formats.ts";

export const PROGRESSIVE_CONTENT_SCHEMA_VERSION =
  "elizaos.progressive-content.v2";
export const PROGRESSIVE_CONTENT_ANCHOR_TIME = "2026-01-01T00:00:00.000Z";

export type ProgressiveContentFamily =
  | "file"
  | "document"
  | "memory"
  | "email"
  | "attachment"
  | "tool-output";

export type ProgressiveContentProfile = "micro" | "pr" | "nightly" | "release";

export type ProgressiveContentFormat =
  | "lf-lines"
  | "crlf-lines"
  | "no-final-newline"
  | "single-line"
  | "minified-json-like"
  | "invalid-utf8";

export interface ProgressiveContentCanary {
  readonly label: "beginning" | "boundary" | "middle" | "end";
  readonly text: string;
  readonly byteStart: number;
  readonly byteEnd: number;
}

export interface ProgressiveContentObject {
  readonly id: string;
  readonly family: ProgressiveContentFamily;
  readonly format: ProgressiveContentFormat;
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sourceSha256: string;
  readonly revision: string;
  readonly authorizationScope: string;
  readonly coordinateSystem: "utf8-byte-start-inclusive-end-exclusive";
  readonly canaries: readonly ProgressiveContentCanary[];
}

export interface ProgressiveContentManifest {
  readonly schemaVersion: typeof PROGRESSIVE_CONTENT_SCHEMA_VERSION;
  readonly generatorRevision: string;
  readonly rootSeed: string;
  readonly anchorTime: typeof PROGRESSIVE_CONTENT_ANCHOR_TIME;
  readonly profile: ProgressiveContentProfile;
  readonly publication: "private-atomic-manifest-last-v1";
  readonly objects: readonly ProgressiveContentObject[];
  readonly formatFixtures: readonly ProgressiveFormatFixture[];
  readonly logicalBytes: number;
  readonly manifestSha256: string;
}

interface ProfileShape {
  readonly counts: Readonly<Record<ProgressiveContentFamily, number>>;
  readonly baseBytes: Readonly<Record<ProgressiveContentFamily, number>>;
}

const PROFILE_SHAPES: Readonly<
  Record<ProgressiveContentProfile, ProfileShape>
> = {
  micro: {
    counts: {
      file: 4,
      document: 4,
      memory: 4,
      email: 3,
      attachment: 3,
      "tool-output": 2,
    },
    baseBytes: {
      file: 32 * 1024,
      document: 24 * 1024,
      memory: 8 * 1024,
      email: 16 * 1024,
      attachment: 24 * 1024,
      "tool-output": 32 * 1024,
    },
  },
  pr: {
    counts: {
      file: 32,
      document: 32,
      memory: 2_000,
      email: 128,
      attachment: 32,
      "tool-output": 16,
    },
    baseBytes: {
      file: 192 * 1024,
      document: 128 * 1024,
      memory: 8 * 1024,
      email: 16 * 1024,
      attachment: 48 * 1024,
      "tool-output": 128 * 1024,
    },
  },
  nightly: {
    counts: {
      file: 1_250,
      document: 1_250,
      memory: 100_000,
      email: 10_000,
      attachment: 2_000,
      "tool-output": 500,
    },
    baseBytes: {
      file: 128 * 1024,
      document: 96 * 1024,
      memory: 4 * 1024,
      email: 16 * 1024,
      attachment: 48 * 1024,
      "tool-output": 96 * 1024,
    },
  },
  release: {
    counts: {
      file: 12_500,
      document: 12_500,
      memory: 1_000_000,
      email: 100_000,
      attachment: 10_000,
      "tool-output": 15_000,
    },
    baseBytes: {
      file: 160 * 1024,
      document: 128 * 1024,
      memory: 4 * 1024,
      email: 16 * 1024,
      attachment: 64 * 1024,
      "tool-output": 128 * 1024,
    },
  },
};

const FAMILY_ORDER: readonly ProgressiveContentFamily[] = [
  "file",
  "document",
  "memory",
  "email",
  "attachment",
  "tool-output",
];

const FORMAT_ORDER: readonly ProgressiveContentFormat[] = [
  "lf-lines",
  "crlf-lines",
  "no-final-newline",
  "single-line",
  "minified-json-like",
  "invalid-utf8",
];

/** Exact transport, preview, historic-cap, and large-source boundaries. */
export const PROGRESSIVE_CONTENT_BOUNDARY_BYTES = [
  0,
  1,
  4_095,
  4_096,
  4_097,
  9_999,
  10_000,
  10_001,
  32_767,
  32_768,
  32_769,
  50 * 1024 - 1,
  50 * 1024,
  50 * 1024 + 1,
  128 * 1024 - 1,
  128 * 1024,
  128 * 1024 + 1,
  256 * 1024 - 1,
  256 * 1024,
  256 * 1024 + 1,
  1024 * 1024,
  10 * 1024 * 1024,
] as const;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const OWNED_DIRECTORIES = ["objects", "formats"] as const;

export class ProgressiveContentCorpusError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProgressiveContentCorpusError";
  }
}

function safeRelativePath(relativePath: string): string {
  if (
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_UNSAFE_PATH",
      `unsafe corpus relative path: ${relativePath}`,
    );
  }
  return relativePath;
}

async function existingStat(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertNoSymlinkComponents(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await existingStat(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new ProgressiveContentCorpusError(
        "PROGRESSIVE_CONTENT_SYMLINK_REJECTED",
        `corpus path component is a symbolic link: ${current}`,
      );
    }
  }
}

async function ensurePrivateDirectory(target: string): Promise<void> {
  await assertNoSymlinkComponents(target);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_DIRECTORY_REJECTED",
      `corpus output component is not a real directory: ${target}`,
    );
  }
  await chmod(target, 0o700);
}

async function resolveCorpusRoot(target: string): Promise<string> {
  const requested = path.resolve(target);
  const requestedStat = await lstat(requested);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_DIRECTORY_REJECTED",
      `corpus output root must be an existing real directory: ${requested}`,
    );
  }
  // Canonicalize trusted operating-system aliases such as macOS /var ->
  // /private/var once. All subsequent paths are derived from this pinned root.
  return realpath(requested);
}

async function assertPrivateRegularFile(target: string): Promise<void> {
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_FILE_REJECTED",
      `corpus artifact must be a singly linked regular file: ${target}`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_PERMISSIONS_REJECTED",
      `corpus artifact is not owner-only: ${target}`,
    );
  }
}

async function atomicPrivateWrite(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> {
  const safePath = safeRelativePath(relativePath);
  const target = path.join(root, ...safePath.split("/"));
  await ensurePrivateDirectory(path.dirname(target));
  const existing = await existingStat(target);
  if (
    existing &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  ) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_TARGET_REJECTED",
      `refusing to replace unsafe corpus artifact: ${target}`,
    );
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
  await assertPrivateRegularFile(target);
}

async function safeRead(root: string, relativePath: string): Promise<Buffer> {
  const target = path.join(root, ...safeRelativePath(relativePath).split("/"));
  await assertNoSymlinkComponents(target);
  await assertPrivateRegularFile(target);
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function listOwnedFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new ProgressiveContentCorpusError(
        "PROGRESSIVE_CONTENT_SYMLINK_REJECTED",
        `owned corpus tree contains a symbolic link: ${absolute}`,
      );
    }
    if (stat.isFile()) {
      if (stat.nlink !== 1) {
        throw new ProgressiveContentCorpusError(
          "PROGRESSIVE_CONTENT_FILE_REJECTED",
          `owned corpus tree contains a hardlinked file: ${absolute}`,
        );
      }
      found.push(relative);
      return;
    }
    if (!stat.isDirectory()) {
      throw new ProgressiveContentCorpusError(
        "PROGRESSIVE_CONTENT_FILE_REJECTED",
        `owned corpus tree contains a non-file entry: ${absolute}`,
      );
    }
    for (const entry of await readdir(absolute)) {
      await visit(path.join(absolute, entry), path.posix.join(relative, entry));
    }
  };
  for (const directory of OWNED_DIRECTORIES) {
    const absolute = path.join(root, directory);
    if (await existingStat(absolute)) await visit(absolute, directory);
  }
  return found.sort();
}

async function sweepStaleOwnedFiles(
  root: string,
  expected: ReadonlySet<string>,
  previouslyOwned: ReadonlySet<string>,
): Promise<void> {
  const actual = await listOwnedFiles(root);
  const unrelated = actual.filter(
    (relativePath) =>
      !expected.has(relativePath) && !previouslyOwned.has(relativePath),
  );
  if (unrelated.length > 0) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_UNOWNED_FILE_REJECTED",
      `refusing to delete files not declared by a prior verified manifest: ${unrelated.join(", ")}`,
    );
  }
  for (const relativePath of actual) {
    if (expected.has(relativePath) || !previouslyOwned.has(relativePath))
      continue;
    const target = path.join(root, ...relativePath.split("/"));
    await assertPrivateRegularFile(target);
    await unlink(target);
  }
  for (const directory of OWNED_DIRECTORIES) {
    const rootDirectory = path.join(root, directory);
    const prune = async (target: string): Promise<void> => {
      for (const entry of await readdir(target, { withFileTypes: true })) {
        if (entry.isDirectory()) await prune(path.join(target, entry.name));
      }
      if (target !== rootDirectory && (await readdir(target)).length === 0)
        await rmdir(target);
    };
    if (await existingStat(rootDirectory)) await prune(rootDirectory);
  }
}

function corpusFailure(code: string, message: string): never {
  throw new ProgressiveContentCorpusError(code, message);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    return corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      `${label} must be an array`,
    );
  }
  return value;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: ReadonlySet<string>,
  label: string,
): void {
  const unsupported = Object.keys(record).filter((key) => !expected.has(key));
  const missing = [...expected].filter((key) => !(key in record));
  if (unsupported.length > 0 || missing.length > 0) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      `${label} has unsupported=[${unsupported.join(",")}] missing=[${missing.join(",")}]`,
    );
  }
}

function rejectUnsupportedKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unsupported = Object.keys(record).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      `${label} has unsupported fields: ${unsupported.join(",")}`,
    );
  }
}

/**
 * Verify a published corpus from bytes on disk. This is intentionally
 * independent of generation state: every digest, extraction oracle, canary
 * coordinate, permission, and declared-file membership is recomputed.
 */
export async function verifyProgressiveContentCorpus(
  outDir: string,
): Promise<ProgressiveContentManifest> {
  const outputRoot = await resolveCorpusRoot(outDir);
  await assertNoSymlinkComponents(outputRoot);
  const manifestBytes = await safeRead(outputRoot, "manifest.json");
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      `manifest.json is not valid JSON: ${error instanceof Error ? error.message : "parse failed"}`,
    );
  }
  const record = requireRecord(decoded, "manifest");
  requireExactKeys(
    record,
    new Set([
      "schemaVersion",
      "generatorRevision",
      "rootSeed",
      "anchorTime",
      "profile",
      "publication",
      "objects",
      "formatFixtures",
      "logicalBytes",
      "manifestSha256",
    ]),
    "manifest",
  );
  if (record.schemaVersion !== PROGRESSIVE_CONTENT_SCHEMA_VERSION) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_SCHEMA_UNSUPPORTED",
      `expected ${PROGRESSIVE_CONTENT_SCHEMA_VERSION}`,
    );
  }
  if (record.publication !== "private-atomic-manifest-last-v1") {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      "manifest publication contract is missing or unsupported",
    );
  }
  if (
    typeof record.generatorRevision !== "string" ||
    record.generatorRevision.trim().length === 0 ||
    typeof record.rootSeed !== "string" ||
    record.rootSeed.trim().length === 0 ||
    record.anchorTime !== PROGRESSIVE_CONTENT_ANCHOR_TIME ||
    typeof record.profile !== "string" ||
    !(record.profile in PROFILE_SHAPES) ||
    typeof record.logicalBytes !== "number" ||
    !Number.isSafeInteger(record.logicalBytes) ||
    record.logicalBytes < 0
  ) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      "manifest identity, profile, anchor, or logicalBytes is invalid",
    );
  }
  if (typeof record.manifestSha256 !== "string") {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      "manifestSha256 must be a string",
    );
  }
  const { manifestSha256, ...unsigned } = record;
  if (sha256(canonicalJson(unsigned)) !== manifestSha256) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_DIGEST_MISMATCH",
      "manifest identity does not match its canonical fields",
    );
  }

  const expectedPaths = new Set<string>();
  let logicalBytes = 0;
  const profile = record.profile as ProgressiveContentProfile;
  const rootSeed = record.rootSeed as string;
  const rawObjects = requireArray(record.objects, "objects");
  const expectedObjectCount = FAMILY_ORDER.reduce(
    (total, family) => total + PROFILE_SHAPES[profile].counts[family],
    0,
  );
  if (rawObjects.length !== expectedObjectCount) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      `profile ${profile} requires ${expectedObjectCount} objects`,
    );
  }
  const expectedObjectSchedule = FAMILY_ORDER.flatMap((family) =>
    Array.from(
      { length: PROFILE_SHAPES[profile].counts[family] },
      (_, index) => ({
        family,
        familyOrdinal: index,
      }),
    ),
  );
  const familyOrdinals = new Map<ProgressiveContentFamily, number>();
  for (const [index, raw] of rawObjects.entries()) {
    const object = requireRecord(raw, `objects[${index}]`);
    requireExactKeys(
      object,
      new Set([
        "id",
        "family",
        "format",
        "relativePath",
        "byteLength",
        "sourceSha256",
        "revision",
        "authorizationScope",
        "coordinateSystem",
        "canaries",
      ]),
      `objects[${index}]`,
    );
    if (
      typeof object.family !== "string" ||
      !FAMILY_ORDER.includes(object.family as ProgressiveContentFamily) ||
      typeof object.format !== "string" ||
      !FORMAT_ORDER.includes(object.format as ProgressiveContentFormat)
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `objects[${index}] has an unsupported family or format`,
      );
    }
    const family = object.family as ProgressiveContentFamily;
    const familyOrdinal = familyOrdinals.get(family) ?? 0;
    familyOrdinals.set(family, familyOrdinal + 1);
    const expectedScheduleEntry = expectedObjectSchedule[index];
    if (
      !expectedScheduleEntry ||
      family !== expectedScheduleEntry.family ||
      familyOrdinal !== expectedScheduleEntry.familyOrdinal
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `objects[${index}] is outside the deterministic family order`,
      );
    }
    const expectedId = progressiveContentObjectId(
      rootSeed,
      family,
      familyOrdinal,
    );
    const expectedByteLength = objectByteLength(
      PROFILE_SHAPES[profile],
      family,
      familyOrdinal,
      profile,
    );
    const expectedFormat =
      FORMAT_ORDER[index % FORMAT_ORDER.length] ?? "single-line";
    const expectedCanaries = canariesFor(expectedId, expectedByteLength);
    const expectedSourceSha256 = deterministicObjectSha256(
      expectedByteLength,
      expectedCanaries,
      expectedFormat,
    );
    if (
      object.id !== expectedId ||
      object.format !== expectedFormat ||
      object.relativePath !==
        path.posix.join("objects", family, `${expectedId}.txt`) ||
      typeof object.relativePath !== "string" ||
      typeof object.byteLength !== "number" ||
      !Number.isSafeInteger(object.byteLength) ||
      object.byteLength !== expectedByteLength ||
      typeof object.sourceSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(object.sourceSha256) ||
      object.revision !== object.sourceSha256 ||
      object.coordinateSystem !== "utf8-byte-start-inclusive-end-exclusive" ||
      object.authorizationScope !==
        `room:${sha256(`${rootSeed}:${family}`).slice(0, 16)}`
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `objects[${index}] has invalid source metadata`,
      );
    }
    if (object.sourceSha256 !== expectedSourceSha256) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_ORACLE_MISMATCH",
        `objects[${index}] differs from the trusted deterministic byte oracle`,
      );
    }
    const relativePath = safeRelativePath(object.relativePath);
    if (expectedPaths.has(relativePath)) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `duplicate declared path: ${relativePath}`,
      );
    }
    expectedPaths.add(relativePath);
    const bytes = await safeRead(outputRoot, relativePath);
    if (
      bytes.byteLength !== object.byteLength ||
      sha256(bytes) !== object.sourceSha256
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_SOURCE_MISMATCH",
        `source bytes do not match objects[${index}]`,
      );
    }
    logicalBytes += bytes.byteLength;
    const rawCanaries = requireArray(
      object.canaries,
      `objects[${index}].canaries`,
    );
    if (canonicalJson(rawCanaries) !== canonicalJson(expectedCanaries)) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_CANARY_MISMATCH",
        `objects[${index}] canary plan differs from the deterministic oracle`,
      );
    }
    for (const [canaryIndex, rawCanary] of rawCanaries.entries()) {
      const canary = requireRecord(
        rawCanary,
        `objects[${index}].canaries[${canaryIndex}]`,
      );
      if (
        typeof canary.text !== "string" ||
        typeof canary.byteStart !== "number" ||
        typeof canary.byteEnd !== "number" ||
        !Number.isSafeInteger(canary.byteStart) ||
        !Number.isSafeInteger(canary.byteEnd) ||
        canary.byteStart < 0 ||
        canary.byteEnd < canary.byteStart ||
        canary.byteEnd > bytes.byteLength ||
        bytes.subarray(canary.byteStart, canary.byteEnd).toString() !==
          canary.text
      ) {
        corpusFailure(
          "PROGRESSIVE_CONTENT_CANARY_MISMATCH",
          `objects[${index}].canaries[${canaryIndex}] does not match source bytes`,
        );
      }
    }
  }
  for (const family of FAMILY_ORDER) {
    if (
      (familyOrdinals.get(family) ?? 0) !==
      PROFILE_SHAPES[profile].counts[family]
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `profile ${profile} has the wrong ${family} object count`,
      );
    }
  }

  const trustedFormatOracles = buildProgressiveFormatFixtureOracles(rootSeed);
  const formatDescriptors = [
    ["markdown", "md", "text/markdown"],
    ["html", "html", "text/html"],
    ["csv", "csv", "text/csv"],
    ["jsonl", "jsonl", "application/x-ndjson"],
    ["pdf-text", "pdf", "application/pdf"],
    [
      "docx",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["mime-nested", "eml", "message/rfc822"],
    ["ocr-required", "pdf", "application/pdf"],
    ["extraction-failed", "bin", "application/octet-stream"],
  ] as const;
  const rawFormatFixtures = requireArray(
    record.formatFixtures,
    "formatFixtures",
  );
  if (rawFormatFixtures.length !== formatDescriptors.length) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
      `formatFixtures must contain ${formatDescriptors.length} deterministic goldens`,
    );
  }
  for (const [index, raw] of rawFormatFixtures.entries()) {
    const fixture = requireRecord(raw, `formatFixtures[${index}]`);
    rejectUnsupportedKeys(
      fixture,
      new Set([
        "id",
        "kind",
        "relativePath",
        "mimeType",
        "byteLength",
        "sourceSha256",
        "revision",
        "authorizationScope",
        "expectedState",
        "normalization",
        "expectedTextSha256",
        "expectedTextUtf8Bytes",
        "canaries",
        "decoys",
      ]),
      `formatFixtures[${index}]`,
    );
    const descriptor = formatDescriptors[index];
    const trustedOracle = trustedFormatOracles[index];
    if (!descriptor || !trustedOracle) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `formatFixtures[${index}] has no descriptor`,
      );
    }
    const [expectedKind, expectedExtension, expectedMimeType] = descriptor;
    const expectedId = sha256(
      `progressive-format:${rootSeed}:${expectedKind}`,
    ).slice(0, 24);
    if (
      fixture.id !== expectedId ||
      fixture.kind !== expectedKind ||
      fixture.relativePath !==
        path.posix.join("formats", `${expectedId}.${expectedExtension}`) ||
      fixture.mimeType !== expectedMimeType ||
      typeof fixture.relativePath !== "string" ||
      typeof fixture.byteLength !== "number" ||
      !Number.isSafeInteger(fixture.byteLength) ||
      fixture.byteLength < 0 ||
      typeof fixture.sourceSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(fixture.sourceSha256) ||
      fixture.revision !== fixture.sourceSha256 ||
      fixture.authorizationScope !==
        `fixture:${sha256(`${rootSeed}:${expectedKind}`).slice(0, 16)}` ||
      !["ready", "ocr-required", "failed"].includes(
        fixture.expectedState as string,
      ) ||
      fixture.normalization !== "elizaos.progressive-content.normalized-text.v1"
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `formatFixtures[${index}] has invalid source metadata`,
      );
    }
    const relativePath = safeRelativePath(fixture.relativePath);
    if (expectedPaths.has(relativePath)) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `duplicate declared path: ${relativePath}`,
      );
    }
    expectedPaths.add(relativePath);
    const bytes = await safeRead(outputRoot, relativePath);
    if (
      canonicalJson(fixture) !== canonicalJson(trustedOracle.declaration) ||
      !Buffer.from(bytes).equals(Buffer.from(trustedOracle.bytes))
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_ORACLE_MISMATCH",
        `formatFixtures[${index}] differs from the trusted deterministic fixture`,
      );
    }
    if (
      bytes.byteLength !== fixture.byteLength ||
      sha256(bytes) !== fixture.sourceSha256
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_SOURCE_MISMATCH",
        `source bytes do not match formatFixtures[${index}]`,
      );
    }
    logicalBytes += bytes.byteLength;
    const extraction = extractProgressiveFormatFixture(
      fixture.kind as ProgressiveFormatFixture["kind"],
      bytes,
    );
    if (extraction.state !== fixture.expectedState) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_EXTRACTION_MISMATCH",
        `formatFixtures[${index}] extraction state changed`,
      );
    }
    if (fixture.expectedState === "ready") {
      if (
        typeof fixture.expectedTextSha256 !== "string" ||
        typeof fixture.expectedTextUtf8Bytes !== "number" ||
        extraction.normalizedText === undefined ||
        sha256(extraction.normalizedText) !== fixture.expectedTextSha256 ||
        Buffer.byteLength(extraction.normalizedText) !==
          fixture.expectedTextUtf8Bytes
      ) {
        corpusFailure(
          "PROGRESSIVE_CONTENT_EXTRACTION_MISMATCH",
          `formatFixtures[${index}] normalized text changed`,
        );
      }
      const textBytes = Buffer.from(extraction.normalizedText);
      for (const coordinateKind of ["canaries", "decoys"] as const) {
        const coordinates = requireArray(
          fixture[coordinateKind],
          `formatFixtures[${index}].${coordinateKind}`,
        );
        if (coordinates.length === 0) {
          corpusFailure(
            "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
            `formatFixtures[${index}] ready state requires ${coordinateKind}`,
          );
        }
        for (const [coordinateIndex, rawCoordinate] of coordinates.entries()) {
          const coordinate = requireRecord(
            rawCoordinate,
            `formatFixtures[${index}].${coordinateKind}[${coordinateIndex}]`,
          );
          if (
            typeof coordinate.text !== "string" ||
            typeof coordinate.utf8ByteStart !== "number" ||
            typeof coordinate.utf8ByteEnd !== "number" ||
            !Number.isSafeInteger(coordinate.utf8ByteStart) ||
            !Number.isSafeInteger(coordinate.utf8ByteEnd) ||
            coordinate.utf8ByteStart < 0 ||
            coordinate.utf8ByteEnd < coordinate.utf8ByteStart ||
            coordinate.utf8ByteEnd > textBytes.byteLength ||
            textBytes
              .subarray(coordinate.utf8ByteStart, coordinate.utf8ByteEnd)
              .toString() !== coordinate.text
          ) {
            corpusFailure(
              "PROGRESSIVE_CONTENT_CANARY_MISMATCH",
              `formatFixtures[${index}].${coordinateKind}[${coordinateIndex}] does not match extracted text`,
            );
          }
        }
      }
    } else if (
      fixture.expectedTextSha256 !== undefined ||
      fixture.expectedTextUtf8Bytes !== undefined ||
      requireArray(fixture.canaries, `formatFixtures[${index}].canaries`)
        .length > 0 ||
      requireArray(fixture.decoys, `formatFixtures[${index}].decoys`).length > 0
    ) {
      corpusFailure(
        "PROGRESSIVE_CONTENT_MANIFEST_INVALID",
        `formatFixtures[${index}] non-ready state cannot declare extracted text`,
      );
    }
  }

  if (record.logicalBytes !== logicalBytes) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_LOGICAL_BYTES_MISMATCH",
      `logicalBytes=${String(record.logicalBytes)} but verified ${logicalBytes}`,
    );
  }
  const actualPaths = await listOwnedFiles(outputRoot);
  if (
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((relativePath) => !expectedPaths.has(relativePath))
  ) {
    corpusFailure(
      "PROGRESSIVE_CONTENT_FILE_SET_MISMATCH",
      "owned corpus directories contain undeclared or missing artifacts",
    );
  }
  return record as unknown as ProgressiveContentManifest;
}

export function progressiveContentObjectId(
  rootSeed: string,
  family: ProgressiveContentFamily,
  index: number,
): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(
      "progressive content index must be a nonnegative safe integer",
    );
  }
  return sha256(
    `${PROGRESSIVE_CONTENT_SCHEMA_VERSION}:${rootSeed}:${family}:${index}`,
  ).slice(0, 32);
}

function objectByteLength(
  shape: ProfileShape,
  family: ProgressiveContentFamily,
  index: number,
  profile: ProgressiveContentProfile,
) {
  const base = shape.baseBytes[family];
  const boundaryCases =
    profile === "micro"
      ? PROGRESSIVE_CONTENT_BOUNDARY_BYTES.slice(0, 9)
      : PROGRESSIVE_CONTENT_BOUNDARY_BYTES;
  if (index < boundaryCases.length) return boundaryCases[index] ?? base;
  return base + (index % 7) * 257;
}

function canariesFor(
  id: string,
  byteLength: number,
): ProgressiveContentCanary[] {
  const labels = ["beginning", "boundary", "middle", "end"] as const;
  const texts = labels.map((label) => `CANARY:${id}:${label}:世界:🧪`);
  const lengths = texts.map((text) => Buffer.byteLength(text));
  const preferred = [
    0,
    Math.min(10_000, Math.floor(byteLength / 3)),
    Math.floor(byteLength / 2),
  ];
  const starts = [
    preferred[0],
    preferred[1],
    preferred[2],
    Math.max(0, byteLength - (lengths[3] ?? 0)),
  ];
  const occupied: Array<{ start: number; end: number }> = [];
  return labels.flatMap((label, index) => {
    const text = texts[index] ?? "";
    const textLength = lengths[index] ?? 0;
    if (textLength > byteLength) return [];
    let start = starts[index] ?? 0;
    for (const prior of occupied) {
      if (start < prior.end && start + textLength > prior.start)
        start = prior.end;
    }
    if (start + textLength > byteLength) return [];
    occupied.push({ start, end: start + textLength });
    return [{ label, text, byteStart: start, byteEnd: start + textLength }];
  });
}

function deterministicObjectChunk(
  offset: number,
  length: number,
  byteLength: number,
  canaries: readonly ProgressiveContentCanary[],
  format: ProgressiveContentFormat,
): Buffer {
  const chunkBytes = 64 * 1024;
  const chunk = Buffer.alloc(
    length,
    0x61 + (Math.floor(offset / chunkBytes) % 26),
  );
  const jsonPattern = Buffer.from('{"key":"escaped\\nvalue","n":123},');
  for (let local = 0; local < length; local += 1) {
    const absolute = offset + local;
    if (format === "lf-lines" && absolute % 80 === 79) chunk[local] = 0x0a;
    if (format === "crlf-lines") {
      if (absolute % 80 === 78) chunk[local] = 0x0d;
      if (absolute % 80 === 79) chunk[local] = 0x0a;
    }
    if (format === "no-final-newline" && absolute % 80 === 79) {
      chunk[local] = 0x0a;
    }
    if (format === "minified-json-like") {
      chunk[local] = jsonPattern[absolute % jsonPattern.length] ?? 0x61;
    }
  }
  if (
    format === "no-final-newline" &&
    byteLength > 0 &&
    offset <= byteLength - 1 &&
    offset + length > byteLength - 1
  ) {
    chunk[byteLength - 1 - offset] = 0x7a;
  }
  if (format === "invalid-utf8" && byteLength > 256) {
    const invalidAt = 127;
    if (offset <= invalidAt && invalidAt < offset + length) {
      chunk[invalidAt - offset] = 0xff;
    }
  }
  for (const canary of canaries) {
    const source = Buffer.from(canary.text);
    const overlapStart = Math.max(offset, canary.byteStart);
    const overlapEnd = Math.min(offset + length, canary.byteEnd);
    if (overlapStart >= overlapEnd) continue;
    source.copy(
      chunk,
      overlapStart - offset,
      overlapStart - canary.byteStart,
      overlapEnd - canary.byteStart,
    );
  }
  return chunk;
}

function deterministicObjectSha256(
  byteLength: number,
  canaries: readonly ProgressiveContentCanary[],
  format: ProgressiveContentFormat,
): string {
  const digest = createHash("sha256");
  const chunkBytes = 64 * 1024;
  for (let offset = 0; offset < byteLength; offset += chunkBytes) {
    const length = Math.min(chunkBytes, byteLength - offset);
    digest.update(
      deterministicObjectChunk(offset, length, byteLength, canaries, format),
    );
  }
  return digest.digest("hex");
}

async function writeStreamedObject(
  root: string,
  relativePath: string,
  byteLength: number,
  canaries: readonly ProgressiveContentCanary[],
  format: ProgressiveContentFormat,
): Promise<string> {
  const target = path.join(root, ...safeRelativePath(relativePath).split("/"));
  await ensurePrivateDirectory(path.dirname(target));
  const existing = await existingStat(target);
  if (
    existing &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  ) {
    throw new ProgressiveContentCorpusError(
      "PROGRESSIVE_CONTENT_TARGET_REJECTED",
      `refusing to replace unsafe corpus artifact: ${target}`,
    );
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  const digest = createHash("sha256");
  const chunkBytes = 64 * 1024;
  try {
    for (let offset = 0; offset < byteLength; offset += chunkBytes) {
      const length = Math.min(chunkBytes, byteLength - offset);
      const chunk = deterministicObjectChunk(
        offset,
        length,
        byteLength,
        canaries,
        format,
      );
      await handle.write(chunk, 0, chunk.length, offset);
      digest.update(chunk);
    }
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
  await assertPrivateRegularFile(target);
  return digest.digest("hex");
}

export async function generateProgressiveContentCorpus(options: {
  readonly outDir: string;
  readonly profile?: ProgressiveContentProfile;
  readonly rootSeed: string;
  readonly generatorRevision: string;
}): Promise<ProgressiveContentManifest> {
  const profile = options.profile ?? "micro";
  const shape = PROFILE_SHAPES[profile];
  if (!shape)
    throw new Error(`unsupported progressive content profile: ${profile}`);
  if (!options.rootSeed.trim())
    throw new Error("progressive content rootSeed is required");
  if (!options.generatorRevision.trim()) {
    throw new Error("progressive content generatorRevision is required");
  }

  const outputRoot = await resolveCorpusRoot(options.outDir);
  await ensurePrivateDirectory(outputRoot);
  const marker = path.join(outputRoot, "manifest.json");
  const previouslyOwned = new Set<string>();
  if (await existingStat(marker)) {
    const priorManifest = await verifyProgressiveContentCorpus(outputRoot);
    for (const object of priorManifest.objects) {
      previouslyOwned.add(object.relativePath);
    }
    for (const fixture of priorManifest.formatFixtures) {
      previouslyOwned.add(fixture.relativePath);
    }
    await assertPrivateRegularFile(marker);
    await unlink(marker);
  } else {
    const preexistingOwnedFiles = await listOwnedFiles(outputRoot);
    if (preexistingOwnedFiles.length > 0) {
      throw new ProgressiveContentCorpusError(
        "PROGRESSIVE_CONTENT_UNOWNED_FILE_REJECTED",
        "owned corpus directories are non-empty but no verified manifest declares them",
      );
    }
  }

  const objects: ProgressiveContentObject[] = [];
  const expectedPaths = new Set<string>();
  let objectOrdinal = 0;
  for (const family of FAMILY_ORDER) {
    for (let index = 0; index < shape.counts[family]; index += 1) {
      const id = progressiveContentObjectId(options.rootSeed, family, index);
      const byteLength = objectByteLength(shape, family, index, profile);
      const format =
        FORMAT_ORDER[objectOrdinal % FORMAT_ORDER.length] ?? "single-line";
      objectOrdinal += 1;
      const relativePath = path.posix.join("objects", family, `${id}.txt`);
      expectedPaths.add(relativePath);
      const canaries = canariesFor(id, byteLength);
      const sourceSha256 = await writeStreamedObject(
        outputRoot,
        relativePath,
        byteLength,
        canaries,
        format,
      );
      objects.push({
        id,
        family,
        format,
        relativePath,
        byteLength,
        sourceSha256,
        revision: sourceSha256,
        authorizationScope: `room:${sha256(`${options.rootSeed}:${family}`).slice(0, 16)}`,
        coordinateSystem: "utf8-byte-start-inclusive-end-exclusive",
        canaries,
      });
    }
  }

  const formatFixtures = await generateProgressiveFormatFixtures({
    rootSeed: options.rootSeed,
    publish: async (relativePath, bytes) => {
      expectedPaths.add(relativePath);
      await atomicPrivateWrite(outputRoot, relativePath, bytes);
    },
  });
  await sweepStaleOwnedFiles(outputRoot, expectedPaths, previouslyOwned);
  const unsigned = {
    schemaVersion: PROGRESSIVE_CONTENT_SCHEMA_VERSION,
    generatorRevision: options.generatorRevision,
    rootSeed: options.rootSeed,
    anchorTime: PROGRESSIVE_CONTENT_ANCHOR_TIME,
    profile,
    publication: "private-atomic-manifest-last-v1",
    objects,
    formatFixtures,
    logicalBytes:
      objects.reduce((total, object) => total + object.byteLength, 0) +
      formatFixtures.reduce((total, fixture) => total + fixture.byteLength, 0),
  } as const;
  const manifest: ProgressiveContentManifest = {
    ...unsigned,
    manifestSha256: sha256(canonicalJson(unsigned)),
  };
  await atomicPrivateWrite(
    outputRoot,
    "manifest.json",
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  );
  await verifyProgressiveContentCorpus(outputRoot);
  return manifest;
}
