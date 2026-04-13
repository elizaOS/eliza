#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { InMemoryDatabaseAdapter } from "../../../../eliza/packages/typescript/src/database/inMemoryAdapter";
import { AgentRuntime } from "../../../../eliza/packages/typescript/src/runtime";
import type { Character } from "../../../../eliza/packages/typescript/src/types/agent";
import type { HandlerCallback } from "../../../../eliza/packages/typescript/src/types/components";
import { ModelType } from "../../../../eliza/packages/typescript/src/types/model";
import type { Plugin } from "../../../../eliza/packages/typescript/src/types/plugin";
import type { Content, UUID } from "../../../../eliza/packages/typescript/src/types/primitives";

type VoicebenchMode = {
  id: string;
  description: string;
  benchmarkContext: string;
};

type VoicebenchConfig = {
  benchmarkName: string;
  defaultIterations: number;
  responsePrompt: string;
  responseMaxChars?: number;
  modes: VoicebenchMode[];
};

type IterationResult = {
  mode: string;
  sampleId: string;
  sampleAudioPath: string;
  iteration: number;
  profile: string;
  expectedTranscript: string | null;
  transcriptionExactMatch: boolean | null;
  transcriptionNormalizedMatch: boolean | null;
  transcriptionMs: number;
  responseTtftMs: number;
  responseTotalMs: number;
  speechToResponseStartMs: number;
  speechToVoiceStartUncachedMs: number;
  speechToVoiceStartCachedMs: number;
  voiceGenerationMs: number;
  voiceFirstTokenUncachedMs: number;
  voiceFirstTokenCachedMs: number;
  ttsFirstSentenceCacheHit: boolean;
  ttsRemainderMs: number;
  ttsCachedPipelineMs: number;
  endToEndMs: number;
  inContext: {
    transcript: string;
    benchmarkContext: string;
    prompt: string;
  };
  outContext: {
    response: string;
    stateExcerpt: string;
    actions: string[];
    providers: string[];
    modelInput: string;
    modelOutputRaw: string;
    modelOutputClean: string;
    modelOutputHasThinkingTag: boolean;
    modelOutputHasXml: boolean;
    modelOutputThoughtTagCount: number;
    modelOutputXmlTagCount: number;
  };
  trajectory: {
    llmCallCount: number;
    providerAccessCount: number;
    llmCalls: Array<{ model: string; purpose: string; latencyMs: number }>;
    providerAccesses: Array<{ providerName: string; purpose: string }>;
  };
  ttsOutputBytes: number;
  ttsFirstSentenceUncachedBytes: number;
  ttsFirstSentenceCachedBytes: number;
  ttsRemainderBytes: number;
  ttsCachedPipelineBytes: number;
  responseCharCount: number;
  responseWasCapped: boolean;
  responseSegmentation: {
    firstSentence: string;
    remainder: string;
  };
};

type BenchmarkOutput = {
  benchmark: string;
  runtime: "typescript";
  profile: string;
  timestamp: string;
  iterations: number;
  datasetName: string;
  datasetPath: string | null;
  sampleCount: number;
  modes: VoicebenchMode[];
  results: IterationResult[];
  summary: Record<string, {
    runs: number;
    avgTranscriptionMs: number;
    avgResponseTtftMs: number;
    avgResponseTotalMs: number;
    avgSpeechToResponseStartMs: number;
    avgSpeechToVoiceStartUncachedMs: number;
    avgSpeechToVoiceStartCachedMs: number;
    avgVoiceGenerationMs: number;
    avgVoiceFirstTokenUncachedMs: number;
    avgVoiceFirstTokenCachedMs: number;
    avgTtsCachedPipelineMs: number;
    p95TranscriptionMs: number;
    p99TranscriptionMs: number;
    p95ResponseTtftMs: number;
    p99ResponseTtftMs: number;
    p95ResponseTotalMs: number;
    p99ResponseTotalMs: number;
    p95SpeechToResponseStartMs: number;
    p99SpeechToResponseStartMs: number;
    p95SpeechToVoiceStartUncachedMs: number;
    p99SpeechToVoiceStartUncachedMs: number;
    p95SpeechToVoiceStartCachedMs: number;
    p99SpeechToVoiceStartCachedMs: number;
    p95VoiceGenerationMs: number;
    p99VoiceGenerationMs: number;
    p95VoiceFirstTokenUncachedMs: number;
    p99VoiceFirstTokenUncachedMs: number;
    p95VoiceFirstTokenCachedMs: number;
    p99VoiceFirstTokenCachedMs: number;
    p95TtsCachedPipelineMs: number;
    p99TtsCachedPipelineMs: number;
    firstSentenceCacheHitRate: number;
    transcriptionNormalizedAccuracy: number;
    avgEndToEndMs: number;
    p95EndToEndMs: number;
    p99EndToEndMs: number;
  }>;
};

