// Self-contained fixture for the pull-up chat-sheet e2e. Mounts the real
// ContinuousChatOverlay with a stateful mock controller over a fake "view"
// background, so a headless browser can drive real drag gestures and capture
// styled screenshots without an app server. Paired with run-chat-sheet-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import { ContinuousChatOverlay } from "../ContinuousChatOverlay";
import type { ShellMessage } from "../shell-state";
import type { ShellController } from "../useShellController";

let nextId = 100;
const uid = () => `m${nextId++}`;

const SEED: ShellMessage[] = [
  { id: "m1", role: "user", content: "what's the plan for today?", createdAt: 1 },
  {
    id: "m2",
    role: "assistant",
    content:
      "Three things: ship the chat-sheet redesign, review the screenshots, then wire the drag e2e. Want me to start on the first?",
    createdAt: 2,
  },
  { id: "m3", role: "user", content: "yes, and keep the input fixed", createdAt: 3 },
  {
    id: "m4",
    role: "assistant",
    content:
      "Done — the composer stays pinned at the bottom; the history pulls up over it and you pull the grabber back down to close.",
    createdAt: 4,
  },
  { id: "m5", role: "user", content: "nice. show me the open state", createdAt: 5 },
  {
    id: "m6",
    role: "assistant",
    content:
      "Pull up anywhere on the sheet (or just start typing) and it springs open into the full transcript.",
    createdAt: 6,
  },
  { id: "m7", role: "user", content: "what closes it?", createdAt: 7 },
  {
    id: "m8",
    role: "assistant",
    content:
      "Drag the grabber at the top back down, or press Escape. Clicking the view behind does nothing — it stays open until you pull it down.",
    createdAt: 8,
  },
  { id: "m9", role: "user", content: "and the input?", createdAt: 9 },
  {
    id: "m10",
    role: "assistant",
    content:
      "The composer is pinned at the very bottom and never moves; the history slides up over it. The latest line always sits just above the input.",
    createdAt: 10,
  },
  { id: "m11", role: "user", content: "great, this scrolls now right?", createdAt: 11 },
  {
    id: "m12",
    role: "assistant",
    content:
      "Yes — once the transcript is taller than the open sheet it scrolls, and the newest line stays pinned at the bottom. This thread is intentionally long so the open state has history to scroll through.",
    createdAt: 12,
  },
];

// Every controller state the harness needs to screenshot is seeded from URL
// params so each state is a deterministic page load: `?empty`, `?phase=booting`
// (also listening/responding/summoned), `?recording`, `?transcript=…`,
// `?speaking`, `?muted`, `?nosend` (canSend=false). The toggles below stay live
// so interactive flows (mic press, voice mute) still work from the default page.
const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const startEmpty = params.has("empty");
const initialPhase = (params.get("phase") as ShellController["phase"]) ?? "summoned";
const initialRecording = params.has("recording");
const initialTranscript =
  params.get("transcript") ?? (initialRecording ? "tell me the plan for…" : "");
const initialSpeaking = params.has("speaking");
const initialMuted = params.has("muted");
const initialCanSend = !params.has("nosend");

function Harness(): React.JSX.Element {
  const [messages, setMessages] = React.useState<ShellMessage[]>(
    startEmpty ? [] : SEED,
  );
  const [phase, setPhase] =
    React.useState<ShellController["phase"]>(initialPhase);
  const [recording, setRecording] = React.useState(initialRecording);
  const [transcript, setTranscript] = React.useState(initialTranscript);
  const [agentVoiceMuted, setAgentVoiceMuted] = React.useState(initialMuted);

  // Log lifecycle so the e2e harness can assert the interaction flow from the
  // console (the user asked for logs to be checked alongside the visuals).
  React.useEffect(() => {
    console.log(
      `[fixture] phase=${phase} messages=${messages.length} recording=${recording}`,
    );
  }, [phase, messages.length, recording]);

  const send = React.useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    console.log(`[fixture] send: ${JSON.stringify(trimmed)}`);
    setMessages((m) => [
      ...m,
      { id: uid(), role: "user", content: trimmed, createdAt: nextId },
    ]);
    setPhase("responding");
    window.setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          content: `On it — “${trimmed}”. Here is a reply that runs a little long so the open transcript has something to scroll through and the latest line stays pinned to the bottom near the composer.`,
          createdAt: nextId,
        },
      ]);
      setPhase("summoned");
    }, 500);
  }, []);

  const startRecording = React.useCallback(() => {
    console.log("[fixture] startRecording");
    setRecording(true);
    setTranscript("tell me the plan for…");
    setPhase("listening");
  }, []);
  const stopRecording = React.useCallback(() => {
    console.log("[fixture] stopRecording");
    setRecording(false);
    setTranscript("");
    setPhase("summoned");
  }, []);
  const toggleRecording = React.useCallback(() => {
    setRecording((r) => {
      const next = !r;
      console.log(`[fixture] toggleRecording -> ${next}`);
      setTranscript(next ? "tell me the plan for…" : "");
      setPhase(next ? "listening" : "summoned");
      return next;
    });
  }, []);
  const toggleAgentVoiceMute = React.useCallback(() => {
    setAgentVoiceMuted((m) => {
      console.log(`[fixture] toggleAgentVoiceMute -> ${!m}`);
      return !m;
    });
  }, []);

  const controller = {
    phase,
    messages,
    canSend: initialCanSend && phase !== "booting",
    recording,
    transcript,
    speaking: initialSpeaking,
    agentVoiceMuted,
    send,
    toggleRecording,
    startRecording,
    stopRecording,
    toggleAgentVoiceMute,
  } as unknown as ShellController;

  return (
    <div
      data-testid="fake-view"
      style={{
        position: "fixed",
        inset: 0,
        // Flat warm orange — the real /chat ambient home backdrop — so these
        // screenshots show the true composite (glass chat panel over orange).
        background: "#ef5a1f",
        color: "rgba(255,255,255,0.9)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* Fake view content behind the overlay — proves the glass + dimming read
          over a real surface, and gives a click-out target. */}
      <div
        data-testid="view-content"
        style={{ padding: "48px 28px", maxWidth: 720 }}
      >
        <h1 style={{ fontSize: 30, fontWeight: 600, margin: 0 }}>Workspace</h1>
        <p style={{ opacity: 0.7, marginTop: 12, lineHeight: 1.6 }}>
          This is the live view behind the floating chat. Clicking here must NOT
          close the chat — the sheet only closes on a pull-down or Escape.
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
          {["Files", "Tasks", "Notes", "Settings"].map((t) => (
            <span
              key={t}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.12)",
                fontSize: 13,
              }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
      <ContinuousChatOverlay controller={controller} />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
