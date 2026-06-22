/**
 * Fixture for the chat-UX gesture e2e (#8928, #8929). Renders the three new,
 * gesture-driven surfaces standalone so a headless browser can drive REAL
 * pointer gestures against them and record a video:
 *
 *   - TopicGroup    — flick UP on the header collapses to a pill; tap the pill
 *                     (or flick DOWN) expands. NO visible buttons.
 *   - ConversationSwiper — a horizontal swipe between adjacent conversations,
 *                     using the same usePullGesture deltaX/onSwipeLeft/onSwipeRight
 *                     the overlay binds (sheet-open only) in production.
 *   - ConversationUndoToast — the soft-undo affordance after a reset; swipe LEFT
 *                     to restore, or tap Undo.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { ConversationUndoToast } from "../ConversationUndoToast";
import { showConversationUndo } from "../conversation-undo-store";
import { TopicChipsBar } from "../TopicChipsBar";
import { TopicGroup } from "../TopicGroup";
import { usePullGesture } from "../use-pull-gesture";

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
            "Deploying now — building the image…",
            "Done. The provisioning worker is live.",
          ]}
        />
      </TopicGroup>
    </div>
  );
}

/**
 * A minimal conversation swiper mirroring the overlay wiring: the live deltaX
 * drives an edge hint, a committed swipe steps to the adjacent conversation.
 */
function ConversationSwiper(): React.JSX.Element {
  const conversations = ["Today's standup", "Billing thread", "Deploy incident"];
  const [index, setIndex] = React.useState(0);
  const [dx, setDx] = React.useState(0);
  const gesture = usePullGesture({
    onDragX: setDx,
    onSwipeLeft: () => {
      setDx(0);
      setIndex((i) => Math.min(conversations.length - 1, i + 1));
    },
    onSwipeRight: () => {
      setDx(0);
      setIndex((i) => Math.max(0, i - 1));
    },
  });
  return (
    <div
      data-testid="conversation-swiper"
      {...gesture}
      className="relative flex h-40 touch-pan-y select-none items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/5"
    >
      {dx < 0 && index > 0 ? (
        <div
          data-testid="swipe-hint-left"
          className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-white/25 to-transparent"
          style={{ opacity: Math.min(1, -dx / 96) }}
        />
      ) : null}
      {dx > 0 && index < conversations.length - 1 ? (
        <div
          data-testid="swipe-hint-right"
          className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-white/25 to-transparent"
          style={{ opacity: Math.min(1, dx / 96) }}
        />
      ) : null}
      <div className="text-center">
        <div className="text-[10px] uppercase tracking-widest text-white/40">
          conversation {index + 1} / {conversations.length}
        </div>
        <div
          data-testid="active-conversation-title"
          className="mt-1 text-lg font-medium text-white/90"
        >
          {conversations[index]}
        </div>
        <div className="mt-1 text-[11px] text-white/40">swipe ← / →</div>
      </div>
    </div>
  );
}

function UndoTrigger(): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid="fire-undo"
      onClick={() =>
        showConversationUndo({
          label: "Conversation cleared",
          actionLabel: "Undo",
          onUndo: () => {
            const el = document.querySelector('[data-testid="undo-result"]');
            if (el) el.textContent = "restored";
          },
        })
      }
      className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-sm text-white/85 hover:bg-white/20"
    >
      Reset conversation
    </button>
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
      <ConversationSwiper />
      <UndoTrigger />
      <div data-testid="undo-result" style={{ display: "none" }} />
      <ConversationUndoToast />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
