// Browser-pure stand-in for useFirstRunController in the in-chat first-run e2e
// bundle (#9952). The real hook wires platform/runtime/voice/cloud state; the
// harness needs a controller whose visible state is driven by URL params AND
// whose `finishRuntime` advances the flow + records a single submit, so the e2e
// can drive the real ChoiceWidget callbacks through to a "first-run complete"
// outcome. Draft + step are live so interactions work.
import * as React from "react";

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();

/** Test sink the runner reads to assert POST /api/first-run fired exactly once. */
declare global {
  interface Window {
    __firstRunSubmits?: number;
    __firstRunComplete?: boolean;
  }
}

export function useFirstRunController() {
  const stepParam = params.get("step");
  const [step, setStep] = React.useState<
    "runtime" | "inference" | "remote" | "pick-agent"
  >(
    stepParam === "remote"
      ? "remote"
      : stepParam === "inference"
        ? "inference"
        : stepParam === "pick-agent"
          ? "pick-agent"
          : "runtime",
  );
  const [draft, setDraft] = React.useState({
    agentName: "Eliza",
    runtime:
      params.get("runtime") ?? (stepParam === "inference" ? "local" : "cloud"),
    localInference: params.get("localinference") ?? "all-local",
    remoteApiBase:
      params.get("step") === "remote" ? "https://agent.example.com" : "",
    remoteToken: "",
  });
  const [submitting, setSubmitting] = React.useState(params.has("busy"));
  const micStatus =
    params.get("mic") === "denied"
      ? "denied"
      : params.get("mic") === "prompt"
        ? "prompt"
        : "granted";
  const updateDraft = React.useCallback((key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);
  const cloudLogin = params.has("cloudlogin");

  // The real controller's terminal action: submit the first-run config exactly
  // once, then hand off to chat. The stub mirrors that contract so the e2e can
  // assert "POST /api/first-run sent once" + firstRunComplete persisted.
  const finishRuntime = React.useCallback(async () => {
    setSubmitting(true);
    if (typeof window !== "undefined") {
      window.__firstRunSubmits = (window.__firstRunSubmits ?? 0) + 1;
      window.__firstRunComplete = true;
    }
    console.log("[first-run] POST /api/first-run (finishRuntime)");
  }, []);

  return {
    step,
    setStep,
    draft,
    updateDraft,
    localRuntimeAvailable: !params.has("nolocal"),
    cloudOnly: params.has("cloudonly"),
    elizaCloudConnected: params.has("connected"),
    submitting,
    busyText: submitting
      ? params.get("busy") || "Starting your agent…"
      : null,
    error: params.get("error"),
    cloudError: cloudLogin
      ? "Open this link to log in: https://cloud.elizaos.ai/signin?token=demo"
      : null,
    cloudLoginFallbackUrl: cloudLogin
      ? "https://cloud.elizaos.ai/signin?token=demo"
      : null,
    primaryLabel: "Continue",
    canBack: step !== "runtime",
    // Picker state for the "pick-agent" step.
    pickerAgents: [],
    pickerPhase: "ready" as const,
    pickerError: null,
    pickerActiveAgentId: null,
    pickerBindingId: null,
    onPickAgent: () => {},
    onCreateNewAgent: () => void finishRuntime(),
    onRetryPicker: () => {},
    onBackFromPicker: () => setStep("runtime"),
    voice: {
      supported: true,
      listening: false,
      speaking: false,
      transcript: "",
      error: null,
    },
    microphone: {
      status: micStatus,
      canRequest: micStatus !== "denied",
      requesting: false,
      request: async () => {},
      openSettings: async () => {},
    },
    goBack: () => setStep("runtime"),
    finishRuntime,
    startVoice: async () => {},
    stopVoice: async () => {},
    toggleVoice: async () => {},
    onPromptReady: () => {},
  };
}
