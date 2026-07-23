/**
 * Reusable mock chat data + a configurable ShellController hook for the Design
 * Lab. Extracted from the chat-sheet e2e fixture's Harness so the lab and the
 * e2e drive the REAL ChatOverlay through one controller shape — the
 * lab just swaps the URL-param seeding for live React state a control panel can
 * mutate, and adds imperative actions (send, stream a reply) so the drag/scroll
 * behaviours can be exercised by hand without an agent.
 */

import type { ShellMessage } from "@ui-src/components/shell/shell-state";
import type { ShellController } from "@ui-src/components/shell/useShellController";
import * as React from "react";

let nextId = 1000;
const uid = () => `lab-${nextId++}`;

// The overlay opens on this intent (the launcher's "open chat" path). The lab's
// drive-the-thread actions fire it so a sent/appended/streamed turn reveals the
// sheet instead of silently landing behind the collapsed pill.
const openChat = () => window.dispatchEvent(new Event("eliza:chat:open"));

/** A realistic back-and-forth about this very redesign — long enough that the
 *  open sheet has history to scroll. */
export const CHAT_SEED: ShellMessage[] = [
  {
    id: "s1",
    role: "user",
    content: "what's the plan for today?",
    createdAt: 1,
  },
  {
    id: "s2",
    role: "assistant",
    content:
      "Three things: ship the chat-sheet redesign, review the screenshots, then wire the drag e2e. Want me to start on the first?",
    createdAt: 2,
  },
  {
    id: "s3",
    role: "user",
    content: "yes, and keep the input fixed",
    createdAt: 3,
  },
  {
    id: "s4",
    role: "assistant",
    content:
      "Done — the composer stays pinned at the bottom; the history pulls up over it and you pull the grabber back down to close.",
    createdAt: 4,
  },
  {
    id: "s5",
    role: "user",
    content: "nice. show me the open state",
    createdAt: 5,
  },
  {
    id: "s6",
    role: "assistant",
    content:
      "Pull up anywhere on the sheet (or just start typing) and it springs open into the full transcript. Drag to the very top and it maximizes edge-to-edge.",
    createdAt: 6,
  },
  { id: "s7", role: "user", content: "and closing it?", createdAt: 7 },
  {
    id: "s8",
    role: "assistant",
    content:
      "Drag the grabber back down, or press Escape. Clicking the view behind does nothing — it stays open until you pull it down.",
    createdAt: 8,
  },
];

/** A long transcript (well past any detent) so the open sheet overflows and the
 *  transcript scrolls — the case the new-message glide + scroll fixes target. */
export const CHAT_SEED_MANY: ShellMessage[] = Array.from(
  { length: 40 },
  (_, i) => {
    const role: ShellMessage["role"] = i % 2 === 0 ? "user" : "assistant";
    return {
      id: `many-${i}`,
      role,
      content:
        role === "user"
          ? `message ${i + 1} — a question that takes a full line to read`
          : `reply ${i + 1}: a deliberately long answer so the transcript grows well past the tallest detent and the scroll container has real overflow on every viewport.`,
      createdAt: i + 1,
    } as ShellMessage;
  },
);

/** The first-run greeting turn (onboarding). */
export const CHAT_SEED_FIRST_RUN: ShellMessage[] = [
  {
    id: "fr1",
    role: "assistant",
    content:
      "Hey — I'm Eliza. Want a quick two-minute tour, or should we jump straight in?",
    createdAt: 1,
    source: "first_run",
  } as ShellMessage,
];

export type ChatSeedKind = "conversation" | "long" | "empty" | "first-run";

export function seedFor(kind: ChatSeedKind): ShellMessage[] {
  switch (kind) {
    case "long":
      return [...CHAT_SEED_MANY];
    case "empty":
      return [];
    case "first-run":
      return [...CHAT_SEED_FIRST_RUN];
    default:
      return [...CHAT_SEED];
  }
}

export interface MockChatConfig {
  seed: ChatSeedKind;
  phase: ShellController["phase"];
  recording: boolean;
  transcribing: boolean;
  speaking: boolean;
  noProvider: boolean;
}

export interface MockChat {
  controller: ShellController;
  /** Append a user turn and simulate a reply after a beat — exercises the
   *  send → open → follow-to-bottom path. */
  sendUser: (text: string) => void;
  /** Append a fresh assistant line (a tall one) — exercises the new-message
   *  glide-from-current-position (not top). */
  appendAssistant: (text?: string) => void;
  /** Grow the last assistant turn token-by-token — exercises streaming follow. */
  streamReply: () => void;
  /** Reset the transcript to the configured seed. */
  reset: () => void;
}

/**
 * A live mock controller whose transcript + phase live in React state so a
 * control panel can mutate them and the imperative actions can drive realistic
 * flows. Re-seeds when `config.seed` changes.
 */
