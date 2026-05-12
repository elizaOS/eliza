/**
 * OnboardingProvider - Context provider for guided onboarding tours.
 * Manages tour state, step navigation, and persistence to localStorage.
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { getTourById, getTourForPath } from "@/lib/onboarding/tours";
import type {
  OnboardingContextValue,
  OnboardingState,
  OnboardingTour,
} from "@/lib/onboarding/types";

const STORAGE_KEY = "eliza-onboarding";

const defaultState: OnboardingState = {
  completedTours: [],
  skippedTours: [],
};

function loadState(): OnboardingState {
  if (typeof window === "undefined") return defaultState;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return defaultState;
  return JSON.parse(stored) as OnboardingState;
}

function saveState(state: OnboardingState): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

export function useOnboarding(): OnboardingContextValue {
  const context = useContext(OnboardingContext);
  if (!context) {
    throw new Error("useOnboarding must be used within OnboardingProvider");
  }
  return context;
}

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const pathname = useLocation().pathname;
  const [state, setState] = useState<OnboardingState>(() => loadState());
  const [activeTour, setActiveTour] = useState<OnboardingTour | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isInitialized, _setIsInitialized] = useState(() => typeof window !== "undefined");

  // Auto-start tour for current path if user hasn't seen it
  useEffect(() => {
    if (!isInitialized || activeTour) return;

    const tour = getTourForPath(pathname || "");
    if (!tour) return;

    // Check if viewport meets minimum width requirement
    if (tour.minWidth && window.innerWidth < tour.minWidth) {
      return;
    }

    const hasCompleted = state.completedTours.includes(tour.id);
    const hasSkipped = state.skippedTours.includes(tour.id);

    if (!hasCompleted && !hasSkipped) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        // Re-check viewport width before starting (in case of resize)
        if (tour.minWidth && window.innerWidth < tour.minWidth) {
          return;
        }
        setActiveTour(tour);
        setCurrentStepIndex(0);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [pathname, isInitialized, activeTour, state.completedTours, state.skippedTours]);

  const startTour = useCallback((tourId: string) => {
    const tour = getTourById(tourId);
    if (!tour) {
      console.warn(`[Onboarding] Tour not found: ${tourId}`);
      return;
    }
    setActiveTour(tour);
    setCurrentStepIndex(0);
  }, []);

  const nextStep = useCallback(() => {
    if (!activeTour) return;

    if (currentStepIndex < activeTour.steps.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      // Last step - complete the tour
      setState((prev) => {
        const newState = {
          ...prev,
          completedTours: [...prev.completedTours, activeTour.id],
          lastSeenAt: Date.now(),
        };
        saveState(newState);
        return newState;
      });
      setActiveTour(null);
      setCurrentStepIndex(0);
    }
  }, [activeTour, currentStepIndex]);

  const prevStep = useCallback(() => {
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [currentStepIndex]);

  const skipTour = useCallback(() => {
    if (!activeTour) return;

    setState((prev) => {
      const newState = {
        ...prev,
        skippedTours: [...prev.skippedTours, activeTour.id],
        lastSeenAt: Date.now(),
      };
      saveState(newState);
      return newState;
    });
    setActiveTour(null);
    setCurrentStepIndex(0);
  }, [activeTour]);

  const completeTour = useCallback(() => {
    if (!activeTour) return;

    setState((prev) => {
      const newState = {
        ...prev,
        completedTours: [...prev.completedTours, activeTour.id],
        lastSeenAt: Date.now(),
      };
      saveState(newState);
      return newState;
    });
    setActiveTour(null);
    setCurrentStepIndex(0);
  }, [activeTour]);

  const isTourCompleted = useCallback(
    (tourId: string) => state.completedTours.includes(tourId),
    [state.completedTours],
  );

  const isTourSkipped = useCallback(
    (tourId: string) => state.skippedTours.includes(tourId),
    [state.skippedTours],
  );

  const resetOnboarding = useCallback(() => {
    setState(defaultState);
    saveState(defaultState);
    setActiveTour(null);
    setCurrentStepIndex(0);
  }, []);

  const value = useMemo<OnboardingContextValue>(
    () => ({
      activeTour,
      currentStepIndex,
      isActive: activeTour !== null,
      startTour,
      nextStep,
      prevStep,
      skipTour,
      completeTour,
      isTourCompleted,
      isTourSkipped,
      resetOnboarding,
    }),
    [
      activeTour,
      currentStepIndex,
      startTour,
      nextStep,
      prevStep,
      skipTour,
      completeTour,
      isTourCompleted,
      isTourSkipped,
      resetOnboarding,
    ],
  );

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}
