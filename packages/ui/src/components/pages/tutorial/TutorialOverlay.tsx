/**
 * The interactive tour overlay mounted at the shell root: watches the live tab
 * and chat transcript, spotlights the target element for the current step,
 * narrates each frame aloud (TutorialNarrator), and advances when the user
 * performs the step's action. Completion is tracked by step id (never a
 * lingering boolean) so one frame's success cannot bleed into the next frame's
 * auto-navigation during the advance render. Drives navigation and chat via the
 * shell controller and locks nav while a step is active.
 */

import * as React from "react";
import { useBranding } from "../../../config/branding";
import { dispatchTutorialChatControl } from "../../../events";
import type { Tab } from "../../../navigation";
import { setNavLock } from "../../../navigation/nav-lock";
import { useAppSelector } from "../../../state";
import { useShellControllerContext } from "../../shell/ShellControllerContext.hooks";
import { TutorialNarrator } from "./TutorialNarrator";
import { TutorialSpotlight } from "./TutorialSpotlight";
import { goToStep, stopTutorial, useTutorial } from "./tutorial-controller";
import {
  buildTutorialSteps,
  type ChatDetent,
  type TutorialObservable,
} from "./tutorial-steps";

/**
 * The always-mounted interactive tour engine. When active it drives the real
 * chat into a clean, known state at the start of each frame, narrates the line
 * aloud through the app's real voice ({@link TutorialNarrator}), samples live UI
 * state (chat detent, composer text, voice transcript, current tab), and
 * auto-advances the instant the user performs the frame's action. The "ask to
 * navigate" + voice frames complete the staged navigation for real on success.
 * Mounted once in App.tsx, inside the shell controller provider.
 */

const LATE_SKIP_SEC = 14; // an unobtrusive "Skip" appears if a frame stalls
const SUCCESS_BEAT_MS = 850; // brief "you did it" pause before advancing

function readChatDetent(): ChatDetent | null {
  if (typeof document === "undefined") return null;
  const d = document
    .querySelector('[data-testid="chat-sheet"]')
    ?.getAttribute("data-detent");
  return d === "pill" || d === "collapsed" || d === "half" || d === "full"
    ? d
    : null;
}

function readComposerText(): string {
  if (typeof document === "undefined") return "";
  const el = document.querySelector('[data-testid="chat-composer-textarea"]');
  return el instanceof HTMLTextAreaElement ? el.value : "";
}

/** Read the active conversation id + index off the live chat-sheet (stamped by
 *  ContinuousChatOverlay). Drives the new-chat / swipe-between-chats frames. */
function readConversation(): { id: string | null; index: number } {
  if (typeof document === "undefined") return { id: null, index: -1 };
  const el = document.querySelector('[data-testid="chat-sheet"]');
  const id = el?.getAttribute("data-conversation-id") ?? null;
  const idx = Number.parseInt(
    el?.getAttribute("data-conversation-index") ?? "",
    10,
  );
  return { id, index: Number.isNaN(idx) ? -1 : idx };
}

