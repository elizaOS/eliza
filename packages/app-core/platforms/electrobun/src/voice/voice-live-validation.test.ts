import { describe, expect, it } from "vitest";
import { VoiceError } from "./errors";
import type {
  VoiceAsrFinalEvent,
  VoiceComponentSnapshot,
  VoicePlaybackEvent,
  VoiceRuntimeHandoffParams,
  VoiceRuntimeHandoffResult,
  VoiceRuntimeStatus,
  VoiceSynthesisResult,
  VoiceSynthesizeSpeechParams,
  VoiceTranscribeAudioParams,
} from "./types";
import {
  runVoiceLiveValidation,
  type VoiceLiveValidationCheck,
} from "./voice-live-validation";
import type { VoiceRuntimeAdapter } from "./voice-runtime-adapter";

class ValidationMockAdapter implements VoiceRuntimeAdapter {
  componentsValue: VoiceComponentSnapshot[] = [
    {
      id: "kokoro",
      name: "Kokoro",
      role: "tts",
      provider: "kokoro",
      status: "ready",
    },
    {
      id: "asr",
      name: "ASR",
      role: "asr",
      provider: "local-inference",
      status: "ready",
    },
  ];
  playbackAvailable = true;

  async status(): Promise<VoiceRuntimeStatus> {
    return {
      mode: "local-runtime",
      listening: false,
      asrPartialSupport: true,
      ttsStreamingSupport: true,
      playbackSupport: this.playbackAvailable,
      playbackAckSupport: this.playbackAvailable,
      runtimeDraftSupport: false,
      vadSupport: true,
      turnSupport: true,
    };
  }

  async components(): Promise<VoiceComponentSnapshot[]> {
    return this.componentsValue;
  }

  async startListening(): Promise<VoiceRuntimeStatus> {
    return this.status();
  }

  async stopListening(): Promise<VoiceRuntimeStatus> {
    return this.status();
  }

  async interrupt(): Promise<VoiceRuntimeStatus> {
    return this.status();
  }

  onVad(): () => void {
    return () => {};
  }

  onTurn(): () => void {
    return () => {};
  }

  onAsrPartial(): () => void {
    return () => {};
  }

  onAsrFinal(): () => void {
    return () => {};
  }

  onTtsChunk(): () => void {
    return () => {};
  }

  onPlayback(): () => void {
    return () => {};
  }

  onError(): () => void {
    return () => {};
  }

  async transcribeAudio(
    params: VoiceTranscribeAudioParams,
  ): Promise<VoiceAsrFinalEvent> {
    return {
      text: "validated transcript",
      metadata: params.metadata,
    };
  }

  async synthesizeSpeech(
    params: VoiceSynthesizeSpeechParams,
  ): Promise<VoiceSynthesisResult> {
    return {
      audioBase64: Buffer.from(params.text).toString("base64"),
      mimeType: "audio/wav",
      byteLength: params.text.length,
      provider: "kokoro",
      voiceId: params.voiceId,
    };
  }

  async playAudio(): Promise<VoicePlaybackEvent> {
    if (!this.playbackAvailable) {
      throw new VoiceError(
        "VOICE_AUDIO_OUTPUT_UNAVAILABLE",
        "Playback acknowledgement is unavailable.",
      );
    }
    return { started: true, metadata: { provider: "mock" } };
  }

  async sendRuntimeMessage(
    params: VoiceRuntimeHandoffParams,
  ): Promise<VoiceRuntimeHandoffResult> {
    return {
      firstTokenText: "ok",
      responseText: `response:${params.text}`,
      conversationId: "conversation-1",
      messageId: "message-1",
    };
  }
}

