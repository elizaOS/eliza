import { useEffect, useState } from "react";
import type { OnboardingHardwareAdvice } from "../services/local-inference/hardware";

export interface OnboardingHardwareModelInput {
  sizeBytes: number;
  ramGbRequired: number;
}

export interface OnboardingHardwareAdviceState {
  advice: OnboardingHardwareAdvice | null;
  loading: boolean;
  error: Error | null;
}

export type OnboardingHardwareAdviceProvider = (
  model: OnboardingHardwareModelInput,
  signal: AbortSignal,
) => Promise<OnboardingHardwareAdvice>;

export interface UseOnboardingHardwareAdviceOptions {
  __test__provider?: OnboardingHardwareAdviceProvider;
  endpoint?: string;
}

const DEFAULT_ENDPOINT = "/api/local-inference/onboarding-hardware-advice";

async function fetchAdvice(
  endpoint: string,
  model: OnboardingHardwareModelInput,
  signal: AbortSignal,
): Promise<OnboardingHardwareAdvice> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(model),
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `onboarding-hardware-advice ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as OnboardingHardwareAdvice;
  return data;
}

export function useOnboardingHardwareAdvice(
  model?: OnboardingHardwareModelInput,
  options: UseOnboardingHardwareAdviceOptions = {},
): OnboardingHardwareAdviceState {
  const [state, setState] = useState<OnboardingHardwareAdviceState>({
    advice: null,
    loading: Boolean(model),
    error: null,
  });
  const provider = options.__test__provider;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

  useEffect(() => {
    if (!model) {
      setState({ advice: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ advice: null, loading: true, error: null });
    const task = provider
      ? provider(model, controller.signal)
      : fetchAdvice(endpoint, model, controller.signal);
    task
      .then((advice) => {
        if (controller.signal.aborted) return;
        setState({ advice, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const error = err instanceof Error ? err : new Error(String(err));
        setState({ advice: null, loading: false, error });
      });
    return () => controller.abort();
  }, [model?.sizeBytes, model?.ramGbRequired, provider, endpoint]);

  return state;
}
