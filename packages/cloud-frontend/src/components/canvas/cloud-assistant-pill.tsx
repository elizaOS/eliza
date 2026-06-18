import {
  applyElizaGenUiPatch,
  type ElizaGenUiPatch,
  type ElizaGenUiSpec,
} from "@elizaos/ui/genui";
import { useContinuousChat } from "@elizaos/ui/hooks/useContinuousChat";
import { useVoiceChat } from "@elizaos/ui/hooks/useVoiceChat";
import { Keyboard, Loader2, Mic, Send, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  deriveViewTypeAndName,
  useCanvasStore,
} from "@/lib/stores/canvas-store";

// ── Slash commands — each triggers a canvas agent query ──
interface SlashCommand {
  name: string;
  description: string;
  query: string | null; // null = direct action, not a query
  directAction?: () => void;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/agents",
    description: "View & manage agents",
    query: "Show my agents",
  },
  {
    name: "/billing",
    description: "Billing & credit balance",
    query: "Show billing overview",
  },
  {
    name: "/keys",
    description: "API key management",
    query: "Show my API keys",
  },
  {
    name: "/analytics",
    description: "Usage analytics",
    query: "Show analytics",
  },
  {
    name: "/deploy",
    description: "Deploy a new agent",
    query: "Deploy a new agent",
  },
  {
    name: "/health",
    description: "System health status",
    query: "Check system health",
  },
  {
    name: "/profile",
    description: "Your account profile",
    query: "Show my profile",
  },
  {
    name: "/connectors",
    description: "Integration connectors",
    query: "Show connectors",
  },
  { name: "/mcps", description: "MCP servers", query: "Show MCPs" },
  { name: "/plugins", description: "Managed plugins", query: "Show plugins" },
  {
    name: "/transactions",
    description: "Recent transactions",
    query: "Show recent transactions",
  },
  {
    name: "/invoices",
    description: "Billing invoices",
    query: "Show invoices",
  },
  {
    name: "/security",
    description: "Security & MFA",
    query: "Show security settings",
  },
  {
    name: "/clear",
    description: "Clear canvas",
    query: null,
    directAction: () => useCanvasStore.getState().clearCanvas(),
  },
  {
    name: "/close",
    description: "Close the canvas",
    query: null,
    directAction: () => useCanvasStore.getState().setCanvasOpen(false),
  },
  {
    name: "/help",
    description: "What can Mist do?",
    query: "What can you do?",
  },
  {
    name: "/diagnose",
    description: "Run full diagnostics",
    query: "Check my setup for any issues",
  },
  {
    name: "/mist",
    description: "Who is Mist?",
    query: "Who are you?",
  },
];

// ── Autocomplete suggestions (for natural language) ──
const AUTOCOMPLETE_PHRASES = [
  "Show my agents",
  "Show billing overview",
  "Show API keys",
  "Deploy a new agent",
  "Show analytics dashboard",
  "Check system health",
  "Show recent activity",
  "Generate a dashboard",
  "Show running instances",
  "Configure webhooks",
  "Show agent logs",
  "Scale an agent",
  "Create a workflow",
  "Export data",
  "Manage secrets",
  "What should I do next?",
  "Check my setup for issues",
  "I'm confused, help me",
  "What can you do?",
  "Who are you?",
];

