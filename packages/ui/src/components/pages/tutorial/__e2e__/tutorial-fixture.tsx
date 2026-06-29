/**
 * Fixture for the tutorial spotlight e2e (run-tutorial-e2e.mjs). Mounts the REAL
 * {@link TutorialSpotlight} over a minimal chat scaffold that carries every
 * target test id the real tour script spotlights (`chat-pill`,
 * `chat-sheet-grabber`, `chat-composer-action`, `chat-composer-mic`,
 * `shell-new-chat`, `chat-sheet`), so each frame resolves and frames a genuine
 * on-screen rect. The composer renders a SECOND, off-screen `chat-composer-action`
 * (mirroring the six real branches) so the e2e can prove `measure()` frames the
 * VISIBLE control, not a hidden duplicate.
 *
 * The runner drives it through `window.__tutorial.show(stepId)` and reads colors
 * off the live DOM; theme tokens are injected by the runner (real base.css /
 * brand-gold.css), so the asserted glow/button colors are the actual themed
 * `--accent`.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { TutorialSpotlight } from "../TutorialSpotlight";
import { buildTutorialSteps, type TutorialStep } from "../tutorial-steps";

const STEPS = buildTutorialSteps("Eliza");

function ChatScaffold(): React.JSX.Element {
  return (
    <div data-testid="tutorial-fixture-chat" style={{ position: "fixed", inset: 0 }}>
      {/* Top bar: the new-chat control the new-chat frame spotlights. */}
      <div style={{ position: "absolute", top: 14, right: 14 }}>
        <button type="button" data-testid="shell-new-chat" style={CONTROL}>
          +
        </button>
      </div>
      {/* The closed-state pill the open-chat frame spotlights. */}
      <button
        type="button"
        data-testid="chat-pill"
        style={{
          position: "absolute",
          left: "50%",
          bottom: "46%",
          transform: "translateX(-50%)",
          width: 132,
          height: 44,
          borderRadius: 22,
        }}
      >
        chat
      </button>
      {/* The chat sheet: the swipe surface + grabber + composer. */}
      <div
        data-testid="chat-sheet"
        data-detent="half"
        data-conversation-id="convo-1"
        data-conversation-index={0}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "44%",
          background: "rgba(127,127,127,0.16)",
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
        }}
      >
        <div
          data-testid="chat-sheet-grabber"
          style={{
            width: 52,
            height: 6,
            margin: "10px auto",
            borderRadius: 3,
            background: "rgba(127,127,127,0.55)",
          }}
        />
        {/* Off-screen duplicate composer-action — one of the six real branches a
            reused test id can resolve to. measure() must skip it. */}
        <button
          type="button"
          data-testid="chat-composer-action"
          aria-hidden
          style={{ position: "absolute", left: -9999, top: -9999, ...CONTROL }}
        >
          send (hidden)
        </button>
        <div
          style={{
            position: "absolute",
            bottom: 18,
            left: 16,
            right: 16,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <textarea
            data-testid="chat-composer-textarea"
            style={{ flex: 1, height: 42, borderRadius: 10 }}
          />
          <button type="button" data-testid="chat-composer-mic" style={CONTROL}>
            mic
          </button>
          <button type="button" data-testid="chat-composer-action" style={CONTROL}>
            send
          </button>
        </div>
      </div>
    </div>
  );
}

const CONTROL: React.CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 12,
  background: "rgba(127,127,127,0.25)",
};

let setStepId: (id: string) => void = () => {};

function Harness(): React.JSX.Element {
  const [stepId, setS] = React.useState(STEPS[0].id);
  setStepId = setS;
  const step: TutorialStep =
    STEPS.find((s) => s.id === stepId) ?? STEPS[0];
  return (
    <>
      <ChatScaffold />
      <TutorialSpotlight
        targetSelector={step.targetSelector}
        dimOutside
        title={step.title}
        body={step.body}
        muted={false}
        onToggleMute={() => {}}
        onSkip={() => {}}
        // Always offer Continue so the e2e can read the accent button color on
        // any frame; the real engine only shows it on centered/stalled frames.
        onContinue={() => {}}
        continueLabel={step.continueLabel ?? "Continue"}
      />
    </>
  );
}

declare global {
  interface Window {
    __tutorial: {
      steps: Array<{
        id: string;
        targetSelector: string | null;
        title: string;
        lockTabs: string[];
      }>;
      show: (id: string) => void;
    };
  }
}

window.__tutorial = {
  steps: STEPS.map((s) => ({
    id: s.id,
    targetSelector: s.targetSelector,
    title: s.title,
    lockTabs: s.lockTabs ?? ["chat"],
  })),
  show: (id) => setStepId(id),
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
