/**
 * Multi-turn voice SCENARIO player — the headful half of the Voice Workbench
 * (#8785). Where {@link runVoiceSelfTest} drives ONE phrase through the real
 * client pipeline, this drives an ordered {@link VoiceScenario} turn-by-turn
 * through the SAME real production functions (transcribeLocalInferenceWav,
 * ElizaClient.sendConversationMessageStream, a real TTS fetch +
 * AudioContext.decodeAudioData), honouring injected pauses and scoring every
 * turn against the scenario's ground truth (expected transcript, respond
 * decision, speaker label, entity).
 *
 * Reused by:
 *   - the in-app voice workbench screen (?shellMode=voice-workbench)
 *   - the web / android / desktop e2e lanes (they navigate to that screen and
 *     scrape `window.__voiceWorkbench(scenario)` / the DOM-mirrored report).
 *
 * Honesty contract (identical to the self-test): a turn whose backend / corpus
 * artifact is genuinely absent on this host reports `skipped` — NEVER `pass` —
 * so CI can tell "can't run here" from "verified working" and never false-green.
 *
 * Scenario type: the canonical `VoiceScenario` schema lives in
 * `@elizaos/plugin-local-inference` (`src/services/voice/voice-scenario.ts`).
 * That plugin depends inward on `@elizaos/ui`; importing it back here would
 * invert the dependency direction, so we mirror the exact transport shape as a
 * local structural type. The plugin's `validateVoiceScenario` remains the single
 * source of truth for cross-field validity; the player only reads the fields it
 * drives and never re-implements scenario validation.
 */

import { wordErrorRate } from "@elizaos/shared/voice-wer";
import type { ElizaClient } from "../../api/client-base";
import { fetchWithCsrf } from "../../api/csrf-client";
import { resolveApiUrl } from "../../utils";
import {
  isLocalInferenceAsrReady,
  transcribeLocalInferenceWav,
} from "../local-asr-transcribe";
import { now, sleep } from "./timing";

export type TurnStatus = "pass" | "fail" | "skipped";

/** Structural mirror of `VoiceScenarioParticipant` (@elizaos/plugin-local-inference). */
export interface WorkbenchParticipant {
  label: string;
  ttsVoiceId?: string;
  entityId?: string;
  isOwner?: boolean;
}

/** Structural mirror of `VoiceScenarioTurn` (@elizaos/plugin-local-inference). */
export interface WorkbenchTurn {
  /** Ground-truth speaker identity that synthesized this turn's audio. */
  speaker: string;
  text?: string;
  audioRef?: string;
  ttsVoiceId?: string;
  pausesMs?: number[];
  expectRespond: boolean;
  expectedTranscript?: string;
  expectedSpeakerLabel?: string;
  expectedEntity?: string;
}

/** Structural mirror of `VoiceScenario` (@elizaos/plugin-local-inference). */
export interface WorkbenchScenario {
  id: string;
  description?: string;
  classes: string[];
  participants: WorkbenchParticipant[];
  turns: WorkbenchTurn[];
  agents?: string[];
}

export type VoiceWorkbenchPlatform = "web" | "android" | "desktop";

/** A single scored turn of the scenario. */
export interface VoiceWorkbenchTurnReport {
  index: number;
  speaker: string;
  expectedSpeakerLabel: string;
  predictedSpeakerLabel: string | null;
  status: TurnStatus;
  /** Did the real client pipeline produce a reply for this turn? */
  responded: boolean;
  /** Ground-truth respond decision for this turn. */
  expectRespond: boolean;
  /** ASR transcript for this turn (empty when ASR was skipped). */
  transcript: string;
  /** Expected ASR reference (explicit `expectedTranscript` or the turn text). */
  expectedTranscript: string;
  /** Agent reply text ("" when the agent did not respond / send was skipped). */
  reply: string;
  durationMs: number;
  detail: Record<string, string | number | boolean>;
  error?: string;
}

