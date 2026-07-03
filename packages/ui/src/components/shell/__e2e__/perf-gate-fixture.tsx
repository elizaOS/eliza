// Fixture for the perf-gate e2e (#9954, Item 5). Mounts the REAL
// ContinuousChatOverlay — the LIVE chat surface the gate is required to drive —
// over the SAME stateful controller shape conversation-swipe-fixture.tsx uses
// (buildConversationNav with ref-backed goPrev/goNext that re-resolve the
// adjacent conversation through the latest state, exactly like
// useShellController). The only deltas from conversation-swipe-fixture are tuned
// for perf measurement, not navigation invariants:
//
//   - a LONG thread (many turns) per conversation, so `#continuous-thread`
//     actually overflows and the gate measures REAL overflow-y scroll frame
//     budget — not a 3-message thread that never scrolls,
//   - a multi-item conversation list with the active chat starting in the
//     MIDDLE, so a real left/right conversation swipe navigates a neighbour in
//     either direction (the overlay's sheet-open conversationSwipe wiring).
//
// The previous version of this fixture mounted a SYNTHETIC surface (a plain
// 200-row <div> + a hand-rolled swiper translating a text label). That did NOT
// gate the live overlay (adversarial-review MAJOR), so it is replaced here with
// the real component. Paired with run-perf-gate-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import type { Conversation } from "../../../api/client-types-chat";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { ContinuousChatOverlay } from "../ContinuousChatOverlay";
import { buildConversationNav } from "../conversation-nav";
import type { ShellMessage } from "../shell-state";
import type { ConversationNav, ShellController } from "../useShellController";

function conv(id: string, n: number): Conversation {
  // Newest first, so a higher `n` is a more recent conversation. createdAt is
  // cosmetic; ordering is the array order.
  const ts = new Date(1_700_000_000_000 + n * 1000).toISOString();
  return {
    id,
    title: id,
    roomId: `room-${id}`,
    createdAt: ts,
    updatedAt: ts,
  };
}

// Five seed conversations, most-recent-first. The active chat starts in the
// MIDDLE (index 2) so a real swipe navigates a neighbour in BOTH directions —
// the gate drives forward AND back over the live conversationSwipe.
const SEED: Conversation[] = [
  conv("c5", 5),
  conv("c4", 4),
  conv("c3", 3),
  conv("c2", 2),
  conv("c1", 1),
];
const START_INDEX = 2;

// A LONG thread (40 turns ⇒ ~80 messages) of multi-line content, so the real
// overflow-y `#continuous-thread` overflows its sheet-full height and the gate
// measures genuine scroll frame budget. The active id is woven into the text so
// the captured pixels visibly change as a swipe navigates between chats.
const TURNS = 40;
function threadFor(activeId: string): ShellMessage[] {
  const messages: ShellMessage[] = [];
  for (let i = 0; i < TURNS; i += 1) {
    messages.push({
      id: `${activeId}-u${i}`,
      role: "user",
      content: `(${activeId}) turn ${i}: ${"how does the scheduler route this task? ".repeat(2)}`,
      createdAt: i * 2 + 1,
    });
    messages.push({
      id: `${activeId}-a${i}`,
      role: "assistant",
      content:
        `Reply ${i} in ${activeId}. ${"It is routed through the single runner, pattern-matched on structural fields, never on prompt text. ".repeat(3)}` +
        "\nSwipe left for the older chat, right for the newer one.",
      createdAt: i * 2 + 2,
    });
  }
  return messages;
}

function Harness(): React.JSX.Element {
  const [conversations] = React.useState<Conversation[]>(SEED);
  const [activeId, setActiveId] = React.useState<string>(SEED[START_INDEX].id);

  // Refs mirror the production controller: a swipe re-resolves through the
  // LATEST list/active id, never a stale closure captured at render time.
  const conversationsRef = React.useRef(conversations);
  const activeIdRef = React.useRef(activeId);
  conversationsRef.current = conversations;
  activeIdRef.current = activeId;

  const selectConversation = React.useCallback((id: string) => {
    setActiveId(id);
  }, []);

  // The real swipe callbacks re-resolve adjacent targets through the current
  // refs (matching useShellController.selectAdjacentConversation), so the
  // overlay never navigates against a stale index.
  const conversationNav = React.useMemo<ConversationNav>(() => {
    const nav = buildConversationNav(conversations, activeId, selectConversation);
    return {
      ...nav,
      goPrev: () => {
        const adj = buildConversationNav(
          conversationsRef.current,
          activeIdRef.current,
          selectConversation,
        );
        adj.goPrev();
      },
      goNext: () => {
        const adj = buildConversationNav(
          conversationsRef.current,
          activeIdRef.current,
          selectConversation,
        );
        adj.goNext();
      },
    };
  }, [conversations, activeId, selectConversation]);

  const controller: ShellController = {
    phase: "summoned",
    messages: threadFor(activeId),
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
    conversationNav,
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
          gate scrolls its overflowing thread and swipes between live
          conversations to measure frame budget + layout stability.
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
