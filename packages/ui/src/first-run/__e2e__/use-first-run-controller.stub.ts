// Browser-pure stand-in for useFirstRunController in the onboarding e2e bundle.
// The real hook wires platform/runtime/voice/cloud state; the harness just needs
// a controller whose visible state is driven by URL params so each onboarding
// state is a deterministic page load. Draft + step are live so interactions work.
import * as React from "react";

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();

export function useFirstRunController() {
  const [step, setStep] = React.useState<"runtime" | "remote">(
    params.get("step") === "remote" ? "remote" : "runtime",
  );
  const [draft, setDraft] = React.useState({
    agentName: "Eliza",
    runtime: params.get("runtime") ?? "cloud",
    localInference: params.get("localinference") ?? "all-local",
    remoteApiBase: params.get("step") === "remote" ? "https://agent.example.com" : "",
    remoteToken: "",
  });
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
  const busy = params.has("busy");

  return {
    step,
    setStep,
    draft,
    updateDraft,
    localRuntimeAvailable: !params.has("nolocal"),
    cloudOnly: params.has("cloudonly"),
    elizaCloudConnected: params.has("connected"),
    submitting: busy,
    busyText: busy ? params.get("busy") || "Starting your agent…" : null,
    error: params.get("error"),
    cloudError: cloudLogin
      ? "Open this link to log in: https://cloud.elizaos.ai/signin?token=demo"
      : null,
    primaryLabel: "Continue",
    canBack: step === "remote",
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
    finishRuntime: async () => {
      console.log("[onboarding] finishRuntime");
    },
    toggleVoice: async () => {},
    onPromptReady: () => {},
  };
}
