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
import {
  applyPiiSweep,
  createDeterministicPiiSweepEngine,
  type PiiSweepEngine,
  type PiiSweepReplacement,
} from "./llm-pii.ts";
import { minePiiCandidates, writeMineArtifacts } from "./mine.ts";
import {
  buildRewritePlan,
  type RewritePlan,
  rewriteSameThemes,
} from "./rewrite.ts";
import { swapPermanentSecrets } from "./secrets.ts";

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
  knownSecrets?: Record<string, string | undefined>;
  rewritePlan?: RewritePlan;
  piiSweepEngine?: PiiSweepEngine;
}

export interface ScrubStageResult {
  message?: CorpusMessage;
  tombstone?: boolean;
  metadata?: Record<string, unknown>;
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
  knownSecrets?: Record<string, string | undefined>;
  piiSweepEngine?: PiiSweepEngine;
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
  candidateCount?: number;
  secretReplacementCount?: number;
  rewriteReplacementCount?: number;
  rewriteSkipped?: number;
  piiSpanCount?: number;
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
  mineArtifacts?: {
    candidatesPath: string;
    frequencyPath: string;
    reviewCsvPath: string;
  };
  piiSweepArtifacts?: {
    classificationPath: string;
  };
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

function targetRootDir(targetPath: string): string {
  return path.extname(targetPath) ? path.dirname(targetPath) : targetPath;
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

function isOffDeviceStage(stage: ScrubStageName): boolean {
  return stage === "rewrite" || stage === "llm";
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

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return undefined;
  const rawValue = match[2].trim();
  const quoted = rawValue.match(/^(['"])(.*)\1$/);
  return [match[1], quoted ? quoted[2] : rawValue];
}

async function readKnownSecretsFromEnvFiles(
  targetPath: string,
): Promise<Record<string, string | undefined>> {
  const rootDir = targetRootDir(targetPath);
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const secrets: Record<string, string | undefined> = {};
  for (const entry of entries) {
    if (!entry.isFile() || !/^\.env(?:\.|$)/.test(entry.name)) continue;
    const raw = await fs.readFile(path.join(rootDir, entry.name), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (parsed) {
        secrets[parsed[0]] = parsed[1];
      }
    }
  }
  return secrets;
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
    async run(message, context) {
      assertScrubStateTransition(message.scrubState, targetState);
      if (stage === "secrets") {
        const swapped = swapPermanentSecrets(message, {
          hashSalt: context.rulesetVersion,
          knownSecrets: context.knownSecrets,
        });
        return {
          message: swapped.message,
          metadata: {
            secretReplacementCount: swapped.replacements.length,
          },
          cost: ZERO_COST,
        };
      }
      if (stage === "rewrite") {
        const next = stableCloneMessage(message);
        if (context.mode === "fast-track") {
          next.scrubState = targetState;
          return {
            message: next,
            metadata: {
              rewriteSkipped: 1,
            },
            cost: ZERO_COST,
          };
        }
        const rewritten = rewriteSameThemes(
          message,
          context.rewritePlan ?? { surrogates: [] },
        );
        return {
          message: rewritten.message,
          metadata: {
            rewriteReplacementCount: rewritten.replacements.length,
          },
          cost: {
            inputTokens: Math.ceil(message.text.length / 4),
            outputTokens: Math.ceil(rewritten.message.text.length / 4),
            estimatedUsd:
              0.0000006 * (message.text.length + rewritten.message.text.length),
            llmCalls: 1,
          },
        };
      }
      if (stage === "llm") {
        const engine =
          context.piiSweepEngine ?? createDeterministicPiiSweepEngine();
        const swept = await applyPiiSweep(message, engine, {
          hashSalt: context.rulesetVersion,
        });
        return {
          message: swept.message,
          metadata: {
            piiSpanCount: swept.replacements.length,
            piiSweepReplacements: swept.replacements,
          },
          cost: {
            inputTokens: Math.ceil(message.text.length / 4),
            outputTokens: Math.ceil(swept.message.text.length / 4),
            estimatedUsd:
              0.0000008 * (message.text.length + swept.message.text.length),
            llmCalls: 1,
          },
        };
      }
      const next = stableCloneMessage(message);
      next.scrubState = targetState;
      // Per-message mining here would be redundant: report.candidateCount is
      // recomputed post-loop from the whole-corpus minePiiCandidates() call.
      return {
        message: next,
        metadata: undefined,
        cost: ZERO_COST,
      };
    },
  };
}

export function defaultScrubStages(): ScrubStageDefinition[] {
  return SCRUB_STAGE_NAMES.map(defaultStage);
}

function hasGreenSecretsRecord(
  ledger: LedgerState,
  messageId: string,
  rulesetVersion: string,
): boolean {
  for (const record of ledger.byKey.values()) {
    if (
      record.messageId === messageId &&
      record.stage === "secrets" &&
      record.rulesetVersion === rulesetVersion &&
      !record.tombstone &&
      record.output &&
      scrubStateRank[record.output.scrubState] >= scrubStateRank.swapped
    ) {
      return true;
    }
  }
  return false;
}

function assertSecretsGate(
  stage: ScrubStageName,
  message: CorpusMessage,
  ledger: LedgerState,
  rulesetVersion: string,
): void {
  if (!isOffDeviceStage(stage)) return;
  if (scrubStateRank[message.scrubState] < scrubStateRank.swapped) {
    throw new Error(
      `refusing ${stage} before secrets stage for message ${message.id}`,
    );
  }
  if (!hasGreenSecretsRecord(ledger, message.id, rulesetVersion)) {
    throw new Error(
      `refusing ${stage}: message ${message.id} lacks a green secrets ledger entry`,
    );
  }
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

/**
 * Ensure a state directory exists and can never be accidentally committed by
 * writing a `*`-glob `.gitignore` into it. This makes safety independent of
 * where `--state-dir` happens to point (previously it relied on the dir
 * sitting under a `data/`-covered path). Safe to call repeatedly.
 */
async function ensureStateDirIgnored(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, ".gitignore"), "*\n");
}

async function writePiiSweepClassification(
  stateDir: string,
  rows: readonly {
    messageId: string;
    replacements: readonly PiiSweepReplacement[];
  }[],
): Promise<string> {
  const classificationPath = path.join(
    stateDir,
    "pii-sweep-classification.json",
  );
  await fs.mkdir(stateDir, { recursive: true });
  // Strip the raw PII cleartext (`text`) from the on-disk artifact. Only
  // non-sensitive classification fields are persisted; the in-memory pipeline
  // result returned to callers still carries the full span.
  const sanitizedRows = rows.map((row) => ({
    messageId: row.messageId,
    replacements: row.replacements.map((replacement) => ({
      kind: replacement.kind,
      start: replacement.start,
      end: replacement.end,
      confidence: replacement.confidence,
      engine: replacement.engine,
      valueHash: replacement.valueHash,
      replacement: replacement.replacement,
    })),
  }));
  await fs.writeFile(
    classificationPath,
    `${JSON.stringify({ rows: sanitizedRows }, null, 2)}\n`,
  );
  return classificationPath;
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
  // Guarantee the state dir (ledger + all artifacts, including pre-scrub
  // snapshots that still contain raw PII) can never be committed, regardless of
  // where it points. Runs before any ledger/artifact write.
  await ensureStateDirIgnored(stateDir);
  const ledger = options.resume
    ? await loadLedger(ledgerPath)
    : { recordsRead: 0, byKey: new Map<string, ScrubLedgerRecord>() };
  let recordsWritten = 0;
  let stageExecutions = 0;
  const knownSecrets = {
    ...(await readKnownSecretsFromEnvFiles(options.targetPath)),
    ...(options.knownSecrets ?? {}),
  };
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
  let mineArtifactPaths: ScrubRunReport["mineArtifacts"] | undefined;
  let piiSweepArtifacts: ScrubRunReport["piiSweepArtifacts"] | undefined;
  const piiSweepRows: {
    messageId: string;
    replacements: PiiSweepReplacement[];
  }[] = [];

  for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
    const stage = stages[stageIndex];
    const report = stageReports[stageIndex];
    const nextMessages: CorpusMessage[] = [];
    const rewritePlan =
      stage.name === "rewrite"
        ? buildRewritePlan(messages, { hashSalt: options.rulesetVersion })
        : undefined;
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

      assertSecretsGate(stage.name, message, ledger, options.rulesetVersion);
      const result = await stage.run(message, {
        stage: stage.name,
        mode: options.mode,
        rulesetVersion: options.rulesetVersion,
        inputHash,
        markerKey: key,
        clusterKey,
        isClusterExemplar,
        knownSecrets,
        rewritePlan,
        piiSweepEngine: options.piiSweepEngine,
      });
      stageExecutions += 1;
      report.executed += 1;
      const cost = costOf(result.cost);
      report.llmCalls += cost.llmCalls;
      report.inputTokens += cost.inputTokens;
      report.outputTokens += cost.outputTokens;
      report.estimatedUsd += cost.estimatedUsd;
      if (
        result.metadata &&
        typeof result.metadata === "object" &&
        "candidateCount" in result.metadata &&
        typeof result.metadata.candidateCount === "number"
      ) {
        report.candidateCount =
          (report.candidateCount ?? 0) + result.metadata.candidateCount;
      }
      if (
        result.metadata &&
        typeof result.metadata === "object" &&
        "secretReplacementCount" in result.metadata &&
        typeof result.metadata.secretReplacementCount === "number"
      ) {
        report.secretReplacementCount =
          (report.secretReplacementCount ?? 0) +
          result.metadata.secretReplacementCount;
      }
      if (
        result.metadata &&
        typeof result.metadata === "object" &&
        "rewriteReplacementCount" in result.metadata &&
        typeof result.metadata.rewriteReplacementCount === "number"
      ) {
        report.rewriteReplacementCount =
          (report.rewriteReplacementCount ?? 0) +
          result.metadata.rewriteReplacementCount;
      }
      if (
        result.metadata &&
        typeof result.metadata === "object" &&
        "rewriteSkipped" in result.metadata &&
        typeof result.metadata.rewriteSkipped === "number"
      ) {
        report.rewriteSkipped =
          (report.rewriteSkipped ?? 0) + result.metadata.rewriteSkipped;
      }
      if (
        result.metadata &&
        typeof result.metadata === "object" &&
        "piiSpanCount" in result.metadata &&
        typeof result.metadata.piiSpanCount === "number"
      ) {
        report.piiSpanCount =
          (report.piiSpanCount ?? 0) + result.metadata.piiSpanCount;
      }
      if (
        stage.name === "llm" &&
        result.metadata &&
        typeof result.metadata === "object" &&
        "piiSweepReplacements" in result.metadata &&
        Array.isArray(result.metadata.piiSweepReplacements)
      ) {
        piiSweepRows.push({
          messageId: message.id,
          replacements: result.metadata
            .piiSweepReplacements as PiiSweepReplacement[],
        });
      }
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
    if (!options.dryRun && stage.name === "mine") {
      const artifacts = await minePiiCandidates(messages, {
        hashSalt: options.rulesetVersion,
      });
      mineArtifactPaths = await writeMineArtifacts(stateDir, artifacts);
      report.candidateCount = artifacts.candidates.length;
    }
    if (!options.dryRun && stage.name === "llm") {
      piiSweepArtifacts = {
        classificationPath: await writePiiSweepClassification(
          stateDir,
          piiSweepRows,
        ),
      };
    }
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
    mineArtifacts: mineArtifactPaths,
    piiSweepArtifacts,
  };
  await writeReport(reportPath, runReport);
  return { messages, report: runReport };
}
