/**
 * Evaluates complete When2Speak dialogues through the production Stage-1
 * response handler. Malformed rows fail before inference; accepted dialogue
 * is never truncated or windowed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  ChannelType,
  ElizaError,
  type IAgentRuntime,
  type Memory,
  runV5MessageRuntimeStage1,
  type State,
  stringToUuid,
} from "@elizaos/core";
import type { LiveProviderName } from "@elizaos/core/testing";
import { createScenarioRuntime } from "./runtime-factory.ts";

export type TimingLabel = "SPEAK" | "SILENT";
export type TimingDataset =
  | "duke-trust-lab/When2Speak"
  | "mookiezi/Discord-Dialogues";
export type TimingInputFormat = "when2speak" | "discord-replay";
export interface When2SpeakExample {
  row: number;
  turns: Array<{ speaker: string; text: string; isAgent: boolean }>;
  label: TimingLabel;
  directlyAddressesAgent: boolean;
  speakerCount: number;
}
export interface TimingCounts {
  total: number;
  correct: number;
  trueSpeak: number;
  falseSpeak: number;
  trueSilent: number;
  falseSilent: number;
}
export interface TimingMetrics extends TimingCounts {
  accuracy: number | null;
  speakPrecision: number | null;
  speakRecall: number | null;
  speakF1: number | null;
  silentPrecision: number | null;
  silentRecall: number | null;
  silentF1: number | null;
  falseInterventionRate: number | null;
  missedInterventionRate: number | null;
}
export interface TimingPrediction {
  row: number;
  gold: TimingLabel;
  predicted: TimingLabel;
  directlyAddressesAgent: boolean;
  speakerCount: number;
  contextTurns: number;
}
export interface TimingReport {
  schema: 2;
  status: "in-progress" | "complete";
  dataset: TimingDataset;
  input: string;
  inputSha256: string;
  provider: string;
  requestedModel: string;
  backend: string;
  trajectoryDir: string;
  selection: {
    shardIndex: number;
    shardCount: number;
    startRow: number;
    limit: number | null;
  };
  startedAt: string;
  finishedAt: string;
  metrics: TimingMetrics;
  slices: {
    address: Record<string, TimingMetrics>;
    speakers: Record<string, TimingMetrics>;
    contextTurns: Record<string, TimingMetrics>;
  };
  predictions: TimingPrediction[];
  exclusions: Array<{ row: number; reason: string }>;
  failures: Array<{ row: number; error: string }>;
}

type CorpusMessage = { role: "user" | "assistant"; content: string };
type DiscordSeat = "participant_a" | "participant_b";
function invalidCorpusRow(
  row: number,
  message: string,
  cause?: unknown,
): ElizaError {
  return new ElizaError(`When2Speak row ${row} ${message}`, {
    code: "WHEN2SPEAK_INVALID_ROW",
    ...(cause === undefined ? {} : { cause }),
    context: { row },
  });
}
function isCorpusMessage(value: unknown): value is CorpusMessage {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.role === "user" || record.role === "assistant") &&
    typeof record.content === "string"
  );
}
function parseSpeakerTurn(
  content: string,
  row: number,
): { speaker: string; text: string } {
  const separator = content.indexOf(":");
  if (separator <= 0)
    throw invalidCorpusRow(row, "has an unparseable speaker turn");
  const speaker = content.slice(0, separator).trim();
  const text = content.slice(separator + 1).trim();
  if (!speaker || !text)
    throw invalidCorpusRow(row, "has an empty speaker or turn");
  return { speaker, text };
}
export function parseWhen2SpeakLine(
  line: string,
  row: number,
): When2SpeakExample {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    // error-policy:J3 Corpus JSON is untrusted input; reject the row explicitly.
    throw invalidCorpusRow(row, "is not valid JSON", cause);
  }
  if (parsed === null || typeof parsed !== "object")
    throw invalidCorpusRow(row, "must be an object");
  const messages = (parsed as Record<string, unknown>).messages;
  if (
    !Array.isArray(messages) ||
    messages.length < 2 ||
    !messages.every(isCorpusMessage)
  )
    throw invalidCorpusRow(row, "must contain typed messages");
  const labelMessage = messages[messages.length - 1];
  if (labelMessage.role !== "assistant")
    throw invalidCorpusRow(row, "must end with an assistant label");
  const contextMessages = messages.slice(0, -1);
  if (contextMessages.some((message) => message.role !== "user"))
    throw invalidCorpusRow(
      row,
      "contains an assistant turn inside the context",
    );
  const turns = contextMessages.map((message) => ({
    ...parseSpeakerTurn(message.content, row),
    isAgent: false,
  }));
  return {
    row,
    turns,
    label: labelMessage.content.trim() === ">" ? "SILENT" : "SPEAK",
    directlyAddressesAgent: turns.some((turn) => turn.text.includes("[AGENT]")),
    speakerCount: new Set(turns.map((turn) => turn.speaker)).size,
  };
}

function isDiscordSeat(value: unknown): value is DiscordSeat {
  return value === "participant_a" || value === "participant_b";
}

/** Parses the pinned Discord converter's observational replay boundary. */
export function parseDiscordReplayLine(
  line: string,
  row: number,
): When2SpeakExample {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    // error-policy:J3 Discord replay JSON is untrusted input; reject explicitly.
    throw invalidCorpusRow(row, "is not valid Discord replay JSON", cause);
  }
  if (parsed === null || typeof parsed !== "object")
    throw invalidCorpusRow(row, "must be a Discord replay object");
  const record = parsed as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    !isDiscordSeat(record.targetSpeaker) ||
    (record.label !== "speak" && record.label !== "silent") ||
    !Array.isArray(record.turns) ||
    record.turns.length === 0
  ) {
    throw invalidCorpusRow(row, "has an invalid Discord replay envelope");
  }
  const targetSpeaker = record.targetSpeaker;
  const turns = record.turns.map((value) => {
    if (value === null || typeof value !== "object")
      throw invalidCorpusRow(row, "has a non-object Discord replay turn");
    const turn = value as Record<string, unknown>;
    if (!isDiscordSeat(turn.speaker) || typeof turn.text !== "string")
      throw invalidCorpusRow(row, "has an invalid Discord replay turn");
    if (!turn.text.trim())
      throw invalidCorpusRow(row, "has an empty Discord replay turn");
    return {
      speaker: turn.speaker,
      text: turn.text,
      isAgent: turn.speaker === targetSpeaker,
    };
  });
  if (turns[turns.length - 1].isAgent) {
    throw new ElizaError(
      `Timing row ${row} is ineligible because the Discord target seat authored the current turn`,
      {
        code: "TIMING_ROW_INELIGIBLE",
        context: { row, reason: "target-seat-authored-current-turn" },
      },
    );
  }
  return {
    row,
    turns,
    label: record.label === "speak" ? "SPEAK" : "SILENT",
    directlyAddressesAgent: false,
    speakerCount: new Set(turns.map((turn) => turn.speaker)).size,
  };
}
function emptyCounts(): TimingCounts {
  return {
    total: 0,
    correct: 0,
    trueSpeak: 0,
    falseSpeak: 0,
    trueSilent: 0,
    falseSilent: 0,
  };
}
function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
export function computeTimingMetrics(counts: TimingCounts): TimingMetrics {
  const speakPrecision = ratio(
    counts.trueSpeak,
    counts.trueSpeak + counts.falseSpeak,
  );
  const speakRecall = ratio(
    counts.trueSpeak,
    counts.trueSpeak + counts.falseSilent,
  );
  const silentPrecision = ratio(
    counts.trueSilent,
    counts.trueSilent + counts.falseSilent,
  );
  const silentRecall = ratio(
    counts.trueSilent,
    counts.trueSilent + counts.falseSpeak,
  );
  return {
    ...counts,
    accuracy: ratio(counts.correct, counts.total),
    speakPrecision,
    speakRecall,
    speakF1:
      speakPrecision === null ||
      speakRecall === null ||
      speakPrecision + speakRecall === 0
        ? null
        : (2 * speakPrecision * speakRecall) / (speakPrecision + speakRecall),
    silentPrecision,
    silentRecall,
    silentF1:
      silentPrecision === null ||
      silentRecall === null ||
      silentPrecision + silentRecall === 0
        ? null
        : (2 * silentPrecision * silentRecall) /
          (silentPrecision + silentRecall),
    falseInterventionRate: ratio(
      counts.falseSpeak,
      counts.falseSpeak + counts.trueSilent,
    ),
    missedInterventionRate: ratio(
      counts.falseSilent,
      counts.falseSilent + counts.trueSpeak,
    ),
  };
}
function recordPrediction(
  counts: TimingCounts,
  gold: TimingLabel,
  predicted: TimingLabel,
): void {
  counts.total += 1;
  if (gold === predicted) counts.correct += 1;
  if (gold === "SPEAK" && predicted === "SPEAK") counts.trueSpeak += 1;
  else if (gold === "SILENT" && predicted === "SPEAK") counts.falseSpeak += 1;
  else if (gold === "SILENT" && predicted === "SILENT") counts.trueSilent += 1;
  else counts.falseSilent += 1;
}
function stateForExample(
  runtime: IAgentRuntime,
  example: When2SpeakExample,
): { state: State; message: Memory } {
  const agentName = runtime.character.name ?? "ScenarioAgent";
  const roomId = stringToUuid(`when2speak-room-${example.row}`);
  const memories = example.turns.map(
    (turn, index): Memory => ({
      id: stringToUuid(`when2speak-${example.row}-turn-${index}`),
      entityId: turn.isAgent
        ? runtime.agentId
        : stringToUuid(`when2speak-${example.row}-${turn.speaker}`),
      agentId: runtime.agentId,
      roomId,
      createdAt: index + 1,
      content: {
        text: turn.text.replaceAll("[AGENT]", agentName),
        senderName: turn.isAgent ? agentName : turn.speaker,
        source: "when2speak-eval",
        channelType: ChannelType.GROUP,
      },
    }),
  );
  const message = memories[memories.length - 1];
  return {
    message,
    state: {
      values: { agentName },
      data: {
        providers: {
          RECENT_MESSAGES: { data: { recentMessages: memories.slice(0, -1) } },
        },
      },
      text: "",
    },
  };
}
export async function evaluateExample(
  runtime: IAgentRuntime,
  example: When2SpeakExample,
): Promise<TimingLabel> {
  const { state, message } = stateForExample(runtime, example);
  const outcome = await runV5MessageRuntimeStage1({
    runtime,
    message,
    state,
    responseId: stringToUuid(`when2speak-${example.row}-response`),
  });
  return outcome.kind === "terminal" ? "SILENT" : "SPEAK";
}
function sliceKey(turns: number): string {
  return turns <= 2 ? "1-2" : turns <= 5 ? "3-5" : "6+";
}
function bucket(map: Map<string, TimingCounts>, key: string): TimingCounts {
  const found = map.get(key);
  if (found) return found;
  const made = emptyCounts();
  map.set(key, made);
  return made;
}
function metricRecord(
  counts: Map<string, TimingCounts>,
): Record<string, TimingMetrics> {
  return Object.fromEntries(
    [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, computeTimingMetrics(value)]),
  );
}
export function summarizeTimingPredictions(
  predictions: readonly TimingPrediction[],
): Pick<TimingReport, "metrics" | "slices"> {
  const overall = emptyCounts();
  const address = new Map<string, TimingCounts>();
  const speakers = new Map<string, TimingCounts>();
  const contextTurns = new Map<string, TimingCounts>();
  for (const prediction of predictions) {
    recordPrediction(overall, prediction.gold, prediction.predicted);
    recordPrediction(
      bucket(address, prediction.directlyAddressesAgent ? "direct" : "ambient"),
      prediction.gold,
      prediction.predicted,
    );
    recordPrediction(
      bucket(speakers, String(prediction.speakerCount)),
      prediction.gold,
      prediction.predicted,
    );
    recordPrediction(
      bucket(contextTurns, sliceKey(prediction.contextTurns)),
      prediction.gold,
      prediction.predicted,
    );
  }
  return {
    metrics: computeTimingMetrics(overall),
    slices: {
      address: metricRecord(address),
      speakers: metricRecord(speakers),
      contextTurns: metricRecord(contextTurns),
    },
  };
}
export function isTimingRowSelected(options: {
  row: number;
  startRow: number;
  shardIndex: number;
  shardCount: number;
}): boolean {
  return (
    options.row >= options.startRow &&
    (options.row - 1) % options.shardCount === options.shardIndex
  );
}

