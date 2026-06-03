// odysseus voice surface (static/js/voiceRecorder.js + the #recording-indicator
// / #mic-btn rules in style.css, plus the hidden TTS admin-card in
// static/index.html). 1:1 with what odysseus actually renders on the chat
// surface — NOT a centered "Voice & Speech" modal (odysseus has no /voice route,
// no voice-view, no voice-panel, and the 17-voice.png frame is just the empty
// default chat). The real odysseus voice chrome is:
//
//   • Recorder — a small inline mic toggle (#mic-btn) and, only while recording,
//     a position:fixed top toast (#recording-indicator): a pulsing record icon,
//     "Recording…" text, and a red "Stop" button, with an .error red-banner
//     state for mic/permission failures. There is NO in-panel waveform, NO
//     MM:SS timer, NO transcript block: odysseus's insertTranscription() writes
//     the transcript straight into the chat composer (#message). Backed by the
//     REAL createVoiceCapture() factory (local-inference ASR with a browser
//     SpeechRecognition fallback) — never fabricated audio.
//
//   • TTS — odysseus's "Text to Speech" admin-card lives INSIDE Settings and is
//     shipped hidden (`<div class="admin-card" hidden style="display:none">`):
//     a speaker-polygon SVG + "Text to Speech" title + an admin-switch toggle,
//     the subtitle "Configure TTS provider for assistant message read-aloud.",
//     Provider / Model / Voice / Speed <select>s, and a single "Preview" button.
//     We render that card faithfully but, like odysseus, keep it hidden by
//     default (a disclosure reveals it). It is wired to the REAL
//     client.getStreamVoice() / streamVoiceSpeak() surface; when no voice
//     backend is attached the controls stay inert/disabled with an honest
//     reason rather than faking audio. (No free-text "read aloud" textarea and
//     no Speak/Stop pair — read-aloud is per assistant message in odysseus.)
//
// elizaMapping: createVoiceCapture() is the same ASR factory the shell + voice
// pill use; transcript segments are routed into the chat composer exactly as
// voiceRecorder.js's insertTranscription() did. getStreamVoice() reports whether
// a voice backend is attached on THIS surface; the orchestrator agent is a
// coding-agent surface that usually has no voice service wired, so the TTS
// Preview stays disabled with an honest reason when the service is absent.

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
import { Mic, Minus } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { readPref, writePref } from "./util/storage";

// odysseus TTS provider <select> options (set-ttsProviderSelect).
const TTS_PROVIDERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "disabled", label: "Disabled" },
  { value: "browser", label: "Browser (built-in)" },
  { value: "local", label: "Local (Kokoro-82M)" },
];

// odysseus TTS model <select> options (set-ttsModelSelect).
const TTS_MODELS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "tts-1", label: "tts-1 (fast)" },
  { value: "tts-1-hd", label: "tts-1-hd (quality)" },
  { value: "gpt-4o-mini-tts", label: "gpt-4o-mini-tts (steerable)" },
];

// odysseus TTS voice <select> options (set-ttsVoiceSelect).
const TTS_VOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "alloy", label: "Alloy" },
  { value: "ash", label: "Ash" },
  { value: "coral", label: "Coral" },
  { value: "echo", label: "Echo" },
  { value: "fable", label: "Fable" },
  { value: "nova", label: "Nova" },
  { value: "onyx", label: "Onyx" },
  { value: "sage", label: "Sage" },
  { value: "shimmer", label: "Shimmer" },
];

// odysseus TTS speed <select> options (set-ttsSpeedSelect); "1" is the default.
const TTS_SPEEDS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "0.5", label: "0.5x" },
  { value: "0.75", label: "0.75x" },
  { value: "1", label: "1x (normal)" },
  { value: "1.25", label: "1.25x" },
  { value: "1.5", label: "1.5x" },
  { value: "2", label: "2x" },
];

// Persisted TTS selections — odysseus stored these server-side; the orchestrator
// has no TTS-settings backend, so the picks are local prefs owned by this view.
const TTS_PROVIDER_KEY = "voice-tts-provider";
const TTS_MODEL_KEY = "voice-tts-model";
const TTS_VOICE_KEY = "voice-tts-voice";
const TTS_SPEED_KEY = "voice-tts-speed";

// Live TTS-service status as reported by client.getStreamVoice(). `loading`
// while the probe is in flight; `attached`+`enabled` only when the service says
// a backend is actually wired — otherwise Preview stays disabled honestly.
interface VoiceStatus {
  loading: boolean;
  enabled: boolean;
  provider: string | null;
  configuredProvider: string | null;
  attached: boolean;
}

const INITIAL_STATUS: VoiceStatus = {
  loading: true,
  enabled: false,
  provider: null,
  configuredProvider: null,
  attached: false,
};

