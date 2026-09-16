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
  type CharacterInput,
  classifyMessageAddress,
  ElizaError,
  type IAgentRuntime,
  type Memory,
  messageChallengesPriorAgentReply,
  runV5MessageRuntimeStage1,
  type State,
  stringToUuid,
} from "@elizaos/core";
import type { LiveProviderName } from "@elizaos/core/testing";
import { getDefaultStylePreset } from "@elizaos/shared";
import { createScenarioRuntime } from "./runtime-factory.ts";

export type TimingLabel = "SPEAK" | "SILENT";
export type TimingDataset =
  | "duke-trust-lab/When2Speak"
  | "mookiezi/Discord-Dialogues";
export type TimingInputFormat = "when2speak" | "discord-replay";
export type TimingCharacterPreset = "minimal" | "eliza";
export type TimingRuntimeProfile =
  | "classifier-isolated"
  | "production-composed";

export function resolveTimingCharacter(
  preset: TimingCharacterPreset,
): (CharacterInput & { name: string }) | undefined {
  if (preset === "minimal") return undefined;
  const eliza = getDefaultStylePreset("en");
  return {
    name: eliza.name,
    system: eliza.system,
    bio: eliza.bio,
    adjectives: eliza.adjectives,
    style: eliza.style,
    topics: eliza.topics,
    postExamples: eliza.postExamples,
    messageExamples: eliza.messageExamples.map((example) =>
      example.map((message) => ({
        name: message.user,
        content: message.content,
      })),
    ),
    ...(eliza.templates ? { templates: { ...eliza.templates } } : {}),
  };
}

