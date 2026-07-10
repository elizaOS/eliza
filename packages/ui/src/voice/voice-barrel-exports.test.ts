/**
 * Smoke coverage for the @elizaos/ui/voice barrel. The assertions call pure
 * exported behavior through the barrel so export regressions fail as behavior,
 * not as assertion-free import padding.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOWNLINK_CODEC,
  DEFAULT_UPLINK_CODEC,
  INITIAL_VOICE_SESSION_STATE,
  VOICE_PCM_SAMPLE_RATE,
  applyClientAction,
  applyServerEvent,
  clampFloatSample,
  encodeClientControl,
  floatPcmToInt16Bytes,
  int16BytesToFloatPcm,
  isUsableMintResponse,
  matchWakeName,
  negotiateCodec,
  normalizeForWake,
  pickDefaultVoiceProvider,
  initialWakeControllerState,
  toContinuousStatus,
  wakeControllerReducer,
} from "./index";

describe("voice barrel exports", () => {
  test("exposes protocol helpers that encode controls and validate mint responses", () => {
    expect(DEFAULT_UPLINK_CODEC).toBe("pcm16");
    expect(DEFAULT_DOWNLINK_CODEC).toBe("pcm16");
    expect(encodeClientControl({ t: "end_audio" })).toBe('{"t":"end_audio"}');
    expect(negotiateCodec("pcm16", ["opus", "pcm16"])).toBe("pcm16");
    expect(negotiateCodec("opus", ["pcm16"])).toBe("pcm16");
    expect(
      isUsableMintResponse({
        sessionId: "s",
        wsUrl: "wss://voice.test",
        token: "t",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        uplink: { codecs: ["pcm16"] },
        downlink: { codecs: ["pcm16"] },
      }),
    ).toBe(true);
    expect(isUsableMintResponse({ sessionId: "s", token: "", expiresAt: "bad" })).toBe(false);
  });

  test("exposes PCM conversion helpers", () => {
    expect(VOICE_PCM_SAMPLE_RATE).toBe(16000);
    expect(clampFloatSample(2)).toBe(1);
    expect(clampFloatSample(-2)).toBe(-1);
    const bytes = floatPcmToInt16Bytes(Float32Array.from([-1, 0, 1]));
    expect(bytes.byteLength).toBe(6);
    expect(Array.from(int16BytesToFloatPcm(bytes)).map((v) => Math.round(v * 1000))).toEqual([-1000, 0, 1000]);
  });

  test("exposes session state transitions and continuous status derivation", () => {
    const connecting = applyClientAction(INITIAL_VOICE_SESSION_STATE, { type: "client/connect" });
    expect(connecting.phase).toBe("connecting");
    const ready = applyServerEvent(connecting, { t: "ready", sessionId: "s", traceId: "trace" });
    expect(ready.sessionId).toBe("s");
    const transcribing = applyServerEvent(ready, { t: "stt_partial", text: "hi", traceId: "trace" });
    expect(toContinuousStatus(transcribing.phase)).toBe("transcribing");
  });

  test("exposes wake and provider selection helpers", () => {
    expect(normalizeForWake("Hey, Eliza!")).toBe("hey eliza");
    expect(matchWakeName("hey eliza", "Eliza").matched).toBe(true);
    const wakeStep = wakeControllerReducer(
      initialWakeControllerState(),
      { type: "head-fired", confidence: 0.9 },
      {
        characterName: "Eliza",
        trainedHeads: new Set(["eliza"]),
        capabilities: { openWakeWord: true, asrConfirm: false, swabble: false },
        nameMatch: {},
      },
    );
    expect(wakeStep.emit?.wakeWord).toBe("Eliza");

    expect(
      pickDefaultVoiceProvider({
        platform: "desktop",
        runtimeMode: "local",
        localTtsAvailable: true,
        localAsrAvailable: true,
      }).tts,
    ).toBe("local-inference");
  });
});