function findCheck(
  checks: VoiceLiveValidationCheck[],
  name: string,
): VoiceLiveValidationCheck {
  const check = checks.find((item) => item.name === name);
  if (!check) throw new Error(`Missing check: ${name}`);
  return check;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

function okFetch(): FetchImpl {
  return async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function failingFetch(): FetchImpl {
  return async () => {
    throw new Error("runtime unavailable");
  };
}

function mockReadFile(): (path: string) => Promise<Buffer> {
  return async (path) => Buffer.from(`fixture:${path}`);
}

function noopWriteFile(): (path: string, data: Buffer) => Promise<void> {
  return async () => {};
}

function noopMkdir(): (
  path: string,
  options: { recursive: true },
) => Promise<string | undefined> {
  return async (path) => path;
}

function tickingClock(stepMs = 10): () => Date {
  let tick = 0;
  return () =>
    new Date(Date.parse("2026-05-17T12:00:00.000Z") + tick++ * stepMs);
}

describe("runVoiceLiveValidation", () => {
  it("produces a dry-run report when runtime is unavailable", async () => {
    const report = await runVoiceLiveValidation({
      env: {},
      adapter: new ValidationMockAdapter(),
      fetchImpl: failingFetch(),
      now: tickingClock(),
    });

    expect(report.mode).toBe("dry-run");
    expect(findCheck(report.checks, "voice.components")).toMatchObject({
      ok: true,
      required: false,
      status: "static",
    });
    expect(report.components.map((component) => component.id)).toEqual(
      expect.arrayContaining(["kokoro", "omnivoice", "asr", "vad"]),
    );
  });

  it("checks a reachable runtime with mocked fetch", async () => {
    const report = await runVoiceLiveValidation({
      env: { ELIZA_VOICE_LIVE_RUNTIME: "1" },
      adapter: new ValidationMockAdapter(),
      fetchImpl: okFetch(),
      now: tickingClock(),
    });

    expect(report.mode).toBe("runtime");
    expect(findCheck(report.checks, "runtime.api")).toMatchObject({
      ok: true,
      required: true,
    });
  });

  it("reports missing ASR audio fixtures without crashing", async () => {
    const report = await runVoiceLiveValidation({
      env: { ELIZA_VOICE_LIVE_ASR: "1" },
      adapter: new ValidationMockAdapter(),
      fetchImpl: okFetch(),
      now: tickingClock(),
    });

    expect(report.mode).toBe("asr");
    expect(findCheck(report.checks, "asr.route")).toMatchObject({
      ok: false,
      required: false,
    });
  });

  it("reports unavailable TTS providers", async () => {
    const adapter = new ValidationMockAdapter();
    adapter.componentsValue = adapter.componentsValue.map((component) => ({
      ...component,
      status: component.role === "tts" ? "available" : component.status,
    }));

    const report = await runVoiceLiveValidation({
      env: { ELIZA_VOICE_LIVE_TTS: "1" },
      adapter,
      fetchImpl: okFetch(),
      now: tickingClock(),
    });

    expect(findCheck(report.checks, "tts.route")).toMatchObject({
      ok: false,
      required: true,
    });
  });

  it("validates TTS with a mocked synthesis result", async () => {
    const report = await runVoiceLiveValidation({
      env: {
        ELIZA_VOICE_LIVE_TTS: "1",
        ELIZA_VOICE_VALIDATION_OUTPUT_DIR: "/tmp/eliza-voice-validation",
      },
      adapter: new ValidationMockAdapter(),
      fetchImpl: okFetch(),
      now: tickingClock(),
      writeFileImpl: noopWriteFile(),
      mkdirImpl: noopMkdir(),
    });

    const tts = findCheck(report.checks, "tts.route");
    expect(tts).toMatchObject({ ok: true, status: "kokoro" });
    expect(tts.details).toMatchObject({ byteLength: expect.any(Number) });
    expect(report.artifacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "audio" })]),
    );
  });

  it("reports unsupported playback acknowledgement", async () => {
    const adapter = new ValidationMockAdapter();
    adapter.playbackAvailable = false;

    const report = await runVoiceLiveValidation({
      env: {
        ELIZA_VOICE_LIVE_PLAYBACK: "1",
        ELIZA_VOICE_VALIDATION_AUDIO_PATH: "/tmp/test.wav",
      },
      adapter,
      fetchImpl: okFetch(),
      now: tickingClock(),
      readFileImpl: mockReadFile(),
    });

    expect(findCheck(report.checks, "playback.ack")).toMatchObject({
      ok: false,
      required: true,
    });
    expect(report.recommendations).toContain(
      "Wire host playback acknowledgement before marking live playback started.",
    );
  });

  it("reports budget misses with recommendations", async () => {
    const report = await runVoiceLiveValidation({
      env: {
        ELIZA_VOICE_LIVE_RUNTIME: "1",
        ELIZA_VOICE_LIVE_ASR: "1",
        ELIZA_VOICE_LIVE_TTS: "1",
        ELIZA_VOICE_LIVE_PLAYBACK: "1",
        ELIZA_VOICE_VALIDATION_AUDIO_PATH: "/tmp/test.wav",
        ELIZA_VOICE_BUDGET_RUNTIME_TO_FIRST_TOKEN_MS: "1",
      },
      adapter: new ValidationMockAdapter(),
      fetchImpl: okFetch(),
      now: tickingClock(10),
      readFileImpl: mockReadFile(),
    });

    expect(report.mode).toBe("full");
    expect(
      report.budgetResults?.find(
        (result) => result.stage === "runtime_to_first_token",
      ),
    ).toMatchObject({ ok: false, actualMs: 30, budgetMs: 1 });
    expect(
      report.recommendations.some((item) =>
        item.includes("runtime_to_first_token missed budget"),
      ),
    ).toBe(true);
  });

  it("runs a full mocked path and returns trace and latency data", async () => {
    const report = await runVoiceLiveValidation({
      env: {
        ELIZA_VOICE_LIVE_RUNTIME: "1",
        ELIZA_VOICE_LIVE_ASR: "1",
        ELIZA_VOICE_LIVE_TTS: "1",
        ELIZA_VOICE_LIVE_PLAYBACK: "1",
        ELIZA_VOICE_VALIDATION_AUDIO_PATH: "/tmp/test.wav",
      },
      adapter: new ValidationMockAdapter(),
      fetchImpl: okFetch(),
      now: tickingClock(),
      readFileImpl: mockReadFile(),
    });

    expect(findCheck(report.checks, "full.turn")).toMatchObject({
      ok: true,
      required: true,
    });
    expect(report.traceSessionId).toMatch(/^trace-/);
    expect(report.latency?.runtimeToFirstTokenMs).toBeGreaterThan(0);
  });
});
