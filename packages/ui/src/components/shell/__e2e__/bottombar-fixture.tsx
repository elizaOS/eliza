// Self-contained fixture for the chromeless desktop bottom-bar e2e (#9953).
//
// Renders the REAL bottom-bar shell composition — the same one
// `ShellFoundationMount` (App.tsx) mounts inside `ChatOverlayShell` when the
// desktop boots with `?shellMode=chat-overlay`: a `HomePill` resting bar plus an
// `AssistantOverlay` holding the glass `ChatSurface` composer (mic + VISION +
// send). No app server, no agent — a headless browser drives the resting→open
// flow and screenshots each state. Paired with run-bottombar-e2e.mjs.
//
// The VISION button (`onVision`) is the #9953 acceptance addition; it is wired
// here exactly as App.tsx wires it (`onVision={controller.captureVision}`), so
// the captured composer is faithful to the shipped bottom bar.

import * as React from "react";
import { createRoot } from "react-dom/client";

import { MockAppProvider } from "../../../storybook/mock-providers";
import { AssistantOverlay } from "../AssistantOverlay";
import { ChatSurface } from "../ChatSurface";
import { HomePill } from "../HomePill";
import type { ShellMessage } from "../shell-state";
import type { ShellPhase } from "../shell-state";

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

/**
 * Mirror of App.tsx `ShellFoundationMount`: HomePill (resting bar) + the
 * AssistantOverlay holding the ChatSurface composer. Drives `phase` locally so a
 * headless browser can flip resting↔open with a real pointer click on the pill.
 */
function BottomBarShell() {
  const [phase, setPhase] = React.useState<ShellPhase>("idle");
  const [recording, setRecording] = React.useState(false);
  const [visionActive, setVisionActive] = React.useState(false);
  const [messages, setMessages] = React.useState<ShellMessage[]>(
    startEmpty ? [] : SEED,
  );

  const open = React.useCallback(() => setPhase("summoned"), []);
  const close = React.useCallback(() => setPhase("idle"), []);

  const send = React.useCallback((text: string) => {
    // eslint-disable-next-line no-console
    console.log(`[fixture] send: ${text}`);
    setMessages((m) => [
      ...m,
      { id: `u${m.length}`, role: "user", content: text, createdAt: Date.now() },
    ]);
  }, []);

  // Exactly how App.tsx wires the VISION button — a tap fires a screen-vision
  // turn and pulses the button until the turn is in flight.
  const captureVision = React.useCallback(() => {
    // eslint-disable-next-line no-console
    console.log("[fixture] captureVision -> screen turn");
    setVisionActive(true);
    send("Take a look at my screen and tell me what you see.");
    setTimeout(() => setVisionActive(false), 1200);
  }, [send]);

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
      {/* Same bottom-anchored, transparent, pointer-pass-through wrapper the
          real `ChatOverlayShell` mounts `ShellFoundationMount` inside (App.tsx),
          so the resting bar pins to the screen bottom exactly as on desktop. */}
      <div
        data-testid="chat-overlay-shell"
        className="pointer-events-none fixed inset-0 flex items-end justify-center bg-transparent"
      >
        <HomePill phase={phase} onOpen={open} onClose={close} />
        <AssistantOverlay phase={phase} onClose={close}>
          <ChatSurface
            messages={messages}
            onSend={send}
            canSend
            greeting="Ask Eliza anything."
            recording={recording}
            onToggleRecording={() => setRecording((r) => !r)}
            onVision={captureVision}
            visionActive={visionActive}
          />
        </AssistantOverlay>
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <MockAppProvider>
    <BottomBarShell />
  </MockAppProvider>,
);
