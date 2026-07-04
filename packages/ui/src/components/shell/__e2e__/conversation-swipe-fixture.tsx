// Fixture for the conversation-swipe interleaving e2e (#9954). Mounts the REAL
// ContinuousChatOverlay over a STATEFUL controller whose conversation list and
// active id actually mutate the way the production controller does:
//
//   - the list is most-recent-first; a new conversation PREPENDS at index 0 and
//     becomes active (mirrors handleNewConversation),
//   - a swipe re-resolves the adjacent conversation through the LATEST state via
//     buildConversationNav (mirrors useShellController's ref-backed callbacks),
//   - selectConversation flips the active id.
//
// So a headless browser drives the exact swipe-back → new → swipe-forward → new
// → forward → swipe-back interleaving the issue names, against a live list, and
// the overlay's data-conversation-id / data-conversation-index attributes report
// the real navigation state for invariant assertions. The previous fixture's
// `ConversationSwiper` was a local re-implementation (hardcoded array + its own
// useState(index)); it is deleted so it can no longer pass for overlay coverage.
//
// Paired with run-conversation-swipe-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import type { Conversation } from "../../../api/client-types-chat";
import { MockAppProvider } from "../../../storybook/mock-providers";
import { readViewInteractions } from "../../../view-telemetry";
import { goHome } from "../../../state/shell-surface-store";
import { ContinuousChatOverlay } from "../ContinuousChatOverlay";
import { buildConversationNav } from "../conversation-nav";
import { HomeLauncherSurface } from "../HomeLauncherSurface";
import type { ShellMessage } from "../shell-state";
import type { ConversationNav, ShellController } from "../useShellController";

function conv(id: string, n: number): Conversation {
  // Newest first, so a higher `n` is a more recent conversation. createdAt is
  // only cosmetic here; ordering is the array order the harness maintains.
  const ts = new Date(1_700_000_000_000 + n * 1000).toISOString();
  return {
    id,
    title: id,
    roomId: `room-${id}`,
    createdAt: ts,
    updatedAt: ts,
  };
}

// Three seed conversations, most-recent-first: [c3 (newest), c2, c1 (oldest)].
// Start active on the NEWEST (index 0) so the first "swipe back" toward a newer
// chat is a boundary no-op — the named sequence starts from index 0.
const SEED: Conversation[] = [conv("c3", 3), conv("c2", 2), conv("c1", 1)];

// The thread reflects the ACTIVE conversation so the recorded screenshots /
// video visibly change as the swipe navigates between chats (the invariant
// assertions read the DOM, but the captured pixels should show the switch too).
function threadFor(activeId: string): ShellMessage[] {
  return [
    {
      id: `${activeId}-m1`,
      role: "user",
      content: `what's the plan in ${activeId}?`,
      createdAt: 1,
    },
    {
      id: `${activeId}-m2`,
      role: "assistant",
      content: `You're viewing conversation ${activeId}. Swipe left for the older chat, right for the newer one.`,
      createdAt: 2,
    },
    { id: `${activeId}-m3`, role: "user", content: "got it", createdAt: 3 },
  ];
}

function BackgroundHome(): React.JSX.Element {
  return (
    <div
      data-testid="background-home-content"
      style={{
        height: "100%",
        padding: "64px 28px",
        color: "rgba(255,255,255,0.9)",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Home</h1>
      <p style={{ marginTop: 12, maxWidth: 340, lineHeight: 1.5 }}>
        Swipe this background while chat is open. The real launcher rail should
        still receive the drag.
      </p>
    </div>
  );
}

function BackgroundLauncher(): React.JSX.Element {
  return (
    <div
      data-testid="background-launcher-content"
      style={{
        height: "100%",
        padding: "64px 28px",
        color: "rgba(255,255,255,0.9)",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Launcher</h1>
      <p style={{ marginTop: 12, maxWidth: 340, lineHeight: 1.5 }}>
        Chat is still open; this page was reached by a background swipe.
      </p>
      <button
        type="button"
        data-testid="background-launcher-home-button"
        onClick={goHome}
        style={{
          marginTop: 20,
          border: "1px solid rgba(255,255,255,0.35)",
          borderRadius: 999,
          padding: "8px 14px",
          color: "white",
          background: "rgba(255,255,255,0.12)",
        }}
      >
        Home
      </button>
    </div>
  );
}

function Harness(): React.JSX.Element {
  const [conversations, setConversations] =
    React.useState<Conversation[]>(SEED);
  const [activeId, setActiveId] = React.useState<string>(SEED[0].id);
  const [created, setCreated] = React.useState(0);

  // Refs mirror the production controller: a swipe re-resolves through the
  // LATEST list/active id, never a stale closure captured at render time.
  const conversationsRef = React.useRef(conversations);
  const activeIdRef = React.useRef(activeId);
  conversationsRef.current = conversations;
  activeIdRef.current = activeId;

  const selectConversation = React.useCallback((id: string) => {
    setActiveId(id);
  }, []);

  // Prepend a new conversation at index 0 and activate it (handleNewConversation).
  const newConversation = React.useCallback(() => {
    setCreated((n) => {
      const id = `new-${n}`;
      const next = conv(id, 100 + n);
      setConversations((list) => [next, ...list]);
      setActiveId(id);
      return n + 1;
    });
  }, []);

  // The real swipe callbacks re-resolve adjacent targets through the current
  // refs (matching useShellController.selectAdjacentConversation), so the overlay
  // never navigates against a stale index even mid-interleave.
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

  // Expose test hooks so the runner can drive new-conversation creation and read
  // the live navigation/telemetry state without reaching into React internals.
  React.useEffect(() => {
    const w = window as typeof window & {
      __convNav?: {
        newConversation: () => void;
        select: (id: string) => void;
        state: () => {
          activeId: string;
          index: number;
          hasPrev: boolean;
          hasNext: boolean;
          ids: string[];
        };
        swipeJankEvents: () => number;
      };
    };
    w.__convNav = {
      newConversation,
      select: selectConversation,
      state: () => ({
        activeId,
        index: conversations.findIndex((c) => c.id === activeId),
        hasPrev: conversationNav.hasPrev,
        hasNext: conversationNav.hasNext,
        ids: conversations.map((c) => c.id),
      }),
      swipeJankEvents: () =>
        readViewInteractions().filter(
          (e) => e.action === "conversation-swipe-jank",
        ).length,
    };
    return () => {
      w.__convNav = undefined;
    };
  }, [
    activeId,
    conversations,
    conversationNav,
    newConversation,
    selectConversation,
  ]);

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
      data-testid="fake-view"
      style={{
        position: "fixed",
        inset: 0,
        background: "#ef5a1f",
        color: "rgba(255,255,255,0.9)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      <HomeLauncherSurface
        home={<BackgroundHome />}
        launcher={<BackgroundLauncher />}
      />
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