type DatasetSample = {
  id: string;
  audioPath: string;
  expectedText: string | null;
};

type TrajectoryStepLogs = {
  llmCalls: Array<{ model: string; purpose: string; latencyMs: number }>;
  providerAccesses: Array<{ providerName: string; purpose: string }>;
};

type TrajectoryLlmLog = {
  stepId: string;
  model: string;
  purpose: string;
  latencyMs: number;
  userPrompt?: string;
  response?: string;
};

type TrajectoryProviderLog = {
  stepId: string;
  providerName: string;
  purpose: string;
};

type TrajectoryLoggerServiceLike = {
  getLlmCallLogs?: () => readonly TrajectoryLlmLog[];
  getProviderAccessLogs?: () => readonly TrajectoryProviderLog[];
  getStep?: (step: string) => TrajectoryStepLogs;
};

type ModelOutputInspection = {
  cleaned: string;
  hasThinkingTag: boolean;
  hasXmlTag: boolean;
  thoughtTagCount: number;
  xmlTagCount: number;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const VOICEBENCH_DIR = resolve(__dirname, "../..");
const SHARED_DIR = resolve(VOICEBENCH_DIR, "shared");

const AGENT_ID = "00000000-0000-0000-0000-000000000101" as UUID;
const USER_ENTITY_ID = "00000000-0000-0000-0000-000000000102" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000103" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000104" as UUID;

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function truncate(text: string, max = 280): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCacheKeyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

function enforceResponseBudget(text: string, maxChars: number): {
  text: string;
  wasCapped: boolean;
} {
  const compact = text.replace(/\s+/g, " ").trim();
  if (maxChars <= 0 || compact.length <= maxChars) {
    return { text: compact, wasCapped: false };
  }

  const head = compact.slice(0, maxChars).trim();
  const breakpoint = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf(", "),
    head.lastIndexOf("; "),
    head.lastIndexOf(": "),
    head.lastIndexOf(" "),
  );
  const minBreakpoint = Math.floor(maxChars * 0.6);
  let bounded = (breakpoint >= minBreakpoint ? head.slice(0, breakpoint) : head).trim();
  if (!/[.!?]$/.test(bounded)) {
    bounded = `${bounded}.`;
  }
  return { text: bounded, wasCapped: true };
}