export function timingCharacterSha256(preset: TimingCharacterPreset): string {
  const character = resolveTimingCharacter(preset) ?? { name: "ScenarioAgent" };
  return createHash("sha256").update(JSON.stringify(character)).digest("hex");
}
export interface When2SpeakExample {
  row: number;
  turns: Array<{ speaker: string; text: string; isAgent: boolean }>;
  label: TimingLabel;
  textuallyReferencesAgent: boolean;
  directlyAddressesAgent: boolean;
  speakerCount: number;
  dialogueId: string;
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
  balancedAccuracy: number | null;
  macroF1: number | null;
  matthewsCorrelation: number | null;
}
export interface TimingPrediction {
  row: number;
  gold: TimingLabel;
  predicted: TimingLabel;
  policyGold?: TimingLabel;
  textuallyReferencesAgent: boolean;
  directlyAddressesAgent: boolean;
  effectiveAddressed?: boolean;
  addressSignals?: {
    platformMention: boolean;
    replyToAgent: boolean;
    textualAgentName: boolean;
    priorAgentChallenge?: boolean;
  };
  speakerCount: number;
  contextTurns: number;
  dialogueId?: string;
  trajectoryId?: string;
  actualProvider?: string;
  promptPrefixHash?: string;
  parsedDecision?: "RESPOND" | "IGNORE" | "STOP";
  attempt?: number;
}
export interface TimingReport {
  schema: 4;
  status: "in-progress" | "complete";
  dataset: TimingDataset;
  input: string;
  inputSha256: string;
  provider: string;
  requestedModel: string;
  backend: string;
  characterPreset: TimingCharacterPreset;
  characterSha256: string;
  runtimeProfile: TimingRuntimeProfile;
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
  objectives: {
    labelAgreement: TimingMetrics;
    policyAlignedAgreement: TimingMetrics;
    dialogueClusterAgreement: {
      clusters: number;
      macroAccuracy: number | null;
      macroPolicyAccuracy: number | null;
    };
    ambientRestraint: {
      eligibleTurns: number;
      predictedResponses: number;
      predictedSilences: number;
      responseRate: number | null;
      restraintRate: number | null;
    };
  };
  slices: {
    address: Record<string, TimingMetrics>;
    textualReference: Record<string, TimingMetrics>;
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
function dialogueIdFor(
  turns: readonly { speaker: string; text: string }[],
): string {
  const first = turns[0];
  return createHash("sha256")
    .update(`${first?.speaker ?? ""}\0${first?.text ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

function directlyAddressesAgentPlaceholder(text: string): boolean {
  return (
    /^\s*(?:thanks?|thank you)\s*,?\s*\[AGENT\]/i.test(text) ||
    /^\s*(?:(?:hey|hi|hello|thanks?|thank you|please)\s*[,!:;-]?\s*)?\[AGENT\](?:\s*[,!:;?-]|\s*$)/i.test(
      text,
    ) ||
    /(?:^|,\s*)\[AGENT\](?:\s*[,!:;?]|\s*$)/i.test(text)
  );
}

/** Assigns stable inferred dialogue ids before sharding using adjacent turn overlap. */
export function inferTimingDialogueIds(
  lines: readonly string[],
  inputFormat: TimingInputFormat,
): Map<number, string> {
  const ids = new Map<number, string>();
  let cluster = 0;
  let previousTurns = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const row = index + 1;
    try {
      const example =
        inputFormat === "when2speak"
          ? parseWhen2SpeakLine(line, row)
          : parseDiscordReplayLine(line, row);
      const turns = new Set(
        example.turns.map((turn) => `${turn.speaker}\0${turn.text}`),
      );
      if (![...turns].some((turn) => previousTurns.has(turn))) cluster += 1;
      ids.set(row, `dialogue-${String(cluster).padStart(5, "0")}`);
      previousTurns = turns;
    } catch {
      // error-policy:J3 Invalid corpus rows break adjacency and remain rejected by the evaluation loop.
      previousTurns = new Set();
    }
  }
  return ids;
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
  if (!labelMessage.content.trim())
    throw invalidCorpusRow(row, "has an empty assistant decision label");
  const contextMessages = messages.slice(0, -1);
  if (contextMessages.some((message) => message.role !== "user"))
    throw invalidCorpusRow(
      row,
      "contains an assistant turn inside the context",
    );
  const turns = contextMessages.map((message) => {
    const turn = parseSpeakerTurn(message.content, row);
    return { ...turn, isAgent: turn.speaker === "Assistant" };
  });
  const currentTurn = turns[turns.length - 1];
  return {
    row,
    turns,
    label: labelMessage.content.trim() === ">" ? "SILENT" : "SPEAK",
    textuallyReferencesAgent: currentTurn.text.includes("[AGENT]"),
    directlyAddressesAgent: directlyAddressesAgentPlaceholder(currentTurn.text),
    speakerCount: new Set(turns.map((turn) => turn.speaker)).size,
    dialogueId: dialogueIdFor(turns),
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
    textuallyReferencesAgent: false,
    directlyAddressesAgent: false,
    speakerCount: new Set(turns.map((turn) => turn.speaker)).size,
    dialogueId: dialogueIdFor(turns),
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
  const speakF1 =
    speakPrecision === null ||
    speakRecall === null ||
    speakPrecision + speakRecall === 0
      ? null
      : (2 * speakPrecision * speakRecall) / (speakPrecision + speakRecall);
  const silentF1 =
    silentPrecision === null ||
    silentRecall === null ||
    silentPrecision + silentRecall === 0
      ? null
      : (2 * silentPrecision * silentRecall) / (silentPrecision + silentRecall);
  const mccDenominator = Math.sqrt(
    (counts.trueSpeak + counts.falseSpeak) *
      (counts.trueSpeak + counts.falseSilent) *
      (counts.trueSilent + counts.falseSpeak) *
      (counts.trueSilent + counts.falseSilent),
  );
  return {
    ...counts,
    accuracy: ratio(counts.correct, counts.total),
    speakPrecision,
    speakRecall,
    speakF1,
    silentPrecision,
    silentRecall,
    silentF1,
    falseInterventionRate: ratio(
      counts.falseSpeak,
      counts.falseSpeak + counts.trueSilent,
    ),
    missedInterventionRate: ratio(
      counts.falseSilent,
      counts.falseSilent + counts.trueSpeak,
    ),
    balancedAccuracy:
      speakRecall === null || silentRecall === null
        ? null
        : (speakRecall + silentRecall) / 2,
    macroF1:
      speakF1 === null || silentF1 === null ? null : (speakF1 + silentF1) / 2,
    matthewsCorrelation:
      mccDenominator === 0
        ? null
        : (counts.trueSpeak * counts.trueSilent -
            counts.falseSpeak * counts.falseSilent) /
          mccDenominator,
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
export function buildWhen2SpeakEvaluationState(
  runtime: IAgentRuntime,
  example: When2SpeakExample,
): { state: State; message: Memory; memories: Memory[] } {
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
    memories,
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
  runtimeProfile: TimingRuntimeProfile = "classifier-isolated",
): Promise<{
  predicted: TimingLabel;
  addressSignals: ReturnType<typeof classifyMessageAddress> & {
    priorAgentChallenge: boolean;
  };
  observation: {
    trajectoryId?: string;
    provider: string;
    prefixHash: string;
    decision: "RESPOND" | "IGNORE" | "STOP";
  };
}> {
  const built = buildWhen2SpeakEvaluationState(runtime, example);
  const { message } = built;
  let state = built.state;
  if (runtimeProfile === "production-composed") {
    for (const memory of built.memories) {
      await runtime.createMemory(memory, "messages");
    }
    state = await runtime.composeState(message, ["RECENT_MESSAGES"], true);
  }
  const structuralAddress = classifyMessageAddress(runtime, message);
  const priorAgentChallenge = messageChallengesPriorAgentReply(
    runtime,
    message,
    state,
  );
  const addressSignals = {
    ...structuralAddress,
    priorAgentChallenge,
    effective: structuralAddress.effective || priorAgentChallenge,
  };
  let observation:
    | {
        trajectoryId?: string;
        provider: string;
        prefixHash: string;
        decision: "RESPOND" | "IGNORE" | "STOP";
      }
    | undefined;
  const outcome = await runV5MessageRuntimeStage1({
    runtime,
    message,
    state,
    responseId: stringToUuid(`when2speak-${example.row}-response`),
    stage1DecisionOnly: true,
    onStage1Decision: (value) => {
      if (!value.provider) {
        throw new ElizaError(
          `Timing row ${example.row} did not expose its Stage-1 provider`,
          {
            code: "TIMING_STAGE1_PROVIDER_MISSING",
            context: { row: example.row },
          },
        );
      }
      observation = {
        ...(value.trajectoryId ? { trajectoryId: value.trajectoryId } : {}),
        provider: value.provider,
        prefixHash: value.prefixHash,
        decision: value.decision,
      };
    },
  });
  if (!observation) {
    throw new ElizaError(
      `Timing row ${example.row} produced no Stage-1 observation`,
      {
        code: "TIMING_STAGE1_OBSERVATION_MISSING",
        context: { row: example.row },
      },
    );
  }
  return {
    predicted:
      outcome.kind === "decision"
        ? outcome.action === "RESPOND"
          ? "SPEAK"
          : "SILENT"
        : outcome.kind === "terminal"
          ? "SILENT"
          : "SPEAK",
    addressSignals,
    observation,
  };
}

/** Applies the shipped group-response policy independently of corpus labels. */
export function classifyProductPolicyLabel(
  example: When2SpeakExample,
  effectiveAddressed: boolean,
): TimingLabel {
  const current = example.turns.at(-1)?.text.trim() ?? "";
  const prior = example.turns.at(-2);
  const stopRequest =
    effectiveAddressed &&
    /^(?:\s*(?:hey|hi|please)\s+)?(?:\[AGENT\]|eliza)[,!:;\s-]*(?:stop|pause|cancel|shut up|be quiet|don't respond|do not respond)\b/i.test(
      current,
    );
  const closer =
    /\b(thanks?|thank you|nice|great|got it|makes sense|helpful|appreciate(?:d| it)?)\b/i.test(
      current,
    ) &&
    !/[?]/.test(current) &&
    !/\b(but|however|why|how|what|when|where|who|which|could|can|would|should|do we|are we|is it)\b/i.test(
      current,
    );
  if (stopRequest || closer) return "SILENT";
  if (effectiveAddressed) return "SPEAK";
  const challengesPriorAgent =
    prior?.isAgent === true &&
    (/[?]/.test(current) ||
      /\b(counterintuitive|disagree|doubt|wrong|incorrect|confus(?:ed|ing)|clarify|actually|but i thought|i thought|are you sure|really|why)\b/i.test(
        current,
      ));
  if (challengesPriorAgent) return "SPEAK";
  const consequentialRisk =
    /\b(urgent|emergency|danger|dangerous|harm|unsafe|overdose|poison|fire|bleeding|suicid(?:e|al)|security breach)\b/i.test(
      current,
    );
  const standingResponsibility =
    /\b(eliza|\[AGENT\]|assistant)\b[^.!?]{0,48}\b(?:is responsible|owns this|on call|assigned|must handle|please monitor)\b/i.test(
      current,
    );
  return consequentialRisk || standingResponsibility ? "SPEAK" : "SILENT";
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
): Pick<TimingReport, "metrics" | "objectives" | "slices"> {
  const overall = emptyCounts();
  const policyAligned = emptyCounts();
  const address = new Map<string, TimingCounts>();
  const textualReference = new Map<string, TimingCounts>();
  const speakers = new Map<string, TimingCounts>();
  const contextTurns = new Map<string, TimingCounts>();
  const dialogueRaw = new Map<string, TimingCounts>();
  const dialoguePolicy = new Map<string, TimingCounts>();
  for (const prediction of predictions) {
    recordPrediction(overall, prediction.gold, prediction.predicted);
    recordPrediction(
      policyAligned,
      prediction.policyGold ?? prediction.gold,
      prediction.predicted,
    );
    const dialogueId = prediction.dialogueId ?? `row-${prediction.row}`;
    recordPrediction(
      bucket(dialogueRaw, dialogueId),
      prediction.gold,
      prediction.predicted,
    );
    recordPrediction(
      bucket(dialoguePolicy, dialogueId),
      prediction.policyGold ?? prediction.gold,
      prediction.predicted,
    );
    recordPrediction(
      bucket(
        address,
        (prediction.effectiveAddressed ?? prediction.directlyAddressesAgent)
          ? "effective"
          : "ambient",
      ),
      prediction.gold,
      prediction.predicted,
    );
    recordPrediction(
      bucket(
        textualReference,
        prediction.textuallyReferencesAgent ? "reference" : "none",
      ),
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
  const metrics = computeTimingMetrics(overall);
  const ambientPredictions = predictions.filter(
    (prediction) =>
      !(prediction.effectiveAddressed ?? prediction.directlyAddressesAgent),
  );
  const predictedResponses = ambientPredictions.filter(
    (prediction) => prediction.predicted === "SPEAK",
  ).length;
  const predictedSilences = ambientPredictions.length - predictedResponses;
  return {
    metrics,
    objectives: {
      labelAgreement: metrics,
      policyAlignedAgreement: computeTimingMetrics(policyAligned),
      dialogueClusterAgreement: {
        clusters: dialogueRaw.size,
        macroAccuracy: ratio(
          [...dialogueRaw.values()].reduce(
            (sum, counts) => sum + counts.correct / counts.total,
            0,
          ),
          dialogueRaw.size,
        ),
        macroPolicyAccuracy: ratio(
          [...dialoguePolicy.values()].reduce(
            (sum, counts) => sum + counts.correct / counts.total,
            0,
          ),
          dialoguePolicy.size,
        ),
      },
      ambientRestraint: {
        eligibleTurns: ambientPredictions.length,
        predictedResponses,
        predictedSilences,
        responseRate: ratio(predictedResponses, ambientPredictions.length),
        restraintRate: ratio(predictedSilences, ambientPredictions.length),
      },
    },
    slices: {
      address: metricRecord(address),
      textualReference: metricRecord(textualReference),
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
    "policyGold" in value &&
    (value.policyGold === "SPEAK" || value.policyGold === "SILENT") &&
    "textuallyReferencesAgent" in value &&
    typeof value.textuallyReferencesAgent === "boolean" &&
    "directlyAddressesAgent" in value &&
    typeof value.directlyAddressesAgent === "boolean" &&
    "effectiveAddressed" in value &&
    typeof value.effectiveAddressed === "boolean" &&
    "addressSignals" in value &&
    value.addressSignals !== null &&
    typeof value.addressSignals === "object" &&
    "platformMention" in value.addressSignals &&
    typeof value.addressSignals.platformMention === "boolean" &&
    "replyToAgent" in value.addressSignals &&
    typeof value.addressSignals.replyToAgent === "boolean" &&
    "textualAgentName" in value.addressSignals &&
    typeof value.addressSignals.textualAgentName === "boolean" &&
    "priorAgentChallenge" in value.addressSignals &&
    typeof value.addressSignals.priorAgentChallenge === "boolean" &&
    "speakerCount" in value &&
    Number.isSafeInteger(value.speakerCount) &&
    "contextTurns" in value &&
    Number.isSafeInteger(value.contextTurns) &&
    "dialogueId" in value &&
    typeof value.dialogueId === "string" &&
    value.dialogueId.length > 0 &&
    "trajectoryId" in value &&
    typeof value.trajectoryId === "string" &&
    value.trajectoryId.length > 0 &&
    "actualProvider" in value &&
    typeof value.actualProvider === "string" &&
    value.actualProvider.length > 0 &&
    "promptPrefixHash" in value &&
    typeof value.promptPrefixHash === "string" &&
    value.promptPrefixHash.length > 0 &&
    "parsedDecision" in value &&
    (value.parsedDecision === "RESPOND" ||
      value.parsedDecision === "IGNORE" ||
      value.parsedDecision === "STOP") &&
    "attempt" in value &&
    typeof value.attempt === "number" &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt > 0
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
  characterPreset: TimingCharacterPreset;
  characterSha256: string;
  runtimeProfile: TimingRuntimeProfile;
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
    value.schema !== 4 ||
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
    !("characterPreset" in value) ||
    value.characterPreset !== options.characterPreset ||
    !("characterSha256" in value) ||
    value.characterSha256 !== options.characterSha256 ||
    !("runtimeProfile" in value) ||
    value.runtimeProfile !== options.runtimeProfile ||
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
  characterPreset?: TimingCharacterPreset;
  runtimeProfile?: TimingRuntimeProfile;
  attempt?: number;
}): Promise<TimingReport> {
  const shardIndex = options.shardIndex ?? 0;
  const shardCount = options.shardCount ?? 1;
  const startRow = options.startRow ?? 1;
  const checkpointEvery = options.checkpointEvery;
  const runtimeProfile = options.runtimeProfile ?? "classifier-isolated";
  const attempt = options.attempt ?? 1;
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
      (!Number.isSafeInteger(checkpointEvery) || checkpointEvery <= 0)) ||
    !Number.isSafeInteger(attempt) ||
    attempt <= 0
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
  const inputBytes = fs.readFileSync(input);
  const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
  let startedAt = new Date().toISOString();
  const previousTrajectoryDir = process.env.ELIZA_TRAJECTORY_DIR;
  const trajectoryDir = path.resolve(options.trajectoryDir);
  process.env.ELIZA_TRAJECTORY_DIR = trajectoryDir;
  let runtimeResult: Awaited<ReturnType<typeof createScenarioRuntime>>;
  try {
    const characterPreset = options.characterPreset ?? "minimal";
    const timingCharacter = resolveTimingCharacter(characterPreset);
    runtimeResult = await createScenarioRuntime({
      ...(options.provider ? { preferredProvider: options.provider } : {}),
      ...(timingCharacter ? { character: timingCharacter } : {}),
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
      context: {
        provider: options.provider ?? "auto",
        characterPreset: options.characterPreset ?? "minimal",
      },
    });
  }
  const predictions: TimingReport["predictions"] = [];
  const exclusions: TimingReport["exclusions"] = [];
  const failures: TimingReport["failures"] = [];
  const inputFormat = options.inputFormat ?? "when2speak";
  const dialogueIds = inferTimingDialogueIds(
    inputBytes
      .toString("utf8")
      .split(/\r?\n/u)
      .filter(
        (line, index, lines) => index < lines.length - 1 || line.length > 0,
      ),
    inputFormat,
  );
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
  // Hash the requested personality, not the runtime-owned character object:
  // provider and plugin assembly may append model-specific runtime metadata.
  const characterSha256 = timingCharacterSha256(
    options.characterPreset ?? "minimal",
  );
  const resumeReport = validateResumeReport({
    value: options.resumeReport,
    input,
    inputSha256,
    dataset,
    provider: runtimeResult.providerName,
    requestedModel,
    backend,
    characterPreset: options.characterPreset ?? "minimal",
    characterSha256,
    runtimeProfile,
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
      schema: 4,
      status,
      dataset,
      input,
      inputSha256,
      provider: runtimeResult.providerName,
      requestedModel,
      backend,
      characterPreset: options.characterPreset ?? "minimal",
      characterSha256,
      runtimeProfile,
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
        example.dialogueId = dialogueIds.get(row) ?? example.dialogueId;
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
      const evaluation = await evaluateExample(
        runtimeResult.runtime,
        example,
        runtimeProfile,
      );
      if (
        runtimeResult.providerName === "cli" &&
        evaluation.observation.provider !== "cli-inference"
      ) {
        throw new ElizaError(
          `Timing row ${example.row} routed Stage 1 through an unexpected provider`,
          {
            code: "TIMING_STAGE1_PROVIDER_DRIFT",
            context: {
              row: example.row,
              requestedProvider: runtimeResult.providerName,
              requestedModel,
              actualProvider: evaluation.observation.provider,
            },
          },
        );
      }
      predictions.push({
        row: example.row,
        gold: example.label,
        predicted: evaluation.predicted,
        policyGold: classifyProductPolicyLabel(
          example,
          evaluation.addressSignals.effective,
        ),
        textuallyReferencesAgent: example.textuallyReferencesAgent,
        directlyAddressesAgent: example.directlyAddressesAgent,
        effectiveAddressed: evaluation.addressSignals.effective,
        addressSignals: {
          platformMention: evaluation.addressSignals.platformMention,
          replyToAgent: evaluation.addressSignals.replyToAgent,
          textualAgentName: evaluation.addressSignals.textualAgentName,
          priorAgentChallenge: evaluation.addressSignals.priorAgentChallenge,
        },
        speakerCount: example.speakerCount,
        contextTurns: example.turns.length,
        dialogueId: example.dialogueId,
        ...(evaluation.observation.trajectoryId
          ? { trajectoryId: evaluation.observation.trajectoryId }
          : {}),
        actualProvider: evaluation.observation.provider,
        promptPrefixHash: evaluation.observation.prefixHash,
        parsedDecision: evaluation.observation.decision,
        attempt,
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
