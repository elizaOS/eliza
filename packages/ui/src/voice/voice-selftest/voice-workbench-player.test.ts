/**
 * Unit coverage for the voice workbench self-test player (local ASR readiness +
 * transcribe round-trip) against a stubbed client. No real device.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaClient } from "../../api/client-base";
import {
  isLocalInferenceAsrReady,
  transcribeLocalInferenceWav,
} from "../local-asr-transcribe";
import {
  runVoiceWorkbench,
  type WorkbenchScenario,
} from "./voice-workbench-player";

vi.mock("../local-asr-transcribe", () => ({
  isLocalInferenceAsrReady: vi.fn(),
  transcribeLocalInferenceWav: vi.fn(),
}));

const scenario = {
  id: "unit-diarization",
  classes: ["diarization"],
  participants: [{ label: "alice", isOwner: true }, { label: "bob" }],
  turns: [
    {
      speaker: "alice",
      text: "first turn",
      expectedSpeakerLabel: "alice",
      expectRespond: false,
    },
    {
      speaker: "bob",
      text: "second turn",
      expectedSpeakerLabel: "bob",
      expectRespond: false,
    },
  ],
} satisfies WorkbenchScenario;

function createClient(): ElizaClient {
  return {
    createConversation: vi.fn(async () => ({
      conversation: { id: "voice-workbench-unit" },
    })),
    sendConversationMessageStream: vi.fn(async () => ({
      text: "",
      completed: true,
      agentName: "Eliza",
      noResponseReason: "ignored",
    })),
  } as unknown as ElizaClient;
}

function mockTranscripts() {
  vi.mocked(transcribeLocalInferenceWav)
    .mockResolvedValueOnce({ text: "first turn", words: [] })
    .mockResolvedValueOnce({ text: "second turn", words: [] });
}

describe("runVoiceWorkbench diarization scoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isLocalInferenceAsrReady).mockResolvedValue(true);
    mockTranscripts();
  });

  it("skips diarization instead of passing when no real speaker-attribution hook is available", async () => {
    const report = await runVoiceWorkbench({
      scenario,
      platform: "web",
      ttsRoute: "/api/tts/cloud",
      resolveTurnWav: vi.fn(async () => new Uint8Array([1, 2, 3])),
      client: createClient(),
      audioCtx: {} as AudioContext,
    });

    expect(report.overall).toBe("skipped");
    expect(report.turns.map((turn) => turn.status)).toEqual(["pass", "pass"]);
    expect(report.turns.map((turn) => turn.predictedSpeakerLabel)).toEqual([
      null,
      null,
    ]);
    expect(
      report.turns.map((turn) => turn.detail.speakerAttributionRan),
    ).toEqual([false, false]);
    expect(report.diarization).toMatchObject({
      status: "skipped",
      total: 0,
      der: 0,
      confusions: 0,
      unattributed: 2,
      evaluated: false,
      passed: false,
    });
    expect(report.diarization.reason).toContain(
      "speaker attribution is not available",
    );
  });

  it("scores DER when a real speaker-attribution hook supplies predictions", async () => {
    const report = await runVoiceWorkbench({
      scenario,
      platform: "web",
      ttsRoute: "/api/tts/cloud",
      resolveTurnWav: vi.fn(async () => new Uint8Array([1, 2, 3])),
      resolvePredictedSpeakerLabel: vi
        .fn()
        .mockResolvedValueOnce("alice")
        .mockResolvedValueOnce("alice"),
      client: createClient(),
      audioCtx: {} as AudioContext,
    });

    expect(report.overall).toBe("fail");
    expect(report.turns.map((turn) => turn.predictedSpeakerLabel)).toEqual([
      "alice",
      "alice",
    ]);
    expect(report.diarization).toMatchObject({
      status: "fail",
      total: 2,
      der: 0.5,
      confusions: 1,
      unattributed: 0,
      evaluated: true,
      passed: false,
    });
  });
});
