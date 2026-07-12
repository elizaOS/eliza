/**
 * In-chat tutorial conductor (headless). While the tutorial service is active
 * it seeds one assistant turn per script step into the SAME live transcript
 * the floating `ChatOverlay` renders, narrates each turn through the
 * app's real voice engine, and auto-advances when the cheap observation for
 * the current step fires (a real user message, a live voice transcript, the
 * Settings tab, a fresh conversation). Nothing is locked or dimmed: the user
 * can ignore the tour entirely and every turn carries Next / Stop choices
 * routed through the reserved `__tutorial__:` action channel.
 *
 * The conductor owns NO presentation — the existing chat widget renderers
 * draw the CHOICE buttons for free from the seeded turn text. It registers
 * the tutorial action + text handlers: choice picks are short-circuited by
 * `AppContext.sendActionMessage`, and the explicit "start/stop/restart
 * tutorial" commands by the composer's `submitText` (the post-onboarding
 * composer sends through `controller.send`, not the action funnel) — neither
 * ever reaches the server.
 *
 * Turn ids embed the run's `startedAt` nonce, so a restart re-seeds fresh
 * (unlocked) choice widgets instead of deduping into the previous run's
 * locked ones, and re-seeding is idempotent within one run — including after
 * a conversation switch replaces the transcript array.
 */
import * as React from "react";
import type { ConversationMessage } from "../api";
import { useShellControllerContext } from "../components/shell/ShellControllerContext.hooks";
import { useBranding } from "../config/branding";
import { dispatchChatOpen } from "../events";
import { useVoiceChat } from "../hooks/useVoiceChat";
import { useAppSelectorShallow } from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import { useVoiceConfig } from "../voice/useVoiceConfig";
import {
  buildTutorialActionValue,
  setTutorialActionHandler,
  setTutorialTextHandler,
  type TutorialAction,
  type TutorialCommand,
} from "./tutorial-action-channel";
import {
  buildTutorialScript,
  type TutorialScriptStep,
  type TutorialStepCompletion,
} from "./tutorial-script";
import {
  advanceTutorial,
  getTutorialState,
  restartTutorial,
  startTutorial,
  stopTutorial,
  useTutorial,
} from "./tutorial-service";

function makeTurn(id: string, text: string): ConversationMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: Date.now(),
    source: "tutorial",
  };
}

/** The seeded turn for a step: copy + its Next/Stop (or Done/Restart) CHOICE. */
function stepTurnText(step: TutorialScriptStep, isLast: boolean): string {
  const lines = isLast
    ? [
        `${buildTutorialActionValue("next", step.id)}=Done`,
        `${buildTutorialActionValue("restart", step.id)}=Restart tutorial`,
      ]
    : [
        `${buildTutorialActionValue("next", step.id)}=Next`,
        `${buildTutorialActionValue("stop", step.id)}=Stop tutorial`,
      ];
  return `${step.text}\n\n[CHOICE:tutorial id=${step.id}]\n${lines.join("\n")}\n[/CHOICE]`;
}

const STOPPED_TEXT =
  'Tutorial stopped. Type "start tutorial" any time to pick it back up from the beginning.';
const ALREADY_RUNNING_TEXT =
  'The tutorial is already running — look for the latest tour message above. Type "stop tutorial" to end it or "restart tutorial" to start over.';