// Resolve a human provider label for the honest Preview-disabled reason.
function providerLabelFor(status: VoiceStatus): string {
  const id = status.provider ?? status.configuredProvider;
  if (!id) return "None";
  const match = VOICE_PROVIDERS.find((p) => p.id === id);
  return match ? match.label : id;
}

// Preset catalogue keyed off the configured stream-voice provider, matching the
// voice.ts EDGE_BACKUP_VOICES intent (ElevenLabs → full PREMADE catalogue; the
// Edge / local fallback gets the trimmed pair). Surfaced only as the inert
// hint when no backend is attached, never as fabricated audio.
function presetsForProvider(provider: string | null): VoicePreset[] {
  if (provider === "elevenlabs") return PREMADE_VOICES;
  return EDGE_BACKUP_VOICES;
}

// odysseus's insertTranscription(): append a transcript segment to the chat
// composer textarea (#message) and refire its input event so the composer
// auto-resizes. The orchestrator composer is the same shared chat input.
function insertTranscription(text: string): boolean {
  if (!text) return false;
  if (typeof document === "undefined") return false;
  const input = document.getElementById("message");
  if (
    !(input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement)
  ) {
    return false;
  }
  const existing = input.value.trim();
  input.value = existing ? `${existing} ${text}` : text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  return true;
}

