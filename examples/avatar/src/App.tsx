import { MemoryType, type Memory } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { LipSyncPlayer } from "./components/LipSyncPlayer";
import { SettingsModal } from "./components/SettingsModal";
import type { VrmEngine, VrmEngineState } from "./components/VrmEngine";
import { VrmViewer } from "./components/VrmViewer";
import { useLocalStorageState } from "./hooks/useLocalStorageState";
import { useVoiceActivityDetection } from "./hooks/useVoiceActivityDetection";
import {
  getEffectiveMode,
  getGreetingText,
  getOrCreateRuntime,
  resetConversation,
  sendUserMessage,
} from "./runtime/runtimeManager";
import { splitForTts, synthesizeSamWav } from "./runtime/samTts";
import { DEFAULT_DEMO_CONFIG, type DemoConfig, type DemoMode } from "./runtime/types";

type UiMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  ts: number;
  visibleUntil?: number; // timestamp when message should fade out
};

const MESSAGE_VISIBLE_DURATION = 8000; // 8 seconds before fade starts

function modeLabel(mode: DemoMode): string {
  switch (mode) {
    case "elizaClassic":
      return "ELIZA";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Claude";
    case "xai":
      return "Grok";
    case "gemini":
      return "Gemini";
    case "groq":
      return "Groq";
    default:
      return "ELIZA";
  }
}

