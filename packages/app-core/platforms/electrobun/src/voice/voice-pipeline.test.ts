/** Exercises voice pipeline behavior with deterministic app-core test fixtures. */
import { MODEL_CATALOG, VOICE_MODEL_VERSIONS } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import type { VoiceLatencyMark, VoiceStage, VoiceTurn } from "./types";
import {
  cloneVoiceTurn,
  discoverStaticVoiceComponents,
  summarizeVoiceLatency,
} from "./voice-pipeline";

function firstVersionById() {
  const first = new Map<string, (typeof VOICE_MODEL_VERSIONS)[number]>();
  for (const version of VOICE_MODEL_VERSIONS) {
    if (!first.has(version.id)) first.set(version.id, version);
  }
  return first;
}

function mark(
  stage: VoiceStage,
  name: string,
  offsetMs?: number,
): VoiceLatencyMark {
  const next: VoiceLatencyMark = {
    stage,
    name,
    timestamp: "2026-05-17T12:00:00.000Z",
  };
  if (offsetMs !== undefined) next.offsetMs = offsetMs;
  return next;
}

function makeTurn(
  marks: VoiceLatencyMark[],
  extra?: {
    metadata?: VoiceTurn["metadata"];
    transcriptFinal?: string;
    error?: string;
  },
): VoiceTurn {
  const turn: VoiceTurn = {
    id: "voice-turn-1",
    pipelineId: "voice-pipeline-1",
    status: "started",
    marks,
    createdAt: "2026-05-17T12:00:00.000Z",
    updatedAt: "2026-05-17T12:00:00.000Z",
  };
  if (extra?.metadata) turn.metadata = extra.metadata;
  if (extra?.transcriptFinal !== undefined) {
    turn.transcriptFinal = extra.transcriptFinal;
  }
  if (extra?.error !== undefined) turn.error = extra.error;
  return turn;
}

describe("discoverStaticVoiceComponents", () => {
  it("returns unique ids sorted by localeCompare", () => {
    const components = discoverStaticVoiceComponents();
    const ids = components.map((component) => component.id);

    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "asr",
      "audio-input",
      "audio-playback",
      "diarizer",
      "embedding",
      "kokoro",
      "speaker-encoder",
      "turn-detector",
      "turn-detector-intl",
      "vad",
      "voice-emotion",
      "wakeword",
    ]);
  });

  it("seeds every first-listed VOICE_MODEL_VERSIONS id plus host audio endpoints", () => {
    const components = discoverStaticVoiceComponents();
    const first = firstVersionById();

    for (const [id, version] of first) {
      const component = components.find((entry) => entry.id === id);
      expect(component).toBeDefined();
      expect(component?.status).toBe("available");
      expect(component?.modelId).toBe(`${id}@${version.version}`);
      expect(component?.path).toBe(
        version.ggufAssets[0]?.filename ?? version.missingAssets?.[0]?.filename,
      );
    }

    expect(components.find((entry) => entry.id === "audio-input")).toEqual(
      expect.objectContaining({
        name: "Audio Input",
        role: "unknown",
        provider: "electrobun",
        status: "available",
        raw: { source: "host" },
      }),
    );
    expect(components.find((entry) => entry.id === "audio-playback")).toEqual(
      expect.objectContaining({
        name: "Audio Playback",
        role: "playback",
        provider: "electrobun",
        status: "available",
        raw: { source: "host" },
      }),
    );
    expect(
      components.find((entry) => entry.id === "audio-input")?.modelId,
    ).toBeUndefined();
    expect(
      components.find((entry) => entry.id === "audio-playback")?.path,
    ).toBeUndefined();
  });

  it("maps providers and roles from the first configured owner, not a later duplicate", () => {
    const byId = Object.fromEntries(
      discoverStaticVoiceComponents().map((component) => [
        component.id,
        component,
      ]),
    );
    const asrDuplicates = VOICE_MODEL_VERSIONS.filter(
      (version) => version.id === "asr",
    );

    expect(asrDuplicates.length).toBeGreaterThan(1);
    expect(byId.asr.modelId).toBe("asr@0.3.0");
    expect(byId.asr.modelId).not.toBe(`asr@${asrDuplicates[1]?.version}`);
    expect(byId.asr.provider).toBe("eliza-1");
    expect(byId.asr.role).toBe("asr");
    expect(byId.vad.provider).toBe("eliza-1");
    expect(byId.vad.role).toBe("vad");
    expect(byId.kokoro.provider).toBe("kokoro");
    expect(byId.kokoro.role).toBe("tts");
    expect(byId.wakeword.provider).toBe("local-inference");
    expect(byId.wakeword.role).toBe("unknown");
    expect(byId["turn-detector"].role).toBe("turn-detection");
    expect(byId["voice-emotion"].role).toBe("emotion");
    expect(byId.diarizer.role).toBe("voice");
  });

  it("does not let MODEL_CATALOG replace an already-seeded component", () => {
    const asr = discoverStaticVoiceComponents().find(
      (component) => component.id === "asr",
    );
    const catalogAsr = MODEL_CATALOG.find(
      (model) => model.sourceModel?.components.asr,
    )?.sourceModel?.components.asr;

    expect(catalogAsr?.file).toBe("bundles/e2b/asr/mmproj-audio-e2b-bf16.gguf");
    expect(asr?.path).toBe("voice/asr/eliza-1-gemma-asr-q4_0.gguf");
    expect(asr?.path).not.toBe(catalogAsr?.file);
    expect(asr?.raw).toEqual(
      expect.objectContaining({
        source: "VOICE_MODEL_VERSIONS",
        version: "0.3.0",
        backend: null,
      }),
    );
  });

  it("prefers the first gguf asset over a missing-asset fallback", () => {
    const kokoro = discoverStaticVoiceComponents().find(
      (component) => component.id === "kokoro",
    );
    const firstKokoro = VOICE_MODEL_VERSIONS.find(
      (version) => version.id === "kokoro",
    );

    expect(firstKokoro?.ggufAssets[0]?.filename).toBe(
      "voice/kokoro/voices/af_sam.bin",
    );
    expect(firstKokoro?.missingAssets?.[0]?.filename).toBe(
      "voice/kokoro/kokoro-v1.0-q4_k_m.gguf",
    );
    expect(kokoro?.path).toBe("voice/kokoro/voices/af_sam.bin");
  });

  it("falls back to the first missing asset when ggufAssets is empty", () => {
    const asr = discoverStaticVoiceComponents().find(
      (component) => component.id === "asr",
    );
    const firstAsr = VOICE_MODEL_VERSIONS.find(
      (version) => version.id === "asr",
    );

    expect(firstAsr?.ggufAssets).toEqual([]);
    expect(asr?.path).toBe(firstAsr?.missingAssets?.[0]?.filename);
  });

  it("is deterministic across calls", () => {
    expect(discoverStaticVoiceComponents()).toEqual(
      discoverStaticVoiceComponents(),
    );
  });
});

