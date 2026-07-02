#!/usr/bin/env bun

/**
 * Three-agent dialogue runner.
 *
 * Spawns three Eliza agent instances (Alice, Bob, Cleo), each with a distinct
 * Groq TTS voice, and runs a scripted scenario where agents take turns
 * speaking. All audio output flows through a shared AudioBus.
 *
 * Captured per run (under artifacts/three-agent-dialogue/<run-id>/):
 *   turns/<idx>-<speaker>.wav  — per-turn per-agent TTS audio
 *   mix.wav                    — sequential mix of all turns
 *   transcripts.json           — per-turn diarization + ASR text
 *   emotion.json               — per-turn emotion detection results
 *   turn-events.json           — turn-taking event log
 *   verification.json          — pass/fail assertions
 *
 * Usage:
 *   bun run runner/run-dialogue.ts [--scenario=canonical] [--output=<dir>]
 *   THREE_AGENT_SMOKE=1 bun run runner/run-dialogue.ts   # smoke (first 4 turns)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRuntime,
  type Character,
  InMemoryDatabaseAdapter,
  ModelType,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import {
  AudioBus,
  estimateWavDurationSec,
  isAudioNonBlank,
} from "./audio-bus.ts";
import {
  countDialogueScenarios,
  listDialogueScenarios,
  loadDialogueScenario,
  validateDialogueScenarios,
} from "./scenarios.ts";
import {
  computeVerification,
  detectEmotionFromText,
  type TurnOutcome,
  type VerificationResult,
} from "./verification.ts";

export type { VerificationResult } from "./verification.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const CHARACTERS_DIR = join(PKG_DIR, "characters");
const REPO_ROOT = resolve(PKG_DIR, "../../..");
const ARTIFACTS_BASE = join(REPO_ROOT, "artifacts", "three-agent-dialogue");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  turnIdx: number;
  speaker: string;
  /** Ground-truth prompt text from the scenario. */
  gtText: string;
  /** Real ASR transcription of the TTS audio; null when no real ASR ran. */
  asrText: string | null;
  /** True when the audio came from the real TTS provider (not sine-wave). */
  ttsReal: boolean;
  /** True when asrText came from a real transcription call. */
  asrReal: boolean;
  /** Emotion detected from the real ASR text (null without real ASR). */
  emotion: string | null;
  /** Confidence of turn-detection / diarization. */
  turnConfidence: number;
}

export interface EmotionEntry {
  turnIdx: number;
  speaker: string;
  expectedEmotion: string;
  detectedEmotion: string | null;
  matches: boolean;
}

export interface TurnEvent {
  turnIdx: number;
  speaker: string;
  eventType: "turn-start" | "tts-complete" | "asr-complete" | "turn-end";
  timestampMs: number;
  details?: string;
}

// ---------------------------------------------------------------------------
// Agent IDs (stable per-agent)
// ---------------------------------------------------------------------------

const AGENT_IDS: Record<string, UUID> = {
  alice: "00000000-3a9e-0000-0000-000000000001" as UUID,
  bob: "00000000-3a9e-0000-0000-000000000002" as UUID,
  cleo: "00000000-3a9e-0000-0000-000000000003" as UUID,
};

const WORLD_ID = "00000000-3a9e-0000-0000-000000000010" as UUID;
const ROOM_ID = "00000000-3a9e-0000-0000-000000000011" as UUID;

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

type GroqPluginModule = { groqPlugin?: Plugin; default?: Plugin };

async function resolveGroqPlugin(): Promise<Plugin | null> {
  // If no API key, don't load Groq plugin — it will throw on init.
  // The harness will fall back to synthetic TTS/ASR.
  if (!process.env.GROQ_API_KEY) {
    console.warn(
      "[three-agent-dialogue] GROQ_API_KEY not set — Groq plugin will not be loaded. " +
        "TTS will use synthetic sine-wave fallback; ASR will use ground-truth text.",
    );
    return null;
  }
  let mod: GroqPluginModule;
  try {
    mod = (await import("@elizaos/plugin-groq")) as GroqPluginModule;
  } catch {
    console.warn(
      "[three-agent-dialogue] Failed to load @elizaos/plugin-groq. Using synthetic fallback.",
    );
    return null;
  }
  const plugin = mod.groqPlugin ?? mod.default;
  if (!plugin) {
    console.warn(
      "[three-agent-dialogue] @elizaos/plugin-groq did not export a plugin. Using synthetic fallback.",
    );
    return null;
  }
  return plugin;
}