export interface VoiceWorkbenchReport {
  schemaVersion: 1;
  overall: "pass" | "fail" | "skipped";
  scenarioId: string;
  classes: string[];
  platform: VoiceWorkbenchPlatform;
  ttsRoute: string;
  startedAt: string;
  finishedAt: string;
  turns: VoiceWorkbenchTurnReport[];
  diarization: {
    status: TurnStatus;
    /** Turns with a real attribution output (the DER denominator). */
    total: number;
    der: number;
    confusions: number;
    /** Turns with no attribution output — no diarizer ran; excluded from DER. */
    unattributed: number;
    maxDer: number;
    /** Did any turn carry a real attribution output? When false the gate is
     * SKIPPED (no diarizer on this host), distinct from a real DER failure. */
    evaluated: boolean;
    passed: boolean;
    reason?: string;
  };
}

export interface VoiceWorkbenchOptions {
  scenario: WorkbenchScenario;
  platform: VoiceWorkbenchPlatform;
  /**
   * Resolves a turn to a decodable WAV (`Uint8Array`). The corpus generator
   * synthesizes one clip per turn; the player fetches it by `audioRef` or by a
   * deterministic per-turn url. When a turn's clip is absent the resolver
   * throws and the turn is reported `skipped`, never `pass`.
   */
  resolveTurnWav: (turn: WorkbenchTurn, index: number) => Promise<Uint8Array>;
  /**
   * Resolve the PREDICTED speaker label for a turn from an actual
   * diarization/speaker-attribution output. When provided, its result — NOT the
   * scenario's ground-truth `speaker` — drives the diarization gate, so the gate
   * fails on a real misattribution. Return `null` when the model can't attribute
   * the turn (unattributed: excluded from DER, the gate reports skipped, never a
   * pass). When absent, the player records no predicted speaker label; it never
   * falls back to `speaker`.
   */
  resolvePredictedSpeakerLabel?: (
    turn: WorkbenchTurn,
    index: number,
    wav: Uint8Array,
  ) => Promise<string | null> | string | null;
  /** TTS route to exercise. local for desktop/android, cloud for web. */
  ttsRoute: "/api/tts/local-inference" | "/api/tts/cloud";
  /** Extra TTS body fields (e.g. voiceId/modelId for the cloud route). */
  ttsExtraBody?: Record<string, unknown>;
  /** Max word-error-rate a turn's ASR transcript may have vs its reference. */
  werTolerance?: number;
  client: ElizaClient;
  audioCtx: AudioContext;
  signal?: AbortSignal;
}

/** The expected ASR reference for a turn (explicit override or its text). */
function turnReference(turn: WorkbenchTurn): string {
  return (turn.expectedTranscript ?? turn.text ?? "").trim();
}

/** Expected diarization label for a turn (explicit override or speaker). */
function turnSpeakerLabel(turn: WorkbenchTurn): string {
  return (turn.expectedSpeakerLabel ?? turn.speaker).trim();
}

/**
 * Peak + RMS amplitude across every channel of a decoded buffer. A buffer of
 * pure silence decodes fine and reports a positive `duration`, so duration
 * alone never proves the TTS produced audible sound — these levels do.
 */
function measureBufferLevel(buffer: AudioBuffer): {
  peak: number;
  rms: number;
} {
  let peak = 0;
  let sumSquares = 0;
  let count = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i] ?? 0);
      if (v > peak) peak = v;
      sumSquares += v * v;
      count += 1;
    }
  }
  return { peak, rms: count > 0 ? Math.sqrt(sumSquares / count) : 0 };
}

