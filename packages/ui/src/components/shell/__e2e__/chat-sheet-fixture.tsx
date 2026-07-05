// Self-contained fixture for the pull-up chat-sheet e2e. Mounts the real
// ContinuousChatOverlay with a stateful mock controller over a fake "view"
// background, so a headless browser can drive real drag gestures and capture
// styled screenshots without an app server. Paired with run-chat-sheet-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import { MockAppProvider } from "../../../storybook/mock-providers";
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
// `?firstrun` pins the sheet at FULL and freezes the composer (in-chat
// onboarding). `?few` seeds only a couple of short messages so the bottom-anchor
// behavior (few messages sit near the composer, first fades into the top edge)
// is visible instead of a long scrolling transcript.
const firstRun = params.has("firstrun");
const fewMessages = params.has("few") || firstRun;
// `?many` seeds a LONG transcript (far taller than any detent) so the scroll
// container's overflow can be reproduced/measured in a real browser: at the FULL
// detent the content must exceed the panel height and the thread must scroll
// natively (the "can't scroll chat on web" repro harness, #chat-scroll-web).
const manyMessages = params.has("many");
const MANY_SEED: ShellMessage[] = Array.from({ length: 40 }, (_, i) => {
  const role: ShellMessage["role"] = i % 2 === 0 ? "user" : "assistant";
  return {
    id: `many-${i}`,
    role,
    content:
      role === "user"
        ? `message number ${i + 1} — a question that takes a full line to read`
        : `reply ${i + 1}: here is a deliberately long answer so the transcript grows well past the tallest sheet detent and the scroll container has real overflow to scroll through on every viewport.`,
    createdAt: i + 1,
  } as ShellMessage;
});
const FEW_SEED: ShellMessage[] = [
  {
    id: "f1",
    role: "assistant",
    content:
      "Hey — I'm your assistant. Want a quick two-minute tour, or should we jump straight in?",
    createdAt: 1,
  },
  { id: "f2", role: "user", content: "let's do the tour", createdAt: 2 },
];
// `?streaming` seeds an EMPTY in-flight assistant turn + responding, so its
// bubble shows the breathing dots anchored where the streamed text fills in.
const streaming = params.has("streaming");
const initialPhase =
  (params.get("phase") as ShellController["phase"]) ??
  (streaming ? "responding" : "summoned");
const initialRecording = params.has("recording");
const initialTranscript =
  params.get("transcript") ?? (initialRecording ? "tell me the plan for…" : "");
const initialSpeaking = params.has("speaking");
const initialMuted = params.has("muted");
const initialCanSend = !params.has("nosend");
// `?unlock` seeds needsAudioUnlock=true so the audio-unlock chip renders; a tap
// clears it (mirrors the real controller's unlockAudio resuming the context).
const initialNeedsUnlock = params.has("unlock");
// `?transcribing` seeds long-form transcription mode (record-only layer).
const initialTranscribing = params.has("transcribing");
// `?failure=no_provider` ends the thread with a failed assistant turn so the
// recovery gate (Connect a provider → Open Settings) can be screenshot.
const failureKind = params.get("failure");
// `?noprovider=off` forces the pre-fix behaviour (boot spinner keeps spinning
// even with a no_provider turn present) so the before/after can be captured from
// the SAME fixture. Unset → the real controller behaviour: once the server has
// reported no_provider, `noProviderConfigured` is true.
const forceNoProviderOff = params.get("noprovider") === "off";
const SEED_WITH_FAILURE: ShellMessage[] =
  failureKind === "no_provider"
    ? [
        ...SEED,
        {
          id: "m-fail",
          role: "assistant",
          content:
            "No model provider is configured, so I can't reply yet. Connect one to start chatting.",
          createdAt: 13,
          failureKind: "no_provider",
        } as ShellMessage,
      ]
    : SEED;

