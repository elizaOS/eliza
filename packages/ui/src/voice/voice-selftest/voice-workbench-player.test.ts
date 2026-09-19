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

it.each([
  "valid",
  "foreign-terminal",
  "wrong-buffer",
  "wrong-turn",
  "deadline",
] as const)(
  "validates playback reply provenance at the workbench consumer boundary: %s",
  async (caseName) => {
    vi.mocked(isLocalInferenceAsrReady).mockResolvedValue(true);
    vi.mocked(transcribeLocalInferenceWav)
      .mockReset()
      .mockResolvedValue({ text: "Controlled question", words: [] });
    const client = createClient();
    vi.mocked(client.sendConversationMessageStream).mockResolvedValue({
      text: "Complete reply",
      completed: true,
      agentName: "Controlled",
    });
    const report = await runVoiceWorkbench({
      scenario: {
        id: "provenance",
        classes: [],
        participants: [{ label: "owner" }],
        turns: [
          {
            speaker: "owner",
            text: "Controlled question",
            expectRespond: true,
          },
        ],
      },
      platform: "web",
      ttsRoute: "/api/tts/cloud",
      client,
      audioCtx: {} as AudioContext,
      resolveTurnWav: async () => new Uint8Array([1]),
      playReply: async (_reply, _index, messageId) => {
        const common = { taskId: "controlled-task", atMs: 1 };
        return [
          {
            ...common,
            kind: "queued",
            generation: 1,
            text: "Complete reply",
            segment: "full",
            provider: "eliza-cloud",
            telemetry: {
              messageId: caseName === "wrong-turn" ? "another-turn" : messageId,
            },
          },
          {
            ...common,
            kind: "encoded",
            requestId: null,
            origin: "cache-unattributed",
            bytes: new Uint8Array([1, 2, 3]),
          },
          {
            ...common,
            kind: "decoded",
            bufferId: 1,
            sampleRate: 16000,
            channels: [new Float32Array([0.25, -0.25])],
          },
          {
            ...common,
            kind: "source-started",
            bufferId: caseName === "wrong-buffer" ? 2 : 1,
            audioTime: 0,
          },
          {
            ...common,
            kind: "terminal",
            taskId:
              caseName === "foreign-terminal" ? "another-task" : common.taskId,
            outcome:
              caseName === "deadline" ? "audio-clock-deadline" : "source-ended",
            audioTime: 1,
          },
        ];
      },
    });
    expect(report.turns[0]?.status).toBe(
      caseName === "valid" ? "pass" : "fail",
    );
    expect(report.turns[0]?.playbackEvidence).toHaveLength(5);
    if (caseName !== "valid")
      expect(report.turns[0]?.error).toContain(
        "provenance did not confirm this turn",
      );
  },
);