describe("summarizeVoiceLatency", () => {
  it("returns undefined for a missing turn", () => {
    expect(summarizeVoiceLatency(undefined)).toBeUndefined();
  });

  it("leaves every span undefined on an empty mark queue", () => {
    expect(summarizeVoiceLatency(makeTurn([]))).toEqual({
      inputToVadMs: undefined,
      vadToAsrPartialMs: undefined,
      asrPartialToRuntimePrepareMs: undefined,
      asrFinalToRuntimeMs: undefined,
      asrFinalToRuntimeCommitMs: undefined,
      runtimeToFirstTokenMs: undefined,
      firstTokenToTtsRequestMs: undefined,
      ttsRequestToFirstAudioMs: undefined,
      firstTokenToTtsFirstAudioMs: undefined,
      ttsFirstAudioToPlaybackMs: undefined,
      totalToFirstTokenMs: undefined,
      totalToFirstAudioMs: undefined,
      totalToPlaybackMs: undefined,
    });
  });

  it("leaves a span undefined when only one endpoint exists", () => {
    const summary = summarizeVoiceLatency(
      makeTurn([mark("input", "audio.input", 10)]),
    );

    expect(summary?.inputToVadMs).toBeUndefined();
    expect(summary?.totalToFirstTokenMs).toBeUndefined();
    expect(summary?.totalToPlaybackMs).toBeUndefined();
  });

  it("computes each named span from matching stage/name offsets", () => {
    const summary = summarizeVoiceLatency(
      makeTurn([
        mark("input", "audio.input", 0),
        mark("vad", "speech.detected", 40),
        mark("asr", "partial", 90),
        mark("asr", "final", 140),
        mark("runtime", "prepare.started", 160),
        mark("runtime", "runtime.started", 200),
        mark("model", "first_token", 350),
        mark("tts", "started", 400),
        mark("tts", "first_audio", 520),
        mark("playback", "started", 610),
      ]),
    );

    expect(summary).toEqual({
      inputToVadMs: 40,
      vadToAsrPartialMs: 50,
      asrPartialToRuntimePrepareMs: 70,
      asrFinalToRuntimeMs: 60,
      asrFinalToRuntimeCommitMs: 60,
      runtimeToFirstTokenMs: 150,
      firstTokenToTtsRequestMs: 50,
      ttsRequestToFirstAudioMs: 120,
      firstTokenToTtsFirstAudioMs: 170,
      ttsFirstAudioToPlaybackMs: 90,
      totalToFirstTokenMs: 350,
      totalToFirstAudioMs: 520,
      totalToPlaybackMs: 610,
    });
  });

  it("treats a zero offset as present rather than missing", () => {
    const summary = summarizeVoiceLatency(
      makeTurn([
        mark("input", "audio.input", 0),
        mark("vad", "speech.detected", 0),
      ]),
    );

    expect(summary?.inputToVadMs).toBe(0);
  });

  it("clamps a reversed pair to zero instead of emitting a negative span", () => {
    const summary = summarizeVoiceLatency(
      makeTurn([
        mark("input", "audio.input", 80),
        mark("vad", "speech.detected", 20),
      ]),
    );

    expect(summary?.inputToVadMs).toBe(0);
  });

  it("uses the first matching mark when the same stage/name is recorded twice", () => {
    const summary = summarizeVoiceLatency(
      makeTurn([
        mark("input", "audio.input", 10),
        mark("input", "audio.input", 200),
        mark("vad", "speech.detected", 40),
      ]),
    );

    expect(summary?.inputToVadMs).toBe(30);
  });

  it("ignores unmatched names, unmatched stages, and marks without offsetMs", () => {
    const summary = summarizeVoiceLatency(
      makeTurn([
        mark("input", "audio.input", 5),
        mark("input", "other", 99),
        mark("vad", "audio.input", 88),
        mark("vad", "speech.detected"),
        mark("turn", "speech.detected", 70),
      ]),
    );

    expect(summary?.inputToVadMs).toBeUndefined();
    expect(summary?.vadToAsrPartialMs).toBeUndefined();
  });

  it("does not mutate the turn while summarizing", () => {
    const turn = makeTurn([
      mark("input", "audio.input", 1),
      mark("vad", "speech.detected", 4),
    ]);
    const before = structuredClone(turn);

    summarizeVoiceLatency(turn);

    expect(turn).toEqual(before);
  });
});