export default function App() {
  const [config, setConfig] = useLocalStorageState<DemoConfig>("eliza-vrm-demo:config", DEFAULT_DEMO_CONFIG);
  const effectiveMode = getEffectiveMode(config);

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);

  const lipSyncPlayerRef = useRef<LipSyncPlayer | null>(null);
  const ttsGenerationRef = useRef<number>(0);
  const vrmEngineRef = useRef<VrmEngine | null>(null);
  const [vrmState, setVrmState] = useState<VrmEngineState | null>(null);
  const lastAssistantIdRef = useRef<string | null>(null);
  const bootedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Voice Activity Detection with auto-send
  const handleVoiceTranscript = useCallback(
    (transcript: string) => {
      if (!sending && transcript.trim()) {
        void handleSendMessage(transcript.trim());
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sending]
  );

  // Barge-in: stop agent audio when user starts speaking
  const handleBargeIn = useCallback(() => {
    // Cancel any in-flight TTS loop and stop current audio immediately.
    ttsGenerationRef.current += 1;
    if (lipSyncPlayerRef.current) {
      lipSyncPlayerRef.current.stop();
    }
    setAgentSpeaking(false);
  }, []);

  const vad = useVoiceActivityDetection(
    {
      silenceThreshold: 1200,
      lang: "en-US",
      echoCancellation: true,
      bargeInDuration: 250, // 250ms of sustained audio to interrupt
      bargeInThreshold: 0.04, // Slightly lower threshold to be responsive
    },
    handleVoiceTranscript,
    handleBargeIn
  );

  // Update VAD about agent speaking state
  useEffect(() => {
    vad.setAgentSpeaking(agentSpeaking);
  }, [agentSpeaking, vad]);

  // Surface runtime errors in the UI
  useEffect(() => {
    const onError = (ev: ErrorEvent) => {
      const msg = ev.error instanceof Error ? ev.error.stack ?? ev.error.message : ev.message;
      setFatalError(msg || "Unknown error");
    };
    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason;
      const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
      setFatalError(msg || "Unhandled promise rejection");
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Keep mouth animation fed from analyser volume
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const player = lipSyncPlayerRef.current;
      setMouthOpen(player ? player.getVolume() : 0);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
    };
  }, []);

  // Initial boot: load prior messages from localdb, else greet.
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const bundle = await getOrCreateRuntime(config);
        const mems = await bundle.runtime.getMemoriesByRoomIds({
          tableName: "messages",
          roomIds: [bundle.roomId],
          limit: 50,
        });

        const msgs: UiMessage[] = mems
          .filter((m: Memory) => m.metadata?.type === MemoryType.MESSAGE && typeof m.content.text === "string")
          .map((m: Memory) => {
            const isUser = m.entityId === bundle.userId;
            return {
              id: (m.id as string | undefined) ?? uuidv4(),
              role: isUser ? ("user" as const) : ("assistant" as const),
              text: String(m.content.text),
              ts: m.createdAt ?? Date.now(),
            };
          })
          .sort((a, b) => a.ts - b.ts);

        if (cancelled) return;
        if (msgs.length > 0) {
          setMessages(msgs);
          return;
        }

        const greet = getGreetingText(effectiveMode);
        setMessages([{ id: uuidv4(), role: "assistant", text: greet, ts: Date.now() }]);
      } catch {
        if (cancelled) return;
        const greet = getGreetingText(effectiveMode);
        setMessages([{ id: uuidv4(), role: "assistant", text: greet, ts: Date.now() }]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [config, effectiveMode]);

  const updateConfig = useCallback(
    (patch: (prev: DemoConfig) => DemoConfig) => {
      setConfig(patch);
    },
    [setConfig]
  );

  // Sync settings to runtime when settings modal closes
  useEffect(() => {
    if (settingsVersion === 0) return; // Skip initial render
    void getOrCreateRuntime(config).catch(() => {});
  }, [settingsVersion, config]);

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsVersion((v) => v + 1);
  }, []);

  const speakText = useCallback(
    async (text: string) => {
      const bundle = await getOrCreateRuntime(config);
      if (!lipSyncPlayerRef.current) {
        lipSyncPlayerRef.current = new LipSyncPlayer();
      }
      // New TTS generation token; barge-in increments this to cancel.
      ttsGenerationRef.current += 1;
      const generation = ttsGenerationRef.current;

      lipSyncPlayerRef.current.stop();
      setAgentSpeaking(true);

      try {
        for (const chunk of splitForTts(text)) {
          if (ttsGenerationRef.current !== generation) break;
          if (config.voiceOutputProvider === "elevenlabs") {
            const apiKey = (config.provider.elevenlabsApiKey ?? "").trim();
            if (!apiKey) {
              // No key: fall back to robot voice.
              const wav = synthesizeSamWav(bundle.runtime, chunk, config.sam);
              await lipSyncPlayerRef.current.playWav(wav);
              continue;
            }

            // Ensure runtime has the latest key (applySettings also does this).
            bundle.runtime.setSetting("ELEVENLABS_API_KEY", apiKey, true);

            let buffer: ArrayBuffer;

            const response = await bundle.runtime.useModel(
              ModelType.TEXT_TO_SPEECH,
              chunk,
            );

            if (response instanceof Uint8Array || response instanceof ArrayBuffer) {
                buffer = response instanceof Uint8Array ? response.buffer : response;
            } else {
                const stream = response as ReadableStream<Uint8Array>;
                const reader = stream.getReader();
                const chunks: Uint8Array[] = [];
                let total = 0;
                while (true) {
                  const res = await reader.read();
                  if (res.done) break;
                  chunks.push(res.value);
                  total += res.value.byteLength;
                }
                reader.releaseLock();

                const merged = new Uint8Array(total);
                let offset = 0;
                for (const c of chunks) {
                  merged.set(c, offset);
                  offset += c.byteLength;
                }
                buffer = merged.buffer;
            }

            await lipSyncPlayerRef.current.playWav(buffer);
          } else {
            const wav = synthesizeSamWav(bundle.runtime, chunk, config.sam);
            await lipSyncPlayerRef.current.playWav(wav);
          }
        }
      } finally {
        if (ttsGenerationRef.current === generation) {
          setAgentSpeaking(false);
        }
      }
    },
    [config]
  );

  const handleSendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      setSending(true);
      vad.clear();

      const now = Date.now();
      const userMsg: UiMessage = {
        id: uuidv4(),
        role: "user",
        text: trimmed,
        ts: now,
        visibleUntil: now + MESSAGE_VISIBLE_DURATION,
      };
      const assistantId = uuidv4();
      lastAssistantIdRef.current = assistantId;
      const assistantMsg: UiMessage = {
        id: assistantId,
        role: "assistant",
        text: "",
        ts: now,
        // Will set visibleUntil after response completes
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput("");

      try {
        const { responseText } = await sendUserMessage(config, trimmed, {
          onAssistantChunk: (chunk) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + chunk } : m))
            );
          },
        });

        // Set visibility timeout after response is complete
        const responseTime = Date.now();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text: responseText, visibleUntil: responseTime + MESSAGE_VISIBLE_DURATION }
              : m
          )
        );

        if (config.voiceOutputEnabled) {
          await speakText(responseText);
        }
      } catch (e) {
        const errText = e instanceof Error ? e.message : "Unknown error";
        const errorTime = Date.now();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text: `Error: ${errText}`, visibleUntil: errorTime + MESSAGE_VISIBLE_DURATION }
              : m
          )
        );
      } finally {
        setSending(false);
        // Return focus to input after sending
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    },
    [config, sending, vad, speakText]
  );

  const handleResetConversation = useCallback(async () => {
    if (sending) return;

    // Stop any audio + cancel in-flight TTS.
    ttsGenerationRef.current += 1;
    lipSyncPlayerRef.current?.stop();
    setAgentSpeaking(false);

    await resetConversation();

    // Reset UI messages to greeting.
    const greet = getGreetingText(effectiveMode);
    setMessages([{ id: uuidv4(), role: "assistant", text: greet, ts: Date.now() }]);
    setInput("");
    lastAssistantIdRef.current = null;

    setTimeout(() => inputRef.current?.focus(), 50);
  }, [sending, effectiveMode]);

  // Clean up old messages periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setMessages((prev) => prev.filter((m) => !m.visibleUntil || m.visibleUntil > now));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void handleSendMessage(input);
    },
    [input, handleSendMessage]
  );

  const toggleVoice = useCallback(() => {
    if (voiceEnabled) {
      vad.stop();
      setVoiceEnabled(false);
    } else {
      vad.start();
      setVoiceEnabled(true);
    }
  }, [voiceEnabled, vad]);

  const handleVrmEngineReady = useCallback((engine: VrmEngine) => {
    vrmEngineRef.current = engine;
  }, []);

  const handleVrmEngineState = useCallback((state: VrmEngineState) => {
    setVrmState(state);
  }, []);

  // Get visible messages for chat bubble display
  const now = Date.now();
  const visibleMessages = messages.filter((m) => !m.visibleUntil || m.visibleUntil > now);

  return (
    <div className="app-fullpage">
      {/* Full-page VRM Canvas */}
      <VrmViewer
        mouthOpen={mouthOpen}
        onEngineReady={handleVrmEngineReady}
        onEngineState={handleVrmEngineState}
      />

      {/* Error overlay */}
      {fatalError && (
        <div className="error-overlay">
          <div className="error-content">
            <div className="error-header">
              <span>Runtime Error</span>
              <button onClick={() => setFatalError(null)}>×</button>
            </div>
            <pre>{fatalError}</pre>
          </div>
        </div>
      )}

      {/* Top-right controls */}
      <div className="top-controls">
        <div className="status-pill">
          <span className={`status-dot ${effectiveMode === "elizaClassic" ? "offline" : "online"}`} />
          <span>{modeLabel(effectiveMode)}</span>
        </div>
        {vrmState?.vrmLoaded ? (
          <div className="status-pill" title={`Idle clip tracks: ${vrmState.idleTracks}`}>
            <span className={`status-dot ${vrmState.idlePlaying ? "online" : "offline"}`} />
            <span>
              idle {vrmState.idlePlaying ? "playing" : "stopped"}{" "}
              <span style={{ opacity: 0.75 }}>({vrmState.idleTime.toFixed(1)}s)</span>
            </span>
          </div>
        ) : null}
        <button
          className="icon-button"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      {/* Chat bubbles display */}
      {visibleMessages.length > 0 && (
        <div className="chat-bubbles">
          {visibleMessages.map((msg) => {
            // Calculate fade-out opacity (fade during last 2 seconds)
            const timeLeft = msg.visibleUntil ? msg.visibleUntil - now : MESSAGE_VISIBLE_DURATION;
            const fadeStart = 2000; // Start fading 2 seconds before removal
            const opacity = timeLeft < fadeStart ? Math.max(0, timeLeft / fadeStart) : 1;

            return (
              <div
                key={msg.id}
                className={`chat-bubble ${msg.role === "user" ? "user" : "assistant"}`}
                style={{ opacity }}
              >
                <div className="bubble-label">{msg.role === "user" ? "You" : "Agent"}</div>
                <div className="bubble-text">
                  {msg.text || (msg.role === "assistant" && sending ? "..." : "")}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom controls - different modes for voice vs text */}
      <div className="bottom-controls">
        {voiceEnabled ? (
          /* Voice mode - mic on left, voice status in center */
          <div className="voice-mode-controls">
            <button
              type="button"
              className="icon-button mic-button active"
              onClick={toggleVoice}
              title="Switch to text mode"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
              </svg>
            </button>

            <div className="voice-status">
              <div className={`voice-indicator ${vad.speaking ? "speaking" : vad.listening ? "listening" : ""}`}>
                <div className="voice-waves">
                  <span style={{ height: `${20 + vad.audioLevel * 60}%` }} />
                  <span style={{ height: `${30 + vad.audioLevel * 50}%` }} />
                  <span style={{ height: `${25 + vad.audioLevel * 70}%` }} />
                  <span style={{ height: `${35 + vad.audioLevel * 40}%` }} />
                  <span style={{ height: `${20 + vad.audioLevel * 55}%` }} />
                </div>
              </div>
              {(vad.interimTranscript || vad.transcript) && (
                <div className={`voice-transcript ${vad.transcript && !vad.interimTranscript ? "pending" : ""}`}>
                  {vad.interimTranscript || vad.transcript}
                </div>
              )}
            </div>

            <button
              type="button"
              className="icon-button reset-button"
              onClick={() => void handleResetConversation()}
              disabled={sending}
              title="Reset conversation"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v6h6" />
              </svg>
            </button>
          </div>
        ) : (
          /* Text mode - show input form with mic toggle */
          <form className="input-form" onSubmit={handleSubmit}>
            <button
              type="button"
              className="icon-button mic-button"
              onClick={toggleVoice}
              disabled={!vad.supported}
              title="Switch to voice mode"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>

            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              disabled={sending}
              className="message-input"
            />

            <button
              type="submit"
              className="icon-button send-button"
              disabled={sending || !input.trim()}
              title="Send message"
            >
              {sending ? (
                <div className="spinner" />
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
              )}
            </button>

            <button
              type="button"
              className="icon-button reset-button"
              onClick={() => void handleResetConversation()}
              disabled={sending}
              title="Reset conversation"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v6h6" />
              </svg>
            </button>
          </form>
        )}
      </div>

      {/* Settings Modal */}
      <SettingsModal
        isOpen={settingsOpen}
        onClose={handleCloseSettings}
        config={config}
        onConfigChange={updateConfig}
        effectiveMode={effectiveMode}
        onResetConversation={() => void handleResetConversation()}
      />
    </div>
  );
}
