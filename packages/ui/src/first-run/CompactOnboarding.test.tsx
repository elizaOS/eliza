// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstRunController } from "./use-first-run-controller";

const controllerMock = vi.hoisted(() => ({
  current: null as FirstRunController | null,
}));

vi.mock("./use-first-run-controller", () => ({
  useFirstRunController: () => {
    if (!controllerMock.current) {
      throw new Error("First-run controller test double missing.");
    }
    return controllerMock.current;
  },
}));

const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../utils/openExternalUrl", () => ({ openExternalUrl }));

import { CompactOnboarding } from "./CompactOnboarding";

function controller(
  overrides: Partial<FirstRunController> = {},
): FirstRunController {
  return {
    step: "runtime",
    draft: {
      agentName: "Eliza",
      runtime: "cloud",
      localInference: "all-local",
      remoteApiBase: "",
      remoteToken: "",
    },
    localRuntimeAvailable: false,
    cloudOnly: false,
    elizaCloudConnected: false,
    submitting: false,
    busyText: null,
    error: null,
    cloudError: null,
    voice: {
      supported: false,
      listening: false,
      speaking: false,
      transcript: "",
      error: null,
    },
    microphone: {
      status: "unknown",
      canRequest: true,
      requesting: false,
      request: vi.fn(async () => {}),
      openSettings: vi.fn(async () => {}),
    },
    primaryLabel: "Continue",
    canBack: false,
    pickerAgents: [],
    pickerPhase: "loading",
    pickerError: null,
    pickerActiveAgentId: null,
    pickerBindingId: null,
    onPickAgent: vi.fn(),
    onCreateNewAgent: vi.fn(),
    onRetryPicker: vi.fn(),
    onBackFromPicker: vi.fn(),
    updateDraft: vi.fn(),
    setStep: vi.fn(),
    goBack: vi.fn(),
    finishRuntime: vi.fn(async () => {}),
    startVoice: vi.fn(async () => {}),
    stopVoice: vi.fn(async () => {}),
    toggleVoice: vi.fn(async () => {}),
    onPromptReady: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  controllerMock.current = null;
  openExternalUrl.mockClear();
});