async function resolveLocalEmbeddingPlugin(): Promise<Plugin | null> {
  // Intentionally do not load plugin-local-inference here — it requires a
  // running Eliza-1 backend (model server) which isn't needed for the
  // three-agent dialogue harness (Groq handles TTS + ASR).
  // We return null so the runtime skips embedding setup entirely.
  return null;
}

// ---------------------------------------------------------------------------
// Runtime factory
// ---------------------------------------------------------------------------

async function seedRuntimeGraph(
  adapter: InMemoryDatabaseAdapter,
  agentId: UUID,
): Promise<void> {
  await adapter.createWorlds([
    {
      id: WORLD_ID,
      name: "ThreeAgentWorld",
      agentId,
      messageServerId: "three-agent-dialogue",
    } as Parameters<typeof adapter.createWorlds>[0][number],
  ]);

  await adapter.createRooms([
    {
      id: ROOM_ID,
      name: "DialogueRoom",
      agentId,
      source: "three-agent-dialogue",
      type: "GROUP",
      worldId: WORLD_ID,
    } as Parameters<typeof adapter.createRooms>[0][number],
  ]);

  await adapter.createEntities([
    {
      id: agentId,
      names: ["DialogueAgent"],
      agentId,
    } as Parameters<typeof adapter.createEntities>[0][number],
  ]);

  await adapter.createRoomParticipants([agentId], ROOM_ID);
}

async function createAgentRuntime(
  agentName: string,
  character: Character,
  groqPlugin: Plugin | null,
  embeddingPlugin: Plugin | null,
): Promise<AgentRuntime> {
  const agentId = AGENT_IDS[agentName];
  if (!agentId) throw new Error(`Unknown agent: ${agentName}`);

  const adapter = new InMemoryDatabaseAdapter();

  const plugins: Plugin[] = [];
  if (groqPlugin) plugins.push(groqPlugin);
  if (embeddingPlugin) plugins.push(embeddingPlugin);

  const envPassthrough: Record<string, string> = {};
  const passthroughKeys = [
    "GROQ_API_KEY",
    "GROQ_BASE_URL",
    "GROQ_SMALL_MODEL",
    "GROQ_LARGE_MODEL",
    "GROQ_TRANSCRIPTION_MODEL",
    "GROQ_TTS_MODEL",
    "GROQ_TTS_RESPONSE_FORMAT",
  ] as const;
  for (const key of passthroughKeys) {
    const val = process.env[key];
    if (typeof val === "string" && val.length > 0) envPassthrough[key] = val;
  }

  const characterSettings = (character.settings ?? {}) as Record<
    string,
    string
  >;

  const runtimeSettings: Record<string, string> = {
    ...envPassthrough,
    ...characterSettings,
    ALLOW_NO_DATABASE: "true",
    USE_MULTI_STEP: "false",
    CHECK_SHOULD_RESPOND: "false",
    VALIDATION_LEVEL: "trusted",
  };

  const runtime = new AgentRuntime({
    agentId,
    character: { ...character, settings: runtimeSettings },
    plugins,
    adapter,
    checkShouldRespond: false,
    logLevel: "fatal",
    disableBasicCapabilities: false,
  });

  await runtime.initialize();
  await seedRuntimeGraph(adapter, agentId);

  return runtime;
}

// ---------------------------------------------------------------------------
// WAV coercion helpers
// ---------------------------------------------------------------------------

