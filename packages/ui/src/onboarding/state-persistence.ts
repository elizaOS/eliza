import { useCallback, useEffect, useState } from "react";
import { initialState, type OnboardingFlowState } from "./state-machine";

const STORAGE_KEY = "eliza.onboarding.v2";

function readStorage(): OnboardingFlowState | undefined {
  if (typeof window === "undefined" || !window.localStorage) return undefined;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingFlowState>;
    if (!parsed.current || typeof parsed.current !== "string") return undefined;
    return {
      current: parsed.current,
      runtime: parsed.runtime,
      sandboxMode: parsed.sandboxMode,
      devicePath: parsed.devicePath,
      language: parsed.language ?? initialState.language,
      name: parsed.name,
      location: parsed.location,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return undefined;
  }
}

function writeStorage(state: OnboardingFlowState): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearStorage(): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export interface PersistedOnboardingHook {
  state: OnboardingFlowState;
  setState: (next: OnboardingFlowState) => void;
  reset: () => void;
}

export function useOnboardingPersisted(): PersistedOnboardingHook {
  const [state, setStateInternal] = useState<OnboardingFlowState>(() => {
    const fromStorage = readStorage();
    return fromStorage ?? initialState;
  });

  useEffect(() => {
    writeStorage(state);
  }, [state]);

  const setState = useCallback((next: OnboardingFlowState) => {
    setStateInternal(next);
  }, []);

  const reset = useCallback(() => {
    clearStorage();
    setStateInternal(initialState);
  }, []);

  return { state, setState, reset };
}

export const ONBOARDING_STORAGE_KEY = STORAGE_KEY;
