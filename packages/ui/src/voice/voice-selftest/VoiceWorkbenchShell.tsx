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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ElizaClient } from "../../api/client-base";
import { fetchWithCsrf } from "../../api/csrf-client";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { isAndroid } from "../../platform/init";
import { resolveApiUrl } from "../../utils";
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

  const run = useCallback(
    async (scenario: WorkbenchScenario): Promise<VoiceWorkbenchReport> => {
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
        setRunning(false);
      }
    },
    [platform, ttsRoute],
  );

  // Expose the player to automation. There is no default scenario — the runner
  // (or the e2e lane) supplies the WorkbenchScenario to drive.
  useEffect(() => {
    window.__voiceWorkbench = (scenario) => run(scenario);
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

      {/* Machine-readable verdict for CI/Playwright to scrape. */}
      <pre
        data-testid="voice-workbench-report"
        style={{
          marginTop: 16,
          padding: 12,
          background: "#141414",
          borderRadius: 6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {report ? JSON.stringify(report, null, 2) : "{}"}
      </pre>
    </div>
  );
}

export default VoiceWorkbenchShell;
