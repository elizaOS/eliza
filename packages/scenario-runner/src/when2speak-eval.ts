/**
 * Evaluates complete When2Speak dialogues through the production Stage-1
 * response handler. Malformed rows fail before inference; accepted dialogue
 * is never truncated or windowed.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  runV5MessageRuntimeStage1,
  type State,
  stringToUuid,
} from "@elizaos/core";
import type { LiveProviderName } from "@elizaos/core/testing";
import { createScenarioRuntime } from "./runtime-factory.ts";

export type TimingLabel = "SPEAK" | "SILENT";
export interface When2SpeakExample {
  row: number;
  turns: Array<{ speaker: string; text: string }>;
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
  falseInterventionRate: number | null;
  missedInterventionRate: number | null;
}
export interface TimingReport {
  schema: 1;
  dataset: "duke-trust-lab/When2Speak";
  input: string;
  provider: string;
  trajectoryDir: string;
  startedAt: string;
  finishedAt: string;
  metrics: TimingMetrics;
  slices: {
    address: Record<string, TimingMetrics>;
    speakers: Record<string, TimingMetrics>;
    contextTurns: Record<string, TimingMetrics>;
  };
  predictions: Array<{
    row: number;
    gold: TimingLabel;
    predicted: TimingLabel;
    directlyAddressesAgent: boolean;
    speakerCount: number;
    contextTurns: number;
  }>;
  failures: Array<{ row: number; error: string }>;
}

type CorpusMessage = { role: "user" | "assistant"; content: string };
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
    throw new Error(`When2Speak row ${row} has an unparseable speaker turn`);
  const speaker = content.slice(0, separator).trim();
  const text = content.slice(separator + 1).trim();
  if (!speaker || !text)
    throw new Error(`When2Speak row ${row} has an empty speaker or turn`);
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
    throw new Error(`When2Speak row ${row} is not valid JSON`, { cause });
  }
  if (parsed === null || typeof parsed !== "object")
    throw new Error(`When2Speak row ${row} must be an object`);
  const messages = (parsed as Record<string, unknown>).messages;
  if (
    !Array.isArray(messages) ||
    messages.length < 2 ||
    !messages.every(isCorpusMessage)
  )
    throw new Error(`When2Speak row ${row} must contain typed messages`);
  const labelMessage = messages[messages.length - 1];
  if (labelMessage.role !== "assistant")
    throw new Error(`When2Speak row ${row} must end with an assistant label`);
  const contextMessages = messages.slice(0, -1);
  if (contextMessages.some((message) => message.role !== "user"))
    throw new Error(
      `When2Speak row ${row} contains an assistant turn inside the context`,
    );
  const turns = contextMessages.map((message) =>
    parseSpeakerTurn(message.content, row),
  );
  return {
    row,
    turns,
    label: labelMessage.content.trim() === ">" ? "SILENT" : "SPEAK",
    directlyAddressesAgent: turns.some((turn) => turn.text.includes("[AGENT]")),
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
      entityId: stringToUuid(`when2speak-${example.row}-${turn.speaker}`),
      agentId: runtime.agentId,
      roomId,
      createdAt: index + 1,
      content: {
        text: turn.text.replaceAll("[AGENT]", agentName),
        senderName: turn.speaker,
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
export async function runWhen2SpeakEval(options: {
  input: string;
  trajectoryDir: string;
  provider?: LiveProviderName;
  limit?: number;
}): Promise<TimingReport> {
  const startedAt = new Date().toISOString();
  const previousTrajectoryDir = process.env.ELIZA_TRAJECTORY_DIR;
  const trajectoryDir = path.resolve(options.trajectoryDir);
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
  let runtimeResult: Awaited<ReturnType<typeof createScenarioRuntime>>;
  try {
    runtimeResult = await createScenarioRuntime({
      ...(options.provider ? { preferredProvider: options.provider } : {}),
    });
  } catch (error) {
    if (previousTrajectoryDir === undefined) {
      delete process.env.ELIZA_TRAJECTORY_DIR;
    } else {
      process.env.ELIZA_TRAJECTORY_DIR = previousTrajectoryDir;
    }
    throw error;
  }
  const overall = emptyCounts();
  const address = new Map<string, TimingCounts>();
  const speakers = new Map<string, TimingCounts>();
  const contextTurns = new Map<string, TimingCounts>();
  const predictions: TimingReport["predictions"] = [];
  const failures: TimingReport["failures"] = [];
  try {
    const lines = readline.createInterface({
      input: fs.createReadStream(options.input),
      crlfDelay: Infinity,
    });
    let row = 0;
    for await (const line of lines) {
      row += 1;
      if (!line.trim()) continue;
      if (options.limit !== undefined && overall.total >= options.limit) break;
      let example: When2SpeakExample;
      try {
        example = parseWhen2SpeakLine(line, row);
      } catch (error) {
        // error-policy:J3 Malformed corpus rows become explicit rejected rows.
        failures.push({
          row,
          error: error instanceof Error ? error.message : String(error),
        });
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
      recordPrediction(overall, example.label, predicted);
      recordPrediction(
        bucket(address, example.directlyAddressesAgent ? "direct" : "ambient"),
        example.label,
        predicted,
      );
      recordPrediction(
        bucket(speakers, String(example.speakerCount)),
        example.label,
        predicted,
      );
      recordPrediction(
        bucket(contextTurns, sliceKey(example.turns.length)),
        example.label,
        predicted,
      );
    }
  } finally {
    await runtimeResult.cleanup();
    if (previousTrajectoryDir === undefined) {
      delete process.env.ELIZA_TRAJECTORY_DIR;
    } else {
      process.env.ELIZA_TRAJECTORY_DIR = previousTrajectoryDir;
    }
  }
  return {
    schema: 1,
    dataset: "duke-trust-lab/When2Speak",
    input: path.resolve(options.input),
    provider: runtimeResult.providerName,
    trajectoryDir,
    startedAt,
    finishedAt: new Date().toISOString(),
    metrics: computeTimingMetrics(overall),
    slices: {
      address: metricRecord(address),
      speakers: metricRecord(speakers),
      contextTurns: metricRecord(contextTurns),
    },
    predictions,
    failures,
  };
}
