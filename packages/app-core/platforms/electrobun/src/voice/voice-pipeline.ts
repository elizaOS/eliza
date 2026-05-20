import type { JsonValue } from "@elizaos/electrobun-carrots";
import {
  type CatalogModel,
  MODEL_CATALOG,
  VOICE_MODEL_VERSIONS,
  type VoiceModelId,
  type VoiceModelVersion,
} from "@elizaos/shared";
import type {
  VoiceComponentRole,
  VoiceComponentSnapshot,
  VoiceLatencyMark,
  VoiceLatencySummary,
  VoiceTurn,
} from "./types";

type ComponentSeed = {
  id: string;
  name: string;
  role: VoiceComponentRole;
  provider: string;
  modelId?: string;
  path?: string;
  raw?: JsonValue;
};

const VOICE_MODEL_ROLES: Readonly<Record<VoiceModelId, VoiceComponentRole>> = {
  "speaker-encoder": "voice",
  diarizer: "voice",
  "turn-detector": "turn-detection",
  "turn-detector-intl": "turn-detection",
  "voice-emotion": "emotion",
  kokoro: "tts",
  omnivoice: "tts",
  vad: "vad",
  wakeword: "unknown",
  embedding: "voice",
  asr: "asr",
};

const VOICE_MODEL_NAMES: Readonly<Record<VoiceModelId, string>> = {
  "speaker-encoder": "Speaker Encoder",
  diarizer: "Speaker Diarizer",
  "turn-detector": "Turn Detector",
  "turn-detector-intl": "International Turn Detector",
  "voice-emotion": "Voice Emotion",
  kokoro: "Kokoro",
  omnivoice: "OmniVoice",
  vad: "Voice Activity Detection",
  wakeword: "Wake Word",
  embedding: "Voice Embedding",
  asr: "ASR",
};

function providerForVoiceModel(id: VoiceModelId): string {
  if (id === "omnivoice") return "omnivoice";
  if (id === "kokoro") return "kokoro";
  if (id === "asr" || id === "vad") return "eliza-1";
  return "local-inference";
}

function latestVoiceVersions(): Map<VoiceModelId, VoiceModelVersion> {
  const latest = new Map<VoiceModelId, VoiceModelVersion>();
  for (const version of VOICE_MODEL_VERSIONS) {
    if (!latest.has(version.id)) latest.set(version.id, version);
  }
  return latest;
}

function jsonRecord(value: Record<string, JsonValue>): JsonValue {
  return value;
}

function firstCatalogComponent(
  key: "voice" | "asr" | "vad",
): { model: CatalogModel; file?: string } | null {
  for (const model of MODEL_CATALOG) {
    const component = model.sourceModel?.components[key];
    if (component) return { model, file: component.file };
  }
  return null;
}

function addSeed(
  components: Map<string, VoiceComponentSnapshot>,
  seed: ComponentSeed,
): void {
  if (components.has(seed.id)) return;
  components.set(seed.id, {
    id: seed.id,
    name: seed.name,
    role: seed.role,
    provider: seed.provider,
    status: "available",
    modelId: seed.modelId,
    path: seed.path,
    raw: seed.raw,
  });
}

