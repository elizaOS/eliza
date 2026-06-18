/**
 * Self-driving voice round-trip test screen (?shellMode=voice-selftest).
 *
 * Renders OUTSIDE the app chrome / onboarding gate (mounted directly by App.tsx
 * like the chat-overlay shell), so it is reachable deterministically by a single
 * URL param on web (Vite), desktop (Electrobun renderer) and Android (Capacitor
 * WebView) — the SAME bundle covers all three platforms.
 *
 * It runs {@link runVoiceSelfTest} against the REAL production functions (no
 * mocks here), shows a per-stage PASS/FAIL, and exposes:
 *   - `window.__voiceSelfTest(opts?)` -> Promise<VoiceSelfTestReport> for e2e
 *   - a DOM-mirrored JSON report at [data-testid="voice-selftest-report"]
 * so an automated runner can scrape the verdict with no human in the loop.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ElizaClient } from "../../api/client-base";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import { isAndroid } from "../../platform/init";
import {
  EXPECTED_PHRASE,
  KNOWN_PHRASE_WAV_DATA_URL,
} from "./fixtures/known-phrase";
import {
  runVoiceSelfTest,
  type VoiceSelfTestMode,
  type VoiceSelfTestPlatform,
  type VoiceSelfTestReport,
} from "./voice-selftest-harness";

function detectPlatform(): VoiceSelfTestPlatform {
  if (isAndroid) return "android";
  if (isElectrobunRuntime()) return "desktop";
  return "web";
}

function resolveTtsRoute(
  platform: VoiceSelfTestPlatform,
): "/api/tts/local-inference" | "/api/tts/cloud" {
  // Desktop and Android both run the on-device fused omnivoice TTS, so the
  // self-test exercises the real local voice path on those platforms. Only the
  // web build (no on-device inference engine) falls back to cloud TTS.
  return platform === "web" ? "/api/tts/cloud" : "/api/tts/local-inference";
}

function getAudioCtx(): AudioContext {
  const Ctor =
    (window as unknown as { AudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext unavailable");
  return new Ctor();
}

const STATUS_COLOR: Record<string, string> = {
  pass: "#2ec27e",
  fail: "#e5484d",
  skipped: "#9b9b9b",
};

export function VoiceSelfTestShell() {
  const platform = useMemo(detectPlatform, []);
  const ttsRoute = useMemo(() => resolveTtsRoute(platform), [platform]);
  const clientRef = useRef<ElizaClient | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const [report, setReport] = useState<VoiceSelfTestReport | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(
    async (
      mode: VoiceSelfTestMode = "wav-direct",
    ): Promise<VoiceSelfTestReport> => {
      setRunning(true);
      try {
        clientRef.current ??= new ElizaClient();
        audioRef.current ??= getAudioCtx();
        if (audioRef.current.state === "suspended") {
          await audioRef.current.resume().catch(() => {});
        }
        const result = await runVoiceSelfTest({
          platform,
          mode,
          fixtureUrl: KNOWN_PHRASE_WAV_DATA_URL,
          expectedPhrase: EXPECTED_PHRASE,
          ttsRoute,
          ttsExtraBody:
            ttsRoute === "/api/tts/cloud"
              ? {
                  voiceId: "21m00Tcm4TlvDq8ikWAM",
                  modelId: "eleven_turbo_v2_5",
                }
              : undefined,
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

  // Expose the harness to automation + auto-run once on mount.
  useEffect(() => {
    (
      window as unknown as {
        __voiceSelfTest?: (opts?: {
          mode?: VoiceSelfTestMode;
        }) => Promise<VoiceSelfTestReport>;
      }
    ).__voiceSelfTest = (opts) => run(opts?.mode ?? "wav-direct");
    void run("wav-direct");
  }, [run]);

  return (
    <div
      data-testid="voice-selftest-shell"
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
      <h1 style={{ fontSize: 18, marginBottom: 4 }}>Voice self-test</h1>
      <div style={{ color: "#9b9b9b", marginBottom: 16 }}>
        platform={platform} · ttsRoute={ttsRoute} · phrase="{EXPECTED_PHRASE}"
      </div>

      <div style={{ marginBottom: 16 }}>
        <button
          type="button"
          data-testid="voice-selftest-run"
          disabled={running}
          onClick={() => void run("wav-direct")}
          style={{
            background: "#e8772e",
            color: "#0b0b0b",
            border: 0,
            borderRadius: 6,
            padding: "8px 14px",
            cursor: running ? "default" : "pointer",
            marginRight: 8,
          }}
        >
          {running ? "Running…" : "Run self-test"}
        </button>
        <button
          type="button"
          data-testid="voice-selftest-run-mic"
          disabled={running}
          onClick={() => void run("mic-capture")}
          style={{
            background: "transparent",
            color: "#e8e8e8",
            border: "1px solid #333",
            borderRadius: 6,
            padding: "8px 14px",
            cursor: running ? "default" : "pointer",
          }}
        >
          Run with mic capture
        </button>
      </div>

      <div
        data-testid="voice-selftest-overall"
        data-overall={report?.overall ?? "pending"}
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
        {(report?.stages ?? []).map((s) => (
          <li
            key={s.stage}
            data-testid={`voice-selftest-stage-${s.stage}`}
            data-status={s.status}
            style={{ marginBottom: 6 }}
          >
            <span style={{ color: STATUS_COLOR[s.status] ?? "#e8e8e8" }}>
              [{s.status}]
            </span>{" "}
            {s.stage} ({s.durationMs}ms){s.error ? ` — ${s.error}` : ""}
          </li>
        ))}
      </ul>

      {/* Machine-readable verdict for CI/Playwright to scrape. */}
      <pre
        data-testid="voice-selftest-report"
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

export default VoiceSelfTestShell;
