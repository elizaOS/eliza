/**
 * Multi-turn voice SCENARIO player screen (?shellMode=voice-workbench).
 *
 * The headful half of the Voice Workbench (#8785). Renders OUTSIDE the app
 * chrome / onboarding gate (mounted directly by App.tsx like the self-test
 * shell), so it is reachable deterministically by a single URL param on web
 * (Vite), desktop (Electrobun renderer) and Android (Capacitor WebView) — the
 * SAME bundle covers all three platforms.
 *
 * It runs {@link runVoiceWorkbench} against the REAL production functions (no
 * mocks here) for whatever {@link WorkbenchScenario} the automation passes, shows
 * a per-turn PASS/FAIL/SKIPPED, and exposes:
 *   - `window.__voiceWorkbench(scenario)` -> Promise<VoiceWorkbenchReport> for e2e
 *   - a per-turn DOM mirror at [data-testid="voice-workbench-turn-<i>"] and an
 *     overall verdict at [data-testid="voice-workbench-overall"]
 * so an automated runner can scrape the verdict with no human in the loop.
 */

import { Capacitor } from "@capacitor/core";
import { ElizaError } from "@elizaos/common";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ElizaClient } from "../../api/client-base";
import { fetchWithCsrf } from "../../api/csrf-client";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import { isAndroid } from "../../platform/init";
import { resolveApiUrl } from "../../utils";
import { toSpeakableText } from "../voice-chat-playback";
import type { VoicePlaybackEvidenceEvent } from "../voice-playback-evidence";
import {
  serializeVoiceWorkbenchReport,
  voiceWorkbenchReportPreview,
} from "./voice-workbench-artifact";
import {
  runVoiceWorkbench,
  type VoiceWorkbenchPlatform,
  type VoiceWorkbenchReport,
  type WorkbenchScenario,
  type WorkbenchTurn,
} from "./voice-workbench-player";

declare global {
  interface Window {
    /** Legacy vendor-prefixed AudioContext (Safari / older WebKit). */
    webkitAudioContext?: typeof AudioContext;
    /** e2e automation hook — drives a WorkbenchScenario and returns its report. */
    __voiceWorkbench?: (
      scenario: WorkbenchScenario,
      options?: { playback?: boolean },
    ) => Promise<VoiceWorkbenchReport>;
  }
}

function detectPlatform(): VoiceWorkbenchPlatform {
  if (isAndroid) return "android";
  if (isElectrobunRuntime()) return "desktop";
  return "web";
}

function resolveTtsRoute(
  platform: VoiceWorkbenchPlatform,
): "/api/tts/local-inference" | "/api/tts/cloud" {
  // Desktop and Android run the on-device fused omnivoice TTS; only the web
  // build (no on-device inference engine) falls back to cloud TTS.
  return platform === "web" ? "/api/tts/cloud" : "/api/tts/local-inference";
}

function getAudioCtx(): AudioContext {
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext unavailable");
  return new Ctor();
}

/**
 * Corpus clip location for a turn: an explicit `audioRef` (relative to the
 * scenario corpus root) or a deterministic per-turn path. The corpus generator
 * writes `voice-corpus/<scenarioId>/turn-<i>.wav`; the e2e lanes route-mock
 * this path. A missing clip makes the fetch throw → the turn is `skipped`.
 */
function turnWavUrl(
  scenarioId: string,
  turn: WorkbenchTurn,
  index: number,
): string {
  const ref = turn.audioRef?.trim();
  const path = ref
    ? `/voice-corpus/${scenarioId}/${ref}`
    : `/voice-corpus/${scenarioId}/turn-${index}.wav`;
  return resolveApiUrl(path);
}

const STATUS_COLOR: Record<string, string> = {
  pass: "#2ec27e",
  fail: "#e5484d",
  skipped: "#9b9b9b",
};