export function useTutorialConductor(): void {
  const { status } = useTutorial();
  const { setConversationMessages } = useConversationMessages();

  const seedTurn = React.useCallback(
    (turn: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.some((m) => m.id === turn.id) ? prev : [...prev, turn],
      );
    },
    [setConversationMessages],
  );
  // Monotonic id source for command echo turns — unique per send even when two
  // land in the same millisecond, so seedTurn's id dedup never swallows one.
  const textTurnSeqRef = React.useRef(0);

  const seedStopped = React.useCallback(() => {
    const seq = (textTurnSeqRef.current += 1);
    seedTurn(makeTurn(`tutorial:stopped:${seq}`, STOPPED_TEXT));
  }, [seedTurn]);

  // ── Choice picks (`__tutorial__:<verb>:<stepId>`) ────────────────────────
  const handleAction = React.useCallback(
    (action: TutorialAction) => {
      switch (action.verb) {
        case "next":
          // Guarded by step id inside the service: stale "Next" widgets from
          // auto-advanced steps no-op instead of skipping the current step.
          advanceTutorial(action.stepId);
          return;
        case "stop":
          if (getTutorialState().status !== "active") return;
          stopTutorial();
          seedStopped();
          return;
        case "restart":
          restartTutorial();
          return;
      }
    },
    [seedStopped],
  );

  // ── Typed commands ("start/stop/restart tutorial") ───────────────────────
  const handleText = React.useCallback(
    (text: string, command: TutorialCommand): boolean => {
      const current = getTutorialState();
      // "stop tutorial" with no tour running is just chat about the tutorial —
      // let it reach the agent.
      if (command === "stop" && current.status !== "active") return false;
      const seq = (textTurnSeqRef.current += 1);
      seedTurn({
        id: `tutorial:user:${seq}`,
        role: "user",
        text: text.trim(),
        timestamp: Date.now(),
        source: "tutorial",
      });
      if (command === "stop") {
        stopTutorial();
        seedStopped();
        return true;
      }
      if (command === "restart") {
        restartTutorial();
        return true;
      }
      // start: restart-from-terminal is what startTutorial already does; only
      // an already-active tour needs an acknowledgement instead.
      if (current.status === "active") {
        seedTurn(makeTurn(`tutorial:already:${seq}`, ALREADY_RUNNING_TEXT));
        return true;
      }
      startTutorial();
      return true;
    },
    [seedTurn, seedStopped],
  );

  const handleActionRef = React.useRef(handleAction);
  handleActionRef.current = handleAction;
  const handleTextRef = React.useRef(handleText);
  handleTextRef.current = handleText;

  React.useEffect(() => {
    setTutorialActionHandler((action) => handleActionRef.current(action));
    setTutorialTextHandler((text, command) =>
      handleTextRef.current(text, command),
    );
    return () => {
      setTutorialActionHandler(null);
      setTutorialTextHandler(null);
    };
  }, []);

  // The tour lives in the transcript, so BECOMING active must reveal the chat
  // — a "start tutorial" typed from the collapsed composer would otherwise
  // seed turns the user never sees. Transition-edged (not on mount) so a
  // resumed-after-reload tour doesn't yank the chat open at boot. Deferred a
  // tick: the first-run "Take the tutorial" pick flips firstRunComplete and
  // starts the tour in the same commit, and the overlay's falling-edge effect
  // collapses the sheet (and its CHAT_OPEN listener still sees firstRunOpen)
  // during that commit's effects — a synchronous dispatch would be swallowed.
  const prevStatusRef = React.useRef(status);
  React.useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (status !== "active" || prev === "active") return;
    const id = window.setTimeout(dispatchChatOpen, 0);
    return () => window.clearTimeout(id);
  }, [status]);
}

/**
 * Seeding + auto-advance + narration effects that only exist while a tour
 * runs — split from the always-mounted conductor so the idle app never
 * subscribes to the per-token transcript stream or spins up the voice engine.
 */
