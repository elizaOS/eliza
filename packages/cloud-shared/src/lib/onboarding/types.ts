/**
 * Types for the onboarding overlay system.
 */

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface OnboardingStep {
  /** CSS selector for the target element (uses data-onboarding attribute) */
  target: string;
  /** Step title displayed in tooltip */
  title: string;
  /** Step description displayed in tooltip */
  description: string;
  /** Tooltip placement relative to target */
  placement: TooltipPlacement;
}

export interface OnboardingTour {
  /** Unique identifier for the tour */
  id: string;
  /** URL path pattern where this tour is active */
  pathPattern: string;
  /** Steps in the tour */
  steps: OnboardingStep[];
  /** Minimum viewport width required to show this tour (for responsive layouts) */
  minWidth?: number;
}

export interface OnboardingState {
  /** IDs of completed tours */
  completedTours: string[];
  /** IDs of skipped tours */
  skippedTours: string[];
  /** Timestamp of last interaction */
  lastSeenAt?: number;
}

export interface OnboardingContextValue {
  /** Currently active tour, if any */
  activeTour: OnboardingTour | null;
  /** Current step index in the active tour */
  currentStepIndex: number;
  /** Whether any tour is currently active */
  isActive: boolean;
  /** Start a specific tour by ID */
  startTour: (tourId: string) => void;
  /** Move to the next step */
  nextStep: () => void;
  /** Move to the previous step */
  prevStep: () => void;
  /** Skip the current tour */
  skipTour: () => void;
  /** Complete the current tour */
  completeTour: () => void;
  /** Check if a tour has been completed */
  isTourCompleted: (tourId: string) => boolean;
  /** Check if a tour has been skipped */
  isTourSkipped: (tourId: string) => boolean;
  /** Reset all onboarding state */
  resetOnboarding: () => void;
}
