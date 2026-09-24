#!/usr/bin/env bun
/**
 * Converts the four canonical real-local context-inspector artifacts into the
 * strict content-context E2E report. The collector validates source identity,
 * persistence state, redaction, and the original artifact bytes before an
 * atomic private publication.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { inflateRawSync } from "node:zlib";
import { parseStrictJson } from "../corpus-tools/src/strict-json.ts";

export const CONTENT_CONTEXT_E2E_RAW_ARTIFACTS = [
  {
    kind: "backend-log",
    path: "e2e-artifacts/backend/server.log",
  },
  {
    kind: "browser-trace",
    path: "e2e-artifacts/browser/trace.zip",
  },
  {
    kind: "network-log",
    path: "e2e-artifacts/network/requests.har",
  },
  {
    kind: "database-state",
    path: "e2e-artifacts/database/rows.json",
  },
];

const E2E_SCHEMA = "elizaos.content-context.e2e.v1";
const MAX_ZIP_ENTRIES = 256;
const MAX_ZIP_MEMBER_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_RATIO = 200;
const BODY_CANARY = Buffer.from(["TOP", " SECRET", " E2E", " BODY"].join(""));
const PATH_CANARY = Buffer.from(["/private", "/e2e", "/account-"].join(""));

export function parseContentContextE2EArgs(argv) {
  const options = {};
  const names = new Map([
    ["artifact-root", "artifactRoot"],
    ["out", "out"],
    ["commit", "commit"],
    ["corpus-manifest-sha256", "corpusManifestSha256"],
    ["run-id", "runId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--"))
      throw new Error(`unknown argument: ${argument}`);
    const equals = argument.indexOf("=");
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    const key = names.get(name);
    if (!key) throw new Error(`unknown argument: --${name}`);
    let value;
    if (equals === -1) {
      index += 1;
      value = argv[index];
    } else {
      value = argument.slice(equals + 1);
    }
    if (!value || value.startsWith("--"))
      throw new Error(`--${name} requires a value`);
    if (options[key] !== undefined)
      throw new Error(`--${name} must be specified once`);
    options[key] = value;
  }
  if (!options.help) {
    for (const [name, key] of names) {
      if (!options[key]) throw new Error(`--${name} is required`);
    }
  }
  return options;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} fields are not exact`);
  }
  return value;
}

function strictJson(bytes, label) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8`, { cause: error });
  }
  return parseStrictJson(text, label);
}

function assertIdentity(value, runId, commit, label, captured = false) {
  if (value.runId !== runId || value.sourceSha !== commit) {
    throw new Error(`${label} does not match the requested run and source`);
  }
  if (captured && value.capturedFromSourceSha !== commit) {
    throw new Error(`${label} was not captured from the requested source`);
  }
}

function assertCanariesAbsent(bytes, label) {
  if (bytes.indexOf(BODY_CANARY) !== -1 || bytes.indexOf(PATH_CANARY) !== -1) {
    throw new Error(`${label} contains a raw redaction probe`);
  }
}

async function assertRealParents(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe artifact parent: ${relativePath}`);
    }
  }
}

async function readPrivateRegular(root, relativePath) {
  await assertRealParents(root, relativePath);
  const filePath = path.join(root, ...relativePath.split("/"));
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error(
        `artifact is not a private single-link regular file: ${relativePath}`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength === 0)
      throw new Error(`artifact is empty: ${relativePath}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

function safeZipName(name) {
  if (
    !name ||
    name !== name.normalize("NFC") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/")
  ) {
    return false;
  }
  return name
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== "..");
}

function findZipEnd(bytes) {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("browser trace is not a complete ZIP archive");
}

/** Decode bounded ZIP members from the already-opened bytes without a path re-read. */
export function readTraceZipMembers(bytes) {
  const archive = Buffer.from(bytes);
  const end = findZipEnd(archive);
  const disk = archive.readUInt16LE(end + 4);
  const centralDisk = archive.readUInt16LE(end + 6);
  const diskEntries = archive.readUInt16LE(end + 8);
  const entries = archive.readUInt16LE(end + 10);
  const centralBytes = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  const commentBytes = archive.readUInt16LE(end + 20);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entries ||
    entries === 0 ||
    entries > MAX_ZIP_ENTRIES ||
    end + 22 + commentBytes !== archive.length ||
    centralOffset + centralBytes !== end
  ) {
    throw new Error("browser trace ZIP inventory is unsupported or malformed");
  }

  const decoded = [];
  const names = new Set();
  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("browser trace ZIP central directory is malformed");
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedBytes = archive.readUInt32LE(offset + 20);
    const uncompressedBytes = archive.readUInt32LE(offset + 24);
    const nameBytes = archive.readUInt16LE(offset + 28);
    const extraBytes = archive.readUInt16LE(offset + 30);
    const memberCommentBytes = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const next = offset + 46 + nameBytes + extraBytes + memberCommentBytes;
    if (next > end || flags & 1 || (method !== 0 && method !== 8)) {
      throw new Error(
        "browser trace ZIP uses encrypted or unsupported members",
      );
    }
    if (
      uncompressedBytes > MAX_ZIP_MEMBER_BYTES ||
      totalBytes + uncompressedBytes > MAX_ZIP_TOTAL_BYTES ||
      (compressedBytes === 0
        ? uncompressedBytes !== 0
        : uncompressedBytes / compressedBytes > MAX_ZIP_RATIO)
    ) {
      throw new Error("browser trace ZIP exceeds decompression limits");
    }
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      archive.subarray(offset + 46, offset + 46 + nameBytes),
    );
    if (!safeZipName(name) || names.has(name) || name.endsWith("/")) {
      throw new Error(
        "browser trace ZIP contains an unsafe or duplicate member",
      );
    }
    names.add(name);
    if (
      localOffset + 30 > centralOffset ||
      archive.readUInt32LE(localOffset) !== 0x04034b50
    ) {
      throw new Error("browser trace ZIP local header is malformed");
    }
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameBytes = archive.readUInt16LE(localOffset + 26);
    const localExtraBytes = archive.readUInt16LE(localOffset + 28);
    const localName = archive.subarray(
      localOffset + 30,
      localOffset + 30 + localNameBytes,
    );
    if (
      localFlags !== flags ||
      localMethod !== method ||
      !localName.equals(Buffer.from(name))
    ) {
      throw new Error("browser trace ZIP central and local headers differ");
    }
    const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes;
    const dataEnd = dataOffset + compressedBytes;
    if (dataEnd > centralOffset)
      throw new Error("browser trace ZIP member is truncated");
    const compressed = archive.subarray(dataOffset, dataEnd);
    let body;
    try {
      body =
        method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    } catch (error) {
      throw new Error("browser trace ZIP member cannot be decompressed", {
        cause: error,
      });
    }
    if (body.byteLength !== uncompressedBytes) {
      throw new Error("browser trace ZIP member size is false");
    }
    totalBytes += body.byteLength;
    decoded.push({ name, bytes: body });
    offset = next;
  }
  if (offset !== end)
    throw new Error("browser trace ZIP directory size is false");
  return decoded;
}

