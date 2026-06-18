// Self-contained fixture for the onboarding e2e. Mounts the real
// CompactOnboarding (primary first-run card, with the first-run controller
// stubbed) and the full-screen FirstRunShell (prop-driven, mocked here) over a
// brand backdrop, so a headless browser can screenshot every state. Paired with
// run-onboarding-e2e.mjs.
import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  FirstRunShell,
  type FirstRunShellProps,
} from "../../components/shell/FirstRunShell";
import { CompactOnboarding } from "../CompactOnboarding";

const params =
  typeof location !== "undefined"
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const full = params.get("shell") === "full";

// brand-gold.css defines these on `.first-run-screen`; mirror them so the
// full-screen FirstRunShell cards render faithfully in the bare harness.
const FIRST_RUN_VARS = {
  "--first-run-text-primary": "rgba(9, 14, 22, 0.96)",
  "--first-run-text-muted": "rgba(35, 45, 60, 0.84)",
  "--first-run-card-bg": "rgba(255, 255, 255, 0.42)",
  "--first-run-card-bg-hover": "rgba(255, 255, 255, 0.52)",
  "--first-run-card-border": "rgba(11, 53, 241, 0.14)",
} as React.CSSProperties;

function FullShell(): React.JSX.Element {
  const [step, setStep] = React.useState<"runtime" | "remote">(
    params.get("step") === "remote" ? "remote" : "runtime",
  );
  const [draft, setDraft] = React.useState({
    agentName: "Eliza",
    runtime: params.get("runtime") ?? "cloud",
    localInference: params.get("localinference") ?? "all-local",
    remoteApiBase:
      params.get("step") === "remote" ? "https://agent.example.com" : "",
    remoteToken: "",
  });
  const mic = params.get("mic");
  const micStatus =
    mic === "denied" ? "denied" : mic === "prompt" ? "prompt" : "granted";
  const shellProps = {
    step,
    draft,
    localRuntimeAvailable: !params.has("nolocal"),
    cloudOnly: params.has("cloudonly"),
    elizaCloudConnected: params.has("connected"),
    submitting: params.has("busy"),
    busyText: params.has("busy") ? "Starting your agent…" : null,
    error: params.get("error"),
    cloudError: null,
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
    primaryLabel: "Continue",
    canBack: step === "remote",
    updateDraft: (key: string, value: unknown) =>
      setDraft((d) => ({ ...d, [key]: value })),
    setStep,
    goBack: () => setStep("runtime"),
    finishRuntime: () => {},
    toggleVoice: async () => {},
    onPromptReady: () => {},
  } as unknown as FirstRunShellProps;
  return (
    <div style={{ position: "fixed", inset: 0, ...FIRST_RUN_VARS }}>
      <FirstRunShell {...shellProps} />
    </div>
  );
}

function Harness(): React.JSX.Element {
  if (full) return <FullShell />;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // Brand backdrop the onboarding card is designed to sit over (white text
        // + #FF5800 accents).
        background:
          "radial-gradient(120% 100% at 50% 0%, #ff8a3d 0%, #ff5800 55%, #c63f00 100%)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <CompactOnboarding />
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Harness />);