function resumeError(
  message: string,
  context?: Record<string, unknown>,
): ElizaError {
  return new ElizaError(message, {
    code: "WHEN2SPEAK_INVALID_RESUME_REPORT",
    ...(context === undefined ? {} : { context }),
  });
}

function hasTimingRow(value: unknown): value is { row: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    "row" in value &&
    typeof value.row === "number" &&
    Number.isSafeInteger(value.row) &&
    value.row > 0
  );
}

function isResumePrediction(value: unknown): value is TimingPrediction {
  return (
    hasTimingRow(value) &&
    "gold" in value &&
    (value.gold === "SPEAK" || value.gold === "SILENT") &&
    "predicted" in value &&
    (value.predicted === "SPEAK" || value.predicted === "SILENT") &&
    "directlyAddressesAgent" in value &&
    typeof value.directlyAddressesAgent === "boolean" &&
    "speakerCount" in value &&
    Number.isSafeInteger(value.speakerCount) &&
    "contextTurns" in value &&
    Number.isSafeInteger(value.contextTurns)
  );
}

function isResumeExclusion(
  value: unknown,
): value is TimingReport["exclusions"][number] {
  return (
    hasTimingRow(value) && "reason" in value && typeof value.reason === "string"
  );
}

function isResumeFailure(
  value: unknown,
): value is TimingReport["failures"][number] {
  return (
    hasTimingRow(value) && "error" in value && typeof value.error === "string"
  );
}

