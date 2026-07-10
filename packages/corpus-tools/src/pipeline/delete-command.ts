/**
 * Filesystem orchestration for the reviewed deletion stage. Planning emits
 * local-only review artifacts; apply validates every binding before writing a
 * mirrored survivor corpus, resumable ledger records, manifest, approval, and
 * sanitized report. The library core stays pure while this boundary owns I/O.
 */
import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CorpusMessage } from "../schema.ts";
import {
  buildCorpusManifest,
  findCorpusShardFiles,
  readCorpusShard,
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
  shardPaths: string[];
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

async function readJsonLines<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const rows: T[] = [];
  const source = await fs.readFile(filePath, "utf8");
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

async function loadCorpus(targetPath: string): Promise<LoadedCorpus> {
  const rootDir = path.extname(targetPath)
    ? path.dirname(targetPath)
    : targetPath;
  const shardPaths = (await findCorpusShardFiles(targetPath)).filter(
    (filePath) => !filePath.split(path.sep).includes(".state"),
  );
  if (shardPaths.length === 0) throw new Error("deletion target has no shards");
  const messages: CorpusMessage[] = [];
  const ids = new Set<string>();
  for (const shardPath of shardPaths) {
    const shard = await readCorpusShard(shardPath, { rootDir });
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
  }
  return { targetPath, rootDir, shardPaths, messages };
}

async function writePrivateJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(filePath, 0o600);
}

export async function planDeletionFiles(
  options: PlanDeletionFilesOptions,
): Promise<DeletionReviewQueue> {
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
): Promise<number> {
  const existing = existsSync(ledgerPath)
    ? await readJsonLines(ledgerPath, z.record(z.string(), z.unknown()))
    : [];
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
  if (missing.length === 0) return 0;
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(
    ledgerPath,
    `${missing.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
  await fs.chmod(ledgerPath, 0o600);
  return missing.length;
}

async function validateDeletionInputsAgainstLedger(
  ledgerPath: string,
  messages: readonly CorpusMessage[],
  rulesetVersion: string,
): Promise<void> {
  if (!existsSync(ledgerPath)) {
    throw new Error("deletion requires an upstream scrub ledger");
  }
  const records = await readJsonLines(
    ledgerPath,
    z.record(z.string(), z.unknown()),
  );
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
): Promise<void> {
  const sourcePath = path.resolve(corpus.targetPath);
  const destinationPath = path.resolve(outputPath);
  const contains = (parent: string, child: string): boolean => {
    const relative = path.relative(parent, child);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  };
  if (
    contains(sourcePath, destinationPath) ||
    contains(destinationPath, sourcePath)
  ) {
    throw new Error("deletion input and output paths must not overlap");
  }
  const survivorsById = new Map(
    survivors.map((message) => [message.id, message]),
  );
  const desired = new Map<string, string>();
  for (const shardPath of corpus.shardPaths) {
    const shard = await readCorpusShard(shardPath, { rootDir: corpus.rootDir });
    const rows = shard.messages
      .map((message) => survivorsById.get(message.id))
      .filter((message): message is CorpusMessage => message !== undefined);
    desired.set(
      path.relative(corpus.rootDir, shardPath),
      rows.length === 0
        ? ""
        : `${rows.map((message) => JSON.stringify(message)).join("\n")}\n`,
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
    return;
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
  await validateDeletionInputsAgainstLedger(
    options.ledgerPath,
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
  await writeSurvivorCorpus(corpus, applied.survivors, options.outputPath);
  const { manifest, issues } = await buildCorpusManifest(
    options.outputPath,
    decisions.reviewedAt,
  );
  if (issues.length > 0) {
    throw new Error(
      `deleted corpus manifest failed: ${issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const ledgerRecordsWritten = await appendLedgerRecords(
    options.ledgerPath,
    records,
  );
  await writePrivateJson(options.manifestPath, manifest);
  await writePrivateJson(options.approvalPath, applied.approval);
  await writePrivateJson(options.reportPath, applied.report);
  return {
    approval: applied.approval,
    report: applied.report,
    ledgerRecordsWritten,
    outputPath: options.outputPath,
  };
}

export async function applyDeletionFiles(
  options: ApplyDeletionFilesOptions,
): Promise<AppliedDeletionFiles> {
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