export function VoiceWorkbenchShell() {
  const platform = useMemo(detectPlatform, []);
  const ttsRoute = useMemo(() => resolveTtsRoute(platform), [platform]);
  const clientRef = useRef<ElizaClient | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const [report, setReport] = useState<VoiceWorkbenchReport | null>(null);
  const [running, setRunning] = useState(false);
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null);
  const preview = useMemo(
    () => (report ? voiceWorkbenchReportPreview(report) : null),
    [report],
  );
  useEffect(() => {
    if (!report?.turns.some((turn) => turn.playbackEvidence)) {
      setArtifactUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([serializeVoiceWorkbenchReport(report)], {
        type: "application/json",
      }),
    );
    setArtifactUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [report]);
  const runningRef = useRef(false);
  const playbackRef = useRef<{
    messageId: string;
    taskId: string | null;
    events: VoicePlaybackEvidenceEvent[];
    resolve: (events: VoicePlaybackEvidenceEvent[]) => void;
  } | null>(null);
  const voiceConfig = useMemo(
    () => ({
      provider:
        ttsRoute === "/api/tts/cloud"
          ? ("eliza-cloud" as const)
          : ("local-inference" as const),
    }),
    [ttsRoute],
  );
  const voice = useVoiceChat({
    onTranscript: () => {},
    voiceConfig,
    onPlaybackEvidence(event) {
      const pending = playbackRef.current;
      if (!pending) return;
      if (
        event.kind === "queued" &&
        event.telemetry?.messageId === pending.messageId &&
        pending.taskId === null
      )
        pending.taskId = event.taskId;
      if (event.taskId !== pending.taskId) return;
      pending.events.push(event);
      if (event.kind === "terminal") {
        playbackRef.current = null;
        pending.resolve(pending.events);
      }
    },
  });
  const playReply = useCallback(
    (reply: string, _turnIndex: number, messageId: string) => {
      if (!toSpeakableText(reply))
        throw new ElizaError("The reply has no speakable content", {
          code: "VOICE_WORKBENCH_PLAYBACK_EMPTY",
        });
      if (Capacitor.isNativePlatform())
        throw new ElizaError(
          "Buffered playback evidence is unavailable for the native speech engine",
          { code: "VOICE_WORKBENCH_PLAYBACK_UNAVAILABLE" },
        );
      if (playbackRef.current)
        throw new ElizaError("A workbench playback is already active", {
          code: "VOICE_WORKBENCH_PLAYBACK_BUSY",
        });
      return new Promise<VoicePlaybackEvidenceEvent[]>((resolve) => {
        playbackRef.current = { messageId, taskId: null, events: [], resolve };
        try {
          voice.speak(reply, { telemetry: { messageId } });
        } catch (error) {
          // error-policy:J2 Release the workbench slot while preserving synchronous enqueue failure.
          playbackRef.current = null;
          throw error;
        }
      });
    },
    [voice.speak],
  );

  const run = useCallback(
    async (
      scenario: WorkbenchScenario,
      options?: { playback?: boolean },
    ): Promise<VoiceWorkbenchReport> => {
      if (runningRef.current)
        throw new ElizaError("A voice scenario is already running", {
          code: "VOICE_WORKBENCH_BUSY",
        });
      runningRef.current = true;
      setRunning(true);
      try {
        clientRef.current ??= new ElizaClient();
        audioRef.current ??= getAudioCtx();
        if (audioRef.current.state === "suspended") {
          // error-policy:J5 a dead AudioContext is observed in the report's
          // playback/TTS rows; the run itself must not abort here
          await audioRef.current.resume().catch(() => {});
        }
        const result = await runVoiceWorkbench({
          scenario,
          playReply: options?.playback ? playReply : undefined,
          platform,
          ttsRoute,
          ttsExtraBody:
            ttsRoute === "/api/tts/cloud"
              ? {
                  voiceId: "21m00Tcm4TlvDq8ikWAM",
                  modelId: "eleven_turbo_v2_5",
                }
              : undefined,
          resolveTurnWav: async (turn, index) => {
            const res = await fetchWithCsrf(
              turnWavUrl(scenario.id, turn, index),
              { method: "GET", headers: { Accept: "audio/*" } },
            );
            if (!res.ok) {
              throw new Error(
                `corpus clip ${turn.audioRef ?? `turn-${index}.wav`} ${res.status}`,
              );
            }
            return new Uint8Array(await res.arrayBuffer());
          },
          client: clientRef.current,
          audioCtx: audioRef.current,
        });
        setReport(result);
        return result;
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [platform, ttsRoute, playReply],
  );

  // Expose the player to automation. There is no default scenario — the runner
  // (or the e2e lane) supplies the WorkbenchScenario to drive.
  useEffect(() => {
    window.__voiceWorkbench = (scenario, options) => run(scenario, options);
    return () => {
      delete window.__voiceWorkbench;
    };
  }, [run]);

  return (
    <div
      data-testid="voice-workbench-shell"
      data-overall={report?.overall ?? "pending"}
      style={{
        position: "fixed",
        inset: 0,
        background: "#0b0b0b",
        color: "#e8e8e8",
        font: "14px ui-monospace, monospace",
        padding: 24,
        overflow: "auto",
      }}
    >
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Voice workbench</h1>
      <div style={{ color: "#9b9b9b", marginBottom: 16 }}>
        platform={platform} · ttsRoute={ttsRoute}
        {report ? ` · scenario=${report.scenarioId}` : ""}
        {report ? ` · classes=${report.classes.join(",")}` : ""}
      </div>

      <div
        data-testid="voice-workbench-overall"
        data-overall={report?.overall ?? "pending"}
        data-diarization-status={report?.diarization.status ?? "pending"}
        data-der={report?.diarization.der ?? ""}
        data-max-der={report?.diarization.maxDer ?? ""}
        data-running={running ? "1" : "0"}
        style={{
          fontSize: 16,
          fontWeight: 700,
          marginBottom: 12,
          color: report
            ? (STATUS_COLOR[report.overall] ?? "#e8e8e8")
            : "#9b9b9b",
        }}
      >
        overall: {report?.overall ?? "pending"}
      </div>

      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {(report?.turns ?? []).map((t) => (
          <li
            key={t.index}
            data-testid={`voice-workbench-turn-${t.index}`}
            data-status={t.status}
            data-speaker={t.speaker}
            data-predicted-speaker-label={t.predictedSpeakerLabel ?? ""}
            data-expected-speaker-label={t.expectedSpeakerLabel}
            data-responded={t.responded ? "1" : "0"}
            data-expect-respond={t.expectRespond ? "1" : "0"}
            style={{ marginBottom: 6 }}
          >
            <span style={{ color: STATUS_COLOR[t.status] ?? "#e8e8e8" }}>
              [{t.status}]
            </span>{" "}
            turn {t.index} · {t.speaker} ({t.durationMs}ms)
            {t.error ? ` — ${t.error}` : ""}
          </li>
        ))}
      </ul>

      {artifactUrl && (
        <div>
          <p>
            Metadata preview. The download includes complete encoded audio and
            decoded PCM.
          </p>
          <a
            href={artifactUrl}
            download="voice-workbench-evidence.json"
            className="keyboard-focus-surface inline-block rounded bg-orange-600 px-3 py-2 text-white hover:bg-orange-700"
          >
            Download complete playback evidence
          </a>
        </div>
      )}
      {/* Full typed values remain in the automation return and downloadable artifact. */}
      <pre
        data-testid="voice-workbench-report"
        data-evidence="metadata-preview"
        style={{
          maxHeight: 480,
          overflow: "auto",
          marginTop: 16,
          padding: 12,
          background: "#141414",
          borderRadius: 6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {preview ? JSON.stringify(preview, null, 2) : "{}"}
      </pre>
    </div>
  );
}

export default VoiceWorkbenchShell;