/** Decode + amplitude-check a synthesized reply clip; "" reply yields no clip. */
async function synthesizeReply(
  opts: VoiceWorkbenchOptions,
  reply: string,
): Promise<{ ok: boolean; detail: Record<string, number>; error?: string }> {
  const res = await fetchWithCsrf(resolveApiUrl(opts.ttsRoute), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "audio/*" },
    body: JSON.stringify({ text: reply, ...(opts.ttsExtraBody ?? {}) }),
    signal: opts.signal,
  });
  if (!res.ok) {
    return {
      ok: false,
      detail: { ttsStatus: res.status },
      error: `TTS ${opts.ttsRoute} returned ${res.status}`,
    };
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength === 0) {
    return {
      ok: false,
      detail: { audioBytes: 0 },
      error: "TTS returned empty audio",
    };
  }
  const audioBuffer = await opts.audioCtx.decodeAudioData(bytes.slice(0));
  const { peak, rms } = measureBufferLevel(audioBuffer);
  // Require real signal, not just a positive duration: a silent (all-zero)
  // buffer decodes fine and would otherwise false-green.
  const nonSilent = peak >= 0.02 && rms >= 1e-4;
  const ok = audioBuffer.duration > 0 && nonSilent;
  return {
    ok,
    detail: {
      audioBytes: bytes.byteLength,
      durationSec: Number(audioBuffer.duration.toFixed(3)),
      peak: Number(peak.toFixed(4)),
      rms: Number(rms.toFixed(5)),
    },
    error: ok
      ? undefined
      : !nonSilent
        ? `TTS audio is silent (peak=${peak.toFixed(4)}, rms=${rms.toFixed(5)})`
        : "decoded audio has zero duration",
  };
}

/**
 * Drive ONE scenario turn through the real client pipeline:
 *   ASR (turn audio -> transcript)
 *   SEND (transcript -> agent reply over real SSE; reply "" == "did not respond")
 *   TTS (reply text -> decodable audio; only when the agent responded)
 * then score the respond decision + transcript WER against ground truth.
 */