function Harness(): React.JSX.Element {
  const [messages, setMessages] = React.useState<ShellMessage[]>(
    startEmpty
      ? []
      : manyMessages
        ? streaming
          ? [
              ...MANY_SEED,
              {
                id: "many-inflight",
                role: "assistant",
                content: "",
                createdAt: MANY_SEED.length + 1,
              },
            ]
          : MANY_SEED
        : fewMessages
          ? FEW_SEED
          : streaming
            ? [
                ...SEED,
                {
                  id: "m-inflight",
                  role: "assistant",
                  content: "",
                  createdAt: 13,
                },
              ]
            : SEED_WITH_FAILURE,
  );
  const [phase, setPhase] =
    React.useState<ShellController["phase"]>(initialPhase);
  const [recording, setRecording] = React.useState(initialRecording);
  const [handsFree, setHandsFree] = React.useState(false);
  const [transcript, setTranscript] = React.useState(initialTranscript);
  const [agentVoiceMuted, setAgentVoiceMuted] = React.useState(initialMuted);
  const [needsAudioUnlock, setNeedsAudioUnlock] =
    React.useState(initialNeedsUnlock);
  const [transcriptionMode, setTranscriptionMode] =
    React.useState(initialTranscribing);
  // Onboarding is stateful so the e2e can drive the completion (falling) edge —
  // `window.__setFirstRun(false)` flips it, exercising the #12178 opaque-backdrop
  // fade + auto-collapse reveal that a static prop can't reach (#12364).
  const [firstRunOpen, setFirstRunOpen] = React.useState(firstRun);
  React.useEffect(() => {
    (
      window as unknown as { __setFirstRun?: (v: boolean) => void }
    ).__setFirstRun = setFirstRunOpen;
  }, []);

  // Deterministic transcript mutation hooks for the browser e2e. These drive the
  // rendered overlay through the same controller `messages` prop as a live
  // response, while letting the runner create a single large streamed growth
  // commit and a new assistant line on demand.
  React.useEffect(() => {
    const w = window as unknown as {
      __appendAssistant?: (content: string) => void;
      __growLastAssistant?: (extra: string) => void;
    };
    w.__appendAssistant = (content) => {
      console.log(`[fixture] appendAssistant length=${content.length}`);
      setMessages((current) => [
        ...current,
        {
          id: uid(),
          role: "assistant",
          content,
          createdAt: nextId,
        },
      ]);
      setPhase("summoned");
    };
    w.__growLastAssistant = (extra) => {
      console.log(`[fixture] growLastAssistant length=${extra.length}`);
      setMessages((current) => {
        const lastAssistantIndex = current.findLastIndex(
          (message) => message.role === "assistant",
        );
        if (lastAssistantIndex === -1) {
          return [
            ...current,
            {
              id: uid(),
              role: "assistant",
              content: extra,
              createdAt: nextId,
            },
          ];
        }
        return current.map((message, index) =>
          index === lastAssistantIndex
            ? { ...message, content: `${message.content}${extra}` }
            : message,
        );
      });
    };
    return () => {
      w.__appendAssistant = undefined;
      w.__growLastAssistant = undefined;
    };
  }, []);

  // Log lifecycle so the e2e harness can assert the interaction flow from the
  // console (the user asked for logs to be checked alongside the visuals).
  React.useEffect(() => {
    console.log(
      `[fixture] phase=${phase} messages=${messages.length} recording=${recording}`,
    );
  }, [phase, messages.length, recording]);

  const send = React.useCallback(
    (text: string, options?: { channelType?: string }) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      console.log(
        `[fixture] send: ${JSON.stringify(trimmed)}${
          options?.channelType ? ` (${options.channelType})` : ""
        }`,
      );
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

  // Capture intent of the active mic session — mirrors the real controller:
  // PTT press → "dictate" (transcript fills the composer draft, no send);
  // hands-free tap → "converse" (final transcript sends a VOICE_DM).
  const captureIntentRef = React.useRef<"converse" | "dictate">("converse");
  const dictationSinkRef = React.useRef<((text: string) => void) | null>(null);

  const startRecording = React.useCallback(
    (intent: "converse" | "dictate" = "converse") => {
      captureIntentRef.current = intent;
      console.log(`[fixture] startRecording(${intent})`);
      setRecording(true);
      setTranscript("tell me the plan for…");
      setPhase("listening");
    },
    [],
  );
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
  // A quick tap on the mic toggles the hands-free conversation loop (the mic
  // re-opens after each spoken reply). The overlay's mic button reflects this
  // via aria-pressed (active = recording || handsFree).
  const toggleHandsFree = React.useCallback(() => {
    setHandsFree((h) => {
      const next = !h;
      console.log(`[fixture] toggleHandsFree -> ${next}`);
      // Like the real controller, turning hands-free ON opens a "converse"
      // capture (recording + intent), so a final transcript sends a VOICE_DM.
      captureIntentRef.current = "converse";
      setRecording(next);
      setPhase(next ? "listening" : "summoned");
      return next;
    });
  }, []);
  // Push-to-talk dictation routes a final transcript into the composer draft.
  // The overlay registers/clears the sink on mount/unmount; store it so the
  // __emitDictation/__emitVoiceFinal test hooks can drive it.
  const setDictationSink = React.useCallback(
    (sink: ((text: string) => void) | null) => {
      dictationSinkRef.current = sink;
    },
    [],
  );
  const setTranscriptSessionSink = React.useCallback(() => {}, []);
  // Test hooks for BIDIRECTIONAL voice (asserted by the e2e): a final transcript
  // either fills the composer draft (dictate) or sends a VOICE_DM (converse),
  // routed by the active capture intent — exactly the two real directions.
  React.useEffect(() => {
    const w = window as {
      __emitDictation?: (t: string) => void;
      __emitVoiceFinal?: (t: string) => void;
    };
    w.__emitDictation = (t) => dictationSinkRef.current?.(t);
    w.__emitVoiceFinal = (t) => {
      if (captureIntentRef.current === "dictate") dictationSinkRef.current?.(t);
      else send(t, { channelType: "VOICE_DM" });
      setRecording(false);
      setPhase("summoned");
    };
    return () => {
      w.__emitDictation = undefined;
      w.__emitVoiceFinal = undefined;
    };
  }, [send]);
  const toggleAgentVoiceMute = React.useCallback(() => {
    setAgentVoiceMuted((m) => {
      console.log(`[fixture] toggleAgentVoiceMute -> ${!m}`);
      return !m;
    });
  }, []);

  const controller = {
    phase,
    // Raw in-flight predicate — mirrors the real controller's `chatSending ||
    // speaking`. In the fixture, "responding" phase stands in for chatSending and
    // `?speaking` for the spoken reply, so the trailing control + voice-gating
    // behave exactly as they do in the app.
    responding: phase === "responding" || initialSpeaking,
    // Rich status (#8813): mirror the real controller's derivation so the
    // screenshots show the phase-aware indicator. Speaking wins; otherwise a
    // responding phase reads as "thinking" in the fixture (no token stream).
    turnStatus: initialSpeaking
      ? { kind: "speaking" as const }
      : phase === "responding"
        ? { kind: "thinking" as const }
        : null,
    messages,
    // Mirrors the real controller: true once the latest assistant turn carries
    // `failureKind: "no_provider"`. Drives the overlay to suppress the forever
    // "Waking …" boot banner and swap the composer placeholder for a Settings
    // hint (the in-transcript no_provider gate is the error surface).
    noProviderConfigured:
      !forceNoProviderOff &&
      messages[messages.length - 1]?.failureKind === "no_provider",
    canSend: initialCanSend && phase !== "booting",
    recording,
    handsFree,
    transcript,
    speaking: initialSpeaking,
    agentVoiceMuted,
    needsAudioUnlock,
    transcriptionMode,
    toggleTranscriptionMode: () => {
      setTranscriptionMode((t) => {
        console.log(`[fixture] toggleTranscriptionMode -> ${!t}`);
        return !t;
      });
    },
    // Mic tap while transcribing: master voice control — everything off.
    stopTranscriptionAndMic: () => {
      console.log("[fixture] stopTranscriptionAndMic");
      setTranscriptionMode(false);
      setRecording(false);
      setTranscript("");
      setPhase("summoned");
    },
    // The overlay reads `modelStatus.kind` unconditionally; "ready" keeps the
    // local-model status strip dormant in the fixture.
    modelStatus: { kind: "ready" },
    send,
    toggleRecording,
    toggleHandsFree,
    setDictationSink,
    setTranscriptSessionSink,
    setComposerHasDraft: (hasDraft: boolean) =>
      console.log(`[fixture] setComposerHasDraft -> ${hasDraft}`),
    startRecording,
    stopRecording,
    toggleAgentVoiceMute,
    unlockAudio: () => {
      console.log("[fixture] unlockAudio");
      setNeedsAudioUnlock(false);
    },
    openSettings: () => console.log("[fixture] openSettings"),
    // `?tab=chat` disables the Home button (already home); `?tab=views` disables
    // Views; `?tab=settings` disables Settings. Unset → all three are enabled.
    currentTab: params.get("tab") ?? undefined,
    navigateHome: () => console.log("[fixture] navigateHome"),
    clearConversation: () => console.log("[fixture] clearConversation"),
    stop: () => {
      console.log("[fixture] stop");
      setPhase("summoned");
    },
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
      <ContinuousChatOverlay
        controller={controller}
        firstRunOpen={firstRunOpen}
      />
    </div>
  );
}

const root = document.getElementById("root");
// Assistant turns render inline widgets and adjacent rich blocks that read the
// app store + chat composer — wrap the headless harness in the mock app provider
// so the segment pipeline resolves without the real shell.
if (root)
  createRoot(root).render(
    <MockAppProvider>
      <Harness />
    </MockAppProvider>,
  );