function validateBackend(bytes, runId, commit) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const [schema, embeddedRunId, sourceSha] = text.split("\n", 3);
  if (
    schema !== "# schema=eliza.context-inspector-backend-log/v1" ||
    embeddedRunId !== `# runId=${runId}` ||
    sourceSha !== `# sourceSha=${commit}`
  ) {
    throw new Error("backend log identity or schema is invalid");
  }
  for (const required of [
    "[device-e2e-host-agent] real API up on",
    "[trajectories] Trajectories service initialized",
  ]) {
    if (!text.includes(required))
      throw new Error("backend log lacks real-local startup proof");
  }
  for (const failure of [
    "[trajectory-logger] Failed",
    "TrajectoriesService.detachedWrite",
  ]) {
    if (text.includes(failure))
      throw new Error("backend log contains a persistence failure");
  }
}

function validateNetwork(bytes, runId, commit) {
  const report = exactKeys(
    strictJson(bytes, "network artifact"),
    ["schema", "runId", "sourceSha", "entries"],
    "network artifact",
  );
  if (report.schema !== "eliza.context-inspector-network-log/v1") {
    throw new Error("network artifact schema is invalid");
  }
  assertIdentity(report, runId, commit, "network artifact");
  if (!Array.isArray(report.entries) || report.entries.length === 0) {
    throw new Error("network artifact has no requests");
  }
  const entries = report.entries.map((entry, index) =>
    exactKeys(
      entry,
      ["method", "pathname", "resourceType", "status"],
      `network entry ${index}`,
    ),
  );
  if (
    entries.some(
      ({ method, pathname, resourceType, status }) =>
        typeof method !== "string" ||
        typeof pathname !== "string" ||
        !pathname.startsWith("/") ||
        typeof resourceType !== "string" ||
        !Number.isInteger(status) ||
        status < 100 ||
        status > 599,
    )
  ) {
    throw new Error("network artifact contains an invalid request entry");
  }
  const inspectorStatuses = entries
    .filter(({ pathname }) => pathname === "/api/context-inspector")
    .map(({ status }) => status);
  if (!inspectorStatuses.includes(200) || !inspectorStatuses.includes(400)) {
    throw new Error(
      "network artifact lacks successful and rejected inspector requests",
    );
  }
  if (
    !entries.some(
      ({ method, pathname, status }) =>
        method === "POST" &&
        pathname === "/api/device-e2e/context-inspector/seed" &&
        status === 200,
    )
  ) {
    throw new Error("network artifact lacks successful real-local seeding");
  }
}