async function runTurn(
  opts: VoiceWorkbenchOptions,
  turn: WorkbenchTurn,
  index: number,
  conversationId: string,
): Promise<VoiceWorkbenchTurnReport> {
  const t0 = now();
  const expectedTranscript = turnReference(turn);
  const expectedSpeakerLabel = turnSpeakerLabel(turn);
  const werTolerance = opts.werTolerance ?? 0.34;

  let wav: Uint8Array;
  try {
    wav = await opts.resolveTurnWav(turn, index);
  } catch (error) {
    // error-policy:J4 no corpus clip for this turn on this host — an
    // explicit "skipped" row, never a fabricated pass
    return {
      index,
      speaker: turn.speaker,
      expectedSpeakerLabel,
      predictedSpeakerLabel: null,
      status: "skipped",
      responded: false,
      expectRespond: turn.expectRespond,
      transcript: "",
      expectedTranscript,
      reply: "",
      durationMs: Math.round(now() - t0),
      detail: { reason: "turn audio clip not available on this host" },
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let predictedSpeakerLabel: string | null = null;
  let speakerAttributionRan = false;
  try {
    if (opts.resolvePredictedSpeakerLabel) {
      const label = await opts.resolvePredictedSpeakerLabel(turn, index, wav);
      predictedSpeakerLabel = label?.trim() || null;
      speakerAttributionRan = predictedSpeakerLabel !== null;
    }
  } catch (error) {
    // error-policy:J1 turn boundary — failure becomes an explicit fail row
    return {
      index,
      speaker: turn.speaker,
      expectedSpeakerLabel,
      predictedSpeakerLabel: null,
      status: "fail",
      responded: false,
      expectRespond: turn.expectRespond,
      transcript: "",
      expectedTranscript,
      reply: "",
      durationMs: Math.round(now() - t0),
      detail: { stage: "speaker-attribution" },
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const speakerLabelOk =
    !speakerAttributionRan || predictedSpeakerLabel === expectedSpeakerLabel;

  let transcript = "";
  try {
    const result = await transcribeLocalInferenceWav(wav, {
      signal: opts.signal,
    });
    transcript = result.text;
  } catch (error) {
    // error-policy:J1 turn boundary — failure becomes an explicit fail row
    return {
      index,
      speaker: turn.speaker,
      expectedSpeakerLabel,
      predictedSpeakerLabel,
      status: "fail",
      responded: false,
      expectRespond: turn.expectRespond,
      transcript: "",
      expectedTranscript,
      reply: "",
      durationMs: Math.round(now() - t0),
      detail: { stage: "asr" },
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const wer = expectedTranscript
    ? wordErrorRate(expectedTranscript, transcript)
    : 0;
  const transcriptOk = wer <= werTolerance;

  // SEND: the same conversation across turns so context (and the respond
  // decision) carries forward exactly as it does in a real voice session.
  let reply = "";
  let completed = false;
  let agentName = "";
  let noResponseReason: string | undefined;
  try {
    const send = await opts.client.sendConversationMessageStream(
      conversationId,
      transcript,
      () => {},
      "VOICE_DM",
      opts.signal,
    );
    reply = (send.text ?? "").trim();
    completed = send.completed;
    agentName = send.agentName;
    noResponseReason = send.noResponseReason;
  } catch (error) {
    // error-policy:J1 turn boundary — failure becomes an explicit fail row
    return {
      index,
      speaker: turn.speaker,
      expectedSpeakerLabel,
      predictedSpeakerLabel,
      status: "fail",
      responded: false,
      expectRespond: turn.expectRespond,
      transcript,
      expectedTranscript,
      reply: "",
      durationMs: Math.round(now() - t0),
      detail: { stage: "send", wer: Number(wer.toFixed(3)) },
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const responded = completed && reply.length > 0;
  const respondDecisionOk = responded === turn.expectRespond;

  // TTS only runs when the agent actually replied — a no-respond turn has
  // nothing to synthesize, and that absence is correct, not a failure.
  let ttsDetail: Record<string, number> = {};
  let ttsOk = true;
  let ttsError: string | undefined;
  if (responded) {
    try {
      const tts = await synthesizeReply(opts, reply);
      ttsDetail = tts.detail;
      ttsOk = tts.ok;
      ttsError = tts.error;
    } catch (error) {
      // error-policy:J1 stage boundary — failure is recorded on the turn row
      ttsOk = false;
      ttsError = error instanceof Error ? error.message : String(error);
    }
  }

  // Inject this turn's silent pauses AFTER the round-trip so the next turn is
  // separated by the scenario's declared gap (barge-in / EOT timing).
  if (turn.pausesMs?.length) {
    for (const ms of turn.pausesMs) {
      if (opts.signal?.aborted) break;
      await sleep(Math.max(0, Math.min(ms, 2_000)));
    }
  }

  const ok =
    transcriptOk &&
    respondDecisionOk &&
    ttsOk &&
    (!speakerAttributionRan || speakerLabelOk);
  const detail: Record<string, string | number | boolean> = {
    transcript,
    expectedTranscript,
    wer: Number(wer.toFixed(3)),
    werTolerance,
    responded,
    expectRespond: turn.expectRespond,
    respondDecisionOk,
    predictedSpeakerLabel: predictedSpeakerLabel ?? "",
    expectedSpeakerLabel,
    speakerLabelOk,
    speakerAttributionRan,
    completed,
    agentName,
    ...ttsDetail,
  };
  if (noResponseReason) detail.noResponseReason = noResponseReason;
  if (turn.pausesMs?.length) {
    detail.pausesMs = turn.pausesMs.join(",");
  }
  if (turn.expectedEntity) detail.expectedEntity = turn.expectedEntity;

  return {
    index,
    speaker: turn.speaker,
    expectedSpeakerLabel,
    predictedSpeakerLabel,
    status: ok ? "pass" : "fail",
    responded,
    expectRespond: turn.expectRespond,
    transcript,
    expectedTranscript,
    reply,
    durationMs: Math.round(now() - t0),
    detail,
    error: ok
      ? undefined
      : !transcriptOk
        ? `ASR WER ${wer.toFixed(3)} exceeds tolerance ${werTolerance}`
        : !respondDecisionOk
          ? `respond decision: got ${responded}, expected ${turn.expectRespond}`
          : speakerAttributionRan && !speakerLabelOk
            ? `speaker label: got ${predictedSpeakerLabel ?? "null"}, expected ${expectedSpeakerLabel}`
            : (ttsError ?? "turn failed"),
  };
}

export function scoreWorkbenchDiarization(
  turns: ReadonlyArray<VoiceWorkbenchTurnReport>,
  maxDer = 0.2,
): VoiceWorkbenchReport["diarization"] {
  const ran = turns.filter((turn) => turn.status !== "skipped");
  // A null prediction means no attribution model ran on this turn (no diarizer
  // available on this host / scenario). Such turns are UNATTRIBUTED — excluded
  // from DER, never scored as a confusion. The gate reports `skipped` (evaluated
  // === false) when nothing was attributed, never a false pass and never a
  // spurious failure that would block a diarizer-less host (#9147, #9427).
  const attributed = ran.filter((turn) => turn.predictedSpeakerLabel !== null);
  let confusions = 0;
  for (const turn of attributed) {
    if (turn.predictedSpeakerLabel !== turn.expectedSpeakerLabel)
      confusions += 1;
  }
  const total = attributed.length;
  const der = total > 0 ? confusions / total : 0;
  const evaluated = total > 0;
  const passed = evaluated && der <= maxDer;
  return {
    status: evaluated ? (passed ? "pass" : "fail") : "skipped",
    total,
    der: Number(der.toFixed(4)),
    confusions,
    unattributed: ran.length - attributed.length,
    maxDer,
    evaluated,
    passed,
    ...(evaluated
      ? {}
      : {
          reason:
            ran.length > 0
              ? "real speaker attribution is not available on this host"
              : "no non-skipped turns available for diarization scoring",
        }),
  };
}

export async function runVoiceWorkbench(
  opts: VoiceWorkbenchOptions,
): Promise<VoiceWorkbenchReport> {
  const { scenario } = opts;
  const startedAt = new Date().toISOString();
  const base: Omit<
    VoiceWorkbenchReport,
    "overall" | "finishedAt" | "turns" | "diarization"
  > = {
    schemaVersion: 1,
    scenarioId: scenario.id,
    classes: scenario.classes,
    platform: opts.platform,
    ttsRoute: opts.ttsRoute,
    startedAt,
  };

  // If ASR genuinely cannot run on this host, every turn is `skipped` — the
  // whole scenario reports `skipped`, never a false `pass`.
  if (!(await isLocalInferenceAsrReady({ signal: opts.signal }))) {
    const turns: VoiceWorkbenchTurnReport[] = scenario.turns.map((t, i) => ({
      index: i,
      speaker: t.speaker,
      expectedSpeakerLabel: turnSpeakerLabel(t),
      predictedSpeakerLabel: null,
      status: "skipped",
      responded: false,
      expectRespond: t.expectRespond,
      transcript: "",
      expectedTranscript: turnReference(t),
      reply: "",
      durationMs: 0,
      detail: { reason: "local-inference ASR not ready on this host" },
    }));
    return {
      ...base,
      overall: "skipped",
      finishedAt: new Date().toISOString(),
      turns,
      diarization: scoreWorkbenchDiarization(turns),
    };
  }

  const { conversation } = await opts.client.createConversation(
    `voice-workbench:${scenario.id}`,
  );

  const turns: VoiceWorkbenchTurnReport[] = [];
  for (let i = 0; i < scenario.turns.length; i += 1) {
    if (opts.signal?.aborted) break;
    turns.push(await runTurn(opts, scenario.turns[i], i, conversation.id));
  }

  const diarization = scoreWorkbenchDiarization(turns);
  const hasFail = turns.some((t) => t.status === "fail");
  const allSkipped =
    turns.length > 0 && turns.every((t) => t.status === "skipped");
  const requiresDiarization = scenario.classes.includes("diarization");
  let overall: VoiceWorkbenchReport["overall"] = "pass";
  if (hasFail || diarization.status === "fail") {
    overall = "fail";
  } else if (
    allSkipped ||
    (requiresDiarization && diarization.status === "skipped")
  ) {
    overall = "skipped";
  }

  return {
    ...base,
    overall,
    finishedAt: new Date().toISOString(),
    turns,
    diarization,
  };
}
