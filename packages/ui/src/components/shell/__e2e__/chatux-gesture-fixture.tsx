/**
 * Fixture for the chat-UX TopicGroup gesture e2e (#8928). Renders the
 * gesture-driven TopicGroup standalone so a headless browser can drive REAL
 * pointer gestures against it and record a video:
 *
 *   - TopicGroup — flick UP on the header collapses to a pill; tap the pill
 *                  (or flick DOWN) expands. NO visible buttons.
 *
 * Conversation-swipe coverage lives in conversation-swipe-fixture.tsx, which
 * mounts the REAL ContinuousChatOverlay. The local `ConversationSwiper` mock that
 * used to live here (a hardcoded array + its own useState(index), sharing only
 * usePullGesture, not the real overlay/nav/async-create path) was DELETED in
 * #9954 — it gave false confidence by passing while exercising none of the real
 * conversation-nav code.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { TopicChipsBar } from "../TopicChipsBar";
import { TopicGroup } from "../TopicGroup";

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
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