describe("CompactOnboarding", () => {
  it("offers the three runtime options with the brand lockup and no orb", () => {
    controllerMock.current = controller();

    render(<CompactOnboarding />);

    expect(screen.getByText("How should elizaOS run?")).toBeTruthy();
    expect(screen.getByText("Eliza Cloud")).toBeTruthy();
    expect(screen.getByText("This device")).toBeTruthy();
    expect(screen.getByTestId("onboarding-option-cloud")).toBeTruthy();
    expect(screen.getByTestId("onboarding-option-remote")).toBeTruthy();
    expect(screen.getByTestId("onboarding-option-local")).toBeTruthy();
    // The voice-first orb is gone.
    expect(screen.queryByRole("button", { name: "Tap to speak" })).toBeNull();
  });

  it("connects to cloud directly from the Eliza Cloud option", async () => {
    const updateDraft = vi.fn();
    const finishRuntime = vi.fn(async () => {});
    controllerMock.current = controller({ updateDraft, finishRuntime });

    render(<CompactOnboarding />);
    fireEvent.click(screen.getByTestId("onboarding-option-cloud"));

    await waitFor(() => expect(finishRuntime).toHaveBeenCalledTimes(1));
    expect(updateDraft).toHaveBeenCalledWith("runtime", "cloud");
  });

  it("opens the remote form (URL + token) from the Remote option", () => {
    const updateDraft = vi.fn();
    const setStep = vi.fn();
    controllerMock.current = controller({ updateDraft, setStep });

    render(<CompactOnboarding />);
    fireEvent.click(screen.getByTestId("onboarding-option-remote"));

    expect(updateDraft).toHaveBeenCalledWith("runtime", "remote");
    expect(setStep).toHaveBeenCalledWith("remote");
  });

  it("renders the remote URL/token form on the remote step and finishes", async () => {
    const finishRuntime = vi.fn(async () => {});
    controllerMock.current = controller({
      step: "remote",
      draft: {
        agentName: "Eliza",
        runtime: "remote",
        localInference: "all-local",
        remoteApiBase: "https://agent.example.com",
        remoteToken: "",
      },
      finishRuntime,
    });

    render(<CompactOnboarding />);
    expect(
      screen.getByPlaceholderText("https://agent.example.com"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("onboarding-remote-connect"));

    await waitFor(() => expect(finishRuntime).toHaveBeenCalledTimes(1));
  });

  it("advances to the inference choice from the Local option", () => {
    const updateDraft = vi.fn();
    const setStep = vi.fn();
    const finishRuntime = vi.fn(async () => {});
    controllerMock.current = controller({
      updateDraft,
      setStep,
      finishRuntime,
    });

    render(<CompactOnboarding />);
    fireEvent.click(screen.getByTestId("onboarding-option-local"));

    expect(updateDraft).toHaveBeenCalledWith("runtime", "local");
    expect(setStep).toHaveBeenCalledWith("inference");
    // The local agent is not provisioned until an inference target is chosen.
    expect(finishRuntime).not.toHaveBeenCalled();
  });

  it("offers cloud + on-device inference on the inference step and finishes", async () => {
    const updateDraft = vi.fn();
    const finishRuntime = vi.fn(async () => {});
    controllerMock.current = controller({
      step: "inference",
      draft: {
        agentName: "Eliza",
        runtime: "local",
        localInference: "cloud-inference",
        remoteApiBase: "",
        remoteToken: "",
      },
      updateDraft,
      finishRuntime,
    });

    render(<CompactOnboarding />);
    expect(screen.getByText("Where should it think?")).toBeTruthy();

    fireEvent.click(screen.getByTestId("onboarding-inference-cloud"));
    await waitFor(() => expect(finishRuntime).toHaveBeenCalledTimes(1));
    expect(updateDraft).toHaveBeenCalledWith(
      "localInference",
      "cloud-inference",
    );

    fireEvent.click(screen.getByTestId("onboarding-inference-local"));
    expect(updateDraft).toHaveBeenCalledWith("localInference", "all-local");
  });

  it("returns to the runtime choice from the inference step's Back link", () => {
    const setStep = vi.fn();
    controllerMock.current = controller({
      step: "inference",
      draft: {
        agentName: "Eliza",
        runtime: "local",
        localInference: "cloud-inference",
        remoteApiBase: "",
        remoteToken: "",
      },
      setStep,
    });

    render(<CompactOnboarding />);
    fireEvent.click(screen.getByText("Back"));

    expect(setStep).toHaveBeenCalledWith("runtime");
  });

  it("surfaces the cloud login link as a tappable button, not raw text", () => {
    controllerMock.current = controller({
      cloudError:
        "Open this link to log in: https://www.elizacloud.ai/auth/cli-login?session=abc",
    });

    render(<CompactOnboarding />);

    const openBtn = screen.getByTestId("onboarding-cloud-open-signin");
    expect(openBtn).toBeTruthy();
    // The raw "Open this link to log in:" string is NOT dumped at the user.
    expect(screen.queryByText(/Open this link to log in:/)).toBeNull();

    fireEvent.click(openBtn);
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://www.elizacloud.ai/auth/cli-login?session=abc",
    );
  });

  it("keeps the orange background when a cloud error is shown", () => {
    controllerMock.current = controller({
      cloudError: "Eliza Cloud login timed out. Please try again.",
    });

    render(<CompactOnboarding />);

    expect(screen.getByTestId("onboarding-toast").textContent).toContain(
      "Eliza Cloud login timed out. Please try again.",
    );
    expect(document.querySelector(".first-run-screen")).toBeTruthy();
  });

  it("shows in-flight progress over a stale cloud error while submitting", () => {
    controllerMock.current = controller({
      submitting: true,
      busyText: "Starting local agent",
      cloudError: "Eliza Cloud login timed out. Please try again.",
    });

    render(<CompactOnboarding />);

    const toast = screen.getByTestId("onboarding-toast").textContent ?? "";
    expect(toast).toContain("Starting local agent");
    expect(toast).not.toContain("login timed out");
  });

  it("disables the option cards while submitting", () => {
    controllerMock.current = controller({ submitting: true });

    render(<CompactOnboarding />);

    expect(
      screen.getByTestId<HTMLButtonElement>("onboarding-option-cloud").disabled,
    ).toBe(true);
    expect(
      screen.getByTestId<HTMLButtonElement>("onboarding-option-local").disabled,
    ).toBe(true);
  });

  it("renders the agent picker on the pick-agent step and forwards a row pick", () => {
    const onPickAgent = vi.fn();
    controllerMock.current = controller({
      step: "pick-agent",
      pickerPhase: "ready",
      pickerAgents: [
        {
          agent_id: "agent-1",
          agent_name: "Agent One",
          node_id: null,
          container_id: null,
          headscale_ip: null,
          bridge_url: null,
          web_ui_url: null,
          status: "running",
          agent_config: {},
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:00:00.000Z",
          containerUrl: "",
          webUiUrl: null,
          database_status: "ready",
          error_message: null,
          last_heartbeat_at: null,
        },
      ],
      onPickAgent,
    });

    render(<CompactOnboarding />);

    expect(screen.getByTestId("onboarding-agent-picker")).toBeTruthy();
    // The welcome choice buttons are NOT rendered on the picker step.
    expect(screen.queryByTestId("onboarding-option-cloud")).toBeNull();

    fireEvent.click(screen.getByTestId("onboarding-agent-option-agent-1"));
    expect(onPickAgent).toHaveBeenCalledWith("agent-1");
  });
});