function validateDatabase(bytes, runId, commit) {
  const report = exactKeys(
    strictJson(bytes, "database artifact"),
    [
      "schema",
      "runId",
      "sourceSha",
      "capturedFromSourceSha",
      "engine",
      "adapter",
      "source",
      "counts",
    ],
    "database artifact",
  );
  if (
    report.schema !== "eliza.context-inspector-db-state/v1" ||
    report.engine !== "pglite" ||
    report.adapter !== "PgliteDatabaseAdapter" ||
    report.source !== "context-inspector-e2e"
  ) {
    throw new Error("database artifact is not the expected real PGlite state");
  }
  assertIdentity(report, runId, commit, "database artifact", true);
  const counts = exactKeys(
    report.counts,
    [
      "trajectories",
      "declaredSteps",
      "indexedSteps",
      "normalizedStepRows",
      "llmCalls",
      "materializedTrajectories",
      "snapshotBytes",
    ],
    "database counts",
  );
  for (const key of [
    "trajectories",
    "declaredSteps",
    "indexedSteps",
    "llmCalls",
    "materializedTrajectories",
  ]) {
    if (counts[key] !== 21)
      throw new Error(`database count is invalid: ${key}`);
  }
  if (
    counts.normalizedStepRows !== 0 ||
    !Number.isSafeInteger(counts.snapshotBytes) ||
    counts.snapshotBytes <= 21_000
  ) {
    throw new Error(
      "database state does not prove the expected persisted rows",
    );
  }
}

function validateTrace(bytes, runId, commit) {
  const members = readTraceZipMembers(bytes);
  const eventMembers = members.filter(
    ({ name, bytes: body }) =>
      (name.endsWith(".trace") || name.endsWith(".network")) &&
      body.byteLength > 0,
  );
  if (eventMembers.length === 0)
    throw new Error("browser trace has no nonempty trace/event member");
  let hasRunId = false;
  let hasCommit = false;
  for (const member of members) {
    assertCanariesAbsent(member.bytes, `browser trace member ${member.name}`);
    hasRunId ||= member.bytes.includes(Buffer.from(runId));
    hasCommit ||= member.bytes.includes(Buffer.from(commit));
  }
  if (!hasRunId || !hasCommit)
    throw new Error(
      "browser trace is not bound to the requested run and source",
    );
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeAtomicPrivate(out, report) {
  const parent = path.dirname(out);
  const parentStat = await fs.lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (parentStat.mode & 0o077) !== 0
  ) {
    throw new Error("output parent must be a private real directory");
  }
  const pending = path.join(parent, `.content-context-e2e-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(pending, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(pending, out);
    await fs.chmod(out, 0o600);
  } catch (error) {
    await fs.rm(pending, { force: true });
    throw error;
  }
}

export async function produceContentContextE2E(options) {
  if (!/^[0-9a-f]{40}$/u.test(options.commit))
    throw new Error("--commit must be an exact lowercase SHA");
  if (!/^[0-9a-f]{64}$/u.test(options.corpusManifestSha256)) {
    throw new Error(
      "--corpus-manifest-sha256 must be an exact lowercase SHA-256",
    );
  }
  if (
    !options.runId ||
    options.runId.length > 200 ||
    [...options.runId].some((character) => character.codePointAt(0) < 0x20)
  ) {
    throw new Error("--run-id is invalid");
  }
  const root = path.resolve(options.artifactRoot);
  const rootStat = await fs.lstat(root);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o077) !== 0
  ) {
    throw new Error("artifact root must be a private real directory");
  }
  const byteMap = new Map();
  for (const artifact of CONTENT_CONTEXT_E2E_RAW_ARTIFACTS) {
    const bytes = await readPrivateRegular(root, artifact.path);
    assertCanariesAbsent(bytes, artifact.path);
    byteMap.set(artifact.path, bytes);
  }
  validateBackend(
    byteMap.get(CONTENT_CONTEXT_E2E_RAW_ARTIFACTS[0].path),
    options.runId,
    options.commit,
  );
  validateTrace(
    byteMap.get(CONTENT_CONTEXT_E2E_RAW_ARTIFACTS[1].path),
    options.runId,
    options.commit,
  );
  validateNetwork(
    byteMap.get(CONTENT_CONTEXT_E2E_RAW_ARTIFACTS[2].path),
    options.runId,
    options.commit,
  );
  validateDatabase(
    byteMap.get(CONTENT_CONTEXT_E2E_RAW_ARTIFACTS[3].path),
    options.runId,
    options.commit,
  );

  const report = {
    schemaVersion: E2E_SCHEMA,
    status: "passed",
    commit: options.commit,
    corpusManifestSha256: options.corpusManifestSha256,
    runId: options.runId,
    checks: {
      api: true,
      ui: true,
      inspector: true,
      backend: true,
      browser: true,
      network: true,
      database: true,
    },
    artifacts: CONTENT_CONTEXT_E2E_RAW_ARTIFACTS.map((artifact) => {
      const bytes = byteMap.get(artifact.path);
      return { ...artifact, sha256: digest(bytes), bytes: bytes.byteLength };
    }),
  };
  await writeAtomicPrivate(path.resolve(options.out), report);
  return report;
}

function printHelp() {
  console.log(
    "Usage: bun packages/scripts/produce-content-context-e2e.mjs --artifact-root=<dir> --out=<e2e.json> --commit=<sha> --corpus-manifest-sha256=<sha256> --run-id=<id>",
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  try {
    const options = parseContentContextE2EArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else console.log(JSON.stringify(await produceContentContextE2E(options)));
  } catch (error) {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  }
}