describe("cloneVoiceTurn", () => {
  it("returns a distinct turn whose mark and metadata records can be mutated independently", () => {
    const original = makeTurn(
      [
        {
          stage: "asr",
          name: "final",
          timestamp: "2026-05-17T12:00:00.000Z",
          offsetMs: 12,
          metadata: { token: "hello" },
        },
      ],
      {
        metadata: { owner: "pipeline" },
        transcriptFinal: "hello",
        error: "none",
      },
    );

    const cloned = cloneVoiceTurn(original);
    cloned.status = "completed";
    cloned.transcriptFinal = "changed";
    cloned.marks[0].name = "partial";
    cloned.marks[0].offsetMs = 99;
    cloned.marks[0].metadata = { token: "mutated" };
    cloned.metadata = { owner: "clone" };
    cloned.marks.push(mark("tts", "started", 20));

    expect(cloned).not.toBe(original);
    expect(cloned.marks).not.toBe(original.marks);
    expect(original.status).toBe("started");
    expect(original.transcriptFinal).toBe("hello");
    expect(original.error).toBe("none");
    expect(original.marks).toHaveLength(1);
    expect(original.marks[0].name).toBe("final");
    expect(original.marks[0].offsetMs).toBe(12);
    expect(original.marks[0].metadata).toEqual({ token: "hello" });
    expect(original.metadata).toEqual({ owner: "pipeline" });
  });

  it("clones a single-mark turn without metadata as undefined metadata", () => {
    const original = makeTurn([mark("input", "audio.input", 3)]);
    const cloned = cloneVoiceTurn(original);

    expect(cloned).toEqual(original);
    expect(cloned.metadata).toBeUndefined();
    expect(cloned.marks[0].metadata).toBeUndefined();
    cloned.marks[0].offsetMs = 0;
    expect(original.marks[0].offsetMs).toBe(3);
  });

  it("clones an empty mark list to a distinct empty array", () => {
    const original = makeTurn([]);
    const cloned = cloneVoiceTurn(original);

    expect(cloned.marks).toEqual([]);
    expect(cloned.marks).not.toBe(original.marks);
  });
});