export function CloudAssistantPill() {
  const {
    canvasOpen,
    isProcessing,
    setCanvasOpen,
    inputGlowActive,
    genui,
    setGenuiSpec,
    addMessage,
    setProcessing,
  } = useCanvasStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const [inputValue, setInputValue] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [voiceModeActive, setVoiceModeActive] = useState(false);
  const [voicePreview, setVoicePreview] = useState("");
  const handleSendRef = useRef<(text: string) => Promise<void>>(async () => {});

  const voice = useVoiceChat({
    cloudConnected: false,
    interruptOnSpeech: true,
    lang: "en-US",
    onTranscript: (text: string) => {
      const transcript = text.trim();
      if (!transcript) return;
      setVoicePreview("");
      void handleSendRef.current?.(transcript);
    },
    onTranscriptPreview: (text: string) => {
      setVoicePreview(text);
    },
  });

  // Compose with continuous chat hook to manage speech sessions, thinking/speaking states
  const _continuous = useContinuousChat({
    voice,
    mode: voiceModeActive ? "always-on" : "off",
    disabled: !canvasOpen,
    assistantGenerating: isProcessing,
  });

  // Cleanup voice on unmount
  useEffect(() => {
    return () => {
      void voice.stopListening();
      voice.stopSpeaking();
    };
  }, [voice]);

  // Focus input when canvas opens
  useEffect(() => {
    if (canvasOpen) {
      setTimeout(() => inputRef.current?.focus(), 500);
    } else {
      setInputValue("");
      setShowSuggestions(false);
    }
  }, [canvasOpen]);

  // ⌘K to toggle/switch, Escape to close/back
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        const isOpen = useCanvasStore.getState().canvasOpen;
        if (isOpen) {
          setCanvasOpen(false);
          setVoiceModeActive(false);
          void voice.stopListening();
          voice.stopSpeaking();
          setVoicePreview("");
        } else {
          setVoiceModeActive(false);
          setCanvasOpen(true);
        }
      }
      if (e.key === "Escape" && useCanvasStore.getState().canvasOpen) {
        if (showSuggestions) {
          setShowSuggestions(false);
        } else if (voiceModeActive) {
          e.preventDefault();
          setVoiceModeActive(false);
          void voice.stopListening();
          voice.stopSpeaking();
          setVoicePreview("");
        } else {
          e.preventDefault();
          setCanvasOpen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCanvasOpen, showSuggestions, voiceModeActive, voice]);

  // Compute suggestions
  const isSlashMode = inputValue.startsWith("/");
  const suggestions = isSlashMode
    ? SLASH_COMMANDS.filter((cmd) =>
        cmd.name.toLowerCase().startsWith(inputValue.toLowerCase()),
      )
    : inputValue.length >= 2
      ? AUTOCOMPLETE_PHRASES.filter((p) =>
          p.toLowerCase().includes(inputValue.toLowerCase()),
        ).slice(0, 6)
      : [];

  // Ghost text for tab completion (only for natural language)
  const ghostText =
    !isSlashMode && inputValue.length >= 2
      ? AUTOCOMPLETE_PHRASES.find((p) =>
          p.toLowerCase().startsWith(inputValue.toLowerCase()),
        )
      : null;
  const ghostSuffix = ghostText ? ghostText.slice(inputValue.length) : "";

  // Reset selection when suggestions change
  useEffect(() => {
    setSelectedIdx(0);
  }, []);

  const executeQuery = useCallback(
    (text: string) => {
      if (!text.trim() || isProcessing) return;

      const store = useCanvasStore.getState();
      store.addMessage({ role: "user", content: text });
      store.setProcessing(true);

      import("@/lib/stores/cloud-assistant-agent").then(
        ({ processUserMessage }) => {
          const msgs = useCanvasStore.getState().messages;
          processUserMessage(text, msgs)
            .then((r) => {
              const activeStore = useCanvasStore.getState();
              activeStore.addMessage({
                role: "assistant",
                content: r.text,
                spec: r.spec ?? undefined,
              });
              activeStore.handleAssistantResponse(r.text, r.spec ?? null, text);
              if (voiceModeActive) {
                voice.speak(r.text);
              }
            })
            .catch(() => {
              useCanvasStore.getState().addMessage({
                role: "assistant",
                content: "Something went wrong.",
              });
              if (voiceModeActive) {
                voice.speak("Something went wrong.");
              }
            })
            .finally(() => useCanvasStore.getState().setProcessing(false));
        },
      );
    },
    [isProcessing, voiceModeActive, voice],
  );

  const handleGenuiSend = useCallback(
    async (text: string) => {
      addMessage({ role: "user", content: text });
      setProcessing(true);

      const { name } = deriveViewTypeAndName(text);
      const viewName = `genui_${name}`;

      let currentSpec: ElizaGenUiSpec = {
        version: "0.1",
        root: "",
        components: [],
      };

      // Open a view for the GenUI interface being generated
      const storeState = useCanvasStore.getState();
      storeState.openView(viewName, "custom", null, currentSpec);
      const activeId = useCanvasStore.getState().activeViewId;

      try {
        const response = await fetch("/api/v1/genui", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text }),
        });

        if (!response.ok || !response.body) {
          throw new Error(`genui request failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) continue;
            try {
              const parsed = JSON.parse(trimmed) as Partial<ElizaGenUiPatch>;
              if (parsed.op && parsed.path) {
                const result = applyElizaGenUiPatch(currentSpec, [
                  parsed as ElizaGenUiPatch,
                ]);
                if (result.ok && result.spec) {
                  currentSpec = result.spec;
                  if (activeId) {
                    storeState.updateViewGenuiSpec(activeId, currentSpec);
                  }
                  setGenuiSpec(currentSpec);
                }
              }
            } catch {}
          }
        }
        // Spec generated successfully on the canvas, no bubble added for the assistant
        if (voiceModeActive) {
          voice.speak("I've generated the interface on your canvas.");
        }
      } catch {
        addMessage({
          role: "assistant",
          content: "Sorry, generation failed.",
        });
        if (voiceModeActive) {
          voice.speak("Sorry, the generation failed.");
        }
      } finally {
        setProcessing(false);
      }
    },
    [addMessage, setProcessing, setGenuiSpec, voiceModeActive, voice],
  );

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isProcessing) return;
      setInputValue("");
      setShowSuggestions(false);

      // Check if it's a slash command
      const cmd = SLASH_COMMANDS.find(
        (c) => c.name === text.trim().toLowerCase(),
      );
      if (cmd) {
        if (cmd.directAction) {
          cmd.directAction();
        } else if (cmd.query) {
          executeQuery(cmd.query);
        }
        return;
      }

      if (genui.enabled) {
        await handleGenuiSend(text);
        return;
      }

      executeQuery(text);
    },
    [isProcessing, executeQuery, genui.enabled, handleGenuiSend],
  );

  // Sync the send ref for voice callbacks to prevent stale closures
  handleSendRef.current = handleSend;

  const toggleVoiceMode = useCallback(() => {
    if (!canvasOpen) {
      setCanvasOpen(true);
    }
    const newActive = !voiceModeActive;
    setVoiceModeActive(newActive);
    if (!newActive) {
      void voice.stopListening();
      voice.stopSpeaking();
      setVoicePreview("");
    } else {
      voice.unlockAudio?.();
      void voice.startListening("passive");
    }
  }, [canvasOpen, voiceModeActive, setCanvasOpen, voice]);

  const handleOrbClick = useCallback(() => {
    if (!canvasOpen) {
      setCanvasOpen(true);
      setVoiceModeActive(true);
      voice.unlockAudio?.();
      void voice.startListening("passive");
    } else {
      toggleVoiceMode();
    }
  }, [canvasOpen, setCanvasOpen, toggleVoiceMode, voice]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const hasSuggestions = suggestions.length > 0 && showSuggestions;

      // Tab completion
      if (e.key === "Tab") {
        e.preventDefault();
        if (hasSuggestions) {
          const selected = isSlashMode
            ? (suggestions[selectedIdx] as SlashCommand)
            : null;
          if (selected && typeof selected === "object" && "name" in selected) {
            setInputValue(`${selected.name} `);
          } else if (ghostText) {
            setInputValue(ghostText);
          }
        } else if (ghostText) {
          setInputValue(ghostText);
        }
        return;
      }

      // Arrow navigation
      if (e.key === "ArrowDown" && hasSuggestions) {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === "ArrowUp" && hasSuggestions) {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
        return;
      }

      // Enter
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (hasSuggestions && isSlashMode) {
          const cmd = suggestions[selectedIdx] as SlashCommand;
          setInputValue("");
          setShowSuggestions(false);
          if (cmd.directAction) {
            cmd.directAction();
          } else if (cmd.query) {
            executeQuery(cmd.query);
          }
        } else if (hasSuggestions && !isSlashMode) {
          const phrase = suggestions[selectedIdx] as string;
          handleSend(phrase);
        } else {
          handleSend(inputValue);
        }
      }
    },
    [
      suggestions,
      showSuggestions,
      selectedIdx,
      isSlashMode,
      ghostText,
      inputValue,
      executeQuery,
      handleSend,
    ],
  );

  // Define what the orb icon looks like
  let orbIcon = (
    <div
      className="h-2.5 w-2.5 rounded-full"
      style={{
        background:
          "radial-gradient(circle, #FF5800 0%, rgba(255,88,0,0.4) 100%)",
        boxShadow: "0 0 8px rgba(255,88,0,0.3)",
      }}
    />
  );

  if (canvasOpen && voiceModeActive) {
    if (isProcessing) {
      orbIcon = <Loader2 className="h-5 w-5 animate-spin text-[#FF5800]" />;
    } else if (voice.isSpeaking) {
      orbIcon = (
        <Volume2
          className="h-5 w-5 text-[#FF5800] animate-bounce"
          style={{ animationDuration: "1s" }}
        />
      );
    } else if (voice.isListening) {
      orbIcon = <Mic className="h-5 w-5 text-[#FF5800] animate-pulse" />;
    } else {
      orbIcon = <Mic className="h-5 w-5 text-white/60" />;
    }
  }

  const isExpandedText = canvasOpen && !voiceModeActive;

  return (
    <>
      <div className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2">
        {/* Suggestion dropdown (above the orb) */}
        {isExpandedText && showSuggestions && suggestions.length > 0 && (
          <div
            className="absolute bottom-full left-0 right-0 mb-2 rounded-xl overflow-hidden"
            style={{
              background: "rgba(9,9,11,0.95)",
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              border: "1px solid rgba(255,255,255,0.06)",
              animation: "fadeUp 0.2s ease both",
            }}
          >
            {isSlashMode
              ? (suggestions as SlashCommand[]).map((cmd, i) => (
                  <button
                    key={cmd.name}
                    type="button"
                    onClick={() => {
                      if (cmd.directAction) {
                        cmd.directAction();
                      } else if (cmd.query) {
                        executeQuery(cmd.query);
                      }
                      setInputValue("");
                      setShowSuggestions(false);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors duration-100"
                    style={{
                      background:
                        i === selectedIdx
                          ? "rgba(255,88,0,0.08)"
                          : "transparent",
                    }}
                  >
                    <span
                      className="font-mono text-[13px] font-medium"
                      style={{
                        color:
                          i === selectedIdx
                            ? "#FF5800"
                            : "rgba(255,255,255,0.5)",
                      }}
                    >
                      {cmd.name}
                    </span>
                    <span className="text-[12px] text-white/20">
                      {cmd.description}
                    </span>
                  </button>
                ))
              : (suggestions as string[]).map((phrase, i) => (
                  <button
                    key={phrase}
                    type="button"
                    onClick={() => handleSend(phrase)}
                    className="flex w-full items-center px-3.5 py-2.5 text-left text-[13px] transition-colors duration-100"
                    style={{
                      background:
                        i === selectedIdx
                          ? "rgba(255,88,0,0.08)"
                          : "transparent",
                      color:
                        i === selectedIdx
                          ? "rgba(255,255,255,0.7)"
                          : "rgba(255,255,255,0.35)",
                    }}
                  >
                    {phrase}
                  </button>
                ))}
          </div>
        )}

        {/* Real-time transcript preview above the voice orb */}
        {canvasOpen &&
          voiceModeActive &&
          (voicePreview ||
            voice.interimTranscript ||
            isProcessing ||
            voice.isSpeaking) && (
            <div
              className="absolute bottom-full left-1/2 mb-4 -translate-x-1/2 rounded-2xl px-4 py-3 text-center flex flex-col items-center gap-1 min-w-[220px] max-w-[340px] z-[70]"
              style={{
                background: "rgba(9,9,11,0.85)",
                backdropFilter: "blur(20px)",
                WebkitBackdropFilter: "blur(20px)",
                border: "1px solid rgba(255,255,255,0.08)",
                boxShadow:
                  "0 10px 30px rgba(0,0,0,0.5), 0 0 20px rgba(255,88,0,0.05)",
                animation: "fadeUp 0.2s ease both",
              }}
            >
              <span className="text-[9px] font-bold uppercase tracking-wider text-[#FF5800]/80">
                {voice.isSpeaking
                  ? "Speaking"
                  : isProcessing
                    ? "Thinking"
                    : "Listening"}
              </span>
              <p className="text-[13px] text-white/90 font-medium leading-relaxed break-words w-full">
                {voice.isSpeaking
                  ? "Mist is responding..."
                  : voicePreview ||
                    voice.interimTranscript ||
                    "Say something..."}
              </p>
            </div>
          )}

        {/* Keyboard switch toggle button (floats to the right of the active voice orb) */}
        {canvasOpen && voiceModeActive && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setVoiceModeActive(false);
              void voice.stopListening();
              voice.stopSpeaking();
              setVoicePreview("");
            }}
            className="absolute -right-14 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full transition-all duration-200 border border-white/10 hover:bg-white/[0.06] hover:border-[#FF5800]/20 active:scale-95 z-20"
            style={{
              background: "rgba(9,9,11,0.7)",
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            }}
            title="Switch to Keyboard input"
          >
            <Keyboard className="h-4.5 w-4.5 text-white/60 hover:text-[#FF5800] transition-colors" />
          </button>
        )}

        {/* The orb / input bar */}
        {/* biome-ignore lint/a11y/useSemanticElements: contains nested <button>s and an <input>, so a <button> wrapper would be invalid HTML */}
        <div
          className={`relative cursor-pointer flex items-center justify-center ${
            inputGlowActive ? "animate-orange-pulse" : ""
          } ${canvasOpen && voiceModeActive && voice.isListening ? "voice-breathe" : ""}`}
          onClick={handleOrbClick}
          onKeyDown={(e) => e.key === "Enter" && handleOrbClick()}
          role="button"
          tabIndex={0}
          style={{
            width: isExpandedText
              ? 560
              : canvasOpen && voiceModeActive
                ? 56
                : 44,
            height: canvasOpen && voiceModeActive ? 56 : 44,
            borderRadius: canvasOpen && voiceModeActive ? 28 : 22,
            background: isExpandedText
              ? "rgba(255,255,255,0.03)"
              : canvasOpen && voiceModeActive && voice.isListening
                ? "radial-gradient(circle, rgba(255,88,0,0.5) 0%, rgba(255,88,0,0.15) 70%, transparent 100%)"
                : canvasOpen && voiceModeActive && voice.isSpeaking
                  ? `radial-gradient(circle, rgba(255,88,0,${0.4 + voice.mouthOpen * 0.4}) 0%, rgba(255,88,0,${0.08 + voice.mouthOpen * 0.1}) 70%, transparent 100%)`
                  : "radial-gradient(circle, rgba(255,88,0,0.35) 0%, rgba(255,88,0,0.08) 70%, transparent 100%)",
            border: `1px solid ${
              isExpandedText
                ? "rgba(255,255,255,0.06)"
                : canvasOpen &&
                    voiceModeActive &&
                    (voice.isListening || voice.isSpeaking)
                  ? "rgba(255,88,0,0.4)"
                  : "rgba(255,88,0,0.15)"
            }`,
            backdropFilter: isExpandedText ? "blur(20px)" : "none",
            WebkitBackdropFilter: isExpandedText ? "blur(20px)" : "none",
            boxShadow: isExpandedText
              ? "none"
              : canvasOpen && voiceModeActive && voice.isListening
                ? "0 0 30px rgba(255,88,0,0.3), 0 0 60px rgba(255,88,0,0.1)"
                : "0 0 30px rgba(255,88,0,0.15), 0 0 60px rgba(255,88,0,0.05)",
            transition: "all 0.5s cubic-bezier(0.4, 0, 0.2, 1)",
            overflow: "hidden",
          }}
        >
          {/* Ripple rings for active voice recording */}
          {canvasOpen && voiceModeActive && voice.isListening && (
            <>
              <div className="absolute inset-0 rounded-full voice-ripple-1 pointer-events-none border border-[#FF5800]/30 z-0" />
              <div className="absolute inset-0 rounded-full voice-ripple-2 pointer-events-none border border-[#FF5800]/20 z-0" />
            </>
          )}

          {/* Orb inner glow (visible when collapsed/voice is idle) */}
          {!isExpandedText && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: canvasOpen && voiceModeActive ? 28 : 22,
                background:
                  "radial-gradient(circle, rgba(255,88,0,0.5) 0%, transparent 60%)",
                opacity: canvasOpen && voiceModeActive ? 0 : 0.6,
                transition: "opacity 0.5s ease",
                pointerEvents: "none",
              }}
            />
          )}

          {/* Orb pulse ring (visible when collapsed/voice is idle) */}
          {!isExpandedText && (
            <div
              style={{
                position: "absolute",
                inset: -4,
                borderRadius: canvasOpen && voiceModeActive ? 32 : 26,
                border: "1px solid rgba(255,88,0,0.1)",
                opacity: canvasOpen || isProcessing ? 0 : 1,
                animation: "orbPulse 3s ease-in-out infinite",
                transition: "opacity 0.5s ease",
                pointerEvents: "none",
              }}
            />
          )}

          {/* Expanded: input area */}
          {isExpandedText && (
            <div
              className="flex h-full w-full items-center gap-2 px-3"
              style={{
                opacity: 1,
                transition: "opacity 0.35s ease",
              }}
            >
              {/* Close orb (toggles voice mode) */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Collapse text bar and enter voice mode
                  setVoiceModeActive(true);
                  voice.unlockAudio?.();
                  void voice.startListening("passive");
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-white/[0.06]"
                aria-label="Enter voice mode"
                title="Enter voice mode"
              >
                <div
                  className="h-2.5 w-2.5 rounded-full"
                  style={{
                    background:
                      "radial-gradient(circle, #FF5800 0%, rgba(255,88,0,0.4) 100%)",
                    boxShadow: "0 0 8px rgba(255,88,0,0.3)",
                  }}
                />
              </button>

              {/* Explicit mic toggle button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setVoiceModeActive(true);
                  voice.unlockAudio?.();
                  void voice.startListening("passive");
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors duration-200 hover:bg-white/[0.06]"
                aria-label="Switch to voice mode"
                title="Switch to voice mode"
              >
                <Mic className="h-4 w-4 text-white/40 hover:text-[#FF5800] transition-colors" />
              </button>

              {/* Input with ghost text overlay */}
              <div className="relative flex-1 h-full">
                {ghostSuffix && canvasOpen && (
                  <div
                    className="absolute inset-0 flex items-center pointer-events-none"
                    aria-hidden="true"
                  >
                    <span className="text-[14px] text-transparent">
                      {inputValue}
                    </span>
                    <span className="text-[14px] text-white/10">
                      {ghostSuffix}
                    </span>
                  </div>
                )}
                <input
                  ref={inputRef}
                  type="text"
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    setShowSuggestions(e.target.value.length > 0);
                  }}
                  onKeyDown={handleKeyDown}
                  onFocus={() =>
                    inputValue.length > 0 && setShowSuggestions(true)
                  }
                  onBlur={() =>
                    setTimeout(() => setShowSuggestions(false), 150)
                  }
                  placeholder="Ask Mist anything… or type /"
                  className="h-full w-full bg-transparent text-[14px] text-white placeholder-white/20 outline-none"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {/* Tab hint */}
              {ghostSuffix && (
                <kbd className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/15">
                  Tab
                </kbd>
              )}

              {/* Send / loading */}
              <button
                type="button"
                onClick={() => handleSend(inputValue)}
                disabled={isProcessing}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-200 hover:bg-white/[0.06] disabled:opacity-30"
              >
                {isProcessing ? (
                  <Loader2 className="h-4 w-4 animate-spin text-white/30" />
                ) : (
                  <Send className="h-3.5 w-3.5 text-white/30" />
                )}
              </button>

              {/* ⌘K hint */}
              {!ghostSuffix && (
                <kbd className="hidden shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/15 sm:inline">
                  ⌘K
                </kbd>
              )}
            </div>
          )}

          {/* Voice Mode / Collapsed Icon */}
          {!isExpandedText && (
            <div className="relative z-10 flex items-center justify-center w-full h-full">
              {orbIcon}
            </div>
          )}
        </div>
      </div>

      {/* Animations */}
      <style>{`
        @keyframes orbPulse {
          0%, 100% { transform: scale(1); opacity: 0.5; }
          50% { transform: scale(1.3); opacity: 0; }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes orangePulseGlow {
          0%, 100% {
            box-shadow: 0 0 0 rgba(255, 88, 0, 0);
            border-color: rgba(255, 255, 255, 0.06);
          }
          25%, 75% {
            box-shadow: 0 0 10px rgba(255, 88, 0, 0.6);
            border-color: rgba(255, 88, 0, 0.5);
          }
          50% {
            box-shadow: 0 0 0 rgba(255, 88, 0, 0);
            border-color: rgba(255, 255, 255, 0.06);
          }
        }
        .animate-orange-pulse {
          animation: orangePulseGlow 0.8s ease-in-out 2 !important;
        }
        @keyframes voiceRipple {
          0% { transform: scale(0.95); opacity: 0.7; }
          100% { transform: scale(1.8); opacity: 0; }
        }
        @keyframes voiceBreathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
        .voice-ripple-1 {
          animation: voiceRipple 2s cubic-bezier(0.1, 0.8, 0.3, 1) infinite;
        }
        .voice-ripple-2 {
          animation: voiceRipple 2s cubic-bezier(0.1, 0.8, 0.3, 1) infinite;
          animation-delay: 0.8s;
        }
        .voice-breathe {
          animation: voiceBreathe 2s ease-in-out infinite;
        }
      `}</style>
    </>
  );
}
