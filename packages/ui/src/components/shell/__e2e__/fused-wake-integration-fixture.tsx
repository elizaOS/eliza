// Integration fixture for the FULL fused-wake chain (#10351), paired with
// run-fused-wake-integration-e2e.mjs.
//
// Unlike fused-wake-fixture.tsx (which hardcodes the capability flag and
// dispatches the event by hand), this installs a MOCK electrobun RPC and uses
// the REAL `registerDesktopFusedWake` desktop transport — so the renderer half
// runs exactly as in the shipping app: registerDesktopFusedWake sets
// `__ELIZA_FUSED_WAKE__`, subscribes to the `voice:fusedWake` channel, and
// invokes `fusedWake:start`. The harness (Bun) runs the REAL `FusedWakeManager`,
// feeds it the real "hey eliza" clip, and delivers the manager's
// `sendToWebview('voice:fusedWake', …)` back through this mock RPC. The only
// thing mocked is the electrobun IPC pipe itself (not the producer, not the
// consumer) — i.e. the whole producer→transport→renderer→bar chain is real.

import * as React from "react";
import { createRoot } from "react-dom/client";

import { MockAppProvider } from "../../../storybook/mock-providers";
import { registerDesktopFusedWake } from "../../../voice/fused-wake-desktop-bridge";
import { useWakeListenWindow } from "../../../voice/useWakeListenWindow";
import { AssistantOverlay } from "../AssistantOverlay";
import { ChatSurface } from "../ChatSurface";
import { HomePill } from "../HomePill";
import type { ShellMessage, ShellPhase } from "../shell-state";

type Listener = (payload: unknown) => void;

// ── Mock electrobun renderer RPC (the IPC pipe — the only mocked part) ────────
const listeners = new Map<string, Set<Listener>>();
declare global {
  interface Window {
    __ELIZA_ELECTROBUN_RPC__?: {
      request: Record<string, (params?: unknown) => Promise<unknown>>;
      onMessage: (name: string, l: Listener) => void;
      offMessage: (name: string, l: Listener) => void;
    };
    /** Harness → page: deliver a main-process `sendToWebview` message. */
    __deliverElectrobunMessage?: (name: string, payload: unknown) => void;
    /** Page → harness (Playwright binding): start the real FusedWakeManager. */
    __hostFusedWakeStart?: (params: unknown) => Promise<unknown>;
    __hostFusedWakeStop?: () => Promise<unknown>;
  }
}

window.__ELIZA_ELECTROBUN_RPC__ = {
  request: {
    fusedWakeStart: async (params) =>
      (await window.__hostFusedWakeStart?.(params)) ?? { started: false },
    fusedWakeStop: async () => window.__hostFusedWakeStop?.(),
  },
  onMessage: (name, l) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)?.add(l);
  },
  offMessage: (name, l) => {
    listeners.get(name)?.delete(l);
  },
};
window.__deliverElectrobunMessage = (name, payload) => {
  for (const l of listeners.get(name) ?? []) l(payload);
};

// Wire the REAL desktop transport (sets the capability flag, subscribes to
// voice:fusedWake → emitFusedWake, invokes fusedWake:start). Done before the
// shell mounts so useWakeController's capability probe sees the flag.
registerDesktopFusedWake();

const SEED: ShellMessage[] = [
  { id: "m1", role: "user", content: "hey eliza", createdAt: 1 },
  {
    id: "m2",
    role: "assistant",
    content: "I'm listening — what do you need?",
    createdAt: 2,
  },
];

function FusedWakeIntegrationShell() {
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
    onClose: React.useCallback(() => setPhase("idle"), []),
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
    <FusedWakeIntegrationShell />
  </MockAppProvider>,
);
