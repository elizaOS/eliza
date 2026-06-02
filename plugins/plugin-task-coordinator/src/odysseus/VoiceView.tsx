// odysseus Voice & speech panel (static/js/tts-ai.js + static/js/voiceRecorder.js
// + the #recording-indicator / #mic-btn rules in style.css). Two stacked
// sections, 1:1 with the odysseus voice surface:
//   • TTS — a provider chip + voice picker (PREMADE / EDGE_BACKUP presets) and a
//     Speak / Stop control. odysseus drove this off AITTSManager → /api/tts/*;
//     the eliza equivalent is the REAL client.getStreamVoice / saveStreamVoice /
//     streamVoiceSpeak surface (the same one the companion voice-pill uses).
//   • Recorder — odysseus's voiceRecorder.js mic UI: a record button, a live
//     bar-waveform fed by the capture analyser, an MM:SS timer, and the inline
//     "Recording…" indicator. Backed by the REAL createVoiceCapture() factory
//     (local-inference ASR with browser-SpeechRecognition fallback), which
//     emits transcript segments — never fabricated audio.
//
// elizaMapping: getStreamVoice() reports whether a voice backend is attached on
// THIS surface. The orchestrator agent is a coding-agent surface and usually has
// no voice service wired, so when getStreamVoice() reports the service absent
// (not enabled, no provider, not attached) the TTS section renders odysseus's
// honest disabled state instead of pretending audio exists. The recorder is
// gated on secure-context + getUserMedia exactly as voiceRecorder.js gated it.

