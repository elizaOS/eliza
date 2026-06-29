// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const setTab = vi.hoisted(() => vi.fn());
vi.mock("../state", () => ({
  useAppSelectorShallow: (
    selector: (s: { setTab: typeof setTab }) => unknown,
  ) => selector({ setTab }),
}));

import { FirstRunChat } from "./FirstRunChat";
import { defaultProviderForRuntime } from "./first-run-config";

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
    localRuntimeAvailable: true,
    cloudOnly: false,
    elizaCloudConnected: false,
    submitting: false,
    busyText: null,
    error: null,
    cloudLoginFallbackUrl: null,
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
  setTab.mockClear();
});

describe("defaultProviderForRuntime", () => {
  it("encodes the role-correct default per runtime in one place", () => {
    expect(defaultProviderForRuntime("cloud")).toBe("elizacloud");
    expect(defaultProviderForRuntime("local")).toBe("on-device");
    expect(defaultProviderForRuntime("remote")).toBeNull();
  });
});

describe("FirstRunChat", () => {
  it("greets the user first and asks the runtime question as in-chat widgets", () => {
    controllerMock.current = controller();
    render(<FirstRunChat />);

    expect(screen.getByTestId("first-run-greeting").textContent).toMatch(
      /hey there/i,
    );
    expect(screen.getByText(/run your agent locally/i)).toBeTruthy();
    expect(screen.getByTestId("choice-cloud")).toBeTruthy();
    expect(screen.getByTestId("choice-local")).toBeTruthy();
    expect(screen.getByTestId("choice-remote")).toBeTruthy();
  });

  it("hides the local option when local runtime is unavailable", () => {
    controllerMock.current = controller({ localRuntimeAvailable: false });
    render(<FirstRunChat />);

    expect(screen.getByTestId("choice-cloud")).toBeTruthy();
    expect(screen.queryByTestId("choice-local")).toBeNull();
  });

  it("choosing cloud drives the controller (updateDraft + finishRuntime), not the widget", () => {
    const c = controller();
    controllerMock.current = c;
    render(<FirstRunChat />);

    fireEvent.click(screen.getByTestId("choice-cloud"));

    expect(c.updateDraft).toHaveBeenCalledWith("runtime", "cloud");
    expect(c.finishRuntime).toHaveBeenCalledTimes(1);
  });

  it("choosing local advances to the provider sub-choice (no immediate provision)", () => {
    const c = controller();
    controllerMock.current = c;
    render(<FirstRunChat />);

    fireEvent.click(screen.getByTestId("choice-local"));

    expect(c.updateDraft).toHaveBeenCalledWith("runtime", "local");
    expect(c.setStep).toHaveBeenCalledWith("inference");
    expect(c.finishRuntime).not.toHaveBeenCalled();
  });

  it("renders the provider question with the role-correct default highlighted, not auto-submitted", () => {
    const c = controller({
      step: "inference",
      draft: { ...controller().draft, runtime: "local" },
    });
    controllerMock.current = c;
    render(<FirstRunChat />);

    expect(screen.getByText(/run my AI/i)).toBeTruthy();
    // local → on-device default is pre-highlighted as "(recommended)".
    expect(screen.getByTestId("choice-on-device").textContent).toMatch(
      /recommended/i,
    );
    expect(screen.getByTestId("choice-elizacloud")).toBeTruthy();
    // Nothing auto-submitted just by rendering the question.
    expect(c.finishRuntime).not.toHaveBeenCalled();
  });

  it("provider=elizacloud maps to cloud-inference and finishes", () => {
    const c = controller({ step: "inference" });
    controllerMock.current = c;
    render(<FirstRunChat />);

    fireEvent.click(screen.getByTestId("choice-elizacloud"));

    expect(c.updateDraft).toHaveBeenCalledWith(
      "localInference",
      "cloud-inference",
    );
    expect(c.finishRuntime).toHaveBeenCalledTimes(1);
  });

  it("provider=other finishes on-device then routes to Settings via the existing handoff", async () => {
    const c = controller({ step: "inference" });
    controllerMock.current = c;
    render(<FirstRunChat />);

    fireEvent.click(screen.getByTestId("choice-other"));

    expect(c.updateDraft).toHaveBeenCalledWith("localInference", "all-local");
    expect(c.finishRuntime).toHaveBeenCalledTimes(1);
    // setTab("settings") fires after finishRuntime resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(setTab).toHaveBeenCalledWith("settings");
  });

  it("renders the Eliza Cloud sign-in as the in-chat credential widget when a login URL is present", () => {
    controllerMock.current = controller({
      cloudLoginFallbackUrl: "https://cloud.elizaos.ai/signin?token=demo",
    });
    render(<FirstRunChat />);

    expect(screen.getByTestId("credential-request")).toBeTruthy();
    expect(screen.getByTestId("credential-oauth-authorize")).toBeTruthy();
  });

  it("renders the inline agent picker on the pick-agent step", () => {
    controllerMock.current = controller({ step: "pick-agent" });
    render(<FirstRunChat />);

    expect(screen.getByText(/which agent should I run/i)).toBeTruthy();
  });
});
