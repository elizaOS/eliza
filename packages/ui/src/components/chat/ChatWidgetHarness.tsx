/**
 * Backend-free, device-runnable chat UX harness.
 *
 * Mounts the REAL ChatOverlay — the production expandable/collapsible
 * chat sheet — over a fake view backdrop, driven by a mock ShellController and
 * a scripted back-and-forth conversation. The script opens with the in-chat
 * onboarding widgets (choice, profile form, permission card, secret request)
 * pinned at the first-run detent, then collapses out of onboarding and walks
 * the remaining production widgets (follow-ups, workflow, checklist, coding
 * task, background picker, code, generated UI, failure/retry) one assistant
 * turn per user interaction. Every widget tap and composer send advances the
 * script; nothing touches the network, so it runs inside the Capacitor
 * simulator with no API server (gated by __ELIZA_CHAT_UI_HARNESS__ in
 * packages/app).
 */
import * as React from "react";

import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import { serializeTranscript } from "../../chat/native-transcript/spec";
import {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "../../first-run/first-run-greeting";
import {
  clearNativeGlassBackdrop,
  GlassStyles,
  setNativeGlassBackdrop,
  useNativeGlassBackdropActive,
} from "../../glass";
import {
  isNativeTranscriptAvailable,
  nativeTranscriptBridge,
} from "../../glass/native-transcript-bridge";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ChatOverlay } from "../shell/ChatOverlay";
import type { ShellMessage } from "../shell/shell-state";
import type {
  CaptureIntent,
  ShellController,
} from "../shell/useShellController";
import { registerTaskWidget } from "./widgets/task-widget";

registerTaskWidget();

/** Build-time seam for the native-transcript demo: `packages/app` bakes
 *  `ELIZA_NATIVE_TRANSCRIPT_DEMO=1` in via a Vite define because host tooling
 *  (`simctl spawn … defaults`) cannot reach WKWebView localStorage on a
 *  simulator. Web/jsdom builds leave it undefined. */
declare const __ELIZA_NATIVE_TRANSCRIPT_DEMO__: boolean | undefined;

export const NATIVE_TRANSCRIPT_DEMO_FLAG = "eliza:native-transcript-demo";

function nativeTranscriptDemoRequested(): boolean {
  if (
    typeof __ELIZA_NATIVE_TRANSCRIPT_DEMO__ !== "undefined" &&
    __ELIZA_NATIVE_TRANSCRIPT_DEMO__ === true
  ) {
    return true;
  }
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem(NATIVE_TRANSCRIPT_DEMO_FLAG) === "1"
  );
}

let nextId = 1000;
const uid = () => `harness-${nextId++}`;

const PROFILE_FORM = JSON.stringify({
  id: "onboarding-profile",
  title: "Set up your assistant",
  description: "Everything stays on this device — nothing is sent anywhere.",
  submitLabel: "Save profile",
  fields: [
    {
      name: "name",
      label: "What should I call you?",
      type: "text",
      required: true,
    },
    {
      name: "focus",
      label: "Primary focus",
      type: "select",
      options: [
        { label: "Work", value: "work" },
        { label: "Personal", value: "personal" },
        { label: "Both", value: "both" },
      ],
    },
    { name: "daily", label: "Send a daily recap", type: "checkbox" },
  ],
});

const PERMISSION_CARD = JSON.stringify({
  action: "permission_request",
  permission: "reminders",
  reason: "I can nudge you about plans you make in chat.",
  feature: "onboarding.reminders",
  fallback_offered: true,
});

const GENERATED_UI = JSON.stringify({
  root: "harness-heading",
  state: {},
  elements: {
    "harness-heading": {
      type: "Heading",
      props: { text: "Interactive generated UI", level: "h3" },
      children: [],
    },
  },
});

/** One scripted assistant turn. `endsOnboarding` collapses the first-run pin. */
export interface Scene {
  content: string;
  source?: string;
  failureKind?: ShellMessage["failureKind"];
  secretRequest?: ShellMessage["secretRequest"];
  toolEvents?: NativeToolCallEvent[];
  reasoning?: string;
  endsOnboarding?: boolean;
}

/**
 * Onboarding opening — the production first-run turns verbatim: the greeting,
 * then the REAL sign-into-cloud choice widget using the same `__first_run__:`
 * action protocol the overlay's own sign-in fallback bakes. In the harness the
 * tap lands in the scripted sendActionMessage instead of the onboarding
 * conductor, advancing the tour.
 */
