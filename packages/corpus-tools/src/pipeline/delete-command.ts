/**
 * Filesystem orchestration for the reviewed deletion stage. Planning emits
 * local-only review artifacts; apply validates every binding before writing a
 * mirrored survivor corpus, resumable ledger records, manifest, approval, and
 * sanitized report. The library core stays pure while this boundary owns I/O.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CorpusMessage } from "../schema.ts";
import {
  buildCorpusManifest,
  findCorpusShardFiles,
  parseCorpusShard,
} from "../validator.ts";
import {
  applyDeletionReview,
  buildDeletionReviewQueue,
  canonicalDeletionArtifactSha256,
  type DeletionApproval,
  type DeletionReport,
  type DeletionReviewQueue,
  parseDeletionReviewQueue,
} from "./delete.ts";
import {
  parseDeletionReviewDecisionsDocument,
  parseDeletionRulesDocument,
} from "./delete-files.ts";

const deletionCandidateSchema = z
  .object({
    msgId: z.string().min(1),
    kind: z.string().min(1),
  })
  .passthrough();

interface LoadedCorpus {
  targetPath: string;
  rootDir: string;
  shards: Array<{
    path: string;
    bytes: Buffer;
    dev: number;
    ino: number;
    messages: CorpusMessage[];
  }>;
  messages: CorpusMessage[];
}

export interface PlanDeletionFilesOptions {
  targetPath: string;
  candidatesPath: string;
  rulesPath: string;
  queuePath: string;
  normalizedRulesPath: string;
}

export interface ApplyDeletionFilesOptions {
  targetPath: string;
  candidatesPath: string;
  normalizedRulesPath: string;
  queuePath: string;
  decisionsPath: string;
  outputPath: string;
  ledgerPath: string;
  manifestPath: string;
  approvalPath: string;
  reportPath: string;
}

export interface AppliedDeletionFiles {
  approval: DeletionApproval;
  report: DeletionReport;
  ledgerRecordsWritten: number;
  outputPath: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readHandleBytes(
  handle: Awaited<ReturnType<typeof fs.open>>,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) {
      throw new Error("file ended while reading a captured snapshot");
    }
    offset += result.bytesRead;
  }
  return bytes;
}

function parseJsonLines<T>(
  source: string,
  filePath: string,
  schema: z.ZodType<T>,
): T[] {
  const rows: T[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSON at ${filePath}:${index + 1}`, {
        cause: error,
      });
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `invalid ${filePath}:${index + 1}: ${z.prettifyError(parsed.error)}`,
      );
    }
    rows.push(parsed.data);
  }
  return rows;
}

async function readJsonLines<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  return parseJsonLines(await fs.readFile(filePath, "utf8"), filePath, schema);
}

async function loadCorpus(targetPath: string): Promise<LoadedCorpus> {
  const rootDir = path.extname(targetPath)
    ? path.dirname(targetPath)
    : targetPath;
  const shardPaths = (await findCorpusShardFiles(targetPath)).filter(
    (filePath) => !filePath.split(path.sep).includes(".state"),
  );
  if (shardPaths.length === 0) throw new Error("deletion target has no shards");
  const messages: CorpusMessage[] = [];
  const shards: LoadedCorpus["shards"] = [];
  const ids = new Set<string>();
  for (const shardPath of shardPaths) {
    const handle = await fs.open(shardPath, "r");
    let bytes: Buffer;
    let before: Awaited<ReturnType<typeof handle.stat>>;
    let after: Awaited<ReturnType<typeof handle.stat>>;
    try {
      before = await handle.stat();
      bytes = await readHandleBytes(handle, before.size);
      after = await handle.stat();
    } finally {
      await handle.close();
    }
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size
    ) {
      throw new Error(`deletion input changed while loading ${shardPath}`);
    }
    const shard = parseCorpusShard(bytes.toString("utf8"), shardPath, {
      rootDir,
    });
    if (shard.issues.length > 0) {
      throw new Error(
        `invalid deletion input ${shardPath}: ${shard.issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    for (const message of shard.messages) {
      if (ids.has(message.id)) {
        throw new Error(`duplicate deletion message id ${message.id}`);
      }
      ids.add(message.id);
      messages.push(message);
    }
    shards.push({
      path: shardPath,
      bytes,
      dev: after.dev,
      ino: after.ino,
      messages: shard.messages,
    });
  }
  return { targetPath, rootDir, shards, messages };
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<{ expectedBytes: Buffer; dev: number; ino: number }> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const expectedBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(expectedBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporaryPath, filePath);
  } finally {
    // error-policy:J6 an interrupted atomic artifact write may leave this file.
    await fs.rm(temporaryPath, { force: true });
  }
  const stat = await fs.stat(filePath);
  if (!(await fs.readFile(filePath)).equals(expectedBytes)) {
    throw new Error(`deletion artifact changed during write at ${filePath}`);
  }
  return { expectedBytes, dev: stat.dev, ino: stat.ino };
}

async function assertArtifactUnchanged(
  filePath: string,
  expected: { expectedBytes: Buffer; dev: number; ino: number },
): Promise<void> {
  const stat = await fs.stat(filePath);
  if (
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    !(await fs.readFile(filePath)).equals(expected.expectedBytes)
  ) {
    throw new Error(`deletion artifact changed after write at ${filePath}`);
  }
}

async function canonicalFuturePath(filePath: string): Promise<string> {
  let cursor = path.resolve(filePath);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`cannot resolve path boundary for ${filePath}`);
    }
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.join(await fs.realpath(cursor), ...suffix);
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function canonicalPaths(
  entries: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const owners = new Map<string, string>();
  const inodeOwners = new Map<string, string>();
  for (const [name, filePath] of Object.entries(entries)) {
    const canonical = await canonicalFuturePath(filePath);
    const owner = owners.get(canonical);
    if (owner) {
      throw new Error(`deletion paths ${owner} and ${name} alias each other`);
    }
    owners.set(canonical, name);
    if (existsSync(canonical)) {
      const stat = await fs.stat(canonical);
      if (stat.isFile()) {
        const inodeKey = `${stat.dev}:${stat.ino}`;
        const inodeOwner = inodeOwners.get(inodeKey);
        if (inodeOwner) {
          throw new Error(
            `deletion paths ${inodeOwner} and ${name} share a file inode`,
          );
        }
        inodeOwners.set(inodeKey, name);
      }
    }
    resolved.set(name, canonical);
  }
  return resolved;
}

function assertNoPathOverlap(
  paths: ReadonlyMap<string, string>,
  parentName: string,
  childNames: readonly string[],
): void {
  const parent = paths.get(parentName);
  if (!parent) throw new Error(`missing canonical ${parentName} path`);
  for (const childName of childNames) {
    const child = paths.get(childName);
    if (!child) throw new Error(`missing canonical ${childName} path`);
    if (pathContains(parent, child) || pathContains(child, parent)) {
      throw new Error(
        `deletion paths ${parentName} and ${childName} must not overlap`,
      );
    }
  }
}

export async function planDeletionFiles(
  options: PlanDeletionFilesOptions,
): Promise<DeletionReviewQueue> {
  const paths = await canonicalPaths({
    target: options.targetPath,
    candidates: options.candidatesPath,
    rules: options.rulesPath,
    queue: options.queuePath,
    normalizedRules: options.normalizedRulesPath,
  });
  assertNoPathOverlap(paths, "target", ["queue", "normalizedRules"]);
  const corpus = await loadCorpus(options.targetPath);
  const candidates = await readJsonLines(
    options.candidatesPath,
    deletionCandidateSchema,
  );
  const rules = parseDeletionRulesDocument(
    await fs.readFile(options.rulesPath, "utf8"),
    options.rulesPath,
  );
  const normalizedRules = {
    ...rules,
    rules: [...rules.rules].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  const queue = buildDeletionReviewQueue({
    messages: corpus.messages,
    candidates,
    rules: normalizedRules,
  });
  await writePrivateJson(options.normalizedRulesPath, normalizedRules);
  await writePrivateJson(options.queuePath, queue);
  return queue;
}

function desiredLedgerRecords(
  inputMessages: readonly CorpusMessage[],
  survivors: readonly CorpusMessage[],
  tombstones: readonly {
    messageId: string;
    stage: "delete";
    stageVersion: string;
    outputHash: string;
    rulesSha256: string;
    reviewedQueueSha256: string;
    reviewDecisionSha256: string;
    ruleIdHashes: readonly string[];
    scope: "message" | "thread";
  }[],
  rulesetVersion: string,
  approval: Pick<
    DeletionApproval,
    | "deleteStageVersion"
    | "rulesSha256"
    | "reviewedQueueSha256"
    | "reviewDecisionSha256"
  >,
): Array<Record<string, unknown>> {
  const stageVersion = approval.deleteStageVersion;
  const survivorsById = new Map(
    survivors.map((message) => [message.id, message]),
  );
  const tombstonesById = new Map(
    tombstones.map((tombstone) => [tombstone.messageId, tombstone]),
  );
  return inputMessages.map((message) => {
    const inputHash = sha256(JSON.stringify(message));
    const tombstone = tombstonesById.get(message.id);
    if (tombstone && tombstone.stageVersion !== stageVersion) {
      throw new Error("deletion tombstone stage version mismatch");
    }
    const markerKey = `pii:${inputHash}:v${rulesetVersion}:delete:${stageVersion}`;
    const common = {
      markerKey,
      messageId: message.id,
      stage: "delete",
      stageVersion,
      rulesetVersion,
      inputHash,
      clusterKey: message.id,
      isClusterExemplar: true,
      cost: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd: 0,
        llmCalls: 0,
      },
    };
    if (tombstone) {
      return { ...common, ...tombstone, tombstone: true };
    }
    const output = survivorsById.get(message.id);
    if (!output) throw new Error(`deletion lost message ${message.id}`);
    return {
      ...common,
      rulesSha256: approval.rulesSha256,
      reviewedQueueSha256: approval.reviewedQueueSha256,
      reviewDecisionSha256: approval.reviewDecisionSha256,
      outputHash: sha256(JSON.stringify(output)),
      tombstone: false,
      output,
    };
  });
}

async function appendLedgerRecords(
  ledgerPath: string,
  records: readonly Record<string, unknown>[],
  inputMessages: readonly CorpusMessage[],
  rulesetVersion: string,
): Promise<{
  recordsWritten: number;
  expectedBytes: Buffer;
  dev: number;
  ino: number;
}> {
  const handle = await fs.open(ledgerPath, "a+", 0o600);
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  try {
    const before = await handle.stat();
    const originalBytes = await readHandleBytes(handle, before.size);
    const afterRead = await handle.stat();
    if (
      before.dev !== afterRead.dev ||
      before.ino !== afterRead.ino ||
      before.size !== afterRead.size ||
      before.mtimeMs !== afterRead.mtimeMs ||
      originalBytes.length !== afterRead.size
    ) {
      await close();
      throw new Error("deletion ledger changed while reading");
    }
    const existing = parseJsonLines(
      originalBytes.toString("utf8"),
      ledgerPath,
      z.record(z.string(), z.unknown()),
    );
    validateDeletionInputsAgainstLedger(
      existing,
      inputMessages,
      rulesetVersion,
    );
    const byMarker = new Map(
      existing.map((record) => [String(record.markerKey), record]),
    );
    if (byMarker.size !== existing.length) {
      throw new Error("deletion ledger contains duplicate marker history");
    }
    const missing: Record<string, unknown>[] = [];
    for (const record of records) {
      const markerKey = String(record.markerKey);
      const prior = byMarker.get(markerKey);
      if (
        prior &&
        canonicalDeletionArtifactSha256(prior) !==
          canonicalDeletionArtifactSha256(record)
      ) {
        throw new Error(`conflicting deletion ledger record ${markerKey}`);
      }
      if (!prior) missing.push(record);
    }
    const appendedBytes = Buffer.from(
      missing.length === 0
        ? ""
        : `${missing.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const beforeWrite = await handle.stat();
    if (
      beforeWrite.dev !== afterRead.dev ||
      beforeWrite.ino !== afterRead.ino ||
      beforeWrite.size !== afterRead.size ||
      beforeWrite.mtimeMs !== afterRead.mtimeMs
    ) {
      await close();
      throw new Error("deletion ledger changed before append");
    }
    try {
      if (appendedBytes.length > 0) await handle.write(appendedBytes);
      await handle.sync();
      await handle.chmod(0o600);
    } finally {
      await close();
    }
    const expectedBytes = Buffer.concat([originalBytes, appendedBytes]);
    const finalStat = await fs.stat(ledgerPath);
    if (
      finalStat.dev !== afterRead.dev ||
      finalStat.ino !== afterRead.ino ||
      !(await fs.readFile(ledgerPath)).equals(expectedBytes)
    ) {
      throw new Error("deletion ledger changed during append");
    }
    return {
      recordsWritten: missing.length,
      expectedBytes,
      dev: finalStat.dev,
      ino: finalStat.ino,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function validateDeletionInputsAgainstLedger(
  records: readonly Record<string, unknown>[],
  messages: readonly CorpusMessage[],
  rulesetVersion: string,
): void {
  const currentSecrets = records.filter(
    (record) =>
      record.rulesetVersion === rulesetVersion &&
      record.stage === "secrets" &&
      record.tombstone === false,
  );
  const secretsById = new Map<string, Record<string, unknown>>();
  for (const record of currentSecrets) {
    const messageId = String(record.messageId);
    if (secretsById.has(messageId)) {
      throw new Error(`ambiguous secrets ledger history for ${messageId}`);
    }
    secretsById.set(messageId, record);
  }
  if (secretsById.size !== messages.length) {
    throw new Error(
      "deletion target does not match secrets ledger message set",
    );
  }
  for (const message of messages) {
    const record = secretsById.get(message.id);
    if (
      !record ||
      record.output === undefined ||
      record.outputHash !== sha256(JSON.stringify(message)) ||
      canonicalDeletionArtifactSha256(record.output) !==
        canonicalDeletionArtifactSha256(message)
    ) {
      throw new Error(
        `deletion target is not the secrets output for ${message.id}`,
      );
    }
  }
}

async function writeSurvivorCorpus(
  corpus: LoadedCorpus,
  survivors: readonly CorpusMessage[],
  outputPath: string,
): Promise<Map<string, string>> {
  const sourcePath = path.resolve(corpus.targetPath);
  const destinationPath = path.resolve(outputPath);
  if (
    pathContains(sourcePath, destinationPath) ||
    pathContains(destinationPath, sourcePath)
  ) {
    throw new Error("deletion input and output paths must not overlap");
  }
  const survivorsById = new Map(
    survivors.map((message) => [message.id, message]),
  );
  const desired = new Map<string, string>();
  for (const shard of corpus.shards) {
    const rows = shard.messages
      .map((message) => survivorsById.get(message.id))
      .filter((message): message is CorpusMessage => message !== undefined);
    if (rows.length === 0) continue;
    desired.set(
      path.relative(corpus.rootDir, shard.path),
      `${rows.map((message) => JSON.stringify(message)).join("\n")}\n`,
    );
  }
  if (existsSync(outputPath)) {
    const existingPaths = (await findCorpusShardFiles(outputPath)).filter(
      (filePath) => !filePath.split(path.sep).includes(".state"),
    );
    const relativeExisting = existingPaths
      .map((filePath) => path.relative(outputPath, filePath))
      .sort();
    if (
      canonicalDeletionArtifactSha256(relativeExisting) !==
      canonicalDeletionArtifactSha256([...desired.keys()].sort())
    ) {
      throw new Error("existing deletion output has a different shard set");
    }
    for (const [relative, bytes] of desired) {
      if (
        (await fs.readFile(path.join(outputPath, relative), "utf8")) !== bytes
      ) {
        throw new Error(`existing deletion output differs at ${relative}`);
      }
    }
    return desired;
  }
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await fs.mkdir(temporaryPath, { recursive: true });
    for (const [relative, bytes] of desired) {
      const destination = path.join(temporaryPath, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, bytes, { mode: 0o600 });
    }
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.rename(temporaryPath, outputPath);
  } finally {
    // error-policy:J6 an interrupted atomic output may leave only this temp tree.
    await fs.rm(temporaryPath, { recursive: true, force: true });
  }
  return desired;
}

async function assertSurvivorOutputUnchanged(
  outputPath: string,
  desired: ReadonlyMap<string, string>,
): Promise<void> {
  const currentPaths = (await findCorpusShardFiles(outputPath))
    .filter((filePath) => !filePath.split(path.sep).includes(".state"))
    .map((filePath) => path.relative(outputPath, filePath))
    .sort();
  if (
    canonicalDeletionArtifactSha256(currentPaths) !==
    canonicalDeletionArtifactSha256([...desired.keys()].sort())
  ) {
    throw new Error("deletion output shard set changed during apply");
  }
  for (const [relative, bytes] of desired) {
    if (
      (await fs.readFile(path.join(outputPath, relative), "utf8")) !== bytes
    ) {
      throw new Error(`deletion output changed during apply at ${relative}`);
    }
  }
}

async function assertLedgerUnchanged(
  ledgerPath: string,
  expected: { expectedBytes: Buffer; dev: number; ino: number },
): Promise<void> {
  const stat = await fs.stat(ledgerPath);
  if (
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    !(await fs.readFile(ledgerPath)).equals(expected.expectedBytes)
  ) {
    throw new Error("deletion ledger changed after append");
  }
}

async function assertCorpusUnchanged(corpus: LoadedCorpus): Promise<void> {
  const currentPaths = (await findCorpusShardFiles(corpus.targetPath))
    .filter((filePath) => !filePath.split(path.sep).includes(".state"))
    .sort();
  const expectedPaths = corpus.shards.map((shard) => shard.path).sort();
  if (
    canonicalDeletionArtifactSha256(currentPaths) !==
    canonicalDeletionArtifactSha256(expectedPaths)
  ) {
    throw new Error("deletion input shard set changed during apply");
  }
  for (const shard of corpus.shards) {
    const stat = await fs.stat(shard.path);
    if (
      stat.dev !== shard.dev ||
      stat.ino !== shard.ino ||
      !(await fs.readFile(shard.path)).equals(shard.bytes)
    ) {
      throw new Error(`deletion input changed during apply at ${shard.path}`);
    }
  }
}

async function assertInternalFilesSeparated(
  corpus: LoadedCorpus,
  ledgerPath: string,
  outputPath?: string,
): Promise<void> {
  const sourceInodes = new Set(
    corpus.shards.map((shard) => `${shard.dev}:${shard.ino}`),
  );
  if (sourceInodes.size !== corpus.shards.length) {
    throw new Error("deletion source shards share a file inode");
  }
  const ledgerStat = await fs.stat(ledgerPath);
  if (sourceInodes.has(`${ledgerStat.dev}:${ledgerStat.ino}`)) {
    throw new Error("deletion ledger shares an inode with a source shard");
  }
  if (!outputPath || !existsSync(outputPath)) return;
  const outputInodes = new Set<string>();
  for (const outputShard of await findCorpusShardFiles(outputPath)) {
    const stat = await fs.stat(outputShard);
    const inode = `${stat.dev}:${stat.ino}`;
    if (sourceInodes.has(inode)) {
      throw new Error("deletion output shares an inode with a source shard");
    }
    if (outputInodes.has(inode)) {
      throw new Error("deletion output shards share a file inode");
    }
    outputInodes.add(inode);
  }
}

async function applyDeletionFilesLocked(
  options: ApplyDeletionFilesOptions,
): Promise<AppliedDeletionFiles> {
  const corpus = await loadCorpus(options.targetPath);
  const queue = parseDeletionReviewQueue(
    JSON.parse(await fs.readFile(options.queuePath, "utf8")),
  );
  const decisions = parseDeletionReviewDecisionsDocument(
    await fs.readFile(options.decisionsPath, "utf8"),
    options.decisionsPath,
  );
  const candidates = await readJsonLines(
    options.candidatesPath,
    deletionCandidateSchema,
  );
  const rules = parseDeletionRulesDocument(
    await fs.readFile(options.normalizedRulesPath, "utf8"),
    options.normalizedRulesPath,
  );
  const expectedQueue = buildDeletionReviewQueue({
    messages: corpus.messages,
    candidates,
    rules,
  });
  if (
    canonicalDeletionArtifactSha256(queue) !==
    canonicalDeletionArtifactSha256(expectedQueue)
  ) {
    throw new Error("deletion review queue is not canonical for its inputs");
  }
  if (!existsSync(options.ledgerPath)) {
    throw new Error("deletion requires an upstream scrub ledger");
  }
  await assertInternalFilesSeparated(
    corpus,
    options.ledgerPath,
    options.outputPath,
  );
  const initialLedgerRecords = await readJsonLines(
    options.ledgerPath,
    z.record(z.string(), z.unknown()),
  );
  validateDeletionInputsAgainstLedger(
    initialLedgerRecords,
    corpus.messages,
    queue.rulesetVersion,
  );
  const applied = applyDeletionReview({
    messages: corpus.messages,
    queue,
    decisions,
  });
  const records = desiredLedgerRecords(
    corpus.messages,
    applied.survivors,
    applied.tombstones,
    applied.approval.rulesetVersion,
    applied.approval,
  );
  await assertCorpusUnchanged(corpus);
  const desiredOutput = await writeSurvivorCorpus(
    corpus,
    applied.survivors,
    options.outputPath,
  );
  await assertCorpusUnchanged(corpus);
  await assertSurvivorOutputUnchanged(options.outputPath, desiredOutput);
  await assertInternalFilesSeparated(
    corpus,
    options.ledgerPath,
    options.outputPath,
  );
  const { manifest, issues } = await buildCorpusManifest(
    options.outputPath,
    decisions.reviewedAt,
  );
  if (issues.length > 0) {
    throw new Error(
      `deleted corpus manifest failed: ${issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  if (
    canonicalDeletionArtifactSha256(
      manifest.shards.map((shard) => shard.path).sort(),
    ) !== canonicalDeletionArtifactSha256([...desiredOutput.keys()].sort()) ||
    manifest.totals.messages !== applied.survivors.length ||
    manifest.shards.some((shard) => {
      const bytes = desiredOutput.get(shard.path);
      return (
        bytes === undefined ||
        shard.sha256 !== sha256(bytes) ||
        shard.count !== bytes.trim().split("\n").length
      );
    })
  ) {
    throw new Error("deletion manifest does not match survivor snapshot");
  }
  const ledgerAppend = await appendLedgerRecords(
    options.ledgerPath,
    records,
    corpus.messages,
    applied.approval.rulesetVersion,
  );
  const manifestArtifact = await writePrivateJson(
    options.manifestPath,
    manifest,
  );
  const approvalArtifact = await writePrivateJson(
    options.approvalPath,
    applied.approval,
  );
  const reportArtifact = await writePrivateJson(
    options.reportPath,
    applied.report,
  );
  await assertCorpusUnchanged(corpus);
  await assertSurvivorOutputUnchanged(options.outputPath, desiredOutput);
  await assertLedgerUnchanged(options.ledgerPath, ledgerAppend);
  await assertInternalFilesSeparated(
    corpus,
    options.ledgerPath,
    options.outputPath,
  );
  await assertArtifactUnchanged(options.manifestPath, manifestArtifact);
  await assertArtifactUnchanged(options.approvalPath, approvalArtifact);
  await assertArtifactUnchanged(options.reportPath, reportArtifact);
  return {
    approval: applied.approval,
    report: applied.report,
    ledgerRecordsWritten: ledgerAppend.recordsWritten,
    outputPath: options.outputPath,
  };
}

export async function applyDeletionFiles(
  options: ApplyDeletionFilesOptions,
): Promise<AppliedDeletionFiles> {
  const paths = await canonicalPaths({
    target: options.targetPath,
    candidates: options.candidatesPath,
    normalizedRules: options.normalizedRulesPath,
    queue: options.queuePath,
    decisions: options.decisionsPath,
    output: options.outputPath,
    ledger: options.ledgerPath,
    manifest: options.manifestPath,
    approval: options.approvalPath,
    report: options.reportPath,
  });
  assertNoPathOverlap(paths, "target", [
    "output",
    "ledger",
    "manifest",
    "approval",
    "report",
  ]);
  assertNoPathOverlap(paths, "output", [
    "candidates",
    "normalizedRules",
    "queue",
    "decisions",
    "ledger",
    "manifest",
    "approval",
    "report",
  ]);
  await fs.mkdir(path.dirname(options.ledgerPath), { recursive: true });
  const lockPath = `${options.ledgerPath}.lock`;
  const lock = await fs.open(lockPath, "wx", 0o600);
  try {
    return await applyDeletionFilesLocked(options);
  } finally {
    await lock.close();
    await fs.rm(lockPath);
  }
}
