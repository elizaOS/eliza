/**
 * Idempotent scrub-pipeline driver for personal-corpus rows. The driver owns
 * the stage graph, per-stage marker ledger, fast-track clustering, cost report,
 * and CLI-facing file orchestration; individual PII detectors and rewrite
 * engines plug in as pure stage functions.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  assertScrubStateTransition,
  type CorpusMessage,
  type ScrubState,
  scrubStateRank,
} from "../schema.ts";
import { findCorpusShardFiles, readCorpusShard } from "../validator.ts";

export const SCRUB_STAGE_NAMES = [
  "mine",
  "secrets",
  "delete",
  "rewrite",
  "llm",
  "verify",
] as const;

export type ScrubStageName = (typeof SCRUB_STAGE_NAMES)[number];
export type ScrubMode = "fast-track" | "deep";
export type ScrubStageSelector = ScrubStageName | "all";

export interface ScrubStageContext {
  stage: ScrubStageName;
  mode: ScrubMode;
  rulesetVersion: string;
  inputHash: string;
  markerKey: string;
  clusterKey: string;
  isClusterExemplar: boolean;
}

export interface ScrubStageResult {
  message?: CorpusMessage;
  tombstone?: boolean;
  cost?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedUsd?: number;
    llmCalls?: number;
  };
}

export type ScrubStageFunction = (
  message: CorpusMessage,
  context: ScrubStageContext,
) => ScrubStageResult | Promise<ScrubStageResult>;

export interface ScrubStageDefinition {
  name: ScrubStageName;
  version: string;
  targetState: ScrubState;
  run: ScrubStageFunction;
}

export interface ScrubLedgerRecord {
  markerKey: string;
  messageId: string;
  stage: ScrubStageName;
  stageVersion: string;
  rulesetVersion: string;
  inputHash: string;
  outputHash: string;
  tombstone: boolean;
  clusterKey: string;
  isClusterExemplar: boolean;
  cost: Required<NonNullable<ScrubStageResult["cost"]>>;
  output?: CorpusMessage;
}

export interface ScrubRunOptions {
  targetPath: string;
  stateDir?: string;
  ledgerPath?: string;
  outputPath?: string;
  reportPath?: string;
  stage?: ScrubStageSelector;
  mode: ScrubMode;
  resume: boolean;
  dryRun: boolean;
  rulesetVersion: string;
  stages?: readonly ScrubStageDefinition[];
  maxStageExecutions?: number;
}

export interface ScrubStageReport {
  stage: ScrubStageName;
  stageVersion: string;
  executed: number;
  ledgerHits: number;
  alreadyComplete: number;
  tombstoned: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface ScrubRunReport {
  mode: ScrubMode;
  stage: ScrubStageSelector;
  rulesetVersion: string;
  dryRun: boolean;
  inputMessages: number;
  outputMessages: number;
  stageReports: ScrubStageReport[];
  clusterStats: {
    clusters: number;
    largestCluster: number;
    fastTrackEligibleMessages: number;
    exemplarMessages: number;
  };
  ledger: {
    path: string;
    recordsRead: number;
    recordsWritten: number;
    hitRate: number;
  };
  outputPath?: string;
  reportPath?: string;
}

interface LedgerState {
  recordsRead: number;
  byKey: Map<string, ScrubLedgerRecord>;
}

const ZERO_COST: Required<NonNullable<ScrubStageResult["cost"]>> = {
  inputTokens: 0,
  outputTokens: 0,
  estimatedUsd: 0,
  llmCalls: 0,
};

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableCloneMessage(message: CorpusMessage): CorpusMessage {
  return JSON.parse(JSON.stringify(message)) as CorpusMessage;
}

function costOf(
  cost: ScrubStageResult["cost"],
): Required<NonNullable<ScrubStageResult["cost"]>> {
  return {
    inputTokens: cost?.inputTokens ?? 0,
    outputTokens: cost?.outputTokens ?? 0,
    estimatedUsd: cost?.estimatedUsd ?? 0,
    llmCalls: cost?.llmCalls ?? 0,
  };
}

function stageKey(params: {
  inputHash: string;
  stage: ScrubStageName;
  stageVersion: string;
  rulesetVersion: string;
}): string {
  return [
    `pii:${params.inputHash}:v${params.rulesetVersion}`,
    params.stage,
    params.stageVersion,
  ].join(":");
}

function defaultStateDir(targetPath: string): string {
  const base = path.extname(targetPath) ? path.dirname(targetPath) : targetPath;
  return path.join(base, ".state");
}

function stageTargetState(stage: ScrubStageName): ScrubState {
  switch (stage) {
    case "mine":
      return "mined";
    case "secrets":
    case "delete":
      return "swapped";
    case "rewrite":
    case "llm":
      return "rewritten";
    case "verify":
      return "verified";
  }
}

function normalizeNewsletterTemplate(text: string): string {
  return text
    .toLowerCase()
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, "<email>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d+\b/g, "<number>")
    .replace(/\s+/g, " ")
    .trim();
}

function clusterKeyFor(message: CorpusMessage, mode: ScrubMode): string {
  if (mode === "deep") return message.id;
  const labels = new Set(message.labels.map((label) => label.toLowerCase()));
  const fastTrackLabel =
    labels.has("newsletter") ||
    labels.has("notification") ||
    labels.has("promotions") ||
    labels.has("updates");
  if (!fastTrackLabel) return message.id;
  return sha256Json({
    platform: message.platform,
    accountId: message.accountId,
    subject: message.subject ?? "",
    template: normalizeNewsletterTemplate(message.text),
  });
}

function clusterStats(messages: readonly CorpusMessage[], mode: ScrubMode) {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const key = clusterKeyFor(message, mode);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let largestCluster = 0;
  let fastTrackEligibleMessages = 0;
  for (const count of counts.values()) {
    if (count > largestCluster) largestCluster = count;
    if (count > 1) fastTrackEligibleMessages += count;
  }
  return {
    clusters: counts.size,
    largestCluster,
    fastTrackEligibleMessages,
    exemplarMessages: counts.size,
  };
}

async function loadLedger(ledgerPath: string): Promise<LedgerState> {
  try {
    const raw = await fs.readFile(ledgerPath, "utf8");
    const byKey = new Map<string, ScrubLedgerRecord>();
    let recordsRead = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      const record = JSON.parse(line) as ScrubLedgerRecord;
      byKey.set(record.markerKey, record);
      recordsRead += 1;
    }
    return { recordsRead, byKey };
  } catch (error) {
    // error-policy:J4 first run has no local-only ledger yet; other read failures surface.
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { recordsRead: 0, byKey: new Map() };
    }
    throw error;
  }
}

async function appendLedgerRecord(
  ledgerPath: string,
  record: ScrubLedgerRecord,
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(ledgerPath, `${JSON.stringify(record)}\n`);
}

async function readMessages(targetPath: string): Promise<CorpusMessage[]> {
  const files = (await findCorpusShardFiles(targetPath)).filter(
    (file) => !file.split(path.sep).includes(".state"),
  );
  const messages: CorpusMessage[] = [];
  for (const file of files) {
    const shard = await readCorpusShard(file, {
      rootDir: path.extname(targetPath) ? path.dirname(targetPath) : targetPath,
    });
    if (shard.issues.length > 0) {
      throw new Error(
        `invalid corpus shard ${file}: ${shard.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    messages.push(...shard.messages);
  }
  return messages;
}

function selectedStages(
  selector: ScrubStageSelector,
  stages: readonly ScrubStageDefinition[],
): ScrubStageDefinition[] {
  if (selector === "all") return [...stages];
  const found = stages.find((stage) => stage.name === selector);
  if (!found) {
    throw new Error(`unknown scrub stage ${selector}`);
  }
  return [found];
}

function defaultStage(stage: ScrubStageName): ScrubStageDefinition {
  const targetState = stageTargetState(stage);
  return {
    name: stage,
    version: "1",
    targetState,
    run(message, context) {
      assertScrubStateTransition(message.scrubState, targetState);
      const next = stableCloneMessage(message);
      next.scrubState = targetState;
      const isLlmExemplar =
        stage === "llm" &&
        (context.mode === "deep" || context.isClusterExemplar);
      return {
        message: next,
        cost: isLlmExemplar
          ? {
              inputTokens: Math.ceil(message.text.length / 4),
              outputTokens: Math.ceil(message.text.length / 8),
              estimatedUsd: 0.000001 * message.text.length,
              llmCalls: 1,
            }
          : ZERO_COST,
      };
    },
  };
}

export function defaultScrubStages(): ScrubStageDefinition[] {
  return SCRUB_STAGE_NAMES.map(defaultStage);
}

async function writeJsonl(
  outputPath: string,
  messages: readonly CorpusMessage[],
): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
  );
}

async function writeReport(
  reportPath: string,
  report: ScrubRunReport,
): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export async function runScrubPipeline(
  options: ScrubRunOptions,
): Promise<{ messages: CorpusMessage[]; report: ScrubRunReport }> {
  const selector = options.stage ?? "all";
  const stages = selectedStages(
    selector,
    options.stages ?? defaultScrubStages(),
  );
  const stateDir = options.stateDir ?? defaultStateDir(options.targetPath);
  const ledgerPath =
    options.ledgerPath ?? path.join(stateDir, "scrub-ledger.jsonl");
  const outputPath =
    options.outputPath ?? path.join(stateDir, "scrub-output.jsonl");
  const reportPath =
    options.reportPath ?? path.join(stateDir, "scrub-report.json");
  const ledger = options.resume
    ? await loadLedger(ledgerPath)
    : { recordsRead: 0, byKey: new Map<string, ScrubLedgerRecord>() };
  let recordsWritten = 0;
  let stageExecutions = 0;
  let messages = await readMessages(options.targetPath);
  const inputMessages = messages.length;
  const stats = clusterStats(messages, options.mode);
  const clusterExemplars = new Set<string>();
  const stageReports: ScrubStageReport[] = stages.map((stage) => ({
    stage: stage.name,
    stageVersion: stage.version,
    executed: 0,
    ledgerHits: 0,
    alreadyComplete: 0,
    tombstoned: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
  }));

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex];
    const report = stageReports[stageIndex];
    const nextMessages: CorpusMessage[] = [];
    clusterExemplars.clear();

    for (const message of messages) {
      if (
        scrubStateRank[message.scrubState] > scrubStateRank[stage.targetState]
      ) {
        report.alreadyComplete += 1;
        nextMessages.push(stableCloneMessage(message));
        continue;
      }
      const inputHash = sha256Json(message);
      const clusterKey = clusterKeyFor(message, options.mode);
      const isClusterExemplar = !clusterExemplars.has(clusterKey);
      clusterExemplars.add(clusterKey);
      const key = stageKey({
        inputHash,
        stage: stage.name,
        stageVersion: stage.version,
        rulesetVersion: options.rulesetVersion,
      });
      const existing = ledger.byKey.get(key);
      if (existing) {
        report.ledgerHits += 1;
        if (existing.tombstone) {
          report.tombstoned += 1;
          continue;
        }
        if (!existing.output) {
          throw new Error(`ledger record ${key} is missing output snapshot`);
        }
        nextMessages.push(stableCloneMessage(existing.output));
        continue;
      }

      if (options.dryRun) {
        report.executed += 1;
        nextMessages.push(stableCloneMessage(message));
        continue;
      }

      if (
        options.maxStageExecutions !== undefined &&
        stageExecutions >= options.maxStageExecutions
      ) {
        throw new Error(
          `simulated interruption after ${stageExecutions} stage executions`,
        );
      }

      const result = await stage.run(message, {
        stage: stage.name,
        mode: options.mode,
        rulesetVersion: options.rulesetVersion,
        inputHash,
        markerKey: key,
        clusterKey,
        isClusterExemplar,
      });
      stageExecutions += 1;
      report.executed += 1;
      const cost = costOf(result.cost);
      report.llmCalls += cost.llmCalls;
      report.inputTokens += cost.inputTokens;
      report.outputTokens += cost.outputTokens;
      report.estimatedUsd += cost.estimatedUsd;
      const output = result.tombstone ? undefined : result.message;
      if (!result.tombstone && !output) {
        throw new Error(
          `stage ${stage.name} returned neither message nor tombstone`,
        );
      }
      if (output) {
        assertScrubStateTransition(message.scrubState, output.scrubState);
        nextMessages.push(stableCloneMessage(output));
      } else {
        report.tombstoned += 1;
      }
      const record: ScrubLedgerRecord = {
        markerKey: key,
        messageId: message.id,
        stage: stage.name,
        stageVersion: stage.version,
        rulesetVersion: options.rulesetVersion,
        inputHash,
        outputHash: sha256Json(output ?? { tombstone: true }),
        tombstone: result.tombstone === true,
        clusterKey,
        isClusterExemplar,
        cost,
        output: output ? stableCloneMessage(output) : undefined,
      };
      ledger.byKey.set(key, record);
      await appendLedgerRecord(ledgerPath, record);
      recordsWritten += 1;
    }
    messages = nextMessages;
  }

  if (!options.dryRun) {
    await writeJsonl(outputPath, messages);
  }
  const totalHits = stageReports.reduce(
    (sum, report) => sum + report.ledgerHits,
    0,
  );
  const totalAttempts = stageReports.reduce(
    (sum, report) => sum + report.ledgerHits + report.executed,
    0,
  );
  const runReport: ScrubRunReport = {
    mode: options.mode,
    stage: selector,
    rulesetVersion: options.rulesetVersion,
    dryRun: options.dryRun,
    inputMessages,
    outputMessages: messages.length,
    stageReports,
    clusterStats: stats,
    ledger: {
      path: ledgerPath,
      recordsRead: ledger.recordsRead,
      recordsWritten,
      hitRate: totalAttempts === 0 ? 0 : totalHits / totalAttempts,
    },
    outputPath: options.dryRun ? undefined : outputPath,
    reportPath,
  };
  await writeReport(reportPath, runReport);
  return { messages, report: runReport };
}
