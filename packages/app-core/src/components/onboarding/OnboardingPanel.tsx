import type { OnboardingStep } from "@elizaos/app-core/state";
import { type ReactNode, useEffect, useRef } from "react";

interface OnboardingPanelProps {
  step: OnboardingStep;
  children: ReactNode;
}

export function OnboardingPanel({ step, children }: OnboardingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevStepRef = useRef(step);

  // Re-trigger entry animation on step change
  useEffect(() => {
    if (prevStepRef.current !== step && panelRef.current) {
      const panel = panelRef.current;
      panel.style.animation = "none";
      // Force reflow
      void panel.offsetHeight;
      panel.style.animation = "";

      // Re-trigger children stagger
      panel.querySelectorAll<HTMLElement>(":scope > *").forEach((child) => {
        child.style.animation = "none";
        void child.offsetHeight;
        child.style.animation = "";
      });
    }
    prevStepRef.current = step;
  }, [step]);

  return (
    <div className="onboarding-right">
      <div className="onboarding-panel" ref={panelRef}>
        {children}
      </div>
    </div>
  );
}