export function discoverStaticVoiceComponents(): VoiceComponentSnapshot[] {
  const components = new Map<string, VoiceComponentSnapshot>();
  const versions = latestVoiceVersions();
  for (const [id, version] of versions) {
    const primaryAsset = version.ggufAssets[0] ?? version.missingAssets?.[0];
    addSeed(components, {
      id,
      name: VOICE_MODEL_NAMES[id],
      role: VOICE_MODEL_ROLES[id],
      provider: providerForVoiceModel(id),
      modelId: `${id}@${version.version}`,
      path: primaryAsset?.filename,
      raw: jsonRecord({
        source: "VOICE_MODEL_VERSIONS",
        version: version.version,
        backend: version.preferredBackend ?? null,
        hfRepo: version.hfRepo,
        hfRevision: version.hfRevision,
      }),
    });
  }

  const backends = new Set(
    MODEL_CATALOG.flatMap((model) => [...(model.voiceBackends ?? [])]),
  );
  if (backends.has("omnivoice")) {
    const component = firstCatalogComponent("voice");
    addSeed(components, {
      id: "omnivoice",
      name: "OmniVoice",
      role: "tts",
      provider: "omnivoice",
      modelId: component?.model.id,
      path: component?.file,
      raw: jsonRecord({ source: "MODEL_CATALOG" }),
    });
  }
  if (backends.has("kokoro")) {
    addSeed(components, {
      id: "kokoro",
      name: "Kokoro",
      role: "tts",
      provider: "kokoro",
      raw: jsonRecord({ source: "MODEL_CATALOG" }),
    });
  }

  const asr = firstCatalogComponent("asr");
  if (asr) {
    addSeed(components, {
      id: "asr",
      name: "ASR",
      role: "asr",
      provider: "eliza-1",
      modelId: asr.model.id,
      path: asr.file,
      raw: jsonRecord({ source: "MODEL_CATALOG" }),
    });
  }

  const vad = firstCatalogComponent("vad");
  if (vad) {
    addSeed(components, {
      id: "vad",
      name: "Voice Activity Detection",
      role: "vad",
      provider: "eliza-1",
      modelId: vad.model.id,
      path: vad.file,
      raw: jsonRecord({ source: "MODEL_CATALOG" }),
    });
  }

  addSeed(components, {
    id: "audio-input",
    name: "Audio Input",
    role: "unknown",
    provider: "electrobun",
    raw: jsonRecord({ source: "host" }),
  });
  addSeed(components, {
    id: "audio-playback",
    name: "Audio Playback",
    role: "playback",
    provider: "electrobun",
    raw: jsonRecord({ source: "host" }),
  });

  return Array.from(components.values()).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
}

function markOffset(
  turn: VoiceTurn,
  stage: string,
  name: string,
): number | null {
  const mark = turn.marks.find((candidate) => {
    return candidate.stage === stage && candidate.name === name;
  });
  return mark?.offsetMs ?? null;
}

function span(start: number | null, end: number | null): number | undefined {
  if (start === null || end === null) return undefined;
  return Math.max(0, end - start);
}

export function summarizeVoiceLatency(
  turn: VoiceTurn | undefined,
): VoiceLatencySummary | undefined {
  if (!turn) return undefined;
  const input = markOffset(turn, "input", "audio.input");
  const vad = markOffset(turn, "vad", "speech.detected");
  const asrPartial = markOffset(turn, "asr", "partial");
  const asrFinal = markOffset(turn, "asr", "final");
  const runtimePrepare = markOffset(turn, "runtime", "prepare.started");
  const runtime = markOffset(turn, "runtime", "runtime.started");
  const firstToken = markOffset(turn, "model", "first_token");
  const ttsStarted = markOffset(turn, "tts", "started");
  const firstAudio = markOffset(turn, "tts", "first_audio");
  const playback = markOffset(turn, "playback", "started");
  return {
    inputToVadMs: span(input, vad),
    vadToAsrPartialMs: span(vad, asrPartial),
    asrPartialToRuntimePrepareMs: span(asrPartial, runtimePrepare),
    asrFinalToRuntimeMs: span(asrFinal, runtime),
    asrFinalToRuntimeCommitMs: span(asrFinal, runtime),
    runtimeToFirstTokenMs: span(runtime, firstToken),
    firstTokenToTtsRequestMs: span(firstToken, ttsStarted),
    ttsRequestToFirstAudioMs: span(ttsStarted, firstAudio),
    firstTokenToTtsFirstAudioMs: span(firstToken, firstAudio),
    ttsFirstAudioToPlaybackMs: span(firstAudio, playback),
    totalToFirstTokenMs: span(input, firstToken),
    totalToFirstAudioMs: span(input, firstAudio),
    totalToPlaybackMs: span(input, playback),
  };
}

export function cloneVoiceTurn(turn: VoiceTurn): VoiceTurn {
  return {
    ...turn,
    marks: turn.marks.map((mark: VoiceLatencyMark) => ({
      ...mark,
      metadata: mark.metadata ? { ...mark.metadata } : undefined,
    })),
    metadata: turn.metadata ? { ...turn.metadata } : undefined,
  };
}