function coerceToBuffer(output: unknown): Buffer {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(output))
    return output as Buffer;
  if (output instanceof Uint8Array)
    return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  if (output instanceof ArrayBuffer) return Buffer.from(output);
  if (typeof output === "string") {
    const raw =
      output.startsWith("data:") && output.includes(",")
        ? output.split(",", 2)[1]
        : output;
    try {
      if (typeof Buffer !== "undefined") {
        return Buffer.from(raw ?? output, "base64");
      }
    } catch {
      // ignore
    }
    return Buffer.from(new TextEncoder().encode(output));
  }
  return Buffer.alloc(0);
}

// ---------------------------------------------------------------------------
// Synthetic TTS fallback — generates real non-blank WAV audio locally.
//
// When the cloud TTS provider is unavailable (no API key or billing issue),
// we generate a sine-wave WAV at a speaker-specific frequency so the
// structural audio pipeline can still be smoke-tested. Runs that use this
// fallback are NEVER scored: computeVerification demotes them to
// "synthetic-smoke" mode.
// ---------------------------------------------------------------------------

/** Sine-wave frequencies used as distinct "voices" per agent. */
const SYNTHETIC_VOICE_FREQ: Record<string, number> = {
  alice: 261.63, // C4 — warm, mid-range
  bob: 196.0, // G3 — lower, direct
  cleo: 329.63, // E4 — expressive, higher
};

/**
 * Generate a synthetic WAV buffer for the given text and speaker.
 * Duration is proportional to the text length (~80ms per word, min 1s).
 */
function generateSyntheticWav(text: string, speaker: string): Buffer {
  const sampleRate = 22050;
  const numChannels = 1;
  const bitsPerSample = 16;

  // Duration: ~80ms per word, clamp 1s–5s
  const wordCount = text.trim().split(/\s+/).length;
  const durationSec = Math.max(1.0, Math.min(5.0, wordCount * 0.08));
  const numSamples = Math.round(sampleRate * durationSec);

  const freq = SYNTHETIC_VOICE_FREQ[speaker] ?? 440;
  const amplitude = 16000; // below max (32767) for clean signal

  const pcmBytes = new Uint8Array(numSamples * 2);
  const pcmView = new DataView(pcmBytes.buffer);

  for (let i = 0; i < numSamples; i++) {
    // Soft envelope: linear fade in/out over 5% of samples
    const fadeLen = Math.round(numSamples * 0.05);
    let env = 1.0;
    if (i < fadeLen) env = i / fadeLen;
    else if (i > numSamples - fadeLen) env = (numSamples - i) / fadeLen;

    const sample = Math.round(
      amplitude * env * Math.sin((2 * Math.PI * freq * i) / sampleRate),
    );
    pcmView.setInt16(i * 2, sample, true);
  }

  // Build WAV header
  const dataLen = pcmBytes.length;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const headerBuf = Buffer.alloc(44);
  headerBuf.write("RIFF", 0);
  headerBuf.writeUInt32LE(36 + dataLen, 4);
  headerBuf.write("WAVE", 8);
  headerBuf.write("fmt ", 12);
  headerBuf.writeUInt32LE(16, 16);
  headerBuf.writeUInt16LE(1, 20); // PCM
  headerBuf.writeUInt16LE(numChannels, 22);
  headerBuf.writeUInt32LE(sampleRate, 24);
  headerBuf.writeUInt32LE(byteRate, 28);
  headerBuf.writeUInt16LE(blockAlign, 32);
  headerBuf.writeUInt16LE(bitsPerSample, 34);
  headerBuf.write("data", 36);
  headerBuf.writeUInt32LE(dataLen, 40);

  return Buffer.concat([headerBuf, Buffer.from(pcmBytes)]);
}

// ---------------------------------------------------------------------------
// Main dialogue runner
// ---------------------------------------------------------------------------

