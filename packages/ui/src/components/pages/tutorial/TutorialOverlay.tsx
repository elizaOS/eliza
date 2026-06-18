import * as React from "react";

import { useApp } from "../../../state";
import { TutorialSpotlight } from "./TutorialSpotlight";
import {
  goToStep,
  setTutorialMode,
  stopTutorial,
  useTutorial,
} from "./tutorial-controller";
import { TUTORIAL_STEPS, type TutorialObservable } from "./tutorial-steps";

/**
 * The always-mounted interactive tutorial engine. When the tutorial is active it
 * samples real UI state (chat detents via stable test ids, the current tab),
 * AUTO-ADVANCES the instant the user performs the step's action, narrates each
 * step via the browser speech API in voice mode, and renders the spotlight that
 * both points at the next control and blocks every other one. Every step also
 * exposes a timed Continue fallback, so a missed auto-detection never traps the
 * user. Mounted once in App.tsx alongside the chat overlay.
 */

function speak(text: string): void {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1;
    synth.speak(u);
  } catch {
    /* no speech synthesis — text mode still works */
  }
}

function cancelSpeech(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

function has(selector: string): boolean {
  return typeof document !== "undefined" && !!document.querySelector(selector);
}

function readObservable(
  tab: string,
  secondsOnStep: number,
): TutorialObservable {
  const pilled = has('[data-testid="chat-pill"]');
  const sheet = has('[data-testid="chat-sheet"]');
  const grabber =
    typeof document !== "undefined"
      ? document.querySelector('[data-testid="chat-sheet-grabber"]')
      : null;
  const grabberExpanded = grabber?.getAttribute("aria-expanded") === "true";
  return {
    tab,
    chatOpen: !pilled,
    chatExpanded: sheet || grabberExpanded,
    chatPilled: pilled,
    secondsOnStep,
  };
}

export function TutorialOverlay(): React.ReactElement | null {
  const { active, stepIndex, mode } = useTutorial();
  const tab = useApp().tab;

  const [secondsOnStep, setSecondsOnStep] = React.useState(0);
  const [succeeded, setSucceeded] = React.useState(false);
  const stepStartRef = React.useRef<number>(0);

  const step = active ? TUTORIAL_STEPS[stepIndex] : undefined;

  const advance = React.useCallback(() => {
    cancelSpeech();
    if (stepIndex >= TUTORIAL_STEPS.length - 1) {
      stopTutorial();
    } else {
      goToStep(stepIndex + 1);
    }
  }, [stepIndex]);

  // Reset per-step timers whenever the step (or active) changes. stepIndex/active
  // are intentional re-run triggers, not values read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stepIndex/active are reset triggers
  React.useEffect(() => {
    stepStartRef.current = Date.now();
    setSecondsOnStep(0);
    setSucceeded(false);
  }, [stepIndex, active]);

  // Narrate the step in voice mode.
  React.useEffect(() => {
    if (!active || mode !== "voice" || !step) return;
    speak(step.voiceLine);
    return () => cancelSpeech();
  }, [active, mode, step]);

  // Sample observable UI state + auto-detect success.
  React.useEffect(() => {
    if (!active || !step || succeeded) return;
    const id = window.setInterval(() => {
      const secs = (Date.now() - stepStartRef.current) / 1000;
      setSecondsOnStep(secs);
      if (step.isComplete?.(readObservable(tab, secs))) {
        setSucceeded(true);
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [active, step, succeeded, tab]);

  // After a brief "you did it" beat, advance.
  React.useEffect(() => {
    if (!succeeded) return;
    const t = window.setTimeout(advance, 850);
    return () => window.clearTimeout(t);
  }, [succeeded, advance]);

  if (!active || !step) return null;

  const showContinue =
    step.manualContinue ||
    (step.continueAfterSec != null && secondsOnStep >= step.continueAfterSec);
  const isLast = stepIndex >= TUTORIAL_STEPS.length - 1;

  return (
    <TutorialSpotlight
      targetSelector={step.targetSelector}
      blockOutside={step.blockOutside && !succeeded}
      title={succeeded ? "Nice — you got it! ✓" : step.title}
      body={
        succeeded
          ? "Moving on…"
          : mode === "voice" && step.voiceCommandHint
            ? `${step.body}\n\n🎙️ Say: “${step.voiceCommandHint}”`
            : step.body
      }
      stepIndex={stepIndex}
      totalSteps={TUTORIAL_STEPS.length}
      mode={mode}
      voiceBusy={
        mode === "voice" &&
        typeof window !== "undefined" &&
        !!window.speechSynthesis?.speaking
      }
      onToggleMode={() => setTutorialMode(mode === "voice" ? "text" : "voice")}
      onSkip={stopTutorial}
      onContinue={showContinue ? advance : undefined}
      continueLabel={isLast ? "Done" : step.continueLabel}
    />
  );
}
