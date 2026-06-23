export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface OnboardingStep {
  target: string;
  title: string;
  description: string;
  placement: TooltipPlacement;
}

export interface OnboardingTour {
  id: string;
  steps: OnboardingStep[];
  minWidth?: number;
}

export interface OnboardingState {
  completedTours: string[];
  skippedTours: string[];
  lastSeenAt?: number;
}

export interface OnboardingContextValue {
  activeTour: OnboardingTour | null;
  currentStepIndex: number;
  isActive: boolean;
  startTour: (tourId: string) => void;
  nextStep: () => void;
  prevStep: () => void;
  skipTour: () => void;
  completeTour: () => void;
  isTourCompleted: (tourId: string) => boolean;
  isTourSkipped: (tourId: string) => boolean;
  resetOnboarding: () => void;
}