export const CHAT_HARNESS_OPENING: ShellMessage[] = [
  {
    id: "first-run:greeting",
    role: "assistant",
    source: "first_run",
    createdAt: 1,
    content: FIRST_RUN_GREETING,
  },
  {
    id: "first-run:cloud-oauth",
    role: "assistant",
    source: "first_run",
    createdAt: 2,
    content: [
      FIRST_RUN_SIGN_IN_PROMPT,
      "",
      "[CHOICE:first-run id=runtime]",
      "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
      "__first_run__:runtime:local=Stay local for now",
      "[/CHOICE]",
    ].join("\n"),
  },
];

export const CHAT_HARNESS_SCRIPT: Scene[] = [
  {
    source: "first_run",
    // The sign-in tap is the last pinned interaction: release the first-run
    // pin with this reply so the whole tour stays reachable from the composer.
    endsOnboarding: true,
    content: `Signed in — welcome! Tell me a little about yourself so I can tailor things.\n[FORM]\n${PROFILE_FORM}\n[/FORM]`,
  },
  {
    source: "first_run",
    content: `Saved. One quick permission so I can remind you about things later:\n\`\`\`json\n${PERMISSION_CARD}\n\`\`\``,
  },
  {
    content:
      "Last onboarding step — connect a model provider key. This secure field never leaves the device in this harness. (Feel free to skip — just keep typing.)",
    secretRequest: {
      key: "HARNESS_API_KEY",
      reason: "Connect a provider to start chatting for real.",
      status: "pending",
      delivery: {
        mode: "inline_owner_app",
        canCollectValueInCurrentChannel: true,
      },
      form: {
        type: "sensitive_request_form",
        kind: "secret",
        mode: "inline_owner_app",
        submitLabel: "Save key",
        fields: [
          {
            name: "HARNESS_API_KEY",
            label: "API key",
            input: "secret",
            required: true,
          },
        ],
      },
    },
  },
  {
    // Explicit id: without one the parser mints a fresh randomUUID per parse,
    // which would make the committed native-transcript golden fixture
    // (regenerated from this script) nondeterministic.
    content:
      "You're all set — onboarding done, sheet unpinned. Pull the grabber down to collapse this chat, pull up (or type) to expand it again. Want to see what I can do mid-conversation?\n[FOLLOWUPS id=harness-followups]\nreply:Show me widgets=Show me\nprompt:Refine the plan for =Prefill composer\nnavigate:/settings=Open settings\n[/FOLLOWUPS]",
  },
  {
    content:
      'Here\'s a live plan. Steps update as work happens:\n[WORKFLOW]\n{"id":"harness-workflow","title":"Ship mobile polish","steps":[{"label":"Capture iOS","status":"done"},{"label":"Tune glass","status":"running"},{"label":"Verify Android","status":"pending"}]}\n[/WORKFLOW]',
  },
  {
    // Live activity channel: real ToolCallEventLog rows (success + running) and
    // the real collapsed ThinkingBlock, exactly as a streamed agent turn
    // carries them (ShellMessage.toolEvents / .reasoning).
    reasoning:
      "The user wants a status check. Query the calendar first, then start the follow-up search; keep the summary short.",
    toolEvents: [
      {
        id: "harness-tool-1",
        type: "tool_result",
        callId: "call-1",
        actionName: "CALENDAR_FIND_EVENTS",
        args: { query: "today", limit: 5 },
        result: { count: 2 },
        status: "completed",
        durationMs: 412,
        stage: "action_execution",
      },
      {
        id: "harness-tool-2",
        type: "tool_call",
        callId: "call-2",
        actionName: "WEB_SEARCH",
        args: { query: "eliza chat glass design" },
        status: "running",
        stage: "action_execution",
      },
    ],
    content:
      "Here's what live agent work looks like — tool calls with their running/success state, expandable for args and results, and my reasoning collapsed under Thinking:",
  },
  {
    content:
      'And a checklist you can track in-line:\n[CHECKLIST]\n{"title":"UX review","items":[{"content":"Tap every control","status":"completed"},{"content":"Check safe areas","status":"in_progress"},{"content":"Review keyboard","status":"pending"}]}\n[/CHECKLIST]',
  },
  {
    content:
      "I can also run coding tasks and restyle the app:\n[TASK:00000000-0000-4000-8000-000000000001]Refine native chat glass[/TASK]\n[BACKGROUND]",
  },
  {
    content: `Code renders inline with the real copyable block:\n\`\`\`tsx\n<ChatWidgetHarness mode="native" />\n\`\`\``,
  },
  {
    // Kept as its own turn: the segment parser's fence regex only recognizes a
    // UiSpec fence when a non-json fence does not precede it in the same
    // message (the earlier fence's closing ``` consumes the json opener).
    content: `And this is live agent-generated UI, not a code block:\n\`\`\`json\n${GENERATED_UI}\n\`\`\``,
  },
  {
    failureKind: "rate_limited",
    content:
      "The provider is temporarily busy — this is the failure state, and the retry affordance should stay obvious.",
  },
  {
    content:
      "That's the full gallery. Keep chatting — every send loops back through these local replies, and every widget above stays interactive.",
  },
];