function splitFirstSentence(text: string): { firstSentence: string; remainder: string } {
  const stripped = text.trim();
  if (!stripped) {
    return { firstSentence: "", remainder: "" };
  }
  const match = stripped.match(/[.!?](?:["')\]]+)?\s/);
  if (!match || typeof match.index !== "number") {
    return { firstSentence: stripped, remainder: "" };
  }
  const end = match.index + match[0].length;
  const firstSentence = stripped.slice(0, end).trim();
  const remainder = stripped.slice(end).trim();
  return { firstSentence: firstSentence || stripped, remainder };
}

function inspectModelOutput(raw: string): ModelOutputInspection {
  const thoughtBlockPattern =
    /<\s*(?:think|thinking|thought)\b[^>]*>[\s\S]*?<\s*\/\s*(?:think|thinking|thought)\s*>/gi;
  const xmlTagPattern = /<\/?[^>\n]+>/g;
  const thoughtTagPattern = /<\s*\/?\s*(?:think|thinking|thought)\b[^>]*>/gi;

  const thoughtTagMatches = raw.match(thoughtTagPattern) ?? [];
  const xmlTagMatches = raw.match(xmlTagPattern) ?? [];
  const withoutThoughtBlocks = raw.replace(thoughtBlockPattern, " ");
  const withoutXml = withoutThoughtBlocks.replace(xmlTagPattern, " ");
  const cleaned = withoutXml.replace(/\s+/g, " ").trim();

  return {
    cleaned,
    hasThinkingTag: thoughtTagMatches.length > 0,
    hasXmlTag: xmlTagMatches.length > 0,
    thoughtTagCount: thoughtTagMatches.length,
    xmlTagCount: xmlTagMatches.length,
  };
}

function resolveAudioBytesLength(output: unknown): number {
  if (output instanceof Uint8Array) return output.byteLength;
  if (output instanceof ArrayBuffer) return output.byteLength;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(output)) return output.length;
  if (typeof output === "string") return output.length;
  if (output && typeof output === "object" && "byteLength" in output) {
    const maybeLength = (output as { byteLength?: unknown }).byteLength;
    if (typeof maybeLength === "number") return maybeLength;
  }
  return 0;
}

function coerceAudioBytes(output: unknown): Uint8Array {
  if (output instanceof Uint8Array) return output;
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(output)) return new Uint8Array(output);
  if (typeof output === "string") {
    const raw = output.startsWith("data:") && output.includes(",") ? output.split(",", 2)[1] : output;
    try {
      if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(raw, "base64"));
      }
    } catch {
      // Fall through to plain text bytes.
    }
    return new TextEncoder().encode(output);
  }
  return new Uint8Array();
}

function loadDatasetSamples(datasetPath: string): { datasetName: string; samples: DatasetSample[] } {
  const datasetRaw = JSON.parse(readFileSync(datasetPath, "utf-8")) as {
    datasetName?: string;
    name?: string;
    samples?: Array<Record<string, unknown>>;
  };
  const datasetName = String(datasetRaw.datasetName ?? datasetRaw.name ?? "voicebench-dataset");
  const parent = dirname(datasetPath);
  const rawSamples = Array.isArray(datasetRaw.samples) ? datasetRaw.samples : [];
  if (rawSamples.length === 0) {
    throw new Error(`Dataset has no samples: ${datasetPath}`);
  }
  const samples: DatasetSample[] = rawSamples.map((sample, idx) => {
    const id = String(sample.id ?? `sample-${idx + 1}`);
    const audioPathValue = sample.audioPath ?? sample.audio_path;
    if (typeof audioPathValue !== "string" || audioPathValue.length === 0) {
      throw new Error(`Dataset sample ${id} missing audioPath`);
    }
    const expectedTextValue = sample.text ?? sample.expectedText ?? sample.label;
    return {
      id,
      audioPath: audioPathValue.startsWith("/") ? audioPathValue : resolve(parent, audioPathValue),
      expectedText: typeof expectedTextValue === "string" ? expectedTextValue : null,
    };
  });
  return { datasetName, samples };
}

async function seedRuntimeGraph(adapter: InMemoryDatabaseAdapter): Promise<void> {
  await adapter.createWorld({
    id: WORLD_ID,
    name: "VoicebenchWorld",
    agentId: AGENT_ID,
    messageServerId: "voicebench",
  });

  await adapter.createRoom({
    id: ROOM_ID,
    name: "VoicebenchRoom",
    agentId: AGENT_ID,
    source: "voicebench",
    type: "GROUP",
    worldId: WORLD_ID,
  } as Parameters<typeof adapter.createRoom>[0]);

  await adapter.createEntities([
    {
      id: AGENT_ID,
      names: ["VoicebenchAgent"],
      agentId: AGENT_ID,
    } as Parameters<typeof adapter.createEntities>[0][number],
    {
      id: USER_ENTITY_ID,
      names: ["VoicebenchUser"],
      agentId: AGENT_ID,
    } as Parameters<typeof adapter.createEntities>[0][number],
  ]);

  await adapter.addParticipantsRoom([USER_ENTITY_ID, AGENT_ID], ROOM_ID);
}