export async function runDialogue(options: {
  scenarioId?: string;
  outputDir?: string;
  smoke?: boolean;
}): Promise<VerificationResult> {
  const scenarioId = options.scenarioId ?? "canonical";
  const scenario = loadDialogueScenario(scenarioId);
  const isSmoke = options.smoke ?? false;

  const turnsToRun = isSmoke
    ? scenario.turns.filter((t) => scenario.smokeSubset.includes(t.turnIdx))
    : scenario.turns;

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = options.outputDir ?? join(ARTIFACTS_BASE, runId);
  mkdirSync(outputDir, { recursive: true });

  console.log(
    `[three-agent-dialogue] run-id=${runId} scenario=${scenarioId} ` +
      `turns=${turnsToRun.length} smoke=${isSmoke} output=${outputDir}`,
  );

  // --- Load Groq plugin (optional — falls back to synthetic audio) ---
  const groqPlugin = await resolveGroqPlugin();
  const embeddingPlugin = await resolveLocalEmbeddingPlugin();

  // --- Load characters ---
  const characterNames = ["alice", "bob", "cleo"] as const;
  const characters: Record<string, Character> = {};
  for (const name of characterNames) {
    const charPath = join(CHARACTERS_DIR, `${name}.json`);
    characters[name] = JSON.parse(readFileSync(charPath, "utf-8")) as Character;
  }

  // --- Create runtimes ---
  console.log("[three-agent-dialogue] Initialising agent runtimes...");
  const runtimes: Record<string, AgentRuntime> = {};
  for (const name of characterNames) {
    runtimes[name] = await createAgentRuntime(
      name,
      characters[name] as Character,
      groqPlugin,
      embeddingPlugin,
    );
    console.log(`[three-agent-dialogue]   ${name} runtime ready`);
  }

  // --- Shared audio bus ---
  const bus = new AudioBus();

  // --- Dialogue state ---
  const transcripts: TranscriptEntry[] = [];
  const emotionLog: EmotionEntry[] = [];
  const turnEvents: TurnEvent[] = [];

  const startMs = nowMs();

  // --- Run scenario turns ---
  for (const turn of turnsToRun) {
    const { turnIdx, speaker, prompt, expectedEmotion, note } = turn;
    const runtime = runtimes[speaker];
    if (!runtime) {
      console.warn(
        `[three-agent-dialogue] No runtime for speaker ${speaker}, skipping turn ${turnIdx}`,
      );
      continue;
    }

    console.log(
      `\n[three-agent-dialogue] turn=${turnIdx} speaker=${speaker} note="${note}"`,
    );

    // Emit turn-start event
    turnEvents.push({
      turnIdx,
      speaker,
      eventType: "turn-start",
      timestampMs: nowMs() - startMs,
    });

    // --- TTS: convert prompt text to audio ---
    let ttsBytes: Buffer = Buffer.alloc(0);
    let ttsError: string | null = null;
    let ttsSynthetic = false;

    if (groqPlugin !== null) {
      try {
        const ttsResult = await runtime.useModel(
          ModelType.TEXT_TO_SPEECH,
          {
            text: prompt,
            voice: (
              characters[speaker] as Character & {
                settings?: Record<string, string>;
              }
            )?.settings?.GROQ_TTS_VOICE,
          },
          "groq",
        );
        ttsBytes = coerceToBuffer(ttsResult);
        console.log(
          `[three-agent-dialogue]   TTS (groq): ${ttsBytes.length} bytes | duration≈${estimateWavDurationSec(ttsBytes).toFixed(2)}s`,
        );
      } catch (err) {
        ttsError = String(err);
        console.warn(
          `[three-agent-dialogue]   TTS cloud failed turn=${turnIdx}, using synthetic fallback: ${ttsError.slice(0, 120)}`,
        );
      }
    }

    if (ttsBytes.length === 0) {
      // Synthetic fallback: generate a real sine-wave WAV at a speaker-specific
      // frequency. Documented fallback per W3-2 spec when cloud TTS unavailable.
      ttsBytes = generateSyntheticWav(prompt, speaker);
      ttsSynthetic = true;
      console.log(
        `[three-agent-dialogue]   TTS (synthetic ${speaker} @ ${SYNTHETIC_VOICE_FREQ[speaker] ?? 440}Hz): ` +
          `${ttsBytes.length} bytes | duration≈${estimateWavDurationSec(ttsBytes).toFixed(2)}s`,
      );
    }

    // Publish to bus (always — synthetic or real)
    bus.publish(turnIdx, speaker, ttsBytes);

    turnEvents.push({
      turnIdx,
      speaker,
      eventType: "tts-complete",
      timestampMs: nowMs() - startMs,
      details: ttsError ?? `bytes=${ttsBytes.length}`,
    });

    // --- ASR: transcribe the audio back (real ASR on real audio only) ---
    let asrText: string | null = null;
    let asrReal = false;

    if (groqPlugin !== null && ttsBytes.length > 0 && !ttsSynthetic) {
      try {
        const asrResult = await runtime.useModel(
          ModelType.TRANSCRIPTION,
          ttsBytes,
          "groq",
        );
        asrText =
          typeof asrResult === "string"
            ? asrResult.trim()
            : String(asrResult).trim();
        asrReal = true;
        console.log(`[three-agent-dialogue]   ASR: "${asrText}"`);
      } catch (err) {
        console.warn(
          `[three-agent-dialogue]   ASR failed turn=${turnIdx}: ${err}`,
        );
      }
    }
    if (!asrReal && ttsSynthetic) {
      // No ground-truth fallback: a synthetic turn has no ASR output and the
      // run is demoted to synthetic-smoke mode (never scored).
      console.log(
        `[three-agent-dialogue]   ASR skipped (synthetic audio, turn not scored)`,
      );
    }

    turnEvents.push({
      turnIdx,
      speaker,
      eventType: "asr-complete",
      timestampMs: nowMs() - startMs,
      details: asrText ?? "no-asr",
    });

    // --- Emotion detection (text heuristic on the REAL ASR output only) ---
    const detectedEmotion =
      asrReal && asrText ? detectEmotionFromText(asrText) : null;

    emotionLog.push({
      turnIdx,
      speaker,
      expectedEmotion,
      detectedEmotion,
      matches: detectedEmotion === expectedEmotion,
    });

    // --- Record transcript entry ---
    transcripts.push({
      turnIdx,
      speaker,
      gtText: prompt,
      asrText,
      ttsReal: !ttsSynthetic,
      asrReal,
      emotion: detectedEmotion,
      turnConfidence: asrReal && asrText ? 1.0 : 0.0,
    });

    turnEvents.push({
      turnIdx,
      speaker,
      eventType: "turn-end",
      timestampMs: nowMs() - startMs,
    });
  }

  // --- Flush audio artefacts ---
  console.log("\n[three-agent-dialogue] Flushing audio artefacts...");
  const { turnFiles, mixFile } = bus.flush(outputDir);
  const busStats = bus.stats();

  console.log(`[three-agent-dialogue] Turn files: ${turnFiles.length}`);
  console.log(`[three-agent-dialogue] Mix: ${mixFile}`);
  console.log(
    `[three-agent-dialogue] Audio duration≈${busStats.durationEstimateSec.toFixed(2)}s`,
  );

  // --- Write JSON artefacts ---
  writeFileSync(
    join(outputDir, "transcripts.json"),
    JSON.stringify(transcripts, null, 2),
  );
  writeFileSync(
    join(outputDir, "emotion.json"),
    JSON.stringify(emotionLog, null, 2),
  );
  writeFileSync(
    join(outputDir, "turn-events.json"),
    JSON.stringify(turnEvents, null, 2),
  );

  // --- Run verification ---
  // Load mix.wav for audio checks
  let mixWavBytes = new Uint8Array();
  try {
    const { readFileSync } = await import("node:fs");
    mixWavBytes = new Uint8Array(readFileSync(mixFile));
  } catch {
    // ignore if file doesn't exist yet
  }

  const turnOutcomes: TurnOutcome[] = transcripts.map((t) => ({
    turnIdx: t.turnIdx,
    speaker: t.speaker,
    gtText: t.gtText,
    asrText: t.asrText,
    ttsReal: t.ttsReal,
    asrReal: t.asrReal,
    detectedEmotion: t.emotion,
    expectedEmotion:
      emotionLog.find((e) => e.turnIdx === t.turnIdx)?.expectedEmotion ?? "",
  }));

  const verification = computeVerification({
    turns: turnOutcomes,
    thresholds: scenario.verificationThresholds,
    mixDurationSec: estimateWavDurationSec(mixWavBytes),
    mixNonBlank: isAudioNonBlank(mixWavBytes),
    distinctSpeakers: bus.getSpeakers().length,
    smokeRequested: isSmoke,
  });

  writeFileSync(
    join(outputDir, "verification.json"),
    JSON.stringify(verification, null, 2),
  );

  // --- Teardown ---
  console.log("\n[three-agent-dialogue] Stopping runtimes...");
  await Promise.allSettled(Object.values(runtimes).map((rt) => rt.stop()));

  // --- Summary ---
  console.log("\n[three-agent-dialogue] === RUN COMPLETE ===");
  console.log(`  Output dir:    ${outputDir}`);
  console.log(`  Mode:          ${verification.mode}`);
  console.log(`  Scored:        ${verification.scored}`);
  console.log(`  Turns taken:   ${verification.turnsTaken}`);
  console.log(
    `  Real turns:    ${verification.realTurns}/${verification.turnsTaken}`,
  );
  console.log(`  Speakers:      ${verification.distinctSpeakersDetected}`);
  console.log(`  Audio dur:     ${verification.durationSec}s`);
  console.log(`  Audio blank:   ${!verification.audioNotBlank}`);
  console.log(
    `  Emotions:      ${verification.emotionsDetected}/${emotionLog.length}`,
  );
  console.log(
    `  Transcripts:   ${transcripts.filter((t) => t.asrReal && t.asrText).length}/${transcripts.length} real ASR`,
  );
  console.log(`  PASS:          ${verification.pass}`);
  if (verification.skippedChecks.length > 0) {
    console.log("  SKIPPED (not scored):");
    for (const s of verification.skippedChecks) console.log(`    - ${s}`);
  }
  if (verification.failures.length > 0) {
    console.log("  FAILURES:");
    for (const f of verification.failures) console.log(`    - ${f}`);
  }

  console.log("\n[three-agent-dialogue] Artefact paths:");
  console.log(`  transcripts: ${join(outputDir, "transcripts.json")}`);
  console.log(`  emotion:     ${join(outputDir, "emotion.json")}`);
  console.log(`  turn-events: ${join(outputDir, "turn-events.json")}`);
  console.log(`  mix audio:   ${mixFile}`);
  for (const f of turnFiles) console.log(`  turn audio:  ${f}`);
  console.log(`  verification: ${join(outputDir, "verification.json")}`);

  return verification;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes("--count-scenarios")) {
    console.log(JSON.stringify(countDialogueScenarios(), null, 2));
    return;
  }
  if (process.argv.includes("--validate-scenarios")) {
    console.log(JSON.stringify(validateDialogueScenarios(), null, 2));
    return;
  }
  if (process.argv.includes("--list-scenarios")) {
    for (const scenario of listDialogueScenarios()) console.log(scenario);
    return;
  }

  const scenarioArg = parseArg("scenario") ?? "canonical";
  const outputArg = parseArg("output");
  const isSmoke =
    process.env.THREE_AGENT_SMOKE === "1" || process.argv.includes("--smoke");

  const result = await runDialogue({
    scenarioId: scenarioArg,
    outputDir: outputArg,
    smoke: isSmoke,
  });

  if (!result.pass) {
    console.error(
      `[three-agent-dialogue] VERIFICATION FAILED: ${result.failures.join(", ")}`,
    );
    process.exit(1);
  }
}

// Only run CLI when invoked directly, not when imported as a module.
if (
  typeof import.meta !== "undefined" &&
  ((import.meta as { main?: boolean }).main === true ||
    (typeof process !== "undefined" &&
      process.argv[1] &&
      import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))))
) {
  main().catch((err) => {
    console.error("[three-agent-dialogue] Fatal error:", err);
    process.exit(1);
  });
}