export function VoiceView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  // The windowed surface is the odysseus TTS admin-card (the only persistent
  // voice chrome). The recording-indicator is a position:fixed toast that
  // floats above it, exactly as in odysseus.
  const win = useWindowControls(
    "win-voice",
    { w: 440, h: 360 },
    { label: "Voice", icon: "Mic", onClose },
  );

  // ── TTS state (mirrors the hidden Settings admin-card) ──
  const [status, setStatus] = useState<VoiceStatus>(INITIAL_STATUS);
  const [ttsCardOpen, setTtsCardOpen] = useState(false);
  const [ttsProvider, setTtsProvider] = useState<string>(() =>
    readPref<string>(TTS_PROVIDER_KEY, "disabled"),
  );
  const [ttsModel, setTtsModel] = useState<string>(() =>
    readPref<string>(TTS_MODEL_KEY, "tts-1"),
  );
  const [ttsVoice, setTtsVoice] = useState<string>(() =>
    readPref<string>(TTS_VOICE_KEY, "alloy"),
  );
  const [ttsSpeed, setTtsSpeed] = useState<string>(() =>
    readPref<string>(TTS_SPEED_KEY, "1"),
  );
  const [previewMsg, setPreviewMsg] = useState<string>("");

  // ── Recorder state ──
  const [recState, setRecState] = useState<VoiceCaptureState>("idle");
  const [recError, setRecError] = useState<string | null>(null);

  const captureRef = useRef<VoiceCaptureHandle | null>(null);

  // Probe the real voice service when the surface opens (getStreamVoice()).
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
          attached: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Release the live capture when the surface closes or the component unmounts
  // mid-recording (the view is normally kept mounted and toggled via `open`,
  // but a true unmount while recording must still free the mic).
  const teardownCapture = useCallback(() => {
    const handle = captureRef.current;
    if (handle) {
      handle.dispose();
      captureRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open) teardownCapture();
  }, [open, teardownCapture]);

  useEffect(() => teardownCapture, [teardownCapture]);

  if (!open) return null;
  if (win.minimized) return null;

  const recording = recState === "listening" || recState === "starting";
  const recErrored = recState === "error" && recError !== null;
  const ttsAttached = !status.loading && status.enabled && status.attached;
  const providerLabel = providerLabelFor(status);
  const presetHints = presetsForProvider(
    status.provider ?? status.configuredProvider,
  );

  const persistProvider = (value: string) => {
    setTtsProvider(value);
    writePref(TTS_PROVIDER_KEY, value);
  };
  const persistModel = (value: string) => {
    setTtsModel(value);
    writePref(TTS_MODEL_KEY, value);
  };
  const persistVoice = (value: string) => {
    setTtsVoice(value);
    writePref(TTS_VOICE_KEY, value);
  };
  const persistSpeed = (value: string) => {
    setTtsSpeed(value);
    writePref(TTS_SPEED_KEY, value);
  };

  // odysseus's set-ttsPreviewBtn: speak a short sample through the attached
  // voice service. Inert unless a backend is actually attached.
  const previewTts = () => {
    if (!ttsAttached) return;
    setPreviewMsg("Previewing…");
    void client
      .streamVoiceSpeak("This is a preview of the assistant voice.")
      .then((res) => {
        setPreviewMsg(res.speaking ? "Speaking…" : "");
      })
      .catch((err: unknown) => {
        setPreviewMsg(err instanceof Error ? err.message : "Preview failed");
      });
  };

  const startRecording = () => {
    if (recording) return;
    setRecError(null);

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
        // Final segments go straight to the chat composer (odysseus
        // insertTranscription). Interim segments are not surfaced — odysseus
        // had no interim UI on this build.
        if (segment.final) insertTranscription(segment.text);
      },
      onStateChange: (state, error) => {
        setRecState(state);
        if (state === "error" && error) setRecError(error.message);
      },
    });
    captureRef.current = handle;

    void handle.start().catch(() => {
      // start() already surfaced the error via onStateChange("error", …).
    });
  };

  const stopRecording = () => {
    const handle = captureRef.current;
    if (handle) {
      void handle.stop().catch(() => {});
    }
  };

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
    } else {
      startRecording();
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
      {win.snapGhost ? (
        <div
          className="od-snap-ghost"
          style={win.snapGhost}
          aria-hidden="true"
        />
      ) : null}

      {/* odysseus #recording-indicator: a position:fixed top toast, shown only
          while recording (or on a mic/permission error). Pulsing record icon +
          "Recording…" text + red Stop button; .error → red banner. */}
      {recording || recErrored ? (
        <div
          className={`od-recording-indicator${recErrored ? " error" : ""}`}
          role="status"
        >
          <div className="od-recording-content">
            <Mic className="od-recording-icon" size={20} aria-hidden="true" />
            <span className="od-recording-text">
              {recErrored ? "Microphone error" : "Recording…"}
            </span>
          </div>
          {recErrored ? (
            <div className="od-recording-error">{recError}</div>
          ) : (
            <button
              type="button"
              className="od-stop-recording-btn"
              onClick={stopRecording}
            >
              Stop
            </button>
          )}
        </div>
      ) : null}

      {/* The persistent voice chrome: a single inline mic toggle plus the
          odysseus "Text to Speech" admin-card (hidden by default, like
          odysseus's `<div class="admin-card" hidden>`). */}
      <div className="od-voice-card" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div className="od-voice-card-bar" onPointerDown={win.onDragStart}>
          <button
            type="button"
            className="od-window-min-btn"
            onClick={win.minimize}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`od-mic-btn${recording ? " recording" : ""}`}
            onClick={toggleRecording}
            title={recording ? "Stop recording" : "Start recording"}
            aria-label={recording ? "Stop recording" : "Start recording"}
            aria-pressed={recording}
          >
            <Mic size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="od-voice-disclosure"
            onClick={() => setTtsCardOpen((v) => !v)}
            aria-expanded={ttsCardOpen}
          >
            {ttsCardOpen ? "Hide" : "Text to Speech"}
          </button>
        </div>

        {ttsCardOpen ? (
          <div className="od-admin-card">
            <h2 className="od-admin-card-title">
              {/* odysseus speaker-polygon SVG (set-ttsEnabledToggle header). */}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="od-admin-card-icon"
                aria-hidden="true"
              >
                <title>Text to Speech</title>
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
              </svg>
              <span>Text to Speech</span>
              <span className="od-admin-card-spacer" />
              <label className="od-admin-switch">
                <input
                  type="checkbox"
                  checked={ttsAttached}
                  disabled
                  aria-label="Text to Speech enabled"
                />
                <span className="od-admin-slider" />
              </label>
            </h2>
            <div className="od-admin-toggle-sub">
              Configure TTS provider for assistant message read-aloud.
            </div>
            <div className="od-tts-fields">
              <div className="od-tts-row">
                <span className="od-settings-label">Provider</span>
                <select
                  className="od-settings-select"
                  value={ttsProvider}
                  onChange={(e) => persistProvider(e.target.value)}
                  aria-label="TTS provider"
                >
                  {TTS_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="od-tts-row">
                <span className="od-settings-label">Model</span>
                <select
                  className="od-settings-select"
                  value={ttsModel}
                  onChange={(e) => persistModel(e.target.value)}
                  aria-label="TTS model"
                >
                  {TTS_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="od-tts-row">
                <span className="od-settings-label">Voice</span>
                <select
                  className="od-settings-select"
                  value={ttsVoice}
                  onChange={(e) => persistVoice(e.target.value)}
                  aria-label="TTS voice"
                >
                  {TTS_VOICES.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="od-tts-row">
                <span className="od-settings-label">Speed</span>
                <select
                  className="od-settings-select"
                  value={ttsSpeed}
                  onChange={(e) => persistSpeed(e.target.value)}
                  aria-label="TTS speed"
                >
                  {TTS_SPEEDS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="od-admin-btn-sm"
                onClick={previewTts}
                disabled={!ttsAttached}
                title={
                  ttsAttached
                    ? "Preview the assistant voice"
                    : `No voice service attached (provider: ${providerLabel}). Preview is unavailable.`
                }
              >
                Preview
              </button>
              <div className="od-tts-msg">
                {status.loading
                  ? "Checking voice service…"
                  : ttsAttached
                    ? previewMsg
                    : `No voice service is attached to the orchestrator (${presetHints.length} fallback voices available). Read-aloud stays off until a provider is configured.`}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