async function resolvePlugins(profile: string): Promise<Plugin[]> {
  const groqModule = await import("../../../../plugins/plugin-groq/typescript/index.ts");
  const groq =
    (groqModule as { groqPlugin?: Plugin }).groqPlugin ??
    (groqModule as { default?: Plugin }).default;

  if (!groq) {
    throw new Error("Failed to load Groq TypeScript plugin");
  }

  if (profile !== "elevenlabs") {
    return [groq];
  }

  const elevenLabsModule = await import(
    "../../../../plugins/plugin-elevenlabs/typescript/src/index.ts"
  );
  const elevenLabs =
    (elevenLabsModule as { elevenLabsPlugin?: Plugin }).elevenLabsPlugin ??
    (elevenLabsModule as { default?: Plugin }).default;
  if (!elevenLabs) {
    throw new Error("Failed to load ElevenLabs TypeScript plugin");
  }

  return [groq, elevenLabs];
}

async function createRuntime(profile: string, character: Character): Promise<AgentRuntime> {
  const adapter = new InMemoryDatabaseAdapter();
  const plugins = await resolvePlugins(profile);
  const runtimeSettings: Record<string, string> = {
    ...(character.settings as Record<string, string> | undefined),
    ALLOW_NO_DATABASE: "true",
    USE_MULTI_STEP: "false",
    CHECK_SHOULD_RESPOND: "false",
    VALIDATION_LEVEL: "trusted",
  };
  const passthroughEnvKeys = [
    "GROQ_API_KEY",
    "GROQ_BASE_URL",
    "GROQ_SMALL_MODEL",
    "GROQ_LARGE_MODEL",
    "GROQ_TRANSCRIPTION_MODEL",
    "GROQ_TTS_MODEL",
    "GROQ_TTS_VOICE",
    "GROQ_TTS_RESPONSE_FORMAT",
    "ELEVENLABS_API_KEY",
    "ELEVENLABS_BASE_URL",
    "ELEVENLABS_VOICE_ID",
    "ELEVENLABS_MODEL_ID",
    "ELEVENLABS_OPTIMIZE_STREAMING_LATENCY",
    "ELEVENLABS_OUTPUT_FORMAT",
    "ELEVENLABS_VOICE_STABILITY",
    "ELEVENLABS_VOICE_SIMILARITY_BOOST",
    "ELEVENLABS_VOICE_STYLE",
    "ELEVENLABS_VOICE_USE_SPEAKER_BOOST",
    "ELEVENLABS_STT_MODEL_ID",
    "ELEVENLABS_STT_LANGUAGE_CODE",
    "ELEVENLABS_STT_TIMESTAMPS_GRANULARITY",
    "ELEVENLABS_STT_DIARIZE",
    "ELEVENLABS_STT_NUM_SPEAKERS",
    "ELEVENLABS_STT_TAG_AUDIO_EVENTS",
  ] as const;
  for (const key of passthroughEnvKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      runtimeSettings[key] = value;
    }
  }

  const runtime = new AgentRuntime({
    agentId: AGENT_ID,
    character: {
      ...character,
      settings: runtimeSettings,
    },
    plugins,
    adapter,
    checkShouldRespond: false,
    logLevel: "fatal",
    disableBasicCapabilities: false,
  });

  await runtime.initialize();
  await seedRuntimeGraph(adapter);

  return runtime;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

