"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TutorialState } from "@/components/tutorial/SpotlightTutorial";
import { DESKTOP_STEPS, MOBILE_STEPS } from "./steps";

const STORAGE_KEY = "feed-markets-tutorial-completed";
const AUTO_START_DELAY = 500;

export type MarketsTutorialState = TutorialState;

interface UseMarketsTutorialOptions {
  onBeforeStart?: () => void;
}

export function useMarketsTutorial(
  options?: UseMarketsTutorialOptions,
): MarketsTutorialState {
  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [hasCompleted, setHasCompleted] = useState(true);
  const onBeforeStartRef = useRef(options?.onBeforeStart);
  onBeforeStartRef.current = options?.onBeforeStart;

  const steps = useMemo(() => {
    if (typeof window === "undefined") return DESKTOP_STEPS;
    return window.matchMedia("(min-width: 768px)").matches
      ? DESKTOP_STEPS
      : MOBILE_STEPS;
  }, []);

  // Check localStorage on mount
  useEffect(() => {
    const completed = localStorage.getItem(STORAGE_KEY) === "true";
    setHasCompleted(completed);

    if (!completed) {
      const timer = setTimeout(() => {
        onBeforeStartRef.current?.();
        setIsActive(true);
        setCurrentStep(0);
      }, AUTO_START_DELAY);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, []);

  const markCompleted = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "true");
    setHasCompleted(true);
  }, []);

  const next = useCallback(() => {
    setCurrentStep((prev) => {
      if (prev >= steps.length - 1) {
        setIsActive(false);
        markCompleted();
        return prev;
      }
      return prev + 1;
    });
  }, [steps.length, markCompleted]);

  const prev = useCallback(() => {
    setCurrentStep((p) => Math.max(0, p - 1));
  }, []);

  const dismiss = useCallback(() => {
    setIsActive(false);
    markCompleted();
  }, [markCompleted]);

  const complete = useCallback(() => {
    setIsActive(false);
    markCompleted();
  }, [markCompleted]);

  const restart = useCallback(() => {
    onBeforeStartRef.current?.();
    setCurrentStep(0);
    setIsActive(true);
  }, []);

  return {
    isActive,
    currentStep,
    steps,
    hasCompleted,
    next,
    prev,
    dismiss,
    complete,
    restart,
  };
}