export function ChatWidgetHarness(): React.JSX.Element {
  // Layered-glass demo: on a native shell with the GlassBridge available the
  // ember field moves behind the (transparent) webview, and the sheet anchors
  // a REAL glass panel over it. The DOM backdrop below stays for CSS tiers.
  const nativeBackdrop = useNativeGlassBackdropActive();
  // The document canvas (html/body launch background) sits between the
  // transparent webview and the DOM — it must go transparent too or it
  // occludes the native field exactly like an opaque backdrop div would.
  // AppBackground owns this in the real shell; the harness mirrors it.
  React.useEffect(() => {
    if (!nativeBackdrop) return;
    const root = document.documentElement;
    const prevRoot = root.style.backgroundColor;
    const prevRootImage = root.style.backgroundImage;
    const prevBody = document.body?.style.backgroundColor ?? "";
    root.style.backgroundColor = "transparent";
    root.style.backgroundImage = "";
    if (document.body) document.body.style.backgroundColor = "transparent";
    return () => {
      root.style.backgroundColor = prevRoot;
      root.style.backgroundImage = prevRootImage;
      if (document.body) document.body.style.backgroundColor = prevBody;
    };
  }, [nativeBackdrop]);
  React.useEffect(() => {
    void setNativeGlassBackdrop({
      kind: "ember",
      // Grounded to BLACK at the top like the app's real field — only the
      // low-center ember pool carries luminance (the radial's bright focus
      // sits at bottom-center; the first stop is the outer/top field).
      colors: ["#000000", "#7a2d0c", "#ff7a3d"],
      animated: true,
    });
    return () => {
      void clearNativeGlassBackdrop();
    };
  }, []);
  const [messages, setMessages] =
    React.useState<ShellMessage[]>(CHAT_HARNESS_OPENING);
  const [phase, setPhase] =
    React.useState<ShellController["phase"]>("summoned");
  const [recording, setRecording] = React.useState(false);
  const [handsFree, setHandsFree] = React.useState(false);
  const [transcript, setTranscript] = React.useState("");
  const [agentVoiceMuted, setAgentVoiceMuted] = React.useState(false);
  const [firstRunOpen, setFirstRunOpen] = React.useState(true);
  const sceneIndexRef = React.useRef(0);
  const chatInputSinkRef = React.useRef<((text: string) => void) | null>(null);
  const dictationSinkRef = React.useRef<((text: string) => void) | null>(null);
  const captureIntentRef = React.useRef<CaptureIntent>("converse");

  const appendUserAndAdvance = React.useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Widget action protocols (__first_run__:, __permission_card__:, …) are
    // machine channels the production pipeline consumes without echoing into
    // the visible transcript — advance the script without a user bubble.
    const isProtocol = trimmed.startsWith("__");
    // While onboarding is pinned the overlay renders ONLY first_run-tagged
    // turns and locks the composer (advancement comes from widget taps), so
    // the echoed user turn must carry the tag to stay visible until the
    // pin releases.
    const nextScene =
      CHAT_HARNESS_SCRIPT[
        Math.min(sceneIndexRef.current, CHAT_HARNESS_SCRIPT.length - 1)
      ];
    if (!isProtocol) {
      setMessages((current) => [
        ...current,
        {
          id: uid(),
          role: "user",
          content: trimmed,
          createdAt: nextId,
          ...(nextScene.source ? { source: nextScene.source } : {}),
        },
      ]);
    }
    setPhase("responding");
    window.setTimeout(() => {
      const scene =
        CHAT_HARNESS_SCRIPT[
          Math.min(sceneIndexRef.current, CHAT_HARNESS_SCRIPT.length - 1)
        ];
      sceneIndexRef.current += 1;
      setMessages((current) => [
        ...current,
        {
          id: uid(),
          role: "assistant",
          content: scene.content,
          createdAt: nextId,
          ...(scene.source ? { source: scene.source } : {}),
          ...(scene.failureKind ? { failureKind: scene.failureKind } : {}),
          ...(scene.secretRequest
            ? { secretRequest: scene.secretRequest }
            : {}),
          ...(scene.toolEvents ? { toolEvents: scene.toolEvents } : {}),
          ...(scene.reasoning ? { reasoning: scene.reasoning } : {}),
        },
      ]);
      if (scene.endsOnboarding) setFirstRunOpen(false);
      setPhase("summoned");
    }, 600);
  }, []);

  // Native-transcript side-by-side REVIEW mode (not production wiring): with
  // the demo flag set and the NativeTranscript plugin present, the harness
  // mirrors every transcript change into the platform-native list mounted
  // over the TOP half of the screen while the DOM overlay stays interactive
  // below, so the two renderers can be compared on-device frame for frame.
  // Native widget taps come back as the SAME action strings the DOM widgets
  // pass to sendActionMessage and land in the same scripted advance — there
  // is exactly one action channel (see chat/native-transcript/spec.ts).
  const [nativeDemoActive, setNativeDemoActive] = React.useState(false);
  React.useEffect(() => {
    if (!nativeTranscriptDemoRequested()) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | null = null;
    let shown = false;
    void (async () => {
      if (!(await isNativeTranscriptAvailable()) || disposed) return;
      const bridge = nativeTranscriptBridge();
      if (!bridge) return;
      const handle = await bridge.addListener(
        "transcriptAction",
        (action) => {
          // Typed envelope routing — mirror the DOM widgets exactly: only
          // `message` reaches the conversation; navigate/prefill/background
          // are LOCAL intents (window event / composer prefill / display
          // store) and must never become chat text.
          switch (action.kind) {
            case "navigate":
              window.dispatchEvent(
                new CustomEvent("eliza:navigate:view", {
                  detail: { view: action.view },
                }),
              );
              return;
            case "prefill":
              chatInputSinkRef.current?.(action.text);
              return;
            case "background":
              // Review harness: no display-preferences store is mounted;
              // surface the intent without fabricating an applied change.
              console.info(
                `[ChatWidgetHarness] native background intent: ${action.presetId}`,
              );
              return;
            default:
              appendUserAndAdvance(action.message);
          }
        },
      );
      if (disposed) {
        void handle.remove();
        return;
      }
      listener = handle;
      await bridge.show({
        rect: {
          x: 0,
          y: 0,
          width: window.innerWidth,
          height: Math.round(window.innerHeight / 2),
        },
      });
      shown = true;
      if (!disposed) setNativeDemoActive(true);
    })();
    return () => {
      disposed = true;
      setNativeDemoActive(false);
      void listener?.remove();
      if (shown) void nativeTranscriptBridge()?.hide();
    };
  }, [appendUserAndAdvance]);

  React.useEffect(() => {
    if (!nativeDemoActive) return;
    const bridge = nativeTranscriptBridge();
    if (!bridge) return;
    void bridge.setTranscript({
      frame: serializeTranscript(messages, {
        turnStatus: phase === "responding" ? { kind: "thinking" } : null,
      }),
    });
  }, [nativeDemoActive, messages, phase]);

  const send = React.useCallback<ShellController["send"]>(
    (text) => appendUserAndAdvance(text),
    [appendUserAndAdvance],
  );

  // Widget taps (choice picks, form submits, follow-ups, permission buttons)
  // route through the app store's sendActionMessage — feed them into the same
  // scripted conversation the composer uses.
  const appValue = React.useMemo(
    () => ({
      sendActionMessage: async (text: string) => appendUserAndAdvance(text),
      setChatInput: (text: string) => chatInputSinkRef.current?.(text),
      copyToClipboard: async () => {},
    }),
    [appendUserAndAdvance],
  );

  const controller: ShellController = {
    phase,
    responding: phase === "responding",
    turnStatus: phase === "responding" ? { kind: "thinking" as const } : null,
    messages,
    noProviderConfigured: false,
    canSend: true,
    waveformMode: recording
      ? "listening"
      : phase === "responding"
        ? "responding"
        : "idle",
    analyser: null,
    open: () => {},
    close: () => {},
    isOpen: true,
    recording,
    handsFree,
    transcript,
    speaking: false,
    agentVoiceMuted,
    needsAudioUnlock: false,
    transcriptionMode: false,
    toggleTranscriptionMode: () => {},
    stopTranscriptionAndMic: () => {
      setRecording(false);
      setTranscript("");
      setPhase("summoned");
    },
    modelStatus: {
      kind: "ready",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    },
    send,
    captureVision: () => {},
    visionCapturing: false,
    toggleRecording: () => {
      setRecording((r) => {
        setTranscript(r ? "" : "listening…");
        setPhase(r ? "summoned" : "listening");
        return !r;
      });
    },
    toggleHandsFree: () => {
      setHandsFree((h) => {
        captureIntentRef.current = "converse";
        setRecording(!h);
        setPhase(h ? "summoned" : "listening");
        return !h;
      });
    },
    micPermission: "unknown",
    recheckMicPermission: async () => "unknown",
    setDictationSink: (sink) => {
      dictationSinkRef.current = sink;
      // The overlay's dictation sink writes into its composer draft — reuse it
      // for widget "prefill composer" actions via the app store's setChatInput.
      chatInputSinkRef.current = sink;
    },
    setTranscriptSessionSink: () => {},
    setComposerHasDraft: () => {},
    startRecording: (intent: CaptureIntent = "converse") => {
      captureIntentRef.current = intent;
      setRecording(true);
      setTranscript("listening…");
      setPhase("listening");
    },
    stopRecording: () => {
      setRecording(false);
      setTranscript("");
      setPhase("summoned");
    },
    speak: () => {},
    stopSpeaking: () => {},
    toggleAgentVoiceMute: () => setAgentVoiceMuted((m) => !m),
    unlockAudio: () => {},
    openSettings: () => {},
    currentTab: undefined,
    navigateHome: () => {},
    clearConversation: () => {
      sceneIndexRef.current = 0;
      setMessages(CHAT_HARNESS_OPENING);
      setFirstRunOpen(true);
      setPhase("summoned");
    },
    stop: () => setPhase("summoned"),
    conversationNav: {
      hasPrev: false,
      hasNext: false,
      goPrev: () => {},
      goNext: () => {},
      activeId: "harness-thread",
      index: 0,
    },
  };

  return (
    <MockAppProvider value={appValue}>
      <div
        data-testid="chat-widget-harness"
        style={{
          position: "fixed",
          inset: 0,
          // The real /chat ambient home backdrop — the glass sheet must be
          // reviewed over the composite it ships on. Transparent while the
          // NATIVE backdrop owns the field (occluding it would blind the
          // native glass panels sampling it).
          background: nativeBackdrop ? "transparent" : "#ef5a1f",
          overflow: "hidden",
        }}
      >
        {/* Detail behind the sheet: frosted glass is invisible over a flat
            color — these stand-in home widgets give the blur something real
            to refract, matching what the sheet floats over in the app. */}
        <div
          aria-hidden
          style={{
            padding: "72px 28px",
            maxWidth: 720,
            color: "rgba(255,255,255,0.92)",
            fontFamily: "inherit",
          }}
        >
          <h1 style={{ fontSize: 30, fontWeight: 600, margin: 0 }}>
            Good evening
          </h1>
          <p style={{ opacity: 0.75, marginTop: 10, lineHeight: 1.6 }}>
            Three meetings today. The build finished 12 minutes ago and the
            review queue is clear.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              marginTop: 18,
            }}
          >
            {["Calendar", "Tasks", "Notes", "Wallet", "Settings"].map((t) => (
              <span
                key={t}
                style={{
                  padding: "10px 16px",
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.12)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  fontSize: 13,
                }}
              >
                {t}
              </span>
            ))}
          </div>
          <div
            style={{
              marginTop: 22,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
            }}
          >
            {[
              "Polish the home screen",
              "Review the glass sheet",
              "Plan tomorrow",
              "Inbox zero",
            ].map((t, i) => (
              <div
                key={t}
                style={{
                  borderRadius: 16,
                  padding: "14px 16px",
                  background:
                    i % 2 ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.14)",
                  fontSize: 14,
                  lineHeight: 1.4,
                }}
              >
                {t}
              </div>
            ))}
          </div>
        </div>
        <GlassStyles />
        <ChatOverlay controller={controller} firstRunOpen={firstRunOpen} />
      </div>
    </MockAppProvider>
  );
}