export function useMockChat(config: MockChatConfig): MockChat {
  const [messages, setMessages] = React.useState<ShellMessage[]>(() =>
    seedFor(config.seed),
  );
  const seedRef = React.useRef(config.seed);
  React.useEffect(() => {
    if (seedRef.current !== config.seed) {
      seedRef.current = config.seed;
      setMessages(seedFor(config.seed));
    }
  }, [config.seed]);

  const [phase, setPhase] = React.useState(config.phase);
  React.useEffect(() => setPhase(config.phase), [config.phase]);

  const dictationSinkRef = React.useRef<((t: string) => void) | null>(null);
  const streamTimerRef = React.useRef<number | null>(null);

  const sendUser = React.useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    openChat();
    // Ids are minted OUTSIDE the setState updater: React StrictMode invokes the
    // updater twice in dev, so a `uid()` inside it would burn two ids and land a
    // duplicate key. Compute once, use the stable value in the pure updater.
    const userId = uid();
    const at = nextId;
    setMessages((m) => [
      ...m,
      { id: userId, role: "user", content: trimmed, createdAt: at },
    ]);
    setPhase("responding");
    window.setTimeout(() => {
      const replyId = uid();
      const replyAt = nextId;
      setMessages((m) => [
        ...m,
        {
          id: replyId,
          role: "assistant",
          content: `On it — “${trimmed}”. Here's a reply that runs a little long so the open transcript has something to scroll and the latest line stays pinned to the bottom.`,
          createdAt: replyAt,
        },
      ]);
      setPhase("summoned");
    }, 500);
  }, []);

  const appendAssistant = React.useCallback((text?: string) => {
    openChat();
    const id = uid();
    const at = nextId;
    setMessages((m) => [
      ...m,
      {
        id,
        role: "assistant",
        content:
          text ??
          "Here's a fresh reply. It's intentionally several lines long so you can watch the transcript follow to the bottom from wherever it currently sits — not sweep down from the very top. Scroll up first, then append another to compare.",
        createdAt: at,
      },
    ]);
    setPhase("summoned");
  }, []);

  const streamReply = React.useCallback(() => {
    if (streamTimerRef.current != null) return;
    openChat();
    const id = uid();
    setMessages((m) => [
      ...m,
      { id, role: "assistant", content: "", createdAt: nextId },
    ]);
    setPhase("responding");
    const words =
      "Streaming a reply token by token so the sheet stays pinned to the newest line while it grows. Each burst is appended to the same turn, so this exercises the growth-follow path rather than the new-line glide.".split(
        " ",
      );
    let i = 0;
    streamTimerRef.current = window.setInterval(() => {
      i += 1;
      setMessages((m) =>
        m.map((msg) =>
          msg.id === id
            ? { ...msg, content: words.slice(0, i).join(" ") }
            : msg,
        ),
      );
      if (i >= words.length) {
        if (streamTimerRef.current != null)
          window.clearInterval(streamTimerRef.current);
        streamTimerRef.current = null;
        setPhase("summoned");
      }
    }, 90);
  }, []);

  const reset = React.useCallback(() => {
    setMessages(seedFor(seedRef.current));
    setPhase(config.phase);
  }, [config.phase]);

  React.useEffect(
    () => () => {
      if (streamTimerRef.current != null)
        window.clearInterval(streamTimerRef.current);
    },
    [],
  );

  const controller = React.useMemo<ShellController>(() => {
    const responding = phase === "responding" || config.speaking;
    return {
      phase,
      responding,
      turnStatus: config.speaking
        ? { kind: "speaking" as const }
        : phase === "responding"
          ? { kind: "thinking" as const }
          : null,
      messages,
      noProviderConfigured: config.noProvider,
      canSend: phase !== "booting",
      waveformMode: config.recording
        ? "listening"
        : responding
          ? "responding"
          : "idle",
      analyser: null,
      open: () => {},
      close: () => {},
      isOpen: true,
      recording: config.recording,
      handsFree: false,
      transcript: config.recording ? "tell me the plan for…" : "",
      speaking: config.speaking,
      agentVoiceMuted: false,
      needsAudioUnlock: false,
      transcriptionMode: config.transcribing,
      toggleTranscriptionMode: () => {},
      stopTranscriptionAndMic: () => {},
      modelStatus: {
        kind: "ready",
        blocksSend: false,
        percent: null,
        etaMs: null,
        modelName: null,
        errors: [],
      },
      send: (text) => sendUser(text),
      captureVision: () => {},
      visionCapturing: false,
      toggleRecording: () => {},
      toggleHandsFree: () => {},
      micPermission: "unknown",
      recheckMicPermission: async () => "unknown",
      setDictationSink: (sink) => {
        dictationSinkRef.current = sink;
      },
      setTranscriptSessionSink: () => {},
      setComposerHasDraft: () => {},
      startRecording: () => {},
      stopRecording: () => {},
      speak: () => {},
      stopSpeaking: () => {},
      toggleAgentVoiceMute: () => {},
      unlockAudio: () => {},
      openSettings: () => {},
      currentTab: "chat",
      navigateHome: () => {},
      clearConversation: () => reset(),
      stop: () => setPhase("summoned"),
      conversationNav: {
        hasPrev: false,
        hasNext: false,
        goPrev: () => {},
        goNext: () => {},
        activeId: "lab-thread",
        index: 0,
      },
    } as ShellController;
  }, [
    phase,
    messages,
    config.speaking,
    config.recording,
    config.transcribing,
    config.noProvider,
    sendUser,
    reset,
  ]);

  return { controller, sendUser, appendAssistant, streamReply, reset };
}
