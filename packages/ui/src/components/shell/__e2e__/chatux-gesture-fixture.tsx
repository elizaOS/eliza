/**
 * Fixture for the chat-UX gesture e2e (#8928, #8929, #9954). Renders the real
 * gesture-driven surfaces standalone so a headless browser can drive production
 * pointer handlers and record a video:
 *
 *   - TopicGroup              flick UP/DOWN on the real topic header/pill.
 *   - ContinuousChatOverlay   open the real sheet, swipe the real thread
 *                             between conversations, and interleave the real
 *                             new-conversation header action.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";

import { MockAppProvider } from "../../../storybook/mock-providers";
import type { Conversation } from "../../../api/client-types-chat";
import {
  FrameBudgetSampler,
  shouldReportFrameBudget,
} from "../../../hooks/frame-budget";
import {
  LAYOUT_SHIFT_OBSERVER_INIT,
  summarizeStability,
  type LayoutShiftSample,
} from "../../../testing/layout-stability";
import { ContinuousChatOverlay } from "../ContinuousChatOverlay";
import { TopicChipsBar } from "../TopicChipsBar";
import { TopicGroup } from "../TopicGroup";
import type { ShellMessage } from "../shell-state";
import {
  buildConversationNav,
  type ShellController,
} from "../useShellController";

type FixtureConversation = Pick<
  Conversation,
  "id" | "title" | "roomId" | "createdAt" | "updatedAt"
>;

type ChatuxPerfSummary = ReturnType<FrameBudgetSampler["summary"]>;

interface ChatuxPerfProbe {
  reset: () => void;
  summary: () => {
    frame: ChatuxPerfSummary;
    stability: ReturnType<typeof summarizeStability>;
    flagged: boolean;
  };
}

declare global {
  interface Window {
    __ELIZA_CHATUX_PERF__?: ChatuxPerfProbe;
    __ELIZA_LAYOUT_SHIFTS__?: LayoutShiftSample[];
  }
}

function installChatuxPerfProbe(): void {
  if (typeof window === "undefined" || window.__ELIZA_CHATUX_PERF__) return;
  const sampler = new FrameBudgetSampler({
    windowSize: 900,
    observeLongTasks: true,
  });
  sampler.start();
  try {
    new Function(LAYOUT_SHIFT_OBSERVER_INIT)();
  } catch {
    window.__ELIZA_LAYOUT_SHIFTS__ = [];
  }
  window.__ELIZA_CHATUX_PERF__ = {
    reset: () => {
      sampler.reset();
      window.__ELIZA_LAYOUT_SHIFTS__ = [];
    },
    summary: () => {
      const frame = sampler.summary();
      const stability = summarizeStability(
        window.__ELIZA_LAYOUT_SHIFTS__ ?? [],
        [],
        { maxCls: 0.02 },
      );
      return {
        frame,
        stability,
        flagged:
          stability.flagged ||
          shouldReportFrameBudget(frame, {
            p95BudgetFactor: 4,
            droppedFrameRatio: 0.75,
            reportOnLongTask: false,
          }),
      };
    },
  };
}

installChatuxPerfProbe();

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const INITIAL_CONVERSATIONS: FixtureConversation[] = [
  {
    id: "conv-alpha",
    title: "Alpha launch",
    roomId: "room-alpha",
    createdAt: iso(now - 1_000),
    updatedAt: iso(now - 1_000),
  },
  {
    id: "conv-beta",
    title: "Beta billing",
    roomId: "room-beta",
    createdAt: iso(now - 2_000),
    updatedAt: iso(now - 2_000),
  },
  {
    id: "conv-gamma",
    title: "Gamma deploy",
    roomId: "room-gamma",
    createdAt: iso(now - 3_000),
    updatedAt: iso(now - 3_000),
  },
];

function Bubbles({ lines }: { lines: string[] }): React.JSX.Element {
  return (
    <>
      {lines.map((line, i) => (
        <div
          key={`${line}-${i}`}
          className="mb-2 whitespace-pre-wrap text-[13px] leading-relaxed text-white/80"
        >
          {line}
        </div>
      ))}
    </>
  );
}

function messagesFor(conversation: FixtureConversation): ShellMessage[] {
  const createdAtMs = Date.parse(conversation.createdAt);
  return [
    {
      id: `${conversation.id}-u1`,
      role: "user",
      content: `Open ${conversation.title} and summarize the latest thread.`,
      createdAt: createdAtMs,
    },
    {
      id: `${conversation.id}-a1`,
      role: "assistant",
      content: `${conversation.title}: this transcript is mounted through the real ContinuousChatOverlay so horizontal swipes exercise the production thread gesture binding.`,
      createdAt: createdAtMs + 1,
    },
    {
      id: `${conversation.id}-u2`,
      role: "user",
      content: "Keep this long enough that the sheet presents the real thread.",
      createdAt: createdAtMs + 2,
    },
  ];
}

function InteractiveTopicGroup(): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState(false);
  return (
    <div data-testid="topic-group-host">
      <TopicChipsBar topics={["billing", "deployment", "latency"]} />
      <TopicGroup
        topic="deployment"
        count={3}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      >
        <Bubbles
          lines={[
            "Can you deploy the worker?",
            "Deploying now - building the image...",
            "Done. The provisioning worker is live.",
          ]}
        />
      </TopicGroup>
    </div>
  );
}

function RealOverlayConversationHarness(): React.JSX.Element {
  const [conversations, setConversations] = React.useState<
    FixtureConversation[]
  >(INITIAL_CONVERSATIONS);
  const [activeId, setActiveId] = React.useState("conv-beta");
  const [conversationLoading, setConversationLoading] = React.useState(false);
  const nextConversationId = React.useRef(1);

  const activeConversation =
    conversations.find((conversation) => conversation.id === activeId) ??
    conversations[0];
  const messages = activeConversation ? messagesFor(activeConversation) : [];

  const selectConversation = React.useCallback((id: string) => {
    console.log(`[fixture] selectConversation ${id}`);
    setConversationLoading(true);
    window.setTimeout(() => {
      setActiveId(id);
      setConversationLoading(false);
    }, 80);
  }, []);

  const clearConversation = React.useCallback(() => {
    const count = nextConversationId.current;
    nextConversationId.current += 1;
    const id = `conv-new-${count}`;
    const conversation: FixtureConversation = {
      id,
      title: `New chat ${count}`,
      roomId: `room-new-${count}`,
      createdAt: iso(Date.now()),
      updatedAt: iso(Date.now()),
    };
    console.log(`[fixture] clearConversation ${id}`);
    setConversationLoading(true);
    window.setTimeout(() => {
      setConversations((list) => [conversation, ...list]);
      setActiveId(id);
      setConversationLoading(false);
    }, 80);
  }, []);

  const conversationNav = React.useMemo(
    () => buildConversationNav(conversations, activeId, selectConversation),
    [activeId, conversations, selectConversation],
  );

  const controller = {
    phase: "summoned",
    responding: false,
    turnStatus: null,
    messages,
    canSend: true,
    modelStatus: { kind: "ready" },
    recording: false,
    waveformMode: "idle",
    analyser: null,
    open: () => {},
    close: () => {},
    isOpen: true,
    send: (text: string) => console.log(`[fixture] send ${text}`),
    captureVision: () => console.log("[fixture] captureVision"),
    visionCapturing: false,
    toggleRecording: () => console.log("[fixture] toggleRecording"),
    startRecording: () => console.log("[fixture] startRecording"),
    stopRecording: () => console.log("[fixture] stopRecording"),
    transcript: "",
    speaking: false,
    agentVoiceMuted: false,
    toggleAgentVoiceMute: () => console.log("[fixture] toggleAgentVoiceMute"),
    needsAudioUnlock: false,
    unlockAudio: () => console.log("[fixture] unlockAudio"),
    handsFree: false,
    toggleHandsFree: () => console.log("[fixture] toggleHandsFree"),
    transcriptionMode: false,
    toggleTranscriptionMode: () =>
      console.log("[fixture] toggleTranscriptionMode"),
    stopTranscriptionAndMic: () =>
      console.log("[fixture] stopTranscriptionAndMic"),
    setDictationSink: () => {},
    setTranscriptSessionSink: () => {},
    setComposerHasDraft: () => {},
    clearConversation,
    selectConversation,
    selectConversationAroundMessage: (id: string) => selectConversation(id),
    openSettings: () => console.log("[fixture] openSettings"),
    navigateHome: () => console.log("[fixture] navigateHome"),
    navigateToViews: () => console.log("[fixture] navigateToViews"),
    stop: () => console.log("[fixture] stop"),
    conversationNav,
    conversationLoading,
  } as unknown as ShellController;

  return (
    <section
      data-testid="real-overlay-conversation-host"
      data-eliza-layout-shift-intent="transient"
      className="relative min-h-[360px] overflow-hidden rounded-sm border border-white/12 bg-[#ef5a1f]"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 p-4 text-white">
        <div className="text-[10px] uppercase tracking-widest text-white/60">
          real overlay conversation
        </div>
        <div
          data-testid="active-conversation-title"
          className="mt-1 text-lg font-medium"
        >
          {activeConversation?.title ?? "No conversation"}
        </div>
        <div className="mt-1 flex gap-3 text-[11px] text-white/70">
          <span data-testid="active-conversation-id">{activeId}</span>
          <span data-testid="conversation-count">{conversations.length}</span>
          <span data-testid="conversation-loading">
            {conversationLoading ? "loading" : "idle"}
          </span>
        </div>
      </div>
      <ContinuousChatOverlay controller={controller} />
    </section>
  );
}

function App(): React.JSX.Element {
  return (
    <div
      style={{
        background:
          "radial-gradient(120% 120% at 50% 0%, #2a2233 0%, #16121c 100%)",
        minHeight: "100vh",
        padding: 24,
        color: "white",
        display: "flex",
        flexDirection: "column",
        gap: 20,
        maxWidth: 560,
        margin: "0 auto",
      }}
    >
      <InteractiveTopicGroup />
      <RealOverlayConversationHarness />
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <MockAppProvider>
      <App />
    </MockAppProvider>,
  );