async function main(): Promise<void> {
  const profile = parseArg("profile") ?? "groq";
  const audioPath = parseArg("audio");
  const datasetPath = parseArg("dataset");
  const output = parseArg("output");
  const timestamp = parseArg("timestamp") ?? `${Date.now()}`;

  if (!audioPath) {
    throw new Error("--audio is required");
  }
  if (!output) {
    throw new Error("--output is required");
  }

  const iterationsArg = parseArg("iterations");
  const config = JSON.parse(
    readFileSync(resolve(SHARED_DIR, "config.json"), "utf-8"),
  ) as VoicebenchConfig;
  const character = JSON.parse(
    readFileSync(resolve(SHARED_DIR, "character.json"), "utf-8"),
  ) as Character;

  const iterations = iterationsArg ? Number.parseInt(iterationsArg, 10) : config.defaultIterations;
  if (!Number.isFinite(iterations) || iterations <= 0) {
    throw new Error(`Invalid iterations: ${iterationsArg}`);
  }
  const responseMaxChars = Number(config.responseMaxChars ?? 140);
  if (!Number.isFinite(responseMaxChars) || responseMaxChars <= 0) {
    throw new Error(`Invalid responseMaxChars: ${config.responseMaxChars}`);
  }

  const dataset = datasetPath ? loadDatasetSamples(datasetPath) : null;
  const datasetName = dataset ? dataset.datasetName : "single-audio";
  const samples: DatasetSample[] = dataset
    ? dataset.samples
    : [{ id: "single-audio", audioPath, expectedText: null }];

  const sttProvider = profile === "elevenlabs" ? "elevenLabs" : "groq";
  const ttsProvider = profile === "elevenlabs" ? "elevenLabs" : "groq";

  const results: IterationResult[] = [];
  const firstSentenceCache = new Map<string, Uint8Array>();
  let messageSequence = 0;

  const runtime = await createRuntime(profile, character);
  try {
    const trajectoryService = runtime.getService("trajectory_logger") as
      | TrajectoryLoggerServiceLike
      | null;
    for (const mode of config.modes) {
      for (const sample of samples) {
        const sampleAudioBytes = readFileSync(sample.audioPath);
        for (let iteration = 1; iteration <= iterations; iteration++) {
          messageSequence += 1;
          const messageIdSuffix = String(messageSequence).padStart(12, "0");
          const stepId = `voicebench-ts-${timestamp}-${mode.id}-${sample.id}-${iteration}`;

          const startedAt = nowMs();

          const transcriptionStart = nowMs();
          const transcription = await runtime.useModel<string>(
            ModelType.TRANSCRIPTION,
            sampleAudioBytes,
            sttProvider,
          );
          const transcriptionMs = nowMs() - transcriptionStart;

          const transcriptText = String(transcription || "").trim();
          const expectedTranscript = sample.expectedText;
          const transcriptionExactMatch =
            typeof expectedTranscript === "string" ? transcriptText === expectedTranscript : null;
          const transcriptionNormalizedMatch =
            typeof expectedTranscript === "string"
              ? normalizeText(transcriptText) === normalizeText(expectedTranscript)
              : null;

          const userPrompt = `${transcriptText}\n\n${config.responsePrompt}`;
          const message = {
            id: `00000000-0000-0000-2100-${messageIdSuffix}` as UUID,
            agentId: AGENT_ID,
            entityId: USER_ENTITY_ID,
            roomId: ROOM_ID,
            createdAt: Date.now(),
            content: {
              text: userPrompt,
              source: "voicebench",
              channelType: "VOICE_DM",
            },
            metadata: {
              trajectoryStepId: stepId,
              benchmarkContext: mode.benchmarkContext,
              entityName: "VoicebenchUser",
            },
          };

          let firstResponseAt: number | null = null;
          let callbackText = "";

          const callback: HandlerCallback = async (content: Content) => {
            if (firstResponseAt === null) {
              firstResponseAt = nowMs();
            }
            if (content.text) {
              callbackText = content.text;
            }
            return [];
          };

          const responseStart = nowMs();
          const responseResult = await runtime.messageService.handleMessage(runtime, message, callback);
          const responseEnd = nowMs();

          const responseTotalMs = responseEnd - responseStart;
          const responseTtftMs = (firstResponseAt ?? responseEnd) - responseStart;
          const speechToResponseStartMs = transcriptionMs + responseTtftMs;
          const rawResponseText =
            callbackText || responseResult.responseContent?.text || "Voicebench fallback response.";
          const boundedResponse = enforceResponseBudget(rawResponseText, responseMaxChars);
          const responseText = boundedResponse.text || "Voicebench fallback response.";

          const segmented = splitFirstSentence(responseText);
          const firstSentence = segmented.firstSentence || responseText;
          const remainder = segmented.remainder;
          const firstSentenceKey = `${profile}|${ttsProvider}|${normalizeCacheKeyText(firstSentence)}`;

          const uncachedFirstSentenceStart = nowMs();
          const uncachedFirstSentenceOutput = await runtime.useModel(
            ModelType.TEXT_TO_SPEECH,
            { text: firstSentence },
            ttsProvider,
          );
          const uncachedFirstSentenceMs = nowMs() - uncachedFirstSentenceStart;
          const speechToVoiceStartUncachedMs =
            transcriptionMs + responseTotalMs + uncachedFirstSentenceMs;
          const uncachedFirstSentenceBytes = resolveAudioBytesLength(uncachedFirstSentenceOutput);

          const cachedPipelineStart = nowMs();
          const cachedHit = firstSentenceCache.has(firstSentenceKey);
          const remainderStartedAt = remainder ? nowMs() : 0;
          const remainderPromise = remainder
            ? runtime.useModel(
                ModelType.TEXT_TO_SPEECH,
                { text: remainder },
                ttsProvider,
              )
            : null;

          let cachedFirstSentenceBytes = 0;
          let cachedFirstSentenceMs = 0;
          if (cachedHit) {
            cachedFirstSentenceBytes = firstSentenceCache.get(firstSentenceKey)?.byteLength ?? 0;
            cachedFirstSentenceMs = nowMs() - cachedPipelineStart;
          } else {
            const cachedFirstSentenceStart = nowMs();
            const cachedFirstSentenceOutput = await runtime.useModel(
              ModelType.TEXT_TO_SPEECH,
              { text: firstSentence },
              ttsProvider,
            );
            const bytes = coerceAudioBytes(cachedFirstSentenceOutput);
            firstSentenceCache.set(firstSentenceKey, bytes);
            cachedFirstSentenceBytes = bytes.byteLength;
            cachedFirstSentenceMs = nowMs() - cachedFirstSentenceStart;
          }
          const speechToVoiceStartCachedMs =
            transcriptionMs + responseTotalMs + cachedFirstSentenceMs;

          let ttsRemainderMs = 0;
          let ttsRemainderBytes = 0;
          if (remainderPromise) {
            const remainderOutput = await remainderPromise;
            ttsRemainderMs = nowMs() - remainderStartedAt;
            ttsRemainderBytes = resolveAudioBytesLength(remainderOutput);
          }
          const ttsCachedPipelineMs = nowMs() - cachedPipelineStart;
          const ttsCachedPipelineBytes = cachedFirstSentenceBytes + ttsRemainderBytes;

          const ttsStart = nowMs();
          const ttsOutput = await runtime.useModel(
            ModelType.TEXT_TO_SPEECH,
            { text: responseText },
            ttsProvider,
          );
          const voiceGenerationMs = nowMs() - ttsStart;

          const endToEndMs = nowMs() - startedAt;

          const allLlmLogs = trajectoryService?.getLlmCallLogs?.() ?? [];
          const allProviderLogs = trajectoryService?.getProviderAccessLogs?.() ?? [];
          const llmLogs = allLlmLogs.filter((entry) => entry.stepId === stepId);
          const providerLogs = allProviderLogs.filter((entry) => entry.stepId === stepId);

          let trajectory: TrajectoryStepLogs = {
            llmCalls: llmLogs.map((entry) => ({
              model: entry.model,
              purpose: entry.purpose,
              latencyMs: entry.latencyMs ?? 0,
            })),
            providerAccesses: providerLogs.map((entry) => ({
              providerName: entry.providerName,
              purpose: entry.purpose,
            })),
          };
          if (trajectory.llmCalls.length === 0 && trajectory.providerAccesses.length === 0) {
            const getStep = trajectoryService?.getStep;
            if (typeof getStep === "function") {
              trajectory = getStep.call(trajectoryService, stepId);
            }
          }

          const primaryLlmLog = llmLogs[0];
          const modelInputRaw = primaryLlmLog?.userPrompt ?? "";
          const modelOutputRaw = primaryLlmLog?.response ?? rawResponseText;
          const modelOutputInspection = inspectModelOutput(modelOutputRaw);

          const record: IterationResult = {
            mode: mode.id,
            sampleId: sample.id,
            sampleAudioPath: sample.audioPath,
            iteration,
            profile,
            expectedTranscript,
            transcriptionExactMatch,
            transcriptionNormalizedMatch,
            transcriptionMs: round(transcriptionMs),
            responseTtftMs: round(responseTtftMs),
            responseTotalMs: round(responseTotalMs),
            speechToResponseStartMs: round(speechToResponseStartMs),
            speechToVoiceStartUncachedMs: round(speechToVoiceStartUncachedMs),
            speechToVoiceStartCachedMs: round(speechToVoiceStartCachedMs),
            voiceGenerationMs: round(voiceGenerationMs),
            voiceFirstTokenUncachedMs: round(uncachedFirstSentenceMs),
            voiceFirstTokenCachedMs: round(cachedFirstSentenceMs),
            ttsFirstSentenceCacheHit: cachedHit,
            ttsRemainderMs: round(ttsRemainderMs),
            ttsCachedPipelineMs: round(ttsCachedPipelineMs),
            endToEndMs: round(endToEndMs),
            inContext: {
              transcript: truncate(transcriptText),
              benchmarkContext: truncate(mode.benchmarkContext || ""),
              prompt: truncate(userPrompt),
            },
            outContext: {
              response: truncate(responseText),
              stateExcerpt: truncate(responseResult.state?.text || ""),
              actions: responseResult.responseContent?.actions ?? [],
              providers: responseResult.responseContent?.providers ?? [],
              modelInput: truncate(modelInputRaw, 900),
              modelOutputRaw: truncate(modelOutputRaw, 900),
              modelOutputClean: truncate(modelOutputInspection.cleaned, 900),
              modelOutputHasThinkingTag: modelOutputInspection.hasThinkingTag,
              modelOutputHasXml: modelOutputInspection.hasXmlTag,
              modelOutputThoughtTagCount: modelOutputInspection.thoughtTagCount,
              modelOutputXmlTagCount: modelOutputInspection.xmlTagCount,
            },
            trajectory: {
              llmCallCount: trajectory.llmCalls.length,
              providerAccessCount: trajectory.providerAccesses.length,
              llmCalls: trajectory.llmCalls,
              providerAccesses: trajectory.providerAccesses,
            },
            ttsOutputBytes: resolveAudioBytesLength(ttsOutput),
            ttsFirstSentenceUncachedBytes: uncachedFirstSentenceBytes,
            ttsFirstSentenceCachedBytes: cachedFirstSentenceBytes,
            ttsRemainderBytes,
            ttsCachedPipelineBytes,
            responseCharCount: responseText.length,
            responseWasCapped: boundedResponse.wasCapped,
            responseSegmentation: {
              firstSentence: truncate(firstSentence),
              remainder: truncate(remainder),
            },
          };

          results.push(record);

          console.log(
            `[voicebench][typescript] mode=${mode.id} sample=${sample.id} iter=${iteration}/${iterations} ` +
              `transcription=${record.transcriptionMs}ms ttft=${record.responseTtftMs}ms ` +
              `response=${record.responseTotalMs}ms tts=${record.voiceGenerationMs}ms ` +
              `voice-ttft-uncached=${record.voiceFirstTokenUncachedMs}ms ` +
              `voice-ttft-cached=${record.voiceFirstTokenCachedMs}ms cache-hit=${record.ttsFirstSentenceCacheHit} ` +
              `e2e=${record.endToEndMs}ms`,
          );
          console.log(`[voicebench][typescript] in-context: ${record.inContext.prompt}`);
          console.log(`[voicebench][typescript] out-context: ${record.outContext.response}`);
        }
      }
    }
  } finally {
    await runtime.stop();
  }

  const summary: BenchmarkOutput["summary"] = {};
  for (const mode of config.modes) {
    const rows = results.filter((entry) => entry.mode === mode.id);
    const scoredRows = rows.filter(
      (entry) => typeof entry.transcriptionNormalizedMatch === "boolean",
    );
    summary[mode.id] = {
      runs: rows.length,
      avgTranscriptionMs: round(average(rows.map((entry) => entry.transcriptionMs))),
      avgResponseTtftMs: round(average(rows.map((entry) => entry.responseTtftMs))),
      avgResponseTotalMs: round(average(rows.map((entry) => entry.responseTotalMs))),
      avgSpeechToResponseStartMs: round(
        average(rows.map((entry) => entry.speechToResponseStartMs)),
      ),
      avgSpeechToVoiceStartUncachedMs: round(
        average(rows.map((entry) => entry.speechToVoiceStartUncachedMs)),
      ),
      avgSpeechToVoiceStartCachedMs: round(
        average(rows.map((entry) => entry.speechToVoiceStartCachedMs)),
      ),
      avgVoiceGenerationMs: round(average(rows.map((entry) => entry.voiceGenerationMs))),
      avgVoiceFirstTokenUncachedMs: round(
        average(rows.map((entry) => entry.voiceFirstTokenUncachedMs)),
      ),
      avgVoiceFirstTokenCachedMs: round(
        average(rows.map((entry) => entry.voiceFirstTokenCachedMs)),
      ),
      avgTtsCachedPipelineMs: round(average(rows.map((entry) => entry.ttsCachedPipelineMs))),
      p95TranscriptionMs: round(percentile(rows.map((entry) => entry.transcriptionMs), 95)),
      p99TranscriptionMs: round(percentile(rows.map((entry) => entry.transcriptionMs), 99)),
      p95ResponseTtftMs: round(percentile(rows.map((entry) => entry.responseTtftMs), 95)),
      p99ResponseTtftMs: round(percentile(rows.map((entry) => entry.responseTtftMs), 99)),
      p95ResponseTotalMs: round(percentile(rows.map((entry) => entry.responseTotalMs), 95)),
      p99ResponseTotalMs: round(percentile(rows.map((entry) => entry.responseTotalMs), 99)),
      p95SpeechToResponseStartMs: round(
        percentile(rows.map((entry) => entry.speechToResponseStartMs), 95),
      ),
      p99SpeechToResponseStartMs: round(
        percentile(rows.map((entry) => entry.speechToResponseStartMs), 99),
      ),
      p95SpeechToVoiceStartUncachedMs: round(
        percentile(rows.map((entry) => entry.speechToVoiceStartUncachedMs), 95),
      ),
      p99SpeechToVoiceStartUncachedMs: round(
        percentile(rows.map((entry) => entry.speechToVoiceStartUncachedMs), 99),
      ),
      p95SpeechToVoiceStartCachedMs: round(
        percentile(rows.map((entry) => entry.speechToVoiceStartCachedMs), 95),
      ),
      p99SpeechToVoiceStartCachedMs: round(
        percentile(rows.map((entry) => entry.speechToVoiceStartCachedMs), 99),
      ),
      p95VoiceGenerationMs: round(percentile(rows.map((entry) => entry.voiceGenerationMs), 95)),
      p99VoiceGenerationMs: round(percentile(rows.map((entry) => entry.voiceGenerationMs), 99)),
      p95VoiceFirstTokenUncachedMs: round(
        percentile(rows.map((entry) => entry.voiceFirstTokenUncachedMs), 95),
      ),
      p99VoiceFirstTokenUncachedMs: round(
        percentile(rows.map((entry) => entry.voiceFirstTokenUncachedMs), 99),
      ),
      p95VoiceFirstTokenCachedMs: round(
        percentile(rows.map((entry) => entry.voiceFirstTokenCachedMs), 95),
      ),
      p99VoiceFirstTokenCachedMs: round(
        percentile(rows.map((entry) => entry.voiceFirstTokenCachedMs), 99),
      ),
      p95TtsCachedPipelineMs: round(
        percentile(rows.map((entry) => entry.ttsCachedPipelineMs), 95),
      ),
      p99TtsCachedPipelineMs: round(
        percentile(rows.map((entry) => entry.ttsCachedPipelineMs), 99),
      ),
      firstSentenceCacheHitRate: round(
        average(rows.map((entry) => (entry.ttsFirstSentenceCacheHit ? 1 : 0))),
      ),
      transcriptionNormalizedAccuracy: round(
        average(
          scoredRows.map((entry) => (entry.transcriptionNormalizedMatch ? 1 : 0)),
        ),
      ),
      avgEndToEndMs: round(average(rows.map((entry) => entry.endToEndMs))),
      p95EndToEndMs: round(percentile(rows.map((entry) => entry.endToEndMs), 95)),
      p99EndToEndMs: round(percentile(rows.map((entry) => entry.endToEndMs), 99)),
    };
  }

  const outputData: BenchmarkOutput = {
    benchmark: config.benchmarkName,
    runtime: "typescript",
    profile,
    timestamp,
    iterations,
    datasetName,
    datasetPath: datasetPath ?? null,
    sampleCount: samples.length,
    modes: config.modes,
    results,
    summary,
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(outputData, null, 2));
}

main().catch((error) => {
  console.error("[voicebench][typescript] fatal:", error);
  process.exit(1);
});