export function validateTimingResumeRows(options: {
  rows: readonly number[];
  startRow: number;
  shardIndex: number;
  shardCount: number;
}): number {
  const coveredRows = [...options.rows].sort((left, right) => left - right);
  const lastCoveredRow = coveredRows.at(-1) ?? 0;
  const expectedRows = Array.from(
    { length: lastCoveredRow },
    (_, index) => index + 1,
  ).filter((row) => isTimingRowSelected({ row, ...options }));
  if (
    coveredRows.length !== new Set(coveredRows).size ||
    coveredRows.length !== expectedRows.length ||
    coveredRows.some((row, index) => row !== expectedRows[index])
  ) {
    throw resumeError(
      "Resume report rows are duplicate, gapped, or out of order",
      {
        coveredRows,
        expectedRows,
      },
    );
  }
  return lastCoveredRow;
}

function validateResumeReport(options: {
  value: unknown;
  input: string;
  inputSha256: string;
  dataset: TimingDataset;
  provider: string;
  requestedModel: string;
  backend: string;
  shardIndex: number;
  shardCount: number;
  startRow: number;
  limit?: number;
}): TimingReport | undefined {
  if (options.value === undefined) return undefined;
  const value = options.value;
  if (
    value === null ||
    typeof value !== "object" ||
    !("schema" in value) ||
    value.schema !== 2 ||
    !("status" in value) ||
    value.status !== "in-progress" ||
    !("dataset" in value) ||
    value.dataset !== options.dataset ||
    !("input" in value) ||
    path.resolve(String(value.input)) !== options.input ||
    !("inputSha256" in value) ||
    value.inputSha256 !== options.inputSha256 ||
    !("provider" in value) ||
    value.provider !== options.provider ||
    !("requestedModel" in value) ||
    value.requestedModel !== options.requestedModel ||
    !("backend" in value) ||
    value.backend !== options.backend ||
    !("selection" in value) ||
    value.selection === null ||
    typeof value.selection !== "object" ||
    !("shardIndex" in value.selection) ||
    value.selection.shardIndex !== options.shardIndex ||
    !("shardCount" in value.selection) ||
    value.selection.shardCount !== options.shardCount ||
    !("startRow" in value.selection) ||
    value.selection.startRow !== options.startRow ||
    !("limit" in value.selection) ||
    value.selection.limit !== (options.limit ?? null) ||
    !("startedAt" in value) ||
    typeof value.startedAt !== "string" ||
    !("predictions" in value) ||
    !Array.isArray(value.predictions) ||
    !value.predictions.every(isResumePrediction) ||
    !("exclusions" in value) ||
    !Array.isArray(value.exclusions) ||
    !value.exclusions.every(isResumeExclusion) ||
    !("failures" in value) ||
    !Array.isArray(value.failures) ||
    !value.failures.every(isResumeFailure)
  ) {
    throw resumeError(
      "Resume report does not match the requested evaluation cell",
    );
  }
  const report = value as TimingReport;
  validateTimingResumeRows({
    rows: [
      ...report.predictions.map(({ row }) => row),
      ...report.exclusions.map(({ row }) => row),
      ...report.failures.map(({ row }) => row),
    ],
    startRow: options.startRow,
    shardIndex: options.shardIndex,
    shardCount: options.shardCount,
  });
  return report;
}
export async function runWhen2SpeakEval(options: {
  input: string;
  trajectoryDir: string;
  provider?: LiveProviderName;
  inputFormat?: TimingInputFormat;
  limit?: number;
  shardIndex?: number;
  shardCount?: number;
  startRow?: number;
  checkpointEvery?: number;
  onCheckpoint?: (report: TimingReport) => void | Promise<void>;
  resumeReport?: unknown;
}): Promise<TimingReport> {
  const shardIndex = options.shardIndex ?? 0;
  const shardCount = options.shardCount ?? 1;
  const startRow = options.startRow ?? 1;
  const checkpointEvery = options.checkpointEvery;
  if (
    !Number.isSafeInteger(shardCount) ||
    shardCount <= 0 ||
    !Number.isSafeInteger(shardIndex) ||
    shardIndex < 0 ||
    shardIndex >= shardCount ||
    !Number.isSafeInteger(startRow) ||
    startRow <= 0 ||
    (options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit <= 0)) ||
    (checkpointEvery !== undefined &&
      (!Number.isSafeInteger(checkpointEvery) || checkpointEvery <= 0))
  ) {
    throw new ElizaError("Invalid When2Speak row selection", {
      code: "WHEN2SPEAK_INVALID_SELECTION",
      context: {
        shardIndex,
        shardCount,
        startRow,
        limit: options.limit,
        checkpointEvery,
      },
    });
  }
  const input = path.resolve(options.input);
  const inputSha256 = createHash("sha256")
    .update(fs.readFileSync(input))
    .digest("hex");
  let startedAt = new Date().toISOString();
  const previousTrajectoryDir = process.env.ELIZA_TRAJECTORY_DIR;
  const trajectoryDir = path.resolve(options.trajectoryDir);
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
  let runtimeResult: Awaited<ReturnType<typeof createScenarioRuntime>>;
  try {
    runtimeResult = await createScenarioRuntime({
      ...(options.provider ? { preferredProvider: options.provider } : {}),
    });
  } catch (error) {
    // error-policy:J2 Restore process state, then add evaluator context while
    // preserving the runtime-construction failure as the cause.
    if (previousTrajectoryDir === undefined) {
      delete process.env.ELIZA_TRAJECTORY_DIR;
    } else {
      process.env.ELIZA_TRAJECTORY_DIR = previousTrajectoryDir;
    }
    throw new ElizaError("Failed to create the When2Speak scenario runtime", {
      code: "WHEN2SPEAK_RUNTIME_CREATE_FAILED",
      cause: error,
      context: { provider: options.provider ?? "auto" },
    });
  }
  const predictions: TimingReport["predictions"] = [];
  const exclusions: TimingReport["exclusions"] = [];
  const failures: TimingReport["failures"] = [];
  const inputFormat = options.inputFormat ?? "when2speak";
  const dataset: TimingDataset =
    inputFormat === "when2speak"
      ? "duke-trust-lab/When2Speak"
      : "mookiezi/Discord-Dialogues";
  const requestedModel =
    "largeModel" in runtimeResult.providerConfig
      ? runtimeResult.providerConfig.largeModel
      : "deterministic";
  const backend =
    runtimeResult.providerConfig.env.ELIZA_CHAT_VIA_CLI ??
    runtimeResult.providerName;
  const resumeReport = validateResumeReport({
    value: options.resumeReport,
    input,
    inputSha256,
    dataset,
    provider: runtimeResult.providerName,
    requestedModel,
    backend,
    shardIndex,
    shardCount,
    startRow,
    limit: options.limit,
  });
  if (resumeReport) {
    startedAt = resumeReport.startedAt;
    predictions.push(...resumeReport.predictions);
    exclusions.push(...resumeReport.exclusions);
    failures.push(...resumeReport.failures);
  }
  const lastCoveredRow = Math.max(
    0,
    ...predictions.map(({ row }) => row),
    ...exclusions.map(({ row }) => row),
    ...failures.map(({ row }) => row),
  );
  const report = (status: TimingReport["status"]): TimingReport => {
    const summary = summarizeTimingPredictions(predictions);
    return {
      schema: 2,
      status,
      dataset,
      input,
      inputSha256,
      provider: runtimeResult.providerName,
      requestedModel,
      backend,
      trajectoryDir,
      selection: {
        shardIndex,
        shardCount,
        startRow,
        limit: options.limit ?? null,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
      ...summary,
      predictions: [...predictions],
      exclusions: [...exclusions],
      failures: [...failures],
    };
  };
  const checkpoint = async (): Promise<void> => {
    if (!options.onCheckpoint) return;
    await options.onCheckpoint(report("in-progress"));
  };
  try {
    const lines = readline.createInterface({
      input: fs.createReadStream(options.input),
      crlfDelay: Infinity,
    });
    let row = 0;
    for await (const line of lines) {
      row += 1;
      if (row <= lastCoveredRow) continue;
      if (!isTimingRowSelected({ row, startRow, shardIndex, shardCount }))
        continue;
      if (options.limit !== undefined && predictions.length >= options.limit)
        break;
      let example: When2SpeakExample;
      try {
        example =
          inputFormat === "when2speak"
            ? parseWhen2SpeakLine(line, row)
            : parseDiscordReplayLine(line, row);
      } catch (error) {
        // error-policy:J3 Malformed corpus rows become explicit rejected rows.
        if (
          error instanceof ElizaError &&
          error.code === "TIMING_ROW_INELIGIBLE"
        ) {
          exclusions.push({ row, reason: error.message });
        } else {
          failures.push({
            row,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (
          options.checkpointEvery !== undefined &&
          (predictions.length + exclusions.length + failures.length) %
            options.checkpointEvery ===
            0
        ) {
          await checkpoint();
        }
        continue;
      }
      // Model and Stage-1 failures abort the run. Retrying every remaining row
      // after a provider failure would turn one boundary error into thousands
      // of requests and a misleading all-fail benchmark.
      const predicted = await evaluateExample(runtimeResult.runtime, example);
      predictions.push({
        row: example.row,
        gold: example.label,
        predicted,
        directlyAddressesAgent: example.directlyAddressesAgent,
        speakerCount: example.speakerCount,
        contextTurns: example.turns.length,
      });
      if (
        options.checkpointEvery !== undefined &&
        (predictions.length + exclusions.length + failures.length) %
          options.checkpointEvery ===
          0
      ) {
        await checkpoint();
      }
    }
  } finally {
    await runtimeResult.cleanup();
    if (previousTrajectoryDir === undefined) {
      delete process.env.ELIZA_TRAJECTORY_DIR;
    } else {
      process.env.ELIZA_TRAJECTORY_DIR = previousTrajectoryDir;
    }
  }
  const finishedInputSha256 = createHash("sha256")
    .update(fs.readFileSync(input))
    .digest("hex");
  if (finishedInputSha256 !== inputSha256) {
    throw new ElizaError("When2Speak input changed during evaluation", {
      code: "WHEN2SPEAK_INPUT_CHANGED",
      context: { input, inputSha256, finishedInputSha256 },
    });
  }
  return report("complete");
}
