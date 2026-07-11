/**
 * Backend-free, device-runnable chat UX harness.
 *
 * Mounts the REAL ContinuousChatOverlay — the production expandable/collapsible
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

import { GlassStyles } from "../../glass";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ContinuousChatOverlay } from "../shell/ContinuousChatOverlay";
import type { ShellController, CaptureIntent } from "../shell/useShellController";
import type { ShellMessage } from "../shell/shell-state";
import { registerTaskWidget } from "./widgets/task-widget";

registerTaskWidget();

let nextId = 1000;
const uid = () => `harness-${nextId++}`;

const PROFILE_FORM = JSON.stringify({
  id: "onboarding-profile",
  title: "Set up your assistant",
  description: "Everything stays on this device — nothing is sent anywhere.",
  submitLabel: "Save profile",
  fields: [
    { name: "name", label: "What should I call you?", type: "text", required: true },
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
interface Scene {
  content: string;
  source?: string;
  failureKind?: ShellMessage["failureKind"];
  secretRequest?: ShellMessage["secretRequest"];
  endsOnboarding?: boolean;
}

/** Onboarding first: greeting choice → profile form → permission → secret. */
const OPENING: ShellMessage[] = [
  {
    id: "harness-onboarding-greeting",
    role: "assistant",
    source: "first_run",
    createdAt: 1,
    content:
      "Hey — I'm your assistant. Let's set things up right here in chat. How do you want to start?\n[CHOICE:onboarding-start id=onboarding-start allowCustom=true]\nsetup=Set me up\ntour=Quick tour\nexplore=Just explore\n[/CHOICE]",
  },
];

const SCRIPT: Scene[] = [
  {
    source: "first_run",
    content: `Great. Tell me a little about yourself so I can tailor things.\n[FORM]\n${PROFILE_FORM}\n[/FORM]`,
  },
  {
    source: "first_run",
    content: `Saved. One quick permission so I can remind you about things later:\n\`\`\`json\n${PERMISSION_CARD}\n\`\`\``,
  },
  {
    source: "first_run",
    content:
      "Last onboarding step — connect a model provider key. This secure field never leaves the device in this harness.",
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
          { name: "HARNESS_API_KEY", label: "API key", input: "secret", required: true },
        ],
      },
    },
  },
  {
    endsOnboarding: true,
    content:
      "You're all set — onboarding done, sheet unpinned. Pull the grabber down to collapse this chat, pull up (or type) to expand it again. Want to see what I can do mid-conversation?\n[FOLLOWUPS]\nreply:Show me widgets=Show me\nprompt:Refine the plan for =Prefill composer\nnavigate:/settings=Open settings\n[/FOLLOWUPS]",
  },
  {
    content:
      'Here\'s a live plan. Steps update as work happens:\n[WORKFLOW]\n{"id":"harness-workflow","title":"Ship mobile polish","steps":[{"label":"Capture iOS","status":"done"},{"label":"Tune glass","status":"running"},{"label":"Verify Android","status":"pending"}]}\n[/WORKFLOW]',
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
    content: `Code and generated UI render inline too:\n\`\`\`tsx\n<ChatWidgetHarness mode="native" />\n\`\`\`\n\`\`\`json\n${GENERATED_UI}\n\`\`\``,
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
  const [messages, setMessages] = React.useState<ShellMessage[]>(OPENING);
  const [phase, setPhase] = React.useState<ShellController["phase"]>("summoned");
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
    // While onboarding is pinned the overlay renders ONLY first_run-tagged
    // turns and locks the composer (advancement comes from widget taps), so
    // the echoed user turn must carry the tag to stay visible until the
    // pin releases.
    const nextScene = SCRIPT[Math.min(sceneIndexRef.current, SCRIPT.length - 1)];
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
    setPhase("responding");
    window.setTimeout(() => {
      const scene = SCRIPT[Math.min(sceneIndexRef.current, SCRIPT.length - 1)];
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
          ...(scene.secretRequest ? { secretRequest: scene.secretRequest } : {}),
        },
      ]);
      if (scene.endsOnboarding) setFirstRunOpen(false);
      setPhase("summoned");
    }, 600);
  }, []);

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
      setMessages(OPENING);
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
          // reviewed over the composite it ships on.
          background: "#ef5a1f",
          overflow: "hidden",
        }}
      >
        <GlassStyles />
        <ContinuousChatOverlay
          controller={controller}
          firstRunOpen={firstRunOpen}
        />
      </div>
    </MockAppProvider>
  );
}
