// Fixture for the chat perf gate (#9954 Item 5, retargeted for #13531). Mounts
// the REAL ContinuousChatOverlay — the LIVE chat surface the gate protects —
// with a LONG overflowing thread so the two surviving high-cost gestures can be
// driven for real:
//
//   - thread-scroll: `#continuous-thread` actually overflows its sheet-full
//     height, so a vertical fling measures REAL overflow-y scroll frame budget
//     (not a 3-message thread that never scrolls),
//   - pull-to-maximize → top-pull-restore (#13531): an over-pull past the
//     80%-viewport threshold commits the sheet to edge-to-edge full-bleed, and a
//     downward pull from the top-20% grab strip restores the inset overlay. Both
//     re-render + re-layout the whole panel, so they are exactly the
//     layout-stability + frame-budget regressions the gate exists to catch.
//
// The single-infinite-thread redesign (#13531) removed chat-to-chat swipe, so
// this fixture no longer needs a multi-conversation list or the ref-backed
// conversation-nav the old swipe fixture carried — one thread, one controller.
// Paired with run-chat-perf-gate.mjs and run-perf-gate-e2e.mjs.
//
// STREAMING DRIVER: the harness also exposes `window.__ELIZA_PERF_STREAM__` — a
// function the perf gate calls once per simulated token to append a character
// to the tail assistant message (flipping `responding` to true) and force a
// REAL transcript re-render, so the gate can measure the frame budget of the
// hot path the memoized widgets protect: streaming into the open chat. Driving
// it from the fixture keeps ContinuousChatOverlay itself untouched.

import * as React from "react";
import { createRoot } from "react-dom/client";

import { MockAppProvider } from "../../../storybook/mock-providers";
import { ContinuousChatOverlay } from "../ContinuousChatOverlay";
import type { ConversationNav } from "../conversation-nav";
import type { ShellMessage } from "../shell-state";
import type { ShellController } from "../useShellController";

// The single infinite thread (#13531) has no chat switcher — nav never has a
// neighbour to move to; `activeId`/`index` carry the one active conversation so
// the overlay's data-conversation-* attributes render.
const SINGLE_THREAD_NAV: ConversationNav = {
  hasPrev: false,
  hasNext: false,
  goPrev: () => {},
  goNext: () => {},
  activeId: "perf-thread",
  index: 0,
};

// A LONG thread (40 turns ⇒ ~80 messages) of multi-line content, so the real
// overflow-y `#continuous-thread` overflows its sheet-full height and the gate
// measures genuine scroll frame budget + maximize/restore re-layout cost.
const TURNS = 40;
function longThread(): ShellMessage[] {
  const messages: ShellMessage[] = [];
  for (let i = 0; i < TURNS; i += 1) {
    messages.push({
      id: `u${i}`,
      role: "user",
      content: `turn ${i}: ${"how does the scheduler route this task? ".repeat(2)}`,
      createdAt: i * 2 + 1,
    });
    messages.push({
      id: `a${i}`,
      role: "assistant",
      content:
        `Reply ${i}. ${"It is routed through the single runner, pattern-matched on structural fields, never on prompt text. ".repeat(3)}` +
        "\nPull up past the top to maximize; pull down from the top to restore.",
      createdAt: i * 2 + 2,
    });
  }
  return messages;
}

// The tail assistant turn carries a CHOICE widget so a streaming token lands in
// a message that already contains an inline widget — the exact condition the
// widget memoization protects (the widget must NOT re-render as the surrounding
// text grows). The gate scrolls to the tail before streaming so the widget is
// on screen.
const TAIL_WIDGET_PREFIX =
  "Here is my answer so far, streaming in token by token. " +
  "[CHOICE:disambiguate id=perf-choice]\nyes=Yes, proceed\nno=No, cancel\n[/CHOICE]\n";

declare global {
  interface Window {
    __ELIZA_PERF_STREAM__?: (chars?: number) => void;
  }
}

function Harness(): React.JSX.Element {
  const [messages, setMessages] = React.useState<ShellMessage[]>(longThread);
  const [responding, setResponding] = React.useState(false);
  // The streamed tail turn is appended once, then grows character-by-character.
  const streamedRef = React.useRef("");

  // Expose a token driver the perf gate calls. Each call appends `chars` more
  // characters of the streamed body (everything AFTER the widget prefix) and
  // flips `responding`, producing the same reference-changing message-array
  // update the real chat container emits per streamed token.
  React.useEffect(() => {
    const tailId = "a-stream";
    const streamedBody =
      "It is routed through the single runner, pattern-matched on structural fields. ".repeat(
        20,
      );
    setMessages((prev) => {
      if (prev.some((m) => m.id === tailId)) return prev;
      streamedRef.current = "";
      return [
        ...prev,
        {
          id: tailId,
          role: "assistant",
          content: TAIL_WIDGET_PREFIX,
          createdAt: 10_000,
        },
      ];
    });
    window.__ELIZA_PERF_STREAM__ = (chars = 1) => {
      streamedRef.current = streamedBody.slice(
        0,
        Math.min(streamedBody.length, streamedRef.current.length + chars),
      );
      const nextContent = TAIL_WIDGET_PREFIX + streamedRef.current;
      setResponding(true);
      // New array + new tail object each tick (matches the real container).
      setMessages((prev) =>
        prev.map((m) =>
          m.id === tailId ? { ...m, content: nextContent } : m,
        ),
      );
    };
    return () => {
      window.__ELIZA_PERF_STREAM__ = undefined;
    };
  }, []);

  const controller: ShellController = {
    phase: "summoned",
    messages,
    canSend: true,
    responding,
    turnStatus: null,
    recording: false,
    waveformMode: "idle",
    analyser: null,
    open: () => {},
    close: () => {},
    isOpen: true,
    handsFree: false,
    transcriptionMode: false,
    transcript: "",
    speaking: false,
    speak: () => {},
    stopSpeaking: () => {},
    agentVoiceMuted: false,
    needsAudioUnlock: false,
    modelStatus: {
      kind: "ready",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    },
    captureVision: () => {},
    visionCapturing: false,
    conversationNav: SINGLE_THREAD_NAV,
    conversationLoading: false,
    send: () => {},
    toggleRecording: () => {},
    toggleHandsFree: () => {},
    toggleTranscriptionMode: () => {},
    stopTranscriptionAndMic: () => {},
    setDictationSink: () => {},
    setTranscriptSessionSink: () => {},
    setComposerHasDraft: () => {},
    startRecording: () => {},
    stopRecording: () => {},
    toggleAgentVoiceMute: () => {},
    unlockAudio: () => {},
    openSettings: () => {},
    navigateHome: () => {},
    clearConversation: () => {},
    stop: () => {},
  };

  return (
    <div
      data-testid="perf-gate-root"
      style={{
        position: "fixed",
        inset: 0,
        background: "#ef5a1f",
        color: "rgba(255,255,255,0.9)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "40px 24px", maxWidth: 640 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Workspace</h1>
        <p style={{ opacity: 0.7, marginTop: 10, lineHeight: 1.6 }}>
          The floating chat below is the REAL ContinuousChatOverlay. The perf
          gate scrolls its overflowing thread and drives pull-to-maximize /
          top-pull-restore to measure frame budget + layout stability.
        </p>
      </div>
      <ContinuousChatOverlay controller={controller} />
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <MockAppProvider>
      <Harness />
    </MockAppProvider>,
  );