export function TutorialOverlay(): React.ReactElement | null {
  const { active, stepIndex } = useTutorial();
  const tab = useAppSelector((s) => s.tab);
  const setTab = useAppSelector((s) => s.setTab);
  const controller = useShellControllerContext();
  // Brand the tour copy ("Meet My App", "Hi, I'm My App") with the app name.
  const { appName } = useBranding();
  const steps = React.useMemo(() => buildTutorialSteps(appName), [appName]);

  const [beat, setBeat] = React.useState<1 | 2>(1);
  // The id of the step whose action has been completed. Tracked by id (not a
  // lingering boolean) so a frame's success can't bleed into the NEXT frame
  // during the advance render — which would fire the next frame's
  // `navigateOnDone` before the user ever acts on it.
  const [doneStepId, setDoneStepId] = React.useState<string | null>(null);
  // The late "Skip" only needs a single boolean flip once a frame stalls — not
  // a per-tick seconds counter, which would re-render the overlay 5×/second.
  const [lateSkip, setLateSkip] = React.useState(false);
  const [muted, setMuted] = React.useState(false);

  const step = active ? steps[stepIndex] : undefined;

  // Live values read by the (closure-stable) sampling interval via refs, so it
  // never captures a stale tab/transcript.
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  const transcriptRef = React.useRef(controller?.transcript ?? "");
  transcriptRef.current = controller?.transcript ?? "";
  const stepStartRef = React.useRef(0);
  const sawPrefillRef = React.useRef(false);
  // The conversation the current frame STARTED on — captured lazily on the first
  // tick the chat is mounted — so new-chat / swipe is measured as a change from
  // it, not an absolute value.
  const convoBaselineRef = React.useRef<{
    id: string | null;
    index: number;
  } | null>(null);

  const advance = React.useCallback(() => {
    if (stepIndex >= steps.length - 1) stopTutorial();
    else goToStep(stepIndex + 1);
  }, [stepIndex, steps.length]);

  // Frame enter: reset per-frame state and drive the chat into the clean state
  // this frame needs (pill / rest / expand) or pre-fill the staged command.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stepIndex/active are the reset triggers
  React.useEffect(() => {
    setBeat(1);
    setDoneStepId(null);
    setLateSkip(false);
    sawPrefillRef.current = false;
    convoBaselineRef.current = null;
    stepStartRef.current = Date.now();
    if (!step) return;
    if (step.prefill != null) {
      dispatchTutorialChatControl({ action: "prefill", text: step.prefill });
    } else if (step.enterChat) {
      dispatchTutorialChatControl({ action: step.enterChat });
    }
  }, [stepIndex, active]);

  // Capability lock: while the tour runs, restrict navigation to the tabs the
  // current frame expects (its own tab + its staged target), so nothing — a
  // stray control, a deep link, an agent action, the chat's own nav buttons —
  // can drift the app into a state the tour doesn't expect. Cleared on exit.
  React.useEffect(() => {
    if (!active || !step) {
      setNavLock(null);
      return undefined;
    }
    setNavLock(step.lockTabs ?? ["chat"]);
    return () => setNavLock(null);
  }, [active, step]);

  // When the tour ends — skip, complete, or unmount — restore the chat to a
  // normal interactive state. A frame may have collapsed it to the pill, where
  // the composer is `inert` (not clickable); without this reset, cancelling the
  // tour on the "open chat" frame leaves the input dead until the pill is
  // tapped. Fires on the active→inactive transition via the effect cleanup.
  React.useEffect(() => {
    if (!active) return undefined;
    return () => {
      dispatchTutorialChatControl({ action: "reset" });
    };
  }, [active]);

  // The tour never auto-launches. It only starts on an explicit user action —
  // the launcher/Tutorial view or Help's "Start the tutorial" link (both call
  // startTutorial()).

  // Sample live UI state and auto-detect completion of the current beat.
  React.useEffect(() => {
    if (!active || !step || doneStepId === step.id) return undefined;
    const id = window.setInterval(() => {
      const secs = (Date.now() - stepStartRef.current) / 1000;
      // Reveal the late "Skip" once, when a frame stalls. setState bails out
      // once it's already true, so this stops re-rendering after the first flip.
      if (secs >= LATE_SKIP_SEC) setLateSkip(true);
      const composerText = readComposerText();
      if (step.prefill && composerText === step.prefill) {
        sawPrefillRef.current = true;
      }
      const convo = readConversation();
      // Capture the frame's starting conversation once the chat is mounted, then
      // report a new-chat / swipe as a change away from it.
      if (convoBaselineRef.current == null && convo.id != null) {
        convoBaselineRef.current = convo;
      }
      const base = convoBaselineRef.current;
      const obs: TutorialObservable = {
        tab: tabRef.current,
        detent: readChatDetent(),
        composerText,
        transcript: transcriptRef.current,
        prefillSent:
          step.prefill != null &&
          sawPrefillRef.current &&
          composerText.trim() === "",
        newConversationStarted:
          base != null && convo.id != null && convo.id !== base.id,
        conversationSwitched:
          base != null && convo.index >= 0 && convo.index !== base.index,
        secondsOnStep: secs,
      };
      const check = beat === 2 && step.beat2 ? step.beat2.isDone : step.isDone;
      if (check?.(obs)) {
        if (beat === 1 && step.beat2) {
          setBeat(2);
          stepStartRef.current = Date.now();
        } else {
          setDoneStepId(step.id);
        }
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [active, step, doneStepId, beat]);

  // On the CURRENT step's success: complete any staged navigation for real, then
  // advance. Guarded by step identity so a prior frame's success can't trigger
  // this frame's navigation during the advance render.
  React.useEffect(() => {
    if (!step || doneStepId !== step.id) return undefined;
    if (step.navigateOnDone) setTab(step.navigateOnDone as Tab);
    const t = window.setTimeout(advance, SUCCESS_BEAT_MS);
    return () => window.clearTimeout(t);
  }, [doneStepId, step, setTab, advance]);

  if (!active || !step) return null;

  const succeeded = doneStepId === step.id;
  const current = beat === 2 && step.beat2 ? step.beat2 : step;
  const isLast = stepIndex >= steps.length - 1;
  const showContinue = step.manualContinue || lateSkip;
  const continueLabel = step.manualContinue
    ? (step.continueLabel ?? "Continue")
    : "Skip";

  return (
    <>
      {!muted && (
        <TutorialNarrator
          utteranceId={`tutorial-${step.id}-${beat}`}
          text={current.voiceLine}
          muted={muted}
        />
      )}
      <TutorialSpotlight
        stepId={step.id}
        targetSelector={step.targetSelector}
        dimOutside={!succeeded}
        title={step.title}
        body={succeeded ? (step.doneBody ?? current.body) : current.body}
        muted={muted}
        onToggleMute={() => {
          controller?.unlockAudio?.();
          setMuted((m) => !m);
        }}
        onSkip={stopTutorial}
        onContinue={
          showContinue && !succeeded
            ? () => {
                controller?.unlockAudio?.();
                advance();
              }
            : undefined
        }
        continueLabel={isLast ? "Done" : continueLabel}
      />
    </>
  );
}
