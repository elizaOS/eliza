/**
 * Real-browser fixture for the detached desktop host of the canonical chat
 * overlay. It keeps the same component, detents, composer, and voice controls
 * as the full app while replacing only the runtime controller with local state.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";

import { client } from "../../../api";
import { GlassStyles } from "../../../glass";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { ChatOverlay } from "../ChatOverlay";
import type { ShellMessage } from "../shell-state";
import type { ConversationNav, ShellController } from "../useShellController";

const SEED: ShellMessage[] = [
  { id: "m1", role: "user", content: "what's on my screen?", createdAt: 1 },
  {
    id: "m2",
    role: "assistant",
    content:
      "Tap the eye to show me — I'll capture the screen and read it back to you.",
    createdAt: 2,
  },
  { id: "m3", role: "user", content: "what's the plan for today?", createdAt: 3 },
  {
    id: "m4",
    role: "assistant",
    content:
      "Ship the chromeless bottom bar, capture the Windows evidence, then close #9953.",
    createdAt: 4,
  },
];

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const startEmpty = params.has("empty");

// Provider truth is a real async selector in the canonical composer. Resolve
// the fixture to the deterministic local route rather than leaving it in the
// honest "unknown" state forever without an API server.
client.getModelsConfig = async () => ({
  targets: { small: {}, large: {}, coding: {} },
});

const CONVERSATION_NAV: ConversationNav = {
  hasPrev: false,
  hasNext: false,
  goPrev: () => {},
  goNext: () => {},
  activeId: "bottom-bar-fixture",
  index: 0,
};

function BottomBarShell() {
  const [open, setOpen] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  const [handsFree, setHandsFree] = React.useState(false);
  const [visionActive, setVisionActive] = React.useState(false);
  const [events, setEvents] = React.useState<string[]>([]);
  const [messages, setMessages] = React.useState<ShellMessage[]>(
    startEmpty ? [] : SEED,
  );

  const send = React.useCallback((text: string) => {
    setEvents((current) => [...current, `send:${text}`]);
    setMessages((m) => [
      ...m,
      { id: `u${m.length}`, role: "user", content: text, createdAt: Date.now() },
    ]);
  }, []);

  const captureVision = React.useCallback(() => {
    setEvents((current) => [...current, "capture-vision"]);
    setVisionActive(true);
    send("Take a look at my screen and tell me what you see.");
    setTimeout(() => setVisionActive(false), 1200);
  }, [send]);

  const controller = React.useMemo<ShellController>(
    () => ({
      phase: recording ? "listening" : open ? "summoned" : "idle",
      authGate: { gated: false, phase: "clear" },
      requestSignIn: () => {},
      signingIn: false,
      responding: false,
      turnStatus: null,
      messages,
      canSend: true,
      modelStatus: {
        kind: "ready",
        blocksSend: false,
        percent: null,
        etaMs: null,
        modelName: null,
        errors: [],
      },
      recording,
      waveformMode: recording ? "listening" : "idle",
      analyser: null,
      open: () => setOpen(true),
      close: () => setOpen(false),
      isOpen: open,
      send,
      captureVision,
      visionCapturing: visionActive,
      toggleRecording: () => setRecording((active) => !active),
      startRecording: () => setRecording(true),
      stopRecording: () => setRecording(false),
      cancelRecording: () => setRecording(false),
      transcript: "",
      speaking: false,
      speak: () => {},
      stopSpeaking: () => {},
      agentVoiceMuted: false,
      toggleAgentVoiceMute: () => {},
      needsAudioUnlock: false,
      unlockAudio: () => {},
      handsFree,
      toggleHandsFree: () => {
        setHandsFree((active) => {
          setRecording(!active);
          return !active;
        });
      },
      micPermission: "granted",
      recheckMicPermission: async () => "granted",
      transcriptionMode: false,
      toggleTranscriptionMode: () => {},
      stopTranscriptionAndMic: () => {},
      setDictationSink: () => {},
      setTranscriptSessionSink: () => {},
      setComposerHasDraft: () => {},
      clearConversation: () => setMessages([]),
      openSettings: () => {},
      navigateHome: () => {},
      currentTab: "home",
      stop: () => {},
      conversationNav: CONVERSATION_NAV,
      conversationLoading: false,
      noProviderConfigured: false,
    }),
    [captureVision, handsFree, messages, open, recording, send, visionActive],
  );

  return (
    <>
      {/* Desktop-like wallpaper behind the transparent chromeless bar, so the
          glass composer reads the way it would pinned to the screen bottom. */}
      <div
        aria-hidden
        style={{
          position: "fixed",
          inset: 0,
          background:
            "radial-gradient(1200px 700px at 18% -5%, #36204d 0%, #0c0c12 58%), linear-gradient(135deg,#1c1238 0%,#08080d 100%)",
        }}
      />
      <div
        data-testid="chat-overlay-shell"
        className="pointer-events-none fixed inset-0 flex items-end justify-center bg-transparent"
      >
        <ChatOverlay
          controller={controller}
          initialMode="pill"
          requestedOpen={open}
          onRequestedOpenChange={setOpen}
        />
      </div>
      <output data-testid="fixture-events" hidden>
        {events.join("|")}
      </output>
    </>
  );
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <MockAppProvider>
    <GlassStyles />
    <BottomBarShell />
  </MockAppProvider>,
);