function TutorialActiveEffects({
  step,
  isLast,
  runNonce,
}: {
  step: TutorialScriptStep;
  isLast: boolean;
  runNonce: number;
}): null {
  const { conversationMessages, setConversationMessages } =
    useConversationMessages();
  const controller = useShellControllerContext();
  const {
    tab,
    activeConversationId,
    uiLanguage,
    elizaCloudVoiceProxyAvailable,
  } = useAppSelectorShallow((s) => ({
    tab: s.tab,
    activeConversationId: s.activeConversationId,
    uiLanguage: s.uiLanguage,
    elizaCloudVoiceProxyAvailable: s.elizaCloudVoiceProxyAvailable,
  }));

  // Per-step baselines, captured when the step mounts: detections fire on a
  // CHANGE from here (a message sent after, a tab reached after, a different
  // conversation than the one the step began on) — never on pre-existing state.
  const baselineRef = React.useRef({
    at: Date.now(),
    tab,
    conversationId: activeConversationId,
  });

  // Keep the current step's turn IN the transcript, not just seed it once:
  // a server round-trip or conversation switch can replace the whole message
  // array (rehydration drops local-only turns), so whenever the turn id goes
  // missing while this step is live, it is re-appended. Idempotent — the id
  // embeds the run nonce + step id.
  const turnId = `tutorial:${runNonce}:step:${step.id}`;
  React.useEffect(() => {
    if (conversationMessages.some((m) => m.id === turnId)) return;
    const turn = makeTurn(turnId, stepTurnText(step, isLast));
    setConversationMessages((prev) =>
      prev.some((m) => m.id === turn.id) ? prev : [...prev, turn],
    );
  }, [conversationMessages, turnId, step, isLast, setConversationMessages]);

  const complete: TutorialStepCompletion | undefined = step.completeOn;

  // A real user message landed after this step began.
  React.useEffect(() => {
    if (complete !== "user-message") return;
    const base = baselineRef.current;
    const sent = conversationMessages.some(
      (m) =>
        m.role === "user" &&
        m.timestamp >= base.at &&
        m.source !== "tutorial" &&
        m.source !== "first_run",
    );
    if (sent) advanceTutorial(step.id);
  }, [complete, conversationMessages, step.id]);

  // A live voice transcript appeared (the mic is capturing).
  const transcript = controller?.transcript ?? "";
  React.useEffect(() => {
    if (complete !== "voice-transcript") return;
    if (transcript.trim()) advanceTutorial(step.id);
  }, [complete, transcript, step.id]);

  // The app navigated to Settings after this step began.
  React.useEffect(() => {
    if (complete !== "navigate-settings") return;
    if (tab === "settings" && baselineRef.current.tab !== "settings") {
      advanceTutorial(step.id);
    }
  }, [complete, tab, step.id]);

  // The active conversation changed (new chat or a swipe to another one).
  React.useEffect(() => {
    if (complete !== "new-conversation") return;
    const base = baselineRef.current.conversationId;
    if (
      base != null &&
      activeConversationId != null &&
      activeConversationId !== base
    ) {
      advanceTutorial(step.id);
    }
  }, [complete, activeConversationId, step.id]);

  // ── Narration through the app's REAL voice pipeline (cloud/local TTS with
  // the browser voice as fallback) — the same engine that voices assistant
  // replies. Output-only: the chat overlay's own capture owns the mic.
  const { voiceConfig, voiceBootstrapTick } = useVoiceConfig(uiLanguage);
  const { queueAssistantSpeech, stopSpeaking, unlockAudio } = useVoiceChat({
    voiceConfig,
    cloudConnected: elizaCloudVoiceProxyAvailable,
    interruptOnSpeech: false,
    onTranscript: () => {},
  });
  React.useEffect(() => {
    if (!step.voiceLine) return;
    if (voiceBootstrapTick === 0) return; // voice config not loaded yet
    unlockAudio?.();
    queueAssistantSpeech(
      `tutorial-${runNonce}-${step.id}`,
      step.voiceLine,
      true,
      {
        replace: true,
      },
    );
    return () => stopSpeaking();
  }, [
    step.id,
    step.voiceLine,
    runNonce,
    voiceBootstrapTick,
    queueAssistantSpeech,
    stopSpeaking,
    unlockAudio,
  ]);

  return null;
}

/** Mount point — render once inside the app provider tree (App.tsx). */
export function TutorialConductorMount(): React.ReactElement | null {
  useTutorialConductor();
  const { status, stepIndex, startedAt } = useTutorial();
  const { appName } = useBranding();
  const script = React.useMemo(() => buildTutorialScript(appName), [appName]);
  const step = status === "active" ? script[stepIndex] : undefined;
  if (!step) return null;
  return (
    <TutorialActiveEffects
      key={`${startedAt ?? 0}:${step.id}`}
      step={step}
      isLast={stepIndex >= script.length - 1}
      runNonce={startedAt ?? 0}
    />
  );
}
