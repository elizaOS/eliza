// Self-contained fixture for the fused on-device wake → bottom-bar e2e (#10351).
//
// Renders the REAL bottom-bar shell composition (HomePill + AssistantOverlay +
// ChatSurface) driven by the REAL wake hooks — `useWakeListenWindow` → the
// unified `useWakeController` → the `eliza:fused-wake` window bridge. This is the
// exact consumer chain `useShellController` mounts (`onOpen` →
// `setIsOpen(true)` + `startCapture('converse')`). No app server, no agent: a
// headless browser dispatches the genuine `eliza:fused-wake` CustomEvent — the
// same event the desktop transport (`fused-wake-desktop-bridge.ts`) emits when
// the native `libwakeword` head fires — and we assert the bar activates and a
// converse capture starts. Paired with run-fused-wake-e2e.mjs.
//
// `window.__ELIZA_FUSED_WAKE__` is set to true before mount (the renderer-boot
// contract `registerDesktopFusedWake` satisfies in production) so the wake
// controller seeds `capabilities.openWakeWord` on its first render and the head
// fast-path is live for the character "eliza".

import * as React from "react";
import { createRoot } from "react-dom/client";

import { MockAppProvider } from "../../../storybook/mock-providers";
import { useWakeListenWindow } from "../../../voice/useWakeListenWindow";
import { AssistantOverlay } from "../AssistantOverlay";
import { ChatSurface } from "../ChatSurface";
import { HomePill } from "../HomePill";
import type { ShellMessage, ShellPhase } from "../shell-state";

// The host contract: the fused on-device wake runtime is live (desktop bridged).
// Set before the React tree mounts so `useWakeController`'s mount-time
// `probeFusedWake()` enables the openWakeWord head fast-path.
(window as { __ELIZA_FUSED_WAKE__?: boolean }).__ELIZA_FUSED_WAKE__ = true;

const SEED: ShellMessage[] = [
  { id: "m1", role: "user", content: "hey eliza", createdAt: 1 },
  {
    id: "m2",
    role: "assistant",
    content: "I'm listening — what do you need?",
    createdAt: 2,
  },
];

/**
 * The real wake → bar wiring, mirroring `useShellController`: a confirmed wake
 * opens the bar and starts a converse capture; the window closing returns to the
 * resting pill. Driving the bar phase off the REAL `useWakeListenWindow`
 * callbacks is the whole point — the e2e then only has to dispatch the genuine
 * `eliza:fused-wake` event.
 */
function FusedWakeShell() {
  const [phase, setPhase] = React.useState<ShellPhase>("idle");
  const [messages, setMessages] = React.useState<ShellMessage[]>(SEED);

  const send = React.useCallback((text: string) => {
    // eslint-disable-next-line no-console
    console.log(`[fixture] send: ${text}`);
    setMessages((m) => [
      ...m,
      { id: `u${m.length}`, role: "user", content: text, createdAt: Date.now() },
    ]);
  }, []);

  useWakeListenWindow({
    enabled: true,
    alwaysOn: false,
    agentBusy: false,
    characterName: "eliza",
    onOpen: React.useCallback(() => {
      // eslint-disable-next-line no-console
      console.log("[fixture] wake -> onOpen: startCapture('converse')");
      setPhase("summoned");
    }, []),
    onClose: React.useCallback(() => {
      // eslint-disable-next-line no-console
      console.log("[fixture] wake -> onClose: stopCapture");
      setPhase("idle");
    }, []),
  });

  return (
    <>
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
        <HomePill
          phase={phase}
          onOpen={() => setPhase("summoned")}
          onClose={() => setPhase("idle")}
        />
        <AssistantOverlay phase={phase} onClose={() => setPhase("idle")}>
          <ChatSurface
            messages={messages}
            onSend={send}
            canSend
            greeting="Ask Eliza anything."
            recording={false}
            onToggleRecording={() => {}}
          />
        </AssistantOverlay>
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <MockAppProvider>
    <FusedWakeShell />
  </MockAppProvider>,
);