import {
  client,
  createVoiceCapture,
  EDGE_BACKUP_VOICES,
  PREMADE_VOICES,
  VOICE_PROVIDERS,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
  type VoicePreset,
} from "@elizaos/ui";
import {
  AlertCircle,
  Loader2,
  Mic,
  Play,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

// localStorage key for the picked TTS voice preset — odysseus persisted the
// chosen voice in user settings; the orchestrator has no voice-settings backend
// so the selection is a local pref, owned by this view.
const VOICE_PRESET_KEY = "voice-tts-preset";

// Provider → voice-preset list, matching odysseus's voice picker (ElevenLabs
// gets the full PREMADE catalogue; Edge / local-inference get the trimmed
// EDGE_BACKUP pair, per voice.ts EDGE_BACKUP_VOICES intent).
function voicesForProvider(provider: string | null): VoicePreset[] {
  if (provider === "elevenlabs") return PREMADE_VOICES;
  return EDGE_BACKUP_VOICES;
}

// Live TTS-service status as reported by client.getStreamVoice(). `loading`
// while the probe is in flight; `ready` only when the service says a backend is
// actually attached and enabled — otherwise the honest disabled state shows.
interface VoiceStatus {
  loading: boolean;
  enabled: boolean;
  provider: string | null;
  configuredProvider: string | null;
  hasApiKey: boolean;
  attached: boolean;
}

const INITIAL_STATUS: VoiceStatus = {
  loading: true,
  enabled: false,
  provider: null,
  configuredProvider: null,
  hasApiKey: false,
  attached: false,
};

// MM:SS, matching voiceRecorder.js formatTime().
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

// Number of waveform bars rendered while recording (odysseus drew a 28-bar
// animated meter in the recording indicator). The live values are driven by the
// capture analyser when one is exposed; with no analyser the bars sit flat.
const WAVE_BARS = 28;

export function VoiceView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-voice", { w: 460, h: 640 });

  // ── TTS state ──
  const [status, setStatus] = useState<VoiceStatus>(INITIAL_STATUS);
  const [voiceId, setVoiceId] = useState<string>(() =>
    readPref<string>(VOICE_PRESET_KEY, ""),
  );
  const [ttsText, setTtsText] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);

  // ── Recorder state ──
  const [recState, setRecState] = useState<VoiceCaptureState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [recError, setRecError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(WAVE_BARS).fill(0),
  );

  const captureRef = useRef<VoiceCaptureHandle | null>(null);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  // Probe the real voice service when the panel opens (client.getStreamVoice()).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus(INITIAL_STATUS);
    void client
      .getStreamVoice()
      .then((res) => {
        if (cancelled) return;
        setStatus({
          loading: false,
          enabled: res.enabled,
          provider: res.provider,
          configuredProvider: res.configuredProvider,
          hasApiKey: res.hasApiKey,
          attached: res.isAttached,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setStatus({
          loading: false,
          enabled: false,
          provider: null,
          configuredProvider: null,
          hasApiKey: false,
          attached: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Tear down the live capture + its loops whenever the panel closes.
  useEffect(() => {
    if (open) return;
    const handle = captureRef.current;
    if (handle) {
      handle.dispose();
      captureRef.current = null;
    }
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [open]);

  if (!open) return null;

  const ttsAvailable = !status.loading && status.enabled && status.attached;
  const voices = voicesForProvider(
    status.provider ?? status.configuredProvider,
  );
  const selectedVoice =
    voices.find((v) => v.id === voiceId) ?? voices[0] ?? null;
  const recording = recState === "listening" || recState === "starting";

  const providerLabel = (() => {
    const id = status.provider ?? status.configuredProvider;
    if (!id) return "None";
    const match = VOICE_PROVIDERS.find((p) => p.id === id);
    return match ? match.label : id;
  })();

  const pickVoice = (id: string) => {
    setVoiceId(id);
    writePref(VOICE_PRESET_KEY, id);
  };

  const speak = () => {
    const text = ttsText.trim();
    if (!text || !ttsAvailable || speaking) return;
    setTtsError(null);
    setSpeaking(true);
    void client
      .streamVoiceSpeak(text)
      .then((res) => {
        setSpeaking(res.speaking);
      })
      .catch((err: unknown) => {
        setTtsError(err instanceof Error ? err.message : "Speak failed");
        setSpeaking(false);
      });
  };

  const stopSpeaking = () => {
    setSpeaking(false);
    // Asking the service to speak an empty turn is its documented "cut current
    // audio" path; ignore the result since we've already reset local state.
    void client.streamVoiceSpeak("").catch(() => {});
  };

  // Sample the analyser into the bar meter on each animation frame, exactly the
  // role odysseus's recording-indicator waveform played. Only the
  // local-inference backend taps the mic stream and exposes an analyser; the
  // browser SpeechRecognition fallback has no audio graph (getAnalyser() →
  // null), so we let the loop die instead of spinning a no-op rAF every frame
  // for the whole recording.
  const pumpWave = () => {
    const handle = captureRef.current;
    const analyser = handle ? handle.getAnalyser() : null;
    if (!analyser) {
      rafRef.current = null;
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const step = Math.max(1, Math.floor(data.length / WAVE_BARS));
    const next: number[] = [];
    for (let i = 0; i < WAVE_BARS; i += 1) {
      const v = data[i * step];
      next.push(Math.min(1, v / 255));
    }
    setLevels(next);
    rafRef.current = window.requestAnimationFrame(pumpWave);
  };

  // Kick the waveform loop only once an analyser is actually live. The analyser
  // is created by the backend during start(), so we arm the loop after start()
  // resolves; if the backend exposes no analyser (browser fallback) pumpWave
  // bails on its first tick and the loop stays dead.
  const armWave = () => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(pumpWave);
  };

  const startRecording = () => {
    if (recording) return;
    setRecError(null);
    setTranscript("");
    setInterim("");
    setElapsed(0);

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setRecError(
        "Microphone requires HTTPS. Use a reverse proxy with SSL or access via localhost.",
      );
      setRecState("error");
      return;
    }
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setRecError("Microphone not supported in this browser.");
      setRecState("error");
      return;
    }

    const handle = createVoiceCapture({
      onTranscript: (segment) => {
        if (segment.final) {
          setTranscript((prev) =>
            prev ? `${prev} ${segment.text}` : segment.text,
          );
          setInterim("");
        } else {
          setInterim(segment.text);
        }
      },
      onStateChange: (state, error) => {
        setRecState(state);
        if (state === "error" && error) setRecError(error.message);
      },
    });
    captureRef.current = handle;

    void handle
      .start()
      .then(() => {
        // The backend creates its analyser during start(); arm the waveform
        // loop now that one may be live. pumpWave self-terminates on the first
        // tick when the active backend exposes none (browser fallback).
        armWave();
      })
      .catch(() => {
        // start() already surfaced the error via onStateChange("error", …).
      });

    timerRef.current = window.setInterval(() => {
      setElapsed((prev) => prev + 1);
    }, 1000);
  };

  const stopRecording = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setLevels(new Array(WAVE_BARS).fill(0));
    const handle = captureRef.current;
    if (handle) {
      void handle.stop().catch(() => {});
    }
  };

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Voice and speech"
    >
      <button
        type="button"
        aria-label="Close voice panel"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-voice-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">Voice & Speech</span>
          <span className="od-mem-stats">
            {status.loading
              ? "Checking…"
              : ttsAvailable
                ? `TTS · ${providerLabel}`
                : "TTS off"}
          </span>
        </div>

        {/* ── Text-to-Speech (tts-ai.js) ── */}
        <div className="od-voice-section">
          <div className="od-voice-section-head">
            <Volume2 size={14} aria-hidden="true" />
            <span>Text to speech</span>
          </div>

          {status.loading ? (
            <div className="od-voice-status-row">
              <Loader2 className="od-voice-spin" size={14} aria-hidden="true" />
              <span>Checking voice service…</span>
            </div>
          ) : ttsAvailable ? (
            <>
              <div className="od-voice-field">
                <span className="od-voice-label">Voice</span>
                <select
                  className="od-voice-select"
                  value={selectedVoice?.id ?? ""}
                  onChange={(e) => pickVoice(e.target.value)}
                  aria-label="TTS voice"
                >
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} — {v.hint}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                className="od-voice-tts-input"
                value={ttsText}
                onChange={(e) => setTtsText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onClose();
                }}
                placeholder="Type text to read aloud…"
                aria-label="Text to speak"
              />
              <div className="od-voice-tts-controls">
                {speaking ? (
                  <button
                    type="button"
                    className="od-voice-btn od-voice-btn-stop"
                    onClick={stopSpeaking}
                    title="Stop"
                  >
                    <VolumeX size={14} />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="od-voice-btn od-voice-btn-speak"
                    onClick={speak}
                    disabled={!ttsText.trim()}
                    title="Read aloud"
                  >
                    <Play size={13} fill="currentColor" />
                    <span>Speak</span>
                  </button>
                )}
              </div>
              {ttsError ? (
                <div className="od-voice-err">
                  <AlertCircle size={13} aria-hidden="true" />
                  <span>{ttsError}</span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="od-voice-disabled">
              <VolumeX size={20} aria-hidden="true" />
              <div className="od-voice-disabled-title">
                Voice backend not connected
              </div>
              <div className="od-voice-disabled-sub">
                {status.configuredProvider
                  ? `A "${providerLabel}" voice is configured but no speech service is attached to this agent.`
                  : "No text-to-speech service is attached to the orchestrator. Configure a voice provider to read replies aloud."}
              </div>
            </div>
          )}
        </div>

        {/* ── Voice recorder (voiceRecorder.js) ── */}
        <div className="od-voice-section">
          <div className="od-voice-section-head">
            <Mic size={14} aria-hidden="true" />
            <span>Voice recorder</span>
          </div>

          <div className="od-voice-recorder">
            <button
              type="button"
              className={`od-voice-mic${recording ? " recording" : ""}`}
              onClick={recording ? stopRecording : startRecording}
              title={recording ? "Stop recording" : "Start recording"}
              aria-label={recording ? "Stop recording" : "Start recording"}
              aria-pressed={recording}
            >
              {recording ? (
                <Square size={16} fill="currentColor" />
              ) : (
                <Mic size={18} />
              )}
            </button>

            <div className="od-voice-wave" aria-hidden="true">
              {levels.map((lvl, i) => (
                <span
                  key={`bar-${i.toString()}`}
                  className="od-voice-wave-bar"
                  style={{ height: `${Math.round(8 + lvl * 28)}px` }}
                />
              ))}
            </div>

            <span className="od-voice-timer">{formatTime(elapsed)}</span>
          </div>

          {recording ? (
            <div className="od-voice-rec-indicator">
              <span className="od-voice-rec-dot" aria-hidden="true" />
              <span>Recording…</span>
            </div>
          ) : null}

          {recError ? (
            <div className="od-voice-err">
              <AlertCircle size={13} aria-hidden="true" />
              <span>{recError}</span>
            </div>
          ) : null}

          {transcript || interim ? (
            <div className="od-voice-transcript">
              {transcript}
              {interim ? (
                <span className="od-voice-interim">
                  {transcript ? " " : ""}
                  {interim}
                </span>
              ) : null}
            </div>
          ) : (
            <div className="od-voice-hint">
              Press the mic to capture speech. Transcription runs on-device when
              available, with a browser fallback.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
