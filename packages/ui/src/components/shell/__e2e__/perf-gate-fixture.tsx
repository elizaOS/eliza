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

function Harness(): React.JSX.Element {
  const [messages] = React.useState<ShellMessage[]>(longThread);

  const controller: ShellController = {
    phase: "summoned",
    messages,
    canSend: true,
    responding: false,
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
