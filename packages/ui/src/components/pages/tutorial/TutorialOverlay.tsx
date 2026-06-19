import * as React from "react";

import { dispatchTutorialChatControl } from "../../../events";
import type { Tab } from "../../../navigation";
import { setNavLock } from "../../../navigation/nav-lock";
import { useApp } from "../../../state";
import { useShellControllerContext } from "../../shell/ShellControllerContext.hooks";
import { TutorialNarrator } from "./TutorialNarrator";
import { TutorialSpotlight } from "./TutorialSpotlight";
import {
  goToStep,
  markTutorialAutoLaunched,
  shouldAutoLaunchTutorial,
  startTutorial,
  stopTutorial,
  useTutorial,
} from "./tutorial-controller";
import {
  type ChatDetent,
  TUTORIAL_STEPS,
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

export function TutorialOverlay(): React.ReactElement | null {
  const { active, stepIndex } = useTutorial();
  const { tab, setTab } = useApp();
  const controller = useShellControllerContext();

  const [beat, setBeat] = React.useState<1 | 2>(1);
  // The id of the step whose action has been completed. Tracked by id (not a
  // lingering boolean) so a frame's success can't bleed into the NEXT frame
  // during the advance render — which would fire the next frame's
  // `navigateOnDone` before the user ever acts on it.
  const [doneStepId, setDoneStepId] = React.useState<string | null>(null);
  const [secondsOnStep, setSecondsOnStep] = React.useState(0);
  const [muted, setMuted] = React.useState(false);

  const step = active ? TUTORIAL_STEPS[stepIndex] : undefined;

  // Live values read by the (closure-stable) sampling interval via refs, so it
  // never captures a stale tab/transcript.
  const tabRef = React.useRef(tab);
  tabRef.current = tab;
  const transcriptRef = React.useRef(controller?.transcript ?? "");
  transcriptRef.current = controller?.transcript ?? "";
  const stepStartRef = React.useRef(0);
  const sawPrefillRef = React.useRef(false);

  const advance = React.useCallback(() => {
    if (stepIndex >= TUTORIAL_STEPS.length - 1) stopTutorial();
    else goToStep(stepIndex + 1);
  }, [stepIndex]);

  // Frame enter: reset per-frame state and drive the chat into the clean state
  // this frame needs (pill / rest / expand) or pre-fill the staged command.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stepIndex/active are the reset triggers
  React.useEffect(() => {
    setBeat(1);
    setDoneStepId(null);
    setSecondsOnStep(0);
    sawPrefillRef.current = false;
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

  // First-run auto-launch: once ever, the first time a brand-new user lands on
  // the home base. Gating on the home tab keeps it out of onboarding/pairing.
  React.useEffect(() => {
    if (active || tab !== "chat" || !shouldAutoLaunchTutorial()) return;
    const t = window.setTimeout(() => {
      if (!shouldAutoLaunchTutorial()) return;
      markTutorialAutoLaunched();
      startTutorial();
    }, 1500);
    return () => window.clearTimeout(t);
  }, [active, tab]);

  // Sample live UI state and auto-detect completion of the current beat.
  React.useEffect(() => {
    if (!active || !step || doneStepId === step.id) return undefined;
    const id = window.setInterval(() => {
      const secs = (Date.now() - stepStartRef.current) / 1000;
      setSecondsOnStep(secs);
      const composerText = readComposerText();
      if (step.prefill && composerText === step.prefill) {
        sawPrefillRef.current = true;
      }
      const obs: TutorialObservable = {
        tab: tabRef.current,
        detent: readChatDetent(),
        composerText,
        transcript: transcriptRef.current,
        prefillSent:
          step.prefill != null &&
          sawPrefillRef.current &&
          composerText.trim() === "",
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
  const isLast = stepIndex >= TUTORIAL_STEPS.length - 1;
  const showContinue = step.manualContinue || secondsOnStep >= LATE_SKIP_SEC;
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
        targetSelector={step.targetSelector}
        blockOutside={!succeeded}
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
